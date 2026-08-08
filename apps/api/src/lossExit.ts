import type { MarketAsset, MarketInterval, MarketProfileId, OrderBookQuote, OrderRecord, StrategyCheck, TradeIntent } from '../../../packages/shared/src';
import type { AppConfig } from './config';
import type { InMemoryStore, SingleFillProfitExitCandidate } from './store';

export type LossExitPlan =
  | { ok: true; intent: TradeIntent; exitLabel: 'YES' | 'NO'; missingLabel: 'YES' | 'NO'; avgPrice: number; shares: number; bestBid: number; expectedLossUsd: number }
  | { ok: false; reason: string };

const LOSS_EXIT_STRATEGY = 'UPDOWN_SINGLE_FILL_LOSS_EXIT';
const PROFIT_EXIT_STRATEGY = 'UPDOWN_SINGLE_FILL_PROFIT_EXIT';
const CLASSIC_ENTRY_STRATEGY = 'UPDOWN_DUAL_ENTRY';
const HEDGE_STRATEGY = 'UPDOWN_SINGLE_FILL_HEDGE';

export function planSingleFillLossExit(params: {
  candidate: SingleFillProfitExitCandidate;
  orders: OrderRecord[];
  orderbooks: OrderBookQuote[];
  appConfig: AppConfig;
  nowMs?: number;
  ignoreTimeWindow?: boolean;
}): LossExitPlan {
  const nowMs = params.nowMs ?? Date.now();
  const secondsToEnd = (new Date(params.candidate.endAt).getTime() - nowMs) / 1000;
  if (!params.appConfig.singleFillLossExitEnabled) return { ok: false, reason: 'LOSS_EXIT_DISABLED' };
  if (!params.ignoreTimeWindow && secondsToEnd > params.appConfig.singleFillLossExitMaxSecondsToEnd) return { ok: false, reason: 'NOT_IN_LOSS_EXIT_WINDOW' };
  if (secondsToEnd <= params.appConfig.singleFillLossExitMinSecondsToEnd) return { ok: false, reason: 'LOSS_EXIT_TOO_CLOSE_TO_EXPIRY' };

  const yes = netExposure(params.orders, 'YES');
  const no = netExposure(params.orders, 'NO');
  const yesBuyShares = buyShares(params.orders, 'YES');
  const noBuyShares = buyShares(params.orders, 'NO');
  const exitLabel = yes.netShares >= params.appConfig.minOrderShares && noBuyShares <= 0 ? 'YES'
    : no.netShares >= params.appConfig.minOrderShares && yesBuyShares <= 0 ? 'NO'
      : null;
  if (!exitLabel) return { ok: false, reason: 'NO_SINGLE_LOSS_EXIT_EXPOSURE' };

  const exit = exitLabel === 'YES' ? yes : no;
  const missingLabel = exitLabel === 'YES' ? 'NO' : 'YES';
  if (!Number.isFinite(exit.avgBuyPrice) || exit.avgBuyPrice <= 0) return { ok: false, reason: 'EXIT_AVG_PRICE_MISSING' };

  const tokenId = exitLabel === 'YES' ? params.candidate.yesTokenId : params.candidate.noTokenId;
  const quote = params.orderbooks.find((item) => item.tokenId === tokenId);
  const quoteGate = sellQuoteGate(quote, params.appConfig.singleFillLossExitMaxOrderbookAgeMs, nowMs);
  if (quoteGate) return { ok: false, reason: quoteGate };
  const bestBid = quote?.bestBid;
  if (bestBid == null) return { ok: false, reason: 'BEST_BID_MISSING' };
  if (bestBid < params.appConfig.singleFillLossExitMinBid) return { ok: false, reason: 'LOSS_EXIT_BID_BELOW_MIN' };

  const limitPrice = roundPrice(Math.max(params.appConfig.singleFillLossExitMinBid, bestBid - params.appConfig.singleFillLossExitPriceOffset));
  if (limitPrice >= exit.avgBuyPrice) return { ok: false, reason: 'LOSS_EXIT_NOT_LOSS' };
  const expectedLossUsd = (exit.avgBuyPrice - limitPrice) * exit.netShares;
  if (expectedLossUsd > params.appConfig.singleFillLossExitMaxLossUsd) return { ok: false, reason: 'LOSS_EXIT_LOSS_ABOVE_MAX' };

  const intent: TradeIntent = {
    id: makeId('loss-exit-intent'),
    profileId: params.candidate.profileId,
    asset: assetFromProfileId(params.candidate.profileId),
    interval: intervalFromProfileId(params.candidate.profileId),
    strategy: LOSS_EXIT_STRATEGY,
    roundId: params.candidate.roundId,
    tokenId,
    label: exitLabel,
    side: 'SELL',
    orderType: 'LIMIT',
    limitPrice,
    shares: roundShares(exit.netShares),
    reason: params.ignoreTimeWindow
      ? `Cross-profile single-fill risk loss exit for ${params.candidate.roundId}: sell filled ${exitLabel} side with capped FAK limit.`
      : `Single-fill loss exit for ${params.candidate.roundId}: sell filled ${exitLabel} side with capped FAK limit.`,
    status: 'generated',
    ttlSeconds: 5,
    createdAt: new Date(nowMs).toISOString(),
  };

  return { ok: true, intent, exitLabel, missingLabel, avgPrice: exit.avgBuyPrice, shares: exit.netShares, bestBid, expectedLossUsd };
}

