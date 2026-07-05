import type { MarketAsset, MarketInterval, MarketProfileId, OrderBookQuote, OrderRecord, StrategyCheck, TradeIntent } from '../../../packages/shared/src';
import type { FillTarget, PolymarketAdapter } from '../../../packages/polymarket/src';
import type { AppConfig } from './config';
import type { InMemoryStore, SingleFillProfitExitCandidate } from './store';

export type ProfitExitPlan =
  | { ok: true; intent: TradeIntent; exitLabel: 'YES' | 'NO'; missingLabel: 'YES' | 'NO'; avgPrice: number; shares: number; bestBid: number; expectedPnlUsd: number }
  | { ok: false; reason: string };

type ExecuteProfitExitParams = {
  appConfig: AppConfig;
  adapter: PolymarketAdapter;
  store: InMemoryStore;
  candidates: SingleFillProfitExitCandidate[];
  orderbooks: OrderBookQuote[];
  ignoreTimeWindow?: boolean;
};

const PROFIT_EXIT_STRATEGY = 'UPDOWN_SINGLE_FILL_PROFIT_EXIT';
const CLASSIC_ENTRY_STRATEGY = 'UPDOWN_DUAL_ENTRY';
const HEDGE_STRATEGY = 'UPDOWN_SINGLE_FILL_HEDGE';
const FAILED_EXIT_COOLDOWN_MS = 60_000;
const FAK_NO_MATCH_RETRY_LIMIT = 2;
const FAK_NO_MATCH_RETRY_DELAY_MS = 750;

export async function executeSingleFillProfitExits(params: ExecuteProfitExitParams): Promise<string[]> {
  const diagnostics: string[] = [];
  if (!params.appConfig.singleFillProfitExitEnabled || !params.candidates.length) return diagnostics;
  if (params.store.getRuntime().status === 'degraded') return ['Single-fill profit exit skipped: runtime is degraded.'];

  for (const candidate of params.candidates) {
    const result = await executeOneProfitExit(params, candidate);
    if (result) diagnostics.push(result);
  }
  return diagnostics;
}

