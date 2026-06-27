import type { OrderBookQuote, OrderRecord, StateSnapshot, TradeIntent } from '../../../packages/shared/src';
import type { StrategyRiskConfig } from '../../../packages/strategy/src';
import type { PolymarketAdapter } from '../../../packages/polymarket/src';
import type { AppConfig } from './config';
import type { InMemoryStore } from './store';

const FAILED_ORDER_COOLDOWN_MS = 5 * 60_000;
const MIN_MARKETABLE_BUY_NOTIONAL_USD = 1;
const MIN_GTD_EXPIRATION_LEAD_MS = 5_000;
const EXPERIMENT_ENTRY_STRATEGY = 'BTC5M_NEXT_ROUND_50_49_STOP_ON_SINGLE';
const ENTRY_STRATEGIES = new Set(['BTC5M_DUAL_45', EXPERIMENT_ENTRY_STRATEGY]);
export type ExecuteIntentsParams = {
  appConfig: AppConfig;
  adapter: PolymarketAdapter;
  store: InMemoryStore;
  snapshot: StateSnapshot;
  intents: TradeIntent[];
  risk: StrategyRiskConfig;
};

export async function executeLiveIntents(params: ExecuteIntentsParams): Promise<string[]> {
  const diagnostics: string[] = [];
  const runtime = params.store.getRuntime();
  if (!params.intents.length) return diagnostics;

  if (runtime.executionMode !== 'live') {
    for (const intent of params.intents) {
      params.store.recordOrder(localOrder(params.snapshot, intent));
      params.store.updateIntent(intent.id, { status: 'executed' });
    }
    diagnostics.push(`Monitor mode recorded ${params.intents.length} local order intents without posting to CLOB.`);
    return diagnostics;
  }

  if (runtime.status === 'degraded') {
    diagnostics.push('Live trading is blocked while runtime is degraded; generated intents were not executed.');
    return diagnostics;
  }

  const balanceGate = await batchBuyBalanceGate(params);
  if (!balanceGate.ok) {
    for (const intent of params.intents) {
      params.store.updateIntent(intent.id, { status: 'rejected', rejectionReason: balanceGate.reason });
    }
    params.store.recordRuntimeLog({
      level: 'warn',
      source: 'execution',
      message: `Execution blocked for batch: ${balanceGate.reason}.`,
      details: balanceGate.details,
    });
    diagnostics.push(`Execution blocked for batch: ${balanceGate.reason}.`);
    return diagnostics;
  }

  for (const intent of params.intents) {
    const result = await executeOneIntent(params, intent);
    if (result) diagnostics.push(result);
  }
  return diagnostics;
}

