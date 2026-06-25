import type { OrderBookQuote, OrderRecord, StateSnapshot, TradeIntent } from '../../../packages/shared/src';
import type { StrategyRiskConfig } from '../../../packages/strategy/src';
import type { PolymarketAdapter } from '../../../packages/polymarket/src';
import type { AppConfig } from './config';
import type { InMemoryStore } from './store';

const FAILED_ORDER_COOLDOWN_MS = 5 * 60_000;
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
    const posted = await params.adapter.executeLimitIntent(intent, { execute: true });
    const order: OrderRecord = {
      id: `order-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      intentId: intent.id,
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

async function executionGate(params: ExecuteIntentsParams, intent: TradeIntent): Promise<GateResult> {
  const executionKey = [intent.roundId, intent.strategy, intent.tokenId, intent.side].join(':');
  const reject = (reason: string, recordFailure = false): GateResult => ({ ok: false, executionKey, reason, recordFailure });

  if (!roundTokens(params.snapshot).has(intent.tokenId)) return reject('TOKEN_NOT_IN_ROUND');
  if (intent.side === 'SELL') return reject('SELL_DISABLED_SETTLEMENT_ONLY');
  if (Date.now() >= new Date(params.snapshot.round.startAt).getTime()) return reject('ROUND_ALREADY_STARTED');
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