export function planSingleFillProfitExit(params: {
  candidate: SingleFillProfitExitCandidate;
  orders: OrderRecord[];
  orderbooks: OrderBookQuote[];
  appConfig: AppConfig;
  nowMs?: number;
  ignoreTimeWindow?: boolean;
}): ProfitExitPlan {
  const nowMs = params.nowMs ?? Date.now();
  const secondsToEnd = (new Date(params.candidate.endAt).getTime() - nowMs) / 1000;
  if (!params.appConfig.singleFillProfitExitEnabled) return { ok: false, reason: 'PROFIT_EXIT_DISABLED' };
  if (!params.ignoreTimeWindow && secondsToEnd > params.appConfig.singleFillProfitExitMaxSecondsToEnd) return { ok: false, reason: 'NOT_IN_PROFIT_EXIT_WINDOW' };
  if (secondsToEnd <= params.appConfig.singleFillProfitExitMinSecondsToEnd) return { ok: false, reason: 'PROFIT_EXIT_TOO_CLOSE_TO_EXPIRY' };

  const yes = netExposure(params.orders, 'YES');
  const no = netExposure(params.orders, 'NO');
  const yesBuyShares = buyShares(params.orders, 'YES');
  const noBuyShares = buyShares(params.orders, 'NO');
  const exitLabel = yes.netShares >= params.appConfig.minOrderShares && noBuyShares <= 0 ? 'YES'
    : no.netShares >= params.appConfig.minOrderShares && yesBuyShares <= 0 ? 'NO'
      : null;
  if (!exitLabel) return { ok: false, reason: 'NO_SINGLE_PROFIT_EXIT_EXPOSURE' };

  const exit = exitLabel === 'YES' ? yes : no;
  const missingLabel = exitLabel === 'YES' ? 'NO' : 'YES';
  if (!Number.isFinite(exit.avgBuyPrice) || exit.avgBuyPrice <= 0) return { ok: false, reason: 'EXIT_AVG_PRICE_MISSING' };

  const tokenId = exitLabel === 'YES' ? params.candidate.yesTokenId : params.candidate.noTokenId;
  const quote = params.orderbooks.find((item) => item.tokenId === tokenId);
  const quoteGate = sellQuoteGate(quote, params.appConfig.singleFillProfitExitMaxOrderbookAgeMs, nowMs);
  if (quoteGate) return { ok: false, reason: quoteGate };
  const bestBid = quote?.bestBid;
  if (bestBid == null) return { ok: false, reason: 'BEST_BID_MISSING' };

  const limitPrice = roundPrice(Math.max(params.appConfig.singleFillProfitExitMinPrice, bestBid - params.appConfig.singleFillProfitExitPriceOffset));
  const profitRate = exit.avgBuyPrice > 0 ? (limitPrice - exit.avgBuyPrice) / exit.avgBuyPrice : 0;
  if (profitRate < params.appConfig.singleFillProfitExitMinRate) return { ok: false, reason: 'EXIT_PROFIT_RATE_BELOW_MIN' };
  const expectedPnlUsd = (limitPrice - exit.avgBuyPrice) * exit.netShares;
  if (expectedPnlUsd < params.appConfig.singleFillProfitExitMinPnlUsd) return { ok: false, reason: 'EXIT_PNL_BELOW_MIN' };

  const intent: TradeIntent = {
    id: makeId('profit-exit-intent'),
    profileId: params.candidate.profileId,
    asset: assetFromProfileId(params.candidate.profileId),
    interval: intervalFromProfileId(params.candidate.profileId),
    strategy: PROFIT_EXIT_STRATEGY,
    roundId: params.candidate.roundId,
    tokenId,
    label: exitLabel,
    side: 'SELL',
    orderType: 'LIMIT',
    limitPrice,
    shares: roundShares(exit.netShares),
    reason: params.ignoreTimeWindow
      ? `Cross-profile single-fill risk exit for ${params.candidate.roundId}: sell filled ${exitLabel} side with capped FAK limit.`
      : `Single-fill profit exit for ${params.candidate.roundId}: sell filled ${exitLabel} side with capped FAK limit.`,
    status: 'generated',
    ttlSeconds: 5,
    createdAt: new Date(nowMs).toISOString(),
  };

  return { ok: true, intent, exitLabel, missingLabel, avgPrice: exit.avgBuyPrice, shares: exit.netShares, bestBid, expectedPnlUsd };
}