export function buildSingleFillLossExitCheck(params: {
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
  const plan = planSingleFillLossExit({ candidate: params.candidate, orders: params.orders, orderbooks: params.orderbooks, appConfig: params.appConfig, nowMs });
  const yes = netExposure(params.orders, 'YES');
  const no = netExposure(params.orders, 'NO');
  const exitLabel = plan.ok ? plan.exitLabel : yes.netShares >= params.appConfig.minOrderShares ? 'YES' : no.netShares >= params.appConfig.minOrderShares ? 'NO' : null;
  const tokenId = exitLabel === 'YES' ? params.candidate.yesTokenId : exitLabel === 'NO' ? params.candidate.noTokenId : '';
  const quote = params.orderbooks.find((item) => item.tokenId === tokenId);
  const quoteGate = exitLabel ? sellQuoteGate(quote, params.appConfig.singleFillLossExitMaxOrderbookAgeMs, nowMs) : 'NO_SINGLE_LOSS_EXIT_EXPOSURE';
  const blocked = [
    ...(!params.appConfig.singleFillLossExitEnabled ? ['LOSS_EXIT_DISABLED'] : []),
    ...(params.runtimeStatus === 'degraded' ? ['RUNTIME_DEGRADED'] : []),
    ...(!plan.ok && !benignLossExitReason(plan.reason) ? [plan.reason] : []),
    ...(params.hasRecentExitOrder ? ['RECENT_LOSS_EXIT_ORDER_EXISTS'] : []),
    ...(params.hasRecentFailedExitOrder ? ['RECENT_FAILED_LOSS_EXIT_ORDER'] : []),
  ];
  const status: StrategyCheck['status'] = plan.ok && !params.hasRecentExitOrder && !params.hasRecentFailedExitOrder
    ? 'eligible'
    : blocked.length ? 'blocked' : 'not-applicable';

  return {
    profileId: params.candidate.profileId,
    asset: assetFromProfileId(params.candidate.profileId),
    interval: intervalFromProfileId(params.candidate.profileId),
    strategy: LOSS_EXIT_STRATEGY,
    title: 'Up/Down Single-Fill Loss Exit',
    status,
    summary: 'When a single filled side is losing but still inside the configured loss budget, cancel the missing-side buy order and sell the filled side with a capped FAK limit.',
    reason: plan.ok ? `Loss exit eligible for ${plan.exitLabel} @ ${plan.intent.limitPrice.toFixed(3)}.` : `Single-fill loss exit is not triggerable: ${plan.reason}.`,
    blockers: blocked,
    amountUsd: plan.ok ? plan.intent.shares * plan.intent.limitPrice : undefined,
    limitPrice: plan.ok ? plan.intent.limitPrice : undefined,
    conditions: [
      condition('Loss exit enabled', params.appConfig.singleFillLossExitEnabled, params.appConfig.singleFillLossExitEnabled ? 'enabled' : 'disabled'),
      condition('Runtime healthy', params.runtimeStatus !== 'degraded', params.runtimeStatus),
      condition('Loss exit window', secondsToEnd <= params.appConfig.singleFillLossExitMaxSecondsToEnd && secondsToEnd > params.appConfig.singleFillLossExitMinSecondsToEnd, `${secondsToEnd.toFixed(1)}s to end / max ${params.appConfig.singleFillLossExitMaxSecondsToEnd}s / min ${params.appConfig.singleFillLossExitMinSecondsToEnd}s`),
      condition('Single net exposure', exitLabel != null, `YES net ${yes.netShares.toFixed(2)} / NO net ${no.netShares.toFixed(2)}`),
      condition('Exit-side book ready', quoteGate == null, quoteGate || quoteAgeLabel(quote)),
      condition('Exit bid floor', quote?.bestBid != null && quote.bestBid >= params.appConfig.singleFillLossExitMinBid, quote?.bestBid == null ? 'bid missing' : `${quote.bestBid.toFixed(3)} / min ${params.appConfig.singleFillLossExitMinBid.toFixed(3)}`),
      condition('Loss budget', plan.ok || plan.reason !== 'LOSS_EXIT_LOSS_ABOVE_MAX', plan.ok ? `${plan.expectedLossUsd.toFixed(2)} / max ${params.appConfig.singleFillLossExitMaxLossUsd.toFixed(2)}` : `blocked: ${plan.reason}`),
      condition('Duplicate loss-exit guard', !params.hasRecentExitOrder, params.hasRecentExitOrder ? 'recent loss-exit order exists' : 'clear'),
      condition('Failed loss-exit cooldown', !params.hasRecentFailedExitOrder, params.hasRecentFailedExitOrder ? 'recent failed loss-exit order exists' : 'clear'),
    ],
  };
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

export function lossExitExposureOrders(orders: OrderRecord[]): OrderRecord[] {
  return orders.filter((order) => {
    if (order.strategy === LOSS_EXIT_STRATEGY || order.strategy === PROFIT_EXIT_STRATEGY || order.strategy === HEDGE_STRATEGY) return true;
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
  if (!quote) return 'LOSS_EXIT_ORDERBOOK_MISSING';
  if (quote.source === 'mock') return 'LOSS_EXIT_ORDERBOOK_NOT_LIVE';
  const ageMs = nowMs - new Date(quote.updatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) return 'LOSS_EXIT_ORDERBOOK_STALE';
  if (quote.bestBid == null) return 'BEST_BID_MISSING';
  return null;
}

function hasExistingLossExitOrder(orders: OrderRecord[], tokenId: string, side: TradeIntent['side']): boolean {
  return orders.some((order) => (
    order.strategy === LOSS_EXIT_STRATEGY
    && order.tokenId === tokenId
    && order.side === side
    && order.status !== 'failed'
    && order.status !== 'cancelled'
  ));
}

function hasExistingProfitExitOrder(orders: OrderRecord[]): boolean {
  return orders.some((order) => (
    order.strategy === PROFIT_EXIT_STRATEGY
    && order.side === 'SELL'
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

function benignLossExitReason(reason: string | undefined): boolean {
  return !reason || ['NO_SINGLE_LOSS_EXIT_EXPOSURE', 'NOT_IN_LOSS_EXIT_WINDOW', 'LOSS_EXIT_TOO_CLOSE_TO_EXPIRY', 'LOSS_EXIT_DISABLED', 'LOSS_EXIT_NOT_LOSS'].includes(reason);
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
