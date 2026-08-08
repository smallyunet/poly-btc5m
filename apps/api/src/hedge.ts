import type { MarketAsset, MarketInterval, MarketProfileId, OrderBookQuote, OrderRecord, StrategyCheck, TradeIntent } from '../../../packages/shared/src';
import type { AppConfig } from './config';
import type { InMemoryStore, SingleFillHedgeCandidate } from './store';

export type HedgePlan =
  | { ok: true; intent: TradeIntent; hedgeMode: HedgeMode; pairCostCap: number; priceCap: number; dominantLabel: 'YES' | 'NO'; dominantAvgPrice: number; missingShares: number; bestAsk: number; expectedPnlPerShare: number }
  | { ok: false; reason: string };

type HedgeMode = 'early' | 'final' | 'emergency';

const HEDGE_STRATEGY = 'UPDOWN_SINGLE_FILL_HEDGE';
const CLASSIC_ENTRY_STRATEGY = 'UPDOWN_DUAL_ENTRY';
const PROFIT_EXIT_STRATEGY = 'UPDOWN_SINGLE_FILL_PROFIT_EXIT';
const LOSS_EXIT_STRATEGY = 'UPDOWN_SINGLE_FILL_LOSS_EXIT';
const MIN_MARKETABLE_BUY_NOTIONAL_USD = 1;

export function activeHedgeWindowSeconds(appConfig: AppConfig): number {
  return Math.max(
    appConfig.singleFillEarlyHedgeWindowSeconds,
    appConfig.singleFillHedgeWindowSeconds,
    appConfig.singleFillEmergencyHedgeWindowSeconds,
  );
}

function hedgeModeForSeconds(secondsToEnd: number, appConfig: AppConfig): HedgeMode {
  if (secondsToEnd <= appConfig.singleFillEmergencyHedgeWindowSeconds) return 'emergency';
  if (secondsToEnd <= appConfig.singleFillHedgeWindowSeconds) return 'final';
  return 'early';
}

function pairCostCapForMode(mode: HedgeMode, appConfig: AppConfig): number {
  if (mode === 'emergency') return appConfig.singleFillEmergencyHedgeMaxPairCost;
  if (mode === 'final') return appConfig.singleFillHedgeMaxPairCost;
  return appConfig.singleFillEarlyHedgeMaxPairCost;
}

function priceCapForMode(mode: HedgeMode, appConfig: AppConfig): number {
  return mode === 'emergency' ? appConfig.singleFillEmergencyHedgeMaxPrice : appConfig.singleFillHedgeMaxPrice;
}

function pairCostReasonForMode(mode: HedgeMode): string {
  if (mode === 'emergency') return 'EMERGENCY_HEDGE_PAIR_COST_ABOVE_CAP';
  if (mode === 'early') return 'EARLY_HEDGE_PAIR_COST_ABOVE_CAP';
  return 'HEDGE_PAIR_COST_ABOVE_CAP';
}