async function executeOneIntent(params: ExecuteIntentsParams, intent: TradeIntent): Promise<string | null> {
  const gate = await executionGate(params, intent);
  if (!gate.ok) {
    params.store.updateIntent(intent.id, { status: gate.recordFailure ? 'failed' : 'rejected', rejectionReason: gate.reason });
    params.store.recordRuntimeLog({
      level: gate.recordFailure ? 'error' : 'warn',
      source: 'execution',
      message: `Execution blocked for ${intent.label}: ${gate.reason}.`,
      details: { intentId: intent.id, tokenId: intent.tokenId, side: intent.side, reason: gate.reason },
    });
    if (gate.recordFailure) params.store.recordOrder(failedOrder(params.snapshot, intent, gate.executionKey, gate.reason));
    return `Execution blocked for ${intent.label}: ${gate.reason}.`;
  }

  try {
    const posted = await params.adapter.executeLimitIntent(intent, {
      execute: true,
      orderType: 'GTD',
      expiration: Math.floor(new Date(params.snapshot.round.startAt).getTime() / 1000),
    });
    const order: OrderRecord = {
      id: `order-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      intentId: intent.id,
      strategy: intent.strategy,
      strategyProfile: strategyProfileForIntent(intent),
      executionKey: gate.executionKey,
      clobOrderId: posted.orderId,
      roundId: intent.roundId,
      eventSlug: params.snapshot.round.eventSlug,
      marketTitle: params.snapshot.round.title,
      imageUrl: params.snapshot.round.imageUrl,
      tokenId: intent.tokenId,
      label: intent.label,
      side: intent.side,
      price: posted.price,
      size: posted.size,
      status: posted.ok ? 'posted' : 'failed',
      createdAt: new Date().toISOString(),
      error: posted.error,
      rawResponse: posted.raw,
    };
    params.store.recordOrder(order);
    params.store.updateIntent(intent.id, { status: posted.ok ? 'executed' : 'failed', rejectionReason: posted.ok ? undefined : posted.error || 'CLOB_POST_FAILED' });
    params.store.recordRuntimeLog({
      level: posted.ok ? 'info' : 'error',
      source: 'execution',
      message: posted.ok ? `Order posted for ${intent.label}.` : `Execution failed for ${intent.label}: ${posted.error || 'CLOB_POST_FAILED'}.`,
      details: { intentId: intent.id, clobOrderId: posted.orderId, tokenId: intent.tokenId, side: intent.side, price: posted.price, size: posted.size },
    });
    return posted.ok ? null : `Execution failed for ${intent.label}: ${posted.error || 'CLOB_POST_FAILED'}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.store.recordOrder(failedOrder(params.snapshot, intent, gate.executionKey, message));
    params.store.updateIntent(intent.id, { status: 'failed', rejectionReason: message });
    params.store.recordRuntimeLog({ level: 'error', source: 'execution', message: `Execution failed for ${intent.label}: ${message}.` });
    return `Execution failed for ${intent.label}: ${message}.`;
  }
}

type GateResult =
  | { ok: true; executionKey: string }
  | { ok: false; executionKey: string; reason: string; recordFailure: boolean };

type BatchGateResult =
  | { ok: true }
  | { ok: false; reason: string; details: Record<string, unknown> };

async function batchBuyBalanceGate(params: ExecuteIntentsParams): Promise<BatchGateResult> {
  const buyIntents = params.intents.filter((intent) => intent.side === 'BUY');
  if (!buyIntents.length) return { ok: true };

  for (const intent of buyIntents) {
    const notional = roundDownShares(intent.shares) * intent.limitPrice;
    if (notional < MIN_MARKETABLE_BUY_NOTIONAL_USD) {
      return {
        ok: false,
        reason: 'ORDER_NOTIONAL_BELOW_MIN',
        details: { intentId: intent.id, label: intent.label, notional, minimum: MIN_MARKETABLE_BUY_NOTIONAL_USD },
      };
    }
  }

  try {
    const [{ balance, allowance }, openOrders] = await Promise.all([
      params.adapter.getCollateralBalanceAllowance(),
      params.adapter.getOpenOrders(),
    ]);
    const activeBuyNotional = openOrders.reduce((total, order) => {
      if (order.side !== 'BUY' || order.price == null || order.size == null) return total;
      const matched = order.sizeMatched ?? 0;
      const remaining = Math.max(0, order.size - matched);
      return total + order.price * remaining;
    }, 0);
    const collateralLimit = allowance == null ? balance : Math.min(balance, allowance);
    const availableCollateral = collateralLimit - activeBuyNotional;
    const requiredNotional = buyIntents.reduce((total, intent) => total + roundDownShares(intent.shares) * intent.limitPrice, 0);
    if (availableCollateral + 0.000001 < requiredNotional) {
      return {
        ok: false,
        reason: 'INSUFFICIENT_AVAILABLE_COLLATERAL',
        details: { requiredNotional, balance, allowance, activeBuyNotional, availableCollateral },
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `COLLATERAL_CHECK_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      details: {},
    };
  }
}

async function executionGate(params: ExecuteIntentsParams, intent: TradeIntent): Promise<GateResult> {
  const executionKey = [intent.roundId, intent.strategy, intent.tokenId, intent.side].join(':');
  const reject = (reason: string, recordFailure = false): GateResult => ({ ok: false, executionKey, reason, recordFailure });

  if (!roundTokens(params.snapshot).has(intent.tokenId)) return reject('TOKEN_NOT_IN_ROUND');
  if (intent.side === 'SELL') return reject('SELL_DISABLED_SETTLEMENT_ONLY');
  const msToStart = new Date(params.snapshot.round.startAt).getTime() - Date.now();
  if (msToStart <= 0) return reject('ROUND_ALREADY_STARTED');
  if (msToStart <= MIN_GTD_EXPIRATION_LEAD_MS) return reject('ROUND_START_TOO_CLOSE_FOR_GTD');
  if (params.snapshot.round.secondsToEnd <= params.appConfig.marketConfig.avoidExpirySeconds) return reject('ROUND_EXPIRY_TOO_CLOSE');
  if (!params.appConfig.ownerPrivateKey?.trim()) return reject('OWNER_PRIVATE_KEY_MISSING', true);
  if (!params.appConfig.depositWallet?.trim()) return reject('POLYMARKET_DEPOSIT_WALLET_MISSING', true);
  if (intent.orderType !== 'LIMIT') return reject('UNSUPPORTED_ORDER_TYPE');
  if (!Number.isFinite(intent.limitPrice) || intent.limitPrice <= 0 || intent.limitPrice >= 1) return reject('INVALID_LIMIT_PRICE');
  if (!Number.isFinite(intent.shares) || intent.shares <= 0) return reject('INVALID_SHARES');
  if (roundDownShares(intent.shares) <= 0) return reject('INVALID_ORDER_SIZE');

  const quote = params.snapshot.orderbooks.find((item) => item.tokenId === intent.tokenId);
  const quoteGate = quoteExecutionGate(quote, intent, params.risk.maxOrderbookAgeSeconds);
  if (quoteGate) return reject(quoteGate);

  const dedupeWindowMs = Math.max(intent.ttlSeconds * 1000, 60_000);
  if (ENTRY_STRATEGIES.has(intent.strategy) && params.store.hasNonFailedOrder(executionKey)) return reject('LOCAL_STRATEGY_ORDER_EXISTS');
  if (params.store.hasRecentOrder(executionKey, dedupeWindowMs)) return reject('LOCAL_DUPLICATE_ORDER');
  if (params.store.hasRecentFailedOrder(executionKey, FAILED_ORDER_COOLDOWN_MS)) return reject('LOCAL_RECENT_FAILED_ORDER');

  try {
    const openOrders = await params.adapter.getOpenOrders({ tokenId: intent.tokenId });
    const matching = openOrders.find((order) => order.tokenId === intent.tokenId);
    if (matching) return reject('PM_OPEN_ORDER_EXISTS');
  } catch (error) {
    return reject(`PM_OPEN_ORDER_CHECK_FAILED: ${error instanceof Error ? error.message : String(error)}`, true);
  }

  return { ok: true, executionKey };
}

function quoteExecutionGate(quote: OrderBookQuote | undefined, intent: TradeIntent, maxAgeSeconds: number): string | null {
  if (!quote) return 'ORDERBOOK_MISSING';
  if (quote.source === 'mock') return 'ORDERBOOK_NOT_LIVE';
  const ageMs = Date.now() - new Date(quote.updatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > maxAgeSeconds * 1000) return 'ORDERBOOK_STALE';
  if (intent.side === 'BUY' && quote.bestAsk == null) return 'BEST_ASK_MISSING';
  if (intent.side === 'SELL' && quote.bestBid == null) return 'BEST_BID_MISSING';
  return null;
}

function localOrder(snapshot: StateSnapshot, intent: TradeIntent): OrderRecord {
  return {
    id: `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    intentId: intent.id,
    strategy: intent.strategy,
    strategyProfile: strategyProfileForIntent(intent),
    executionKey: [intent.roundId, intent.strategy, intent.tokenId, intent.side].join(':'),
    roundId: intent.roundId,
    eventSlug: snapshot.round.eventSlug,
    marketTitle: snapshot.round.title,
    imageUrl: snapshot.round.imageUrl,
    tokenId: intent.tokenId,
    label: intent.label,
    side: intent.side,
    price: intent.limitPrice,
    size: roundDownShares(intent.shares),
    status: 'local',
    createdAt: new Date().toISOString(),
    rawResponse: { monitor: true },
  };
}

function failedOrder(snapshot: StateSnapshot, intent: TradeIntent, executionKey: string, error: string): OrderRecord {
  return {
    ...localOrder(snapshot, intent),
    id: `failed-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    executionKey,
    status: 'failed',
    error,
    rawResponse: { error },
  };
}

function roundTokens(snapshot: StateSnapshot): Set<string> {
  return new Set([snapshot.round.yesTokenId, snapshot.round.noTokenId].filter(Boolean));
}

function roundDownShares(shares: number): number {
  return Math.floor(shares * 100) / 100;
}

function strategyProfileForIntent(intent: TradeIntent): OrderRecord['strategyProfile'] {
  return intent.strategy === 'BTC5M_NEXT_ROUND_50_49_STOP_ON_SINGLE' ? 'experiment_next_round' : 'classic';
}