export function buildSingleFillProfitExitCheck(params: {
  candidate: SingleFillProfitExitCandidate;
  orders: OrderRecord[];
  orderbooks: OrderBookQuote[];
  appConfig: AppConfig;
  runtimeStatus: 'running' | 'degraded';
  hasRecentExitOrder: boolean;
  hasRecentFailedExitOrder: boolean;
}): StrategyCheck {
  const nowMs = Date.now();
  const secondsToEnd = (new Date(params.candidate.endAt).getTime() - nowMs) / 1000;
  const plan = planSingleFillProfitExit({ candidate: params.candidate, orders: params.orders, orderbooks: params.orderbooks, appConfig: params.appConfig, nowMs });
  const yes = netExposure(params.orders, 'YES');
  const no = netExposure(params.orders, 'NO');
  const exitLabel = plan.ok ? plan.exitLabel : yes.netShares >= params.appConfig.minOrderShares ? 'YES' : no.netShares >= params.appConfig.minOrderShares ? 'NO' : null;
  const tokenId = exitLabel === 'YES' ? params.candidate.yesTokenId : exitLabel === 'NO' ? params.candidate.noTokenId : '';
  const quote = params.orderbooks.find((item) => item.tokenId === tokenId);
  const quoteGate = exitLabel ? sellQuoteGate(quote, params.appConfig.singleFillProfitExitMaxOrderbookAgeMs, nowMs) : 'NO_SINGLE_PROFIT_EXIT_EXPOSURE';
  const blocked = [
    ...(!params.appConfig.singleFillProfitExitEnabled ? ['PROFIT_EXIT_DISABLED'] : []),
    ...(params.runtimeStatus === 'degraded' ? ['RUNTIME_DEGRADED'] : []),
    ...(!plan.ok && !benignProfitExitReason(plan.reason) ? [plan.reason] : []),
    ...(params.hasRecentExitOrder ? ['RECENT_PROFIT_EXIT_ORDER_EXISTS'] : []),
    ...(params.hasRecentFailedExitOrder ? ['RECENT_FAILED_PROFIT_EXIT_ORDER'] : []),
  ];
  const status: StrategyCheck['status'] = plan.ok && !params.hasRecentExitOrder && !params.hasRecentFailedExitOrder
    ? 'eligible'
    : blocked.length ? 'blocked' : 'not-applicable';

  return {
    profileId: params.candidate.profileId,
    asset: assetFromProfileId(params.candidate.profileId),
    interval: intervalFromProfileId(params.candidate.profileId),
    strategy: PROFIT_EXIT_STRATEGY,
    title: 'Up/Down Single-Fill Profit Exit',
    status,
    summary: 'When only one side has filled and its live bid is profitable, cancel the missing-side buy order and sell the filled side with a capped FAK limit.',
    reason: plan.ok ? `Profit exit eligible for ${plan.exitLabel} @ ${plan.intent.limitPrice.toFixed(3)}.` : `Single-fill profit exit is not triggerable: ${plan.reason}.`,
    blockers: blocked,
    amountUsd: plan.ok ? plan.intent.shares * plan.intent.limitPrice : undefined,
    limitPrice: plan.ok ? plan.intent.limitPrice : undefined,
    conditions: [
      condition('Profit exit enabled', params.appConfig.singleFillProfitExitEnabled, params.appConfig.singleFillProfitExitEnabled ? 'enabled' : 'disabled'),
      condition('Runtime healthy', params.runtimeStatus !== 'degraded', params.runtimeStatus),
      condition('Profit exit window', secondsToEnd <= params.appConfig.singleFillProfitExitMaxSecondsToEnd && secondsToEnd > params.appConfig.singleFillProfitExitMinSecondsToEnd, `${secondsToEnd.toFixed(1)}s to end / max ${params.appConfig.singleFillProfitExitMaxSecondsToEnd}s / min ${params.appConfig.singleFillProfitExitMinSecondsToEnd}s`),
      condition('Single net exposure', exitLabel != null, `YES net ${yes.netShares.toFixed(2)} / NO net ${no.netShares.toFixed(2)}`),
      condition('Exit-side book ready', quoteGate == null, quoteGate || quoteAgeLabel(quote)),
      condition('Exit bid floor', quote?.bestBid != null && quote.bestBid >= params.appConfig.singleFillProfitExitMinPrice, quote?.bestBid == null ? 'bid missing' : `${quote.bestBid.toFixed(3)} / min ${params.appConfig.singleFillProfitExitMinPrice.toFixed(3)}`),
      condition('Exit PnL floor', plan.ok || plan.reason !== 'EXIT_PNL_BELOW_MIN', plan.ok ? `${plan.expectedPnlUsd.toFixed(2)} / min ${params.appConfig.singleFillProfitExitMinPnlUsd.toFixed(2)}` : `blocked: ${plan.reason}`),
      condition('Duplicate exit guard', !params.hasRecentExitOrder, params.hasRecentExitOrder ? 'recent exit order exists' : 'clear'),
      condition('Failed exit cooldown', !params.hasRecentFailedExitOrder, params.hasRecentFailedExitOrder ? 'recent failed exit order exists' : 'clear'),
    ],
  };
}