export function planSingleFillHedge(params: {
  candidate: SingleFillHedgeCandidate;
  orders: OrderRecord[];
  orderbooks: OrderBookQuote[];
  appConfig: AppConfig;
  nowMs?: number;
  ignoreTimeWindow?: boolean;
}): HedgePlan {
  const nowMs = params.nowMs ?? Date.now();
  const secondsToEnd = (new Date(params.candidate.endAt).getTime() - nowMs) / 1000;
  const hedgeWindowSeconds = activeHedgeWindowSeconds(params.appConfig);
  if (!params.ignoreTimeWindow && secondsToEnd > hedgeWindowSeconds) return { ok: false, reason: 'NOT_IN_HEDGE_WINDOW' };
  if (secondsToEnd <= params.appConfig.singleFillHedgeMinSecondsToEnd) return { ok: false, reason: 'HEDGE_TOO_CLOSE_TO_EXPIRY' };
  const hedgeMode = hedgeModeForSeconds(secondsToEnd, params.appConfig);
  const pairCostCap = pairCostCapForMode(hedgeMode, params.appConfig);
  const priceCap = priceCapForMode(hedgeMode, params.appConfig);

  const activeExit = activeSellOrder(params.orders);
  if (activeExit) return { ok: false, reason: 'PROFIT_EXIT_ORDER_ACTIVE' };

  const yes = netExposure(params.orders, 'YES');
  const no = netExposure(params.orders, 'NO');
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
  if (bestAsk > priceCap) return { ok: false, reason: 'HEDGE_ASK_ABOVE_CAP' };

  const limitPrice = roundPrice(Math.min(bestAsk + params.appConfig.singleFillHedgePriceOffset, priceCap));
  if (limitPrice * diff < MIN_MARKETABLE_BUY_NOTIONAL_USD) return { ok: false, reason: 'HEDGE_NOTIONAL_BELOW_MIN' };
  const pairCost = dominantAvgPrice + limitPrice;
  if (pairCost > pairCostCap + 0.000001) return { ok: false, reason: pairCostReasonForMode(hedgeMode) };

  const intent: TradeIntent = {
    id: makeId('hedge-intent'),
    profileId: params.candidate.profileId,
    asset: assetFromProfileId(params.candidate.profileId),
    interval: intervalFromProfileId(params.candidate.profileId),
    strategy: HEDGE_STRATEGY,
    roundId: params.candidate.roundId,
    tokenId,
    label: missingLabel,
    side: 'BUY',
    orderType: 'LIMIT',
    limitPrice,
    shares: diff,
    reason: params.ignoreTimeWindow
      ? `Cross-profile single-fill risk hedge for ${params.candidate.roundId}: buy missing ${missingLabel} with capped aggressive limit.`
      : `Single-fill ${hedgeMode} hedge for ${params.candidate.roundId}: buy missing ${missingLabel} with capped aggressive limit.`,
    status: 'generated',
    ttlSeconds: params.appConfig.singleFillHedgeWindowSeconds,
    createdAt: new Date(nowMs).toISOString(),
  };

  return {
    ok: true,
    intent,
    hedgeMode,
    pairCostCap,
    priceCap,
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
  outcome?: { status: 'posted' | 'blocked' | 'failed'; reason: string; recordedAt: string };
  hasRecentHedgeOrder?: boolean;
  hasRecentFailedHedgeOrder?: boolean;
  nowMs?: number;
}): StrategyCheck {
  const nowMs = params.nowMs ?? Date.now();
  const secondsToEnd = (new Date(params.candidate.endAt).getTime() - nowMs) / 1000;
  const yes = netExposure(params.orders, 'YES');
  const no = netExposure(params.orders, 'NO');
  const diff = roundShares(Math.abs(yes.shares - no.shares));
  const dominantLabel = yes.shares > no.shares ? 'YES' : no.shares > yes.shares ? 'NO' : null;
  const missingLabel = dominantLabel === 'YES' ? 'NO' : dominantLabel === 'NO' ? 'YES' : null;
  const missingTokenId = missingLabel === 'YES' ? params.candidate.yesTokenId : missingLabel === 'NO' ? params.candidate.noTokenId : '';
  const quote = missingTokenId ? params.orderbooks.find((item) => item.tokenId === missingTokenId) : undefined;
  const quoteGate = missingLabel ? buyQuoteGate(quote, params.appConfig.maxOrderbookAgeSeconds) : 'NO_MATERIAL_SINGLE_FILL_EXPOSURE';
  const currentHedgeMode = hedgeModeForSeconds(secondsToEnd, params.appConfig);
  const currentPriceCap = priceCapForMode(currentHedgeMode, params.appConfig);
  const plan = params.appConfig.singleFillHedgeEnabled && params.runtimeStatus !== 'degraded'
    ? planSingleFillHedge(params)
    : { ok: false as const, reason: params.appConfig.singleFillHedgeEnabled ? 'RUNTIME_DEGRADED' : 'HEDGE_DISABLED' };
  const outcome = params.outcome;
  const executionPassed = !outcome || outcome.status === 'posted';
  const blockers = [
    ...(!params.appConfig.singleFillHedgeEnabled ? ['HEDGE_DISABLED'] : []),
    ...(params.runtimeStatus === 'degraded' ? ['RUNTIME_DEGRADED'] : []),
    ...(!plan.ok ? [plan.reason] : []),
    ...(params.hasRecentHedgeOrder ? ['RECENT_HEDGE_ORDER_EXISTS'] : []),
    ...(params.hasRecentFailedHedgeOrder ? ['RECENT_FAILED_HEDGE_ORDER'] : []),
    ...(outcome && !executionPassed ? [`EXECUTION_${outcome.status.toUpperCase()}`] : []),
  ];
  const status: StrategyCheck['status'] = outcome && outcome.status === 'posted'
    ? 'eligible'
    : plan.ok && !params.hasRecentHedgeOrder && !params.hasRecentFailedHedgeOrder
      ? 'eligible'
      : benignHedgeReason(!plan.ok ? plan.reason : undefined)
        ? 'not-applicable'
        : 'blocked';

  return {
    profileId: params.candidate.profileId,
    asset: assetFromProfileId(params.candidate.profileId),
    interval: intervalFromProfileId(params.candidate.profileId),
    strategy: HEDGE_STRATEGY,
    title: 'Up/Down Single-Fill Hedge',
    status,
    summary: 'When one side fills and the other does not, buy the missing side in the final round window using a capped aggressive limit order.',
    reason: hedgeCheckReason(plan, outcome, params.hasRecentHedgeOrder, params.hasRecentFailedHedgeOrder),
    blockers,
    amountUsd: plan.ok ? plan.intent.shares * plan.intent.limitPrice : undefined,
    limitPrice: plan.ok ? plan.intent.limitPrice : undefined,
    conditions: [
      condition('Hedge enabled', params.appConfig.singleFillHedgeEnabled, params.appConfig.singleFillHedgeEnabled ? 'enabled' : 'disabled'),
      condition('Runtime healthy', params.runtimeStatus !== 'degraded', params.runtimeStatus),
      condition('Hedge window', secondsToEnd <= activeHedgeWindowSeconds(params.appConfig) && secondsToEnd > params.appConfig.singleFillHedgeMinSecondsToEnd, `${secondsToEnd.toFixed(1)}s to end / early ${params.appConfig.singleFillEarlyHedgeWindowSeconds}s / final ${params.appConfig.singleFillHedgeWindowSeconds}s / emergency ${params.appConfig.singleFillEmergencyHedgeWindowSeconds}s / min ${params.appConfig.singleFillHedgeMinSecondsToEnd}s`),
      condition('Single-fill exposure', diff >= params.appConfig.minOrderShares, `YES ${yes.shares.toFixed(2)} / NO ${no.shares.toFixed(2)} / diff ${diff.toFixed(2)} / min ${params.appConfig.minOrderShares.toFixed(2)}`),
      condition('Missing side identified', missingLabel != null, missingLabel ? `buy missing ${missingLabel}` : 'balanced or no fill'),
      condition('Missing-side book ready', quoteGate == null, quoteGate || quoteAgeLabel(quote)),
      condition('Hedge ask cap', quote?.bestAsk != null && quote.bestAsk <= currentPriceCap, quote?.bestAsk == null ? 'ask missing' : `${quote.bestAsk.toFixed(3)} / ${currentHedgeMode} cap ${currentPriceCap.toFixed(3)}`),
      condition('Hedge notional minimum', plan.ok || plan.reason !== 'HEDGE_NOTIONAL_BELOW_MIN', plan.ok ? `${(plan.intent.shares * plan.intent.limitPrice).toFixed(2)} / min ${MIN_MARKETABLE_BUY_NOTIONAL_USD.toFixed(2)}` : `blocked: ${plan.reason}`),
      condition('Pair cost cap', plan.ok || !['HEDGE_PAIR_COST_ABOVE_CAP', 'EARLY_HEDGE_PAIR_COST_ABOVE_CAP', 'EMERGENCY_HEDGE_PAIR_COST_ABOVE_CAP'].includes(plan.reason), plan.ok ? `${(plan.dominantAvgPrice + plan.intent.limitPrice).toFixed(3)} / ${plan.hedgeMode} cap ${plan.pairCostCap.toFixed(3)}` : `blocked: ${plan.reason}`),
      condition('Duplicate hedge guard', !params.hasRecentHedgeOrder, params.hasRecentHedgeOrder ? 'recent hedge order exists' : 'clear'),
      condition('Failed hedge cooldown', !params.hasRecentFailedHedgeOrder, params.hasRecentFailedHedgeOrder ? 'recent failed hedge order exists' : 'clear'),
      condition('Execution result', executionPassed, outcome ? `${outcome.status}: ${outcome.reason} @ ${outcome.recordedAt}` : 'no execution attempt yet'),
    ],
  };
}

