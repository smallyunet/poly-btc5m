import type { OrderBookQuote, OrderRecord, StrategyCheck, TradeIntent } from '../../../packages/shared/src';
import type { PolymarketAdapter, FillTarget } from '../../../packages/polymarket/src';
import type { AppConfig } from './config';
import type { InMemoryStore, SingleFillHedgeCandidate } from './store';

export type HedgePlan =
  | { ok: true; intent: TradeIntent; dominantLabel: 'YES' | 'NO'; dominantAvgPrice: number; missingShares: number; bestAsk: number; expectedPnlPerShare: number }
  | { ok: false; reason: string };

type ExecuteHedgesParams = {
  appConfig: AppConfig;
  adapter: PolymarketAdapter;
  store: InMemoryStore;
  candidates: SingleFillHedgeCandidate[];
  orderbooks: OrderBookQuote[];
};

const HEDGE_STRATEGY = 'BTC5M_SINGLE_FILL_HEDGE';
const FAILED_HEDGE_COOLDOWN_MS = 60_000;

export async function executeSingleFillHedges(params: ExecuteHedgesParams): Promise<string[]> {
  const diagnostics: string[] = [];
  if (!params.appConfig.singleFillHedgeEnabled || !params.candidates.length) return diagnostics;

  const runtime = params.store.getRuntime();
  if (runtime.status === 'degraded') return ['Single-fill hedge skipped: runtime is degraded.'];

  for (const candidate of params.candidates) {
    const result = await executeOneHedge(params, candidate);
    if (result) diagnostics.push(result);
  }
  return diagnostics;
}

export function planSingleFillHedge(params: {
  candidate: SingleFillHedgeCandidate;
  orders: OrderRecord[];
  orderbooks: OrderBookQuote[];
  appConfig: AppConfig;
  nowMs?: number;
}): HedgePlan {
  const nowMs = params.nowMs ?? Date.now();
  const secondsToEnd = (new Date(params.candidate.endAt).getTime() - nowMs) / 1000;
  if (secondsToEnd > params.appConfig.singleFillHedgeWindowSeconds) return { ok: false, reason: 'NOT_IN_HEDGE_WINDOW' };
  if (secondsToEnd <= params.appConfig.singleFillHedgeMinSecondsToEnd) return { ok: false, reason: 'HEDGE_TOO_CLOSE_TO_EXPIRY' };

  const buyFills = params.orders.flatMap((order) => matchingBuyFills(order));
  const yes = exposure(buyFills.filter((fill) => fill.label === 'YES'));
  const no = exposure(buyFills.filter((fill) => fill.label === 'NO'));
  const diff = roundShares(Math.abs(yes.shares - no.shares));
  if (diff < params.appConfig.minOrderShares) return { ok: false, reason: 'NO_MATERIAL_SINGLE_FILL_EXPOSURE' };

  const dominantLabel = yes.shares > no.shares ? 'YES' : 'NO';
  const missingLabel = dominantLabel === 'YES' ? 'NO' : 'YES';
  const dominantAvgPrice = dominantLabel === 'YES' ? yes.avgPrice : no.avgPrice;
  if (!Number.isFinite(dominantAvgPrice) || dominantAvgPrice <= 0) return { ok: false, reason: 'DOMINANT_AVG_PRICE_MISSING' };

  const tokenId = missingLabel === 'YES' ? params.candidate.yesTokenId : params.candidate.noTokenId;
  const quote = params.orderbooks.find((item) => item.tokenId === tokenId);
  const quoteGate = buyQuoteGate(quote, params.appConfig.maxOrderbookAgeSeconds);
  if (quoteGate) return { ok: false, reason: quoteGate };
  const bestAsk = quote?.bestAsk;
  if (bestAsk == null) return { ok: false, reason: 'BEST_ASK_MISSING' };
  if (bestAsk > params.appConfig.singleFillHedgeMaxPrice) return { ok: false, reason: 'HEDGE_ASK_ABOVE_CAP' };

  const limitPrice = roundPrice(Math.min(bestAsk + params.appConfig.singleFillHedgePriceOffset, params.appConfig.singleFillHedgeMaxPrice));
  const pairCost = dominantAvgPrice + limitPrice;
  if (pairCost > params.appConfig.singleFillHedgeMaxPairCost + 0.000001) return { ok: false, reason: 'HEDGE_PAIR_COST_ABOVE_CAP' };

  const intent: TradeIntent = {
    id: makeId('hedge-intent'),
    strategy: HEDGE_STRATEGY,
    roundId: params.candidate.roundId,
    tokenId,
    label: missingLabel,
    side: 'BUY',
    orderType: 'LIMIT',
    limitPrice,
    shares: diff,
    reason: `Single-fill hedge for ${params.candidate.roundId}: buy missing ${missingLabel} with capped aggressive limit.`,
    status: 'generated',
    ttlSeconds: params.appConfig.singleFillHedgeWindowSeconds,
    createdAt: new Date(nowMs).toISOString(),
  };

  return {
    ok: true,
    intent,
    dominantLabel,
    dominantAvgPrice,
    missingShares: diff,
    bestAsk,
    expectedPnlPerShare: 1 - pairCost,
  };
}