async function executeOneProfitExit(params: ExecuteProfitExitParams, candidate: SingleFillProfitExitCandidate): Promise<string | null> {
  const entryOrders = params.store.roundOrders(candidate.profileId, candidate.roundId, CLASSIC_ENTRY_STRATEGY);
  await reconcileCandidateFills(params, entryOrders);
  const plan = planSingleFillProfitExit({ candidate, orders: profitExitExposureOrders(params.store.roundOrders(candidate.profileId, candidate.roundId)), orderbooks: params.orderbooks, appConfig: params.appConfig, ignoreTimeWindow: params.ignoreTimeWindow });
  if (!plan.ok) {
    if (!benignProfitExitReason(plan.reason)) {
      params.store.recordRuntimeLog({ level: 'warn', source: 'execution', message: `Single-fill profit exit skipped for ${candidate.roundId}: ${plan.reason}.` });
    }
    return null;
  }

  const executionKey = [plan.intent.profileId, plan.intent.roundId, plan.intent.strategy, plan.intent.tokenId, plan.intent.side].filter(Boolean).join(':');
  const currentRoundOrders = params.store.roundOrders(candidate.profileId, candidate.roundId);
  if (hasExistingProfitExitOrder(currentRoundOrders, plan.intent.tokenId, plan.intent.side)) return null;
  if (hasExistingHedgeOrder(currentRoundOrders)) return null;
  if (params.store.hasRecentOrder(executionKey, plan.intent.ttlSeconds * 1000)) return null;
  if (params.store.hasRecentFailedOrder(executionKey, FAILED_EXIT_COOLDOWN_MS)) return null;

  const cancelResult = await cancelMissingSideBuyOrders(params, candidate.profileId, candidate.roundId, plan.missingLabel);
  if (!cancelResult.ok) return `Single-fill profit exit blocked for ${plan.exitLabel}: ${cancelResult.reason}.`;

  await reconcileCandidateFills(params, entryOrders);
  const finalPlan = planSingleFillProfitExit({ candidate, orders: profitExitExposureOrders(params.store.roundOrders(candidate.profileId, candidate.roundId)), orderbooks: params.orderbooks, appConfig: params.appConfig, ignoreTimeWindow: params.ignoreTimeWindow });
  if (!finalPlan.ok) return null;
  const finalRoundOrders = params.store.roundOrders(candidate.profileId, candidate.roundId);
  if (hasExistingProfitExitOrder(finalRoundOrders, finalPlan.intent.tokenId, finalPlan.intent.side)) return null;
  if (hasExistingHedgeOrder(finalRoundOrders)) return null;
  params.store.recordIntents([finalPlan.intent]);

  if (params.store.getRuntime().executionMode !== 'live') {
    params.store.recordOrder(localExitOrder(candidate, finalPlan.intent, executionKey));
    params.store.updateIntent(finalPlan.intent.id, { status: 'executed' });
    return `Monitor mode recorded single-fill profit exit for ${finalPlan.intent.label} @ ${finalPlan.intent.limitPrice.toFixed(3)}.`;
  }

  if (!params.appConfig.ownerPrivateKey?.trim()) {
    params.store.updateIntent(finalPlan.intent.id, { status: 'failed', rejectionReason: 'OWNER_PRIVATE_KEY_MISSING' });
    return 'Single-fill profit exit blocked: OWNER_PRIVATE_KEY_MISSING.';
  }
  if (!params.appConfig.depositWallet?.trim()) {
    params.store.updateIntent(finalPlan.intent.id, { status: 'failed', rejectionReason: 'POLYMARKET_DEPOSIT_WALLET_MISSING' });
    return 'Single-fill profit exit blocked: POLYMARKET_DEPOSIT_WALLET_MISSING.';
  }

  try {
    const { posted, plan: postedPlan, attempts, retryReasons } = await postProfitExitWithFakNoMatchRetry(params, candidate, finalPlan);
    params.store.recordOrder({
      ...localExitOrder(candidate, postedPlan.intent, executionKey),
      id: `profit-exit-order-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      clobOrderId: posted.orderId,
      price: posted.price,
      size: posted.size,
      status: posted.ok ? 'posted' : 'failed',
      error: posted.error,
      rawResponse: retryReasons.length ? { posted: posted.raw, retryReasons, attempts } : posted.raw,
    });
    params.store.updateIntent(postedPlan.intent.id, { status: posted.ok ? 'executed' : 'failed', rejectionReason: posted.ok ? undefined : posted.error || 'CLOB_POST_FAILED' });
    params.store.recordRuntimeLog({
      level: posted.ok ? 'warn' : 'error',
      source: 'execution',
      message: posted.ok
        ? `Single-fill profit exit posted for ${postedPlan.intent.label} at ${posted.price.toFixed(3)} after ${attempts} attempt(s); expected PnL ${postedPlan.expectedPnlUsd.toFixed(2)}.`
        : `Single-fill profit exit failed for ${postedPlan.intent.label}: ${posted.error || 'CLOB_POST_FAILED'}.`,
      details: { roundId: candidate.roundId, intent: postedPlan.intent, avgPrice: postedPlan.avgPrice, bestBid: postedPlan.bestBid, expectedPnlUsd: postedPlan.expectedPnlUsd, attempts, retryReasons },
    });
    return posted.ok ? null : `Single-fill profit exit failed for ${postedPlan.intent.label}: ${posted.error || 'CLOB_POST_FAILED'}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.store.recordOrder({ ...localExitOrder(candidate, finalPlan.intent, executionKey), status: 'failed', error: message, rawResponse: { error: message } });
    params.store.updateIntent(finalPlan.intent.id, { status: 'failed', rejectionReason: message });
    params.store.recordRuntimeLog({ level: 'error', source: 'execution', message: `Single-fill profit exit failed for ${finalPlan.intent.label}: ${message}.` });
    return `Single-fill profit exit failed for ${finalPlan.intent.label}: ${message}.`;
  }
}

async function postProfitExitWithFakNoMatchRetry(
  params: ExecuteProfitExitParams,
  candidate: SingleFillProfitExitCandidate,
  initialPlan: Extract<ProfitExitPlan, { ok: true }>,
): Promise<{ posted: Awaited<ReturnType<PolymarketAdapter['executeLimitIntent']>>; plan: Extract<ProfitExitPlan, { ok: true }>; attempts: number; retryReasons: string[] }> {
  let plan = initialPlan;
  const retryReasons: string[] = [];
  for (let attempt = 1; attempt <= FAK_NO_MATCH_RETRY_LIMIT + 1; attempt += 1) {
    const availableShares = await params.adapter.getAvailableShares(plan.intent.tokenId);
    if (availableShares + 0.000001 < plan.intent.shares) {
      return {
        posted: { ok: false, price: plan.intent.limitPrice, size: roundShares(plan.intent.shares), error: `EXIT_SHARES_UNAVAILABLE (${availableShares.toFixed(2)} / ${plan.intent.shares.toFixed(2)})`, raw: { retryReasons } },
        plan,
        attempts: attempt,
        retryReasons,
      };
    }

    const posted = await params.adapter.executeLimitIntent(plan.intent, { execute: true, orderType: 'FAK' });
    if (posted.ok || !isFakNoMatchError(posted.error) || attempt > FAK_NO_MATCH_RETRY_LIMIT) {
      return { posted, plan, attempts: attempt, retryReasons };
    }

    retryReasons.push(posted.error || 'FAK_NO_MATCH');
    await delay(FAK_NO_MATCH_RETRY_DELAY_MS);
    await reconcileCandidateFills(params, params.store.roundOrders(candidate.profileId, candidate.roundId, CLASSIC_ENTRY_STRATEGY));
    const nextPlan = planSingleFillProfitExit({
      candidate,
      orders: profitExitExposureOrders(params.store.roundOrders(candidate.profileId, candidate.roundId)),
      orderbooks: params.orderbooks,
      appConfig: params.appConfig,
    });
    if (!nextPlan.ok) {
      return {
        posted: { ok: false, price: plan.intent.limitPrice, size: roundShares(plan.intent.shares), error: `FAK_RETRY_REPLAN_BLOCKED: ${nextPlan.reason}`, raw: { retryReasons } },
        plan,
        attempts: attempt,
        retryReasons,
      };
    }
    plan = { ...nextPlan, intent: { ...nextPlan.intent, id: initialPlan.intent.id } };
  }
  throw new Error('unreachable');
}

async function reconcileCandidateFills(params: ExecuteProfitExitParams, orders: OrderRecord[]): Promise<void> {
  const targets: FillTarget[] = orders.map((order) => ({
    profileId: order.profileId,
    asset: order.asset,
    interval: order.interval,
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
    // A stale local view should naturally block through missing shares or duplicate checks.
  }
}

async function cancelMissingSideBuyOrders(params: ExecuteProfitExitParams, profileId: SingleFillProfitExitCandidate['profileId'], roundId: string, label: 'YES' | 'NO'): Promise<{ ok: true } | { ok: false; reason: string }> {
  const orders = params.store.roundOrders(profileId, roundId, CLASSIC_ENTRY_STRATEGY).filter((order) => (
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
    params.store.recordRuntimeLog({ level: 'warn', source: 'execution', message: `Cancelled ${clobOrderIds.length} stale ${label} buy order(s) before profit exit.`, details: { roundId, clobOrderIds } });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `PROFIT_EXIT_CANCEL_FAILED: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function netExposure(orders: OrderRecord[], label: 'YES' | 'NO'): { netShares: number; avgBuyPrice: number } {
  const buys = orders.filter((order) => order.label === label && order.side === 'BUY');
  const sells = orders.filter((order) => order.label === label && order.side === 'SELL');
  const buyFilled = sum(buys.map((order) => filledShares(order)));
  const sellFilled = sum(sells.map((order) => filledShares(order)));
  const buyCost = sum(buys.map((order) => filledShares(order) * (order.avgFillPrice ?? order.price)));
  return {
    netShares: roundShares(Math.max(0, buyFilled - sellFilled)),
    avgBuyPrice: buyFilled > 0 ? buyCost / buyFilled : 0,
  };
}

export function profitExitExposureOrders(orders: OrderRecord[]): OrderRecord[] {
  return orders.filter((order) => {
    if (order.strategy === PROFIT_EXIT_STRATEGY || order.strategy === HEDGE_STRATEGY) return true;
    if (order.strategy === CLASSIC_ENTRY_STRATEGY) return true;
    return !order.strategy && order.strategyProfile !== 'experiment_next_round';
  });
}

function buyShares(orders: OrderRecord[], label: 'YES' | 'NO'): number {
  return sum(orders.filter((order) => order.label === label && order.side === 'BUY').map((order) => filledShares(order)));
}

function filledShares(order: OrderRecord): number {
  if (order.filledSize != null) return order.filledSize;
  if (order.status === 'filled') return order.size;
  return 0;
}

function sellQuoteGate(quote: OrderBookQuote | undefined, maxAgeMs: number, nowMs = Date.now()): string | null {
  if (!quote) return 'PROFIT_EXIT_ORDERBOOK_MISSING';
  if (quote.source === 'mock') return 'PROFIT_EXIT_ORDERBOOK_NOT_LIVE';
  const ageMs = nowMs - new Date(quote.updatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) return 'PROFIT_EXIT_ORDERBOOK_STALE';
  if (quote.bestBid == null) return 'BEST_BID_MISSING';
  return null;
}

function localExitOrder(candidate: SingleFillProfitExitCandidate, intent: TradeIntent, executionKey: string): OrderRecord {
  return {
    id: `profit-exit-local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    profileId: candidate.profileId,
    asset: intent.asset,
    interval: intent.interval,
    intentId: intent.id,
    strategy: intent.strategy,
    strategyProfile: 'classic',
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
    rawResponse: { monitor: true },
  };
}

function hasExistingProfitExitOrder(orders: OrderRecord[], tokenId: string, side: TradeIntent['side']): boolean {
  return orders.some((order) => (
    order.strategy === PROFIT_EXIT_STRATEGY
    && order.tokenId === tokenId
    && order.side === side
    && order.status !== 'failed'
    && order.status !== 'cancelled'
  ));
}

function hasExistingHedgeOrder(orders: OrderRecord[]): boolean {
  return orders.some((order) => (
    order.strategy === HEDGE_STRATEGY
    && order.side === 'BUY'
    && order.status !== 'failed'
    && order.status !== 'cancelled'
  ));
}

function condition(label: string, passed: boolean, actual: string) {
  return { label, passed, actual };
}

function assetFromProfileId(profileId: MarketProfileId): MarketAsset {
  return profileId.split('-')[0] as MarketAsset;
}

function intervalFromProfileId(profileId: MarketProfileId): MarketInterval {
  return profileId.split('-').slice(1).join('-') as MarketInterval;
}

function quoteAgeLabel(quote: OrderBookQuote | undefined): string {
  if (!quote) return 'missing';
  const ageMs = Date.now() - new Date(quote.updatedAt).getTime();
  return `${quote.source}, ${ageMs.toFixed(0)}ms old`;
}

function benignProfitExitReason(reason: string | undefined): boolean {
  return !reason || ['NO_SINGLE_PROFIT_EXIT_EXPOSURE', 'NOT_IN_PROFIT_EXIT_WINDOW', 'PROFIT_EXIT_TOO_CLOSE_TO_EXPIRY', 'PROFIT_EXIT_DISABLED'].includes(reason);
}

function isFakNoMatchError(error: string | undefined): boolean {
  const normalized = (error || '').toLowerCase();
  return normalized.includes('no orders found to match') && normalized.includes('fak');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function roundPrice(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundShares(value: number): number {
  return Math.floor(value * 100) / 100;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}