function netExposure(orders: OrderRecord[], label: 'YES' | 'NO'): { shares: number; avgPrice: number } {
  const sideOrders = orders.filter((order) => order.label === label);
  const buyFilled = sum(sideOrders.filter((order) => order.side === 'BUY').map((order) => filledShares(order)));
  const sellFilled = sum(sideOrders.filter((order) => order.side === 'SELL').map((order) => filledShares(order)));
  const buyCost = sum(sideOrders.filter((order) => order.side === 'BUY').map((order) => filledShares(order) * fillPrice(order)));
  const sellProceeds = sum(sideOrders.filter((order) => order.side === 'SELL').map((order) => filledShares(order) * fillPrice(order)));
  const shares = roundShares(Math.max(0, buyFilled - sellFilled));
  const costBasis = Math.max(0, buyCost - sellProceeds);
  return { shares, avgPrice: shares > 0 ? costBasis / shares : 0 };
}

export function hedgeExposureOrders(orders: OrderRecord[]): OrderRecord[] {
  return orders.filter((order) => {
    if (order.strategy === HEDGE_STRATEGY || order.strategy === PROFIT_EXIT_STRATEGY || order.strategy === LOSS_EXIT_STRATEGY) return true;
    if (order.strategy === CLASSIC_ENTRY_STRATEGY) return true;
    return !order.strategy && order.strategyProfile !== 'experiment_next_round';
  });
}