export function buildSingleFillHedgeCheck(params: {
  candidate: SingleFillHedgeCandidate;
  orders: OrderRecord[];
  orderbooks: OrderBookQuote[];
  appConfig: AppConfig;
  runtimeStatus: 'running' | 'degraded';
  outcome?: { status: 'posted' | 'blocked' | 'failed' | 'monitor'; reason: string; recordedAt: string };
  hasRecentHedgeOrder?: boolean;
  hasRecentFailedHedgeOrder?: boolean;
  nowMs?: number;
}): StrategyCheck {
  const nowMs = params.nowMs ?? Date.now();
  const secondsToEnd = (new Date(params.candidate.endAt).getTime() - nowMs) / 1000;
  const buyFills = params.orders.flatMap((order) => matchingBuyFills(order));
  const yes = exposure(buyFills.filter((fill) => fill.label === 'YES'));
  const no = exposure(buyFills.filter((fill) => fill.label === 'NO'));
  const diff = roundShares(Math.abs(yes.shares - no.shares));
  const dominantLabel = yes.shares > no.shares ? 'YES' : no.shares > yes.shares ? 'NO' : null;
  const missingLabel = dominantLabel === 'YES' ? 'NO' : dominantLabel === 'NO' ? 'YES' : null;
  const missingTokenId = missingLabel === 'YES' ? params.candidate.yesTokenId : missingLabel === 'NO' ? params.candidate.noTokenId : '';
  const quote = missingTokenId ? params.orderbooks.find((item) => item.tokenId === missingTokenId) : undefined;
  const quoteGate = missingLabel ? buyQuoteGate(quote, params.appConfig.maxOrderbookAgeSeconds) : 'NO_MATERIAL_SINGLE_FILL_EXPOSURE';
  const plan = params.appConfig.singleFillHedgeEnabled && params.runtimeStatus !== 'degraded'
    ? planSingleFillHedge(params)
    : { ok: false as const, reason: params.appConfig.singleFillHedgeEnabled ? 'RUNTIME_DEGRADED' : 'HEDGE_DISABLED' };
  const outcome = params.outcome;
  const executionPassed = !outcome || outcome.status === 'posted' || outcome.status === 'monitor';
  const blockers = [
    ...(!params.appConfig.singleFillHedgeEnabled ? ['HEDGE_DISABLED'] : []),
    ...(params.runtimeStatus === 'degraded' ? ['RUNTIME_DEGRADED'] : []),
    ...(!plan.ok ? [plan.reason] : []),
    ...(params.hasRecentHedgeOrder ? ['RECENT_HEDGE_ORDER_EXISTS'] : []),
    ...(params.hasRecentFailedHedgeOrder ? ['RECENT_FAILED_HEDGE_ORDER'] : []),
    ...(outcome && !executionPassed ? [`EXECUTION_${outcome.status.toUpperCase()}`] : []),
  ];
  const status: StrategyCheck['status'] = outcome && (outcome.status === 'posted' || outcome.status === 'monitor')
    ? 'eligible'
    : plan.ok && !params.hasRecentHedgeOrder && !params.hasRecentFailedHedgeOrder
      ? 'eligible'
      : benignHedgeReason(!plan.ok ? plan.reason : undefined)
        ? 'not-applicable'
        : 'blocked';

  return {
    strategy: HEDGE_STRATEGY,
    title: 'BTC 5m Single-Fill Hedge',
    status,
    summary: 'When one side fills and the other does not, buy the missing side in the final round window using a capped aggressive limit order.',
    reason: hedgeCheckReason(plan, outcome, params.hasRecentHedgeOrder, params.hasRecentFailedHedgeOrder),
    blockers,
    amountUsd: plan.ok ? plan.intent.shares * plan.intent.limitPrice : undefined,
    limitPrice: plan.ok ? plan.intent.limitPrice : undefined,
    conditions: [
      condition('Hedge enabled', params.appConfig.singleFillHedgeEnabled, params.appConfig.singleFillHedgeEnabled ? 'enabled' : 'disabled'),
      condition('Runtime healthy', params.runtimeStatus !== 'degraded', params.runtimeStatus),
      condition('Final hedge window', secondsToEnd <= params.appConfig.singleFillHedgeWindowSeconds && secondsToEnd > params.appConfig.singleFillHedgeMinSecondsToEnd, `${secondsToEnd.toFixed(1)}s to end / window ${params.appConfig.singleFillHedgeWindowSeconds}s / min ${params.appConfig.singleFillHedgeMinSecondsToEnd}s`),
      condition('Single-fill exposure', diff >= params.appConfig.minOrderShares, `YES ${yes.shares.toFixed(2)} / NO ${no.shares.toFixed(2)} / diff ${diff.toFixed(2)} / min ${params.appConfig.minOrderShares.toFixed(2)}`),
      condition('Missing side identified', missingLabel != null, missingLabel ? `buy missing ${missingLabel}` : 'balanced or no fill'),
      condition('Missing-side book ready', quoteGate == null, quoteGate || quoteAgeLabel(quote)),
      condition('Hedge ask cap', quote?.bestAsk != null && quote.bestAsk <= params.appConfig.singleFillHedgeMaxPrice, quote?.bestAsk == null ? 'ask missing' : `${quote.bestAsk.toFixed(3)} / cap ${params.appConfig.singleFillHedgeMaxPrice.toFixed(3)}`),
      condition('Pair cost cap', plan.ok || plan.reason !== 'HEDGE_PAIR_COST_ABOVE_CAP', plan.ok ? `${(plan.dominantAvgPrice + plan.intent.limitPrice).toFixed(3)} / cap ${params.appConfig.singleFillHedgeMaxPairCost.toFixed(3)}` : `blocked: ${plan.reason}`),
      condition('Duplicate hedge guard', !params.hasRecentHedgeOrder, params.hasRecentHedgeOrder ? 'recent hedge order exists' : 'clear'),
      condition('Failed hedge cooldown', !params.hasRecentFailedHedgeOrder, params.hasRecentFailedHedgeOrder ? 'recent failed hedge order exists' : 'clear'),
      condition('Execution result', executionPassed, outcome ? `${outcome.status}: ${outcome.reason} @ ${outcome.recordedAt}` : 'no execution attempt yet'),
    ],
  };
}

async function executeOneHedge(params: ExecuteHedgesParams, candidate: SingleFillHedgeCandidate): Promise<string | null> {
  const orders = params.store.roundOrders(candidate.roundId);
  await reconcileCandidateFills(params, orders);
  const plan = planSingleFillHedge({ candidate, orders: params.store.roundOrders(candidate.roundId), orderbooks: params.orderbooks, appConfig: params.appConfig });

  if (!plan.ok) {
    params.store.recordSingleFillHedgeOutcome({
      roundId: candidate.roundId,
      status: 'blocked',
      reason: plan.reason,
      recordedAt: new Date().toISOString(),
    });
    if (!['NO_MATERIAL_SINGLE_FILL_EXPOSURE', 'NOT_IN_HEDGE_WINDOW', 'HEDGE_TOO_CLOSE_TO_EXPIRY'].includes(plan.reason)) {
      params.store.recordRuntimeLog({ level: 'warn', source: 'execution', message: `Single-fill hedge skipped for ${candidate.roundId}: ${plan.reason}.` });
    }
    return null;
  }

  const executionKey = [plan.intent.roundId, plan.intent.strategy, plan.intent.tokenId, plan.intent.side].join(':');
  if (params.store.hasRecentOrder(executionKey, params.appConfig.singleFillHedgeWindowSeconds * 1000)) {
    params.store.recordSingleFillHedgeOutcome({
      roundId: candidate.roundId,
      status: 'blocked',
      reason: 'RECENT_HEDGE_ORDER_EXISTS',
      recordedAt: new Date().toISOString(),
    });
    return null;
  }
  if (params.store.hasRecentFailedOrder(executionKey, FAILED_HEDGE_COOLDOWN_MS)) {
    params.store.recordSingleFillHedgeOutcome({
      roundId: candidate.roundId,
      status: 'blocked',
      reason: 'RECENT_FAILED_HEDGE_ORDER',
      recordedAt: new Date().toISOString(),
    });
    return null;
  }

  const cancelResult = await cancelMissingSideOrders(params, candidate.roundId, plan.intent.label);
  if (!cancelResult.ok) {
    params.store.recordSingleFillHedgeOutcome({
      roundId: candidate.roundId,
      status: 'failed',
      reason: cancelResult.reason,
      recordedAt: new Date().toISOString(),
    });
    params.store.recordIntents([plan.intent]);
    params.store.updateIntent(plan.intent.id, { status: 'failed', rejectionReason: cancelResult.reason });
    return `Single-fill hedge blocked for ${plan.intent.label}: ${cancelResult.reason}.`;
  }

  await reconcileCandidateFills(params, params.store.roundOrders(candidate.roundId));
  const finalPlan = planSingleFillHedge({ candidate, orders: params.store.roundOrders(candidate.roundId), orderbooks: params.orderbooks, appConfig: params.appConfig });
  if (!finalPlan.ok) {
    params.store.recordSingleFillHedgeOutcome({
      roundId: candidate.roundId,
      status: 'blocked',
      reason: finalPlan.reason,
      recordedAt: new Date().toISOString(),
    });
    return null;
  }
  params.store.recordIntents([finalPlan.intent]);

  if (params.store.getRuntime().executionMode !== 'live') {
    params.store.recordOrder(localHedgeOrder(candidate, finalPlan.intent, executionKey));
    params.store.updateIntent(finalPlan.intent.id, { status: 'executed' });
    params.store.recordSingleFillHedgeOutcome({
      roundId: candidate.roundId,
      status: 'monitor',
      reason: 'MONITOR_HEDGE_RECORDED',
      recordedAt: new Date().toISOString(),
    });
    return `Monitor mode recorded single-fill hedge for ${finalPlan.intent.label} @ ${finalPlan.intent.limitPrice.toFixed(3)}.`;
  }

  if (!params.appConfig.ownerPrivateKey?.trim()) {
    params.store.updateIntent(finalPlan.intent.id, { status: 'failed', rejectionReason: 'OWNER_PRIVATE_KEY_MISSING' });
    params.store.recordSingleFillHedgeOutcome({
      roundId: candidate.roundId,
      status: 'failed',
      reason: 'OWNER_PRIVATE_KEY_MISSING',
      recordedAt: new Date().toISOString(),
    });
    return 'Single-fill hedge blocked: OWNER_PRIVATE_KEY_MISSING.';
  }
  if (!params.appConfig.depositWallet?.trim()) {
    params.store.updateIntent(finalPlan.intent.id, { status: 'failed', rejectionReason: 'POLYMARKET_DEPOSIT_WALLET_MISSING' });
    params.store.recordSingleFillHedgeOutcome({
      roundId: candidate.roundId,
      status: 'failed',
      reason: 'POLYMARKET_DEPOSIT_WALLET_MISSING',
      recordedAt: new Date().toISOString(),
    });
    return 'Single-fill hedge blocked: POLYMARKET_DEPOSIT_WALLET_MISSING.';
  }

  try {
    const posted = await params.adapter.executeLimitIntent(finalPlan.intent, { execute: true });
    params.store.recordOrder({
      ...localHedgeOrder(candidate, finalPlan.intent, executionKey),
      id: `hedge-order-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      clobOrderId: posted.orderId,
      price: posted.price,
      size: posted.size,
      status: posted.ok ? 'posted' : 'failed',
      error: posted.error,
      rawResponse: posted.raw,
    });
    params.store.updateIntent(finalPlan.intent.id, { status: posted.ok ? 'executed' : 'failed', rejectionReason: posted.ok ? undefined : posted.error || 'CLOB_POST_FAILED' });
    params.store.recordSingleFillHedgeOutcome({
      roundId: candidate.roundId,
      status: posted.ok ? 'posted' : 'failed',
      reason: posted.ok ? 'HEDGE_POSTED' : posted.error || 'CLOB_POST_FAILED',
      recordedAt: new Date().toISOString(),
    });
    params.store.recordRuntimeLog({
      level: posted.ok ? 'warn' : 'error',
      source: 'execution',
      message: posted.ok
        ? `Single-fill hedge posted for ${finalPlan.intent.label} at ${posted.price.toFixed(3)}; expected locked PnL/share ${finalPlan.expectedPnlPerShare.toFixed(3)}.`
        : `Single-fill hedge failed for ${finalPlan.intent.label}: ${posted.error || 'CLOB_POST_FAILED'}.`,
      details: { roundId: candidate.roundId, intent: finalPlan.intent, dominantLabel: finalPlan.dominantLabel, dominantAvgPrice: finalPlan.dominantAvgPrice, bestAsk: finalPlan.bestAsk },
    });
    return posted.ok ? null : `Single-fill hedge failed for ${finalPlan.intent.label}: ${posted.error || 'CLOB_POST_FAILED'}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.store.recordOrder({ ...localHedgeOrder(candidate, finalPlan.intent, executionKey), status: 'failed', error: message, rawResponse: { error: message } });
    params.store.updateIntent(finalPlan.intent.id, { status: 'failed', rejectionReason: message });
    params.store.recordSingleFillHedgeOutcome({
      roundId: candidate.roundId,
      status: 'failed',
      reason: message,
      recordedAt: new Date().toISOString(),
    });
    params.store.recordRuntimeLog({ level: 'error', source: 'execution', message: `Single-fill hedge failed for ${finalPlan.intent.label}: ${message}.` });
    return `Single-fill hedge failed for ${finalPlan.intent.label}: ${message}.`;
  }
}

async function reconcileCandidateFills(params: ExecuteHedgesParams, orders: OrderRecord[]): Promise<void> {
  const targets: FillTarget[] = orders.map((order) => ({
    roundId: order.roundId,
    eventSlug: order.eventSlug,
    marketTitle: order.marketTitle,
    imageUrl: order.imageUrl,
    tokenId: order.tokenId,
    label: order.label,
    clobOrderId: order.clobOrderId,
  }));
  if (!targets.length) return;
  try {
    params.store.recordFills(await params.adapter.getRecentFillsForTargets(targets));
  } catch {
    // Existing order reconciliation will surface live API failures; a stale local
    // view should block naturally through duplicate/open-order checks.
  }
}

async function cancelMissingSideOrders(params: ExecuteHedgesParams, roundId: string, label: 'YES' | 'NO'): Promise<{ ok: true } | { ok: false; reason: string }> {
  const orders = params.store.roundOrders(roundId).filter((order) => (
    order.label === label
    && order.side === 'BUY'
    && (order.status === 'posted' || order.status === 'partially_filled')
    && order.clobOrderId
  ));
  const clobOrderIds = orders.map((order) => order.clobOrderId).filter((id): id is string => Boolean(id));
  if (!clobOrderIds.length) return { ok: true };
  if (params.store.getRuntime().executionMode !== 'live') {
    params.store.markOrdersCancelled(clobOrderIds);
    return { ok: true };
  }
  try {
    await params.adapter.cancelOrders(clobOrderIds);
    params.store.markOrdersCancelled(clobOrderIds);
    params.store.recordRuntimeLog({ level: 'warn', source: 'execution', message: `Cancelled ${clobOrderIds.length} stale ${label} order(s) before single-fill hedge.`, details: { roundId, clobOrderIds } });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `HEDGE_CANCEL_FAILED: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function matchingBuyFills(order: OrderRecord): Array<{ label: 'YES' | 'NO'; price: number; size: number }> {
  if (order.side !== 'BUY') return [];
  const filledSize = order.filledSize ?? 0;
  const avgFillPrice = order.avgFillPrice ?? order.price;
  if (filledSize <= 0 || !Number.isFinite(avgFillPrice)) return [];
  return [{ label: order.label, price: avgFillPrice, size: filledSize }];
}

function exposure(fills: Array<{ price: number; size: number }>): { shares: number; avgPrice: number } {
  const shares = sum(fills.map((fill) => fill.size));
  const cost = sum(fills.map((fill) => fill.price * fill.size));
  return { shares, avgPrice: shares > 0 ? cost / shares : 0 };
}

function buyQuoteGate(quote: OrderBookQuote | undefined, maxAgeSeconds: number): string | null {
  if (!quote) return 'HEDGE_ORDERBOOK_MISSING';
  if (quote.source === 'mock') return 'HEDGE_ORDERBOOK_NOT_LIVE';
  const ageMs = Date.now() - new Date(quote.updatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > maxAgeSeconds * 1000) return 'HEDGE_ORDERBOOK_STALE';
  if (quote.bestAsk == null) return 'BEST_ASK_MISSING';
  return null;
}

function condition(label: string, passed: boolean, actual: string) {
  return { label, passed, actual };
}

function benignHedgeReason(reason: string | undefined): boolean {
  return !reason || ['NO_MATERIAL_SINGLE_FILL_EXPOSURE', 'NOT_IN_HEDGE_WINDOW', 'HEDGE_TOO_CLOSE_TO_EXPIRY'].includes(reason);
}

function hedgeCheckReason(plan: HedgePlan, outcome: { status: 'posted' | 'blocked' | 'failed' | 'monitor'; reason: string; recordedAt: string } | undefined, hasRecentHedgeOrder?: boolean, hasRecentFailedHedgeOrder?: boolean): string {
  if (outcome) return `Latest hedge outcome is ${outcome.status}: ${outcome.reason}.`;
  if (hasRecentHedgeOrder) return 'Single-fill hedge already has a recent order for the missing side.';
  if (hasRecentFailedHedgeOrder) return 'Single-fill hedge is paused by the short failed-order cooldown.';
  if (!plan.ok) return `Single-fill hedge is not triggerable: ${plan.reason}.`;
  return `Single-fill hedge is triggerable: buy missing ${plan.intent.label} @ ${plan.intent.limitPrice.toFixed(3)}.`;
}

function quoteAgeLabel(quote: OrderBookQuote | undefined): string {
  if (!quote) return 'missing';
  const ageSeconds = (Date.now() - new Date(quote.updatedAt).getTime()) / 1000;
  const ask = quote.bestAsk == null ? ', ask missing' : `, ask ${quote.bestAsk.toFixed(3)}`;
  return `${quote.source}, ${Number.isFinite(ageSeconds) ? ageSeconds.toFixed(1) : 'unknown'}s old${ask}`;
}

function localHedgeOrder(candidate: SingleFillHedgeCandidate, intent: TradeIntent, executionKey: string): OrderRecord {
  return {
    id: `local-hedge-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    intentId: intent.id,
    executionKey,
    roundId: intent.roundId,
    eventSlug: candidate.eventSlug,
    marketTitle: candidate.marketTitle,
    imageUrl: candidate.imageUrl,
    tokenId: intent.tokenId,
    label: intent.label,
    side: intent.side,
    price: intent.limitPrice,
    size: roundShares(intent.shares),
    status: 'local',
    createdAt: new Date().toISOString(),
    rawResponse: { hedge: true },
  };
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundShares(value: number): number {
  return Math.floor(value * 100) / 100;
}

function roundPrice(value: number): number {
  return Math.round(value * 1000) / 1000;
}