function activeSellOrder(orders: OrderRecord[]): OrderRecord | undefined {
  return orders.find((order) => order.side === 'SELL' && (order.status === 'posted' || order.status === 'partially_filled' || order.status === 'local'));
}

function hasExistingHedgeOrder(orders: OrderRecord[], tokenId: string, side: TradeIntent['side']): boolean {
  return orders.some((order) => (
    order.strategy === HEDGE_STRATEGY
    && order.tokenId === tokenId
    && order.side === side
    && order.status !== 'failed'
    && order.status !== 'cancelled'
  ));
}

function filledShares(order: OrderRecord): number {
  if (order.filledSize != null) return order.filledSize;
  if (order.status === 'filled') return order.size;
  return 0;
}

function fillPrice(order: OrderRecord): number {
  return order.avgFillPrice ?? order.price;
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
  return !reason || ['NO_MATERIAL_SINGLE_FILL_EXPOSURE', 'NOT_IN_HEDGE_WINDOW', 'HEDGE_TOO_CLOSE_TO_EXPIRY', 'PROFIT_EXIT_ORDER_ACTIVE'].includes(reason);
}

function hedgeCheckReason(plan: HedgePlan, outcome: { status: 'posted' | 'blocked' | 'failed'; reason: string; recordedAt: string } | undefined, hasRecentHedgeOrder?: boolean, hasRecentFailedHedgeOrder?: boolean): string {
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

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function assetFromProfileId(profileId: MarketProfileId): MarketAsset {
  return profileId.split('-')[0] as MarketAsset;
}

function intervalFromProfileId(profileId: MarketProfileId): MarketInterval {
  return profileId.split('-').slice(1).join('-') as MarketInterval;
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
