import type { FillRecord, OrderBookQuote, OrderRecord, PositionSnapshot, StateSnapshot, StrategyCheck, StrategyCondition, TradeIntent } from '../../shared/src';

export type StrategyRiskConfig = {
  dryRun: boolean;
  dualLimitPrice: number;
  dynamicLimitEnabled: boolean;
  minDynamicLimitPrice: number;
  maxDynamicLimitPrice: number;
  maxPairCost: number;
  orderSharesPerSide: number;
  dynamicSharesEnabled: boolean;
  maxOrderSharesPerSide: number;
  minOrderShares: number;
  maxOrderbookAgeSeconds: number;
  minCross120s: number;
  maxAbsDrift120s: number;
  maxAbsMomentum30s: number;
  minChopScore: number;
  minRangeBps120s: number;
  minBiExcursionBps120s: number;
  maxDriftRatio120s: number;
  maxMomentumRatio30s: number;
  maxEntryQueueImbalance: number;
  minParticipationHoldersPerSide: number;
  minParticipationTopHolderSharesPerSide: number;
  minParticipationTopPositionPnl: number;
  minParticipationPositionPnlSum: number;
  maxParticipationHolderConcentration: number;
  entryOrderTtlSeconds: number;
  entryCooldownUntil?: string;
  entryCooldownReason?: string;
};

export type ExitEvaluationContext = {
  fills?: FillRecord[];
  orders?: OrderRecord[];
};

export type StrategyEvaluation = {
  intents: TradeIntent[];
  rejected: TradeIntent[];
  diagnostics: string[];
  checks: StrategyCheck[];
};

const nowIso = () => new Date().toISOString();
const makeId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

export function classifyRegime(snapshot: StateSnapshot, config: StrategyRiskConfig): StateSnapshot['regime'] {
  const f = snapshot.features;
  if (f.price == null || f.samples120s < 8) return 'UNKNOWN';
  const rangeReady = f.rangeBps120s >= config.minRangeBps120s;
  const twoSided = f.minBiExcursionBps120s >= config.minBiExcursionBps120s;
  const driftControlled = f.driftRatio120s <= config.maxDriftRatio120s;
  const momentumControlled = f.momentumRatio30s <= config.maxMomentumRatio30s;
  if (f.chopScore >= config.minChopScore && f.cross120s >= config.minCross120s && rangeReady && twoSided && driftControlled && momentumControlled) {
    return 'CHOP';
  }
  if (f.cross120s === 0 && (!driftControlled || !momentumControlled || Math.abs(f.drift120s) > config.maxAbsDrift120s || Math.abs(f.momentum30s) > config.maxAbsMomentum30s)) {
    return 'TREND';
  }
  return 'LOW_ACTIVITY';
}

export function evaluateEntry(snapshot: StateSnapshot, config: StrategyRiskConfig): StrategyEvaluation {
  const diagnostics: string[] = [];
  const intents: TradeIntent[] = [];
  const rejected: TradeIntent[] = [];
  const reasons: string[] = [];
  const inDecisionWindow = snapshot.round.secondsToStart <= config.entryOrderTtlSeconds && snapshot.round.secondsToStart >= 0;
  const yesQuote = quoteFor(snapshot, snapshot.round.yesTokenId);
  const noQuote = quoteFor(snapshot, snapshot.round.noTokenId);
  const booksTradable = buyQuoteReady(yesQuote, config) && buyQuoteReady(noQuote, config);
  const limitPrice = entryLimitPrice(snapshot, config);
  const shares = entryShares(snapshot, config);
  const pairCost = limitPrice * 2;
  const pairEdge = 1 - pairCost;
  const queue = entryQueueStats(yesQuote, noQuote, limitPrice);
  const participation = participationStats(snapshot, config);
  const cooldownUntilMs = config.entryCooldownUntil ? new Date(config.entryCooldownUntil).getTime() : 0;
  const cooldownActive = Number.isFinite(cooldownUntilMs) && cooldownUntilMs > Date.now();

  if (cooldownActive) reasons.push('SINGLE_FILL_COOLDOWN');
  if (!inDecisionWindow) reasons.push('NOT_IN_DECISION_WINDOW');
  if (snapshot.regime !== 'CHOP') reasons.push(`REGIME_${snapshot.regime}`);
  if (!booksTradable) reasons.push('ORDERBOOK_NOT_TRADABLE');
  if (shares < config.minOrderShares) reasons.push('ORDER_SHARES_TOO_SMALL');
  if (limitPrice <= 0 || limitPrice >= 1) reasons.push('INVALID_DUAL_LIMIT_PRICE');
  if (pairCost > config.maxPairCost + 0.000001) reasons.push('PAIR_COST_TOO_HIGH');
  if (queue.ratio != null && queue.ratio > config.maxEntryQueueImbalance) reasons.push('ENTRY_QUEUE_IMBALANCE');
  if (participation.blocked) reasons.push('PARTICIPATION_WEAK');

  const base = [
    makeIntent(snapshot, 'YES', snapshot.round.yesTokenId, shares, limitPrice, config),
    makeIntent(snapshot, 'NO', snapshot.round.noTokenId, shares, limitPrice, config),
  ];

  if (reasons.length) {
    rejected.push(...base.map((intent) => reject(intent, reasons.join(','))));
  } else {
    intents.push(...base);
  }

  const checks: StrategyCheck[] = [{
    strategy: 'BTC5M_DUAL_45',
    title: 'BTC 5m Dynamic Dual Pre-Round',
    status: reasons.length ? 'blocked' : 'eligible',
    summary: 'Place paired YES/NO limit buys before the round starts using score-based limit pricing when BTC path structure is choppy.',
    reason: reasons.length ? reasons.join(', ') : `Chop setup is eligible at ${limitPrice.toFixed(3)} per side.`,
    blockers: reasons,
    amountUsd: shares * pairCost,
    limitPrice,
    conditions: [
      condition('Decision window', inDecisionWindow, `${snapshot.round.secondsToStart.toFixed(1)}s to start`),
      condition('Single-fill cooldown', !cooldownActive, cooldownActive ? cooldownLabel(config.entryCooldownUntil, config.entryCooldownReason) : 'inactive'),
      condition('Regime is CHOP', snapshot.regime === 'CHOP', snapshot.regime),
      condition('CHOP score threshold', snapshot.features.chopScore >= config.minChopScore, `${snapshot.features.chopScore.toFixed(1)} / ${config.minChopScore}`),
      condition('cross_120s threshold', snapshot.features.cross120s >= config.minCross120s, `${snapshot.features.cross120s} / ${config.minCross120s}`),
      condition('range_120s sufficient', snapshot.features.rangeBps120s >= config.minRangeBps120s, `${snapshot.features.rangeBps120s.toFixed(2)}bps / ${config.minRangeBps120s}`),
      condition('two-sided excursion', snapshot.features.minBiExcursionBps120s >= config.minBiExcursionBps120s, `${snapshot.features.minBiExcursionBps120s.toFixed(2)}bps / ${config.minBiExcursionBps120s}`),
      condition('drift ratio capped', snapshot.features.driftRatio120s <= config.maxDriftRatio120s, `${snapshot.features.driftRatio120s.toFixed(2)} / ${config.maxDriftRatio120s}`),
      condition('momentum ratio capped', snapshot.features.momentumRatio30s <= config.maxMomentumRatio30s, `${snapshot.features.momentumRatio30s.toFixed(2)} / ${config.maxMomentumRatio30s}`),
      condition('YES book tradable', buyQuoteReady(yesQuote, config), quoteAgeLabel(yesQuote)),
      condition('NO book tradable', buyQuoteReady(noQuote, config), quoteAgeLabel(noQuote)),
      condition('Entry queue imbalance', queue.ratio == null || queue.ratio <= config.maxEntryQueueImbalance, queueLabel(queue, config.maxEntryQueueImbalance)),
      condition('Participation data', participation.dataPassed, participation.dataLabel),
      condition('Holder count depth', participation.holderCountPassed, participation.holderCountLabel),
      condition('Top holder shares', participation.topHolderSharesPassed, participation.topHolderSharesLabel),
      condition('Holder concentration', participation.concentrationPassed, participation.concentrationLabel),
      condition('Top position PnL', participation.topPositionPnlPassed, participation.topPositionPnlLabel),
      condition('Visible position PnL sum', participation.positionPnlSumPassed, participation.positionPnlSumLabel),
      condition('Dynamic limit price', limitPrice > 0 && limitPrice < 1, `${limitPrice.toFixed(3)} (${config.dynamicLimitEnabled ? 'score policy' : 'fixed'})`),
      condition('Pair cost cap', pairCost <= config.maxPairCost + 0.000001, `${pairCost.toFixed(3)} / ${config.maxPairCost.toFixed(3)}, edge ${pairEdge.toFixed(3)}`),
      condition('Dynamic shares', shares >= config.minOrderShares, `${shares.toFixed(2)} / base ${config.orderSharesPerSide.toFixed(2)} / max ${config.maxOrderSharesPerSide.toFixed(2)} (${config.dynamicSharesEnabled ? 'score policy' : 'fixed'})`),
      condition('Shares per side', shares >= config.minOrderShares, `${shares.toFixed(2)} / min ${config.minOrderShares}`),
    ],
  }];

  return { intents, rejected, diagnostics, checks };
}

type ParticipationStats = {
  blocked: boolean;
  dataPassed: boolean;
  dataLabel: string;
  holderCountPassed: boolean;
  holderCountLabel: string;
  topHolderSharesPassed: boolean;
  topHolderSharesLabel: string;
  concentrationPassed: boolean;
  concentrationLabel: string;
  topPositionPnlPassed: boolean;
  topPositionPnlLabel: string;
  positionPnlSumPassed: boolean;
  positionPnlSumLabel: string;
};

function participationStats(snapshot: StateSnapshot, config: StrategyRiskConfig): ParticipationStats {
  const data = snapshot.participation;
  if (!data || data.status !== 'enabled') {
    const status = data?.status || 'missing';
    return {
      blocked: false,
      dataPassed: true,
      dataLabel: `${status}; not blocking`,
      holderCountPassed: true,
      holderCountLabel: 'unknown; not blocking',
      topHolderSharesPassed: true,
      topHolderSharesLabel: 'unknown; not blocking',
      concentrationPassed: true,
      concentrationLabel: 'unknown; not blocking',
      topPositionPnlPassed: true,
      topPositionPnlLabel: 'unknown; not blocking',
      positionPnlSumPassed: true,
      positionPnlSumLabel: 'unknown; not blocking',
    };
  }

  const yes = data.sides.find((side) => side.label === 'YES');
  const no = data.sides.find((side) => side.label === 'NO');
  const holderCountPassed = Boolean(yes && no && yes.holderCount >= config.minParticipationHoldersPerSide && no.holderCount >= config.minParticipationHoldersPerSide);
  const topHolderSharesPassed = Boolean(yes && no && yes.topHolderShares >= config.minParticipationTopHolderSharesPerSide && no.topHolderShares >= config.minParticipationTopHolderSharesPerSide);
  const maxConcentration = Math.max(yes?.largestHolderShareRatio ?? 0, no?.largestHolderShareRatio ?? 0);
  const concentrationPassed = maxConcentration <= config.maxParticipationHolderConcentration;
  const topPositionPnl = data.maxPositionPnl;
  const topPositionPnlPassed = true;
  const positionPnlSumPassed = true;

  return {
    blocked: !(holderCountPassed && topHolderSharesPassed && concentrationPassed),
    dataPassed: true,
    dataLabel: `enabled, top ${data.topHoldersPerSide}/side @ ${ageLabel(data.updatedAt)}`,
    holderCountPassed,
    holderCountLabel: `YES ${yes?.holderCount ?? 0} / NO ${no?.holderCount ?? 0} / min ${config.minParticipationHoldersPerSide}`,
    topHolderSharesPassed,
    topHolderSharesLabel: `YES ${formatCompact(yes?.topHolderShares ?? 0)} / NO ${formatCompact(no?.topHolderShares ?? 0)} / min ${formatCompact(config.minParticipationTopHolderSharesPerSide)}`,
    concentrationPassed,
    concentrationLabel: `max ${formatRatio(maxConcentration)} / cap ${formatRatio(config.maxParticipationHolderConcentration)}`,
    topPositionPnlPassed,
    topPositionPnlLabel: `${moneyLabel(topPositionPnl)} sample; not blocking`,
    positionPnlSumPassed,
    positionPnlSumLabel: `${moneyLabel(data.totalPositionPnl)} sample; not blocking`,
  };
}

function cooldownLabel(until: string | undefined, reason: string | undefined): string {
  if (!until) return 'active';
  const remainingSeconds = Math.max(0, (new Date(until).getTime() - Date.now()) / 1000);
  const remainingHours = remainingSeconds / 3600;
  const remaining = remainingHours >= 1 ? `${remainingHours.toFixed(1)}h remaining` : `${Math.ceil(remainingSeconds / 60)}m remaining`;
  return reason ? `${remaining}, ${reason}` : remaining;
}

export function evaluateExit(snapshot: StateSnapshot, positions: PositionSnapshot[], config: StrategyRiskConfig, context: ExitEvaluationContext = {}): StrategyEvaluation {
  const intents: TradeIntent[] = [];
  const rejected: TradeIntent[] = [];
  const diagnostics: string[] = [];
  const activePositions = positions.filter((item) => item.shares > 0).length;

  const checks: StrategyCheck[] = [{
    strategy: 'BTC5M_SINGLE_EXIT',
    title: 'BTC 5m Post-Start Exit Policy',
    status: 'not-applicable',
    summary: 'Sell-side exits are disabled; regular post-start add/rebalance actions are disabled, except for the independent capped single-fill hedge rule.',
    reason: 'No sell-side exit or regular rebalance action is generated after round start.',
    blockers: [],
    conditions: [
      condition('Sell-side exits disabled', true, 'buy-only risk control'),
      condition('Active positions observed', true, `${activePositions}`),
      condition('Regular trade generation after start', true, 'disabled; hedge rule is separate'),
    ],
  }];

  return { intents, rejected, diagnostics, checks };
}

function makeIntent(snapshot: StateSnapshot, label: 'YES' | 'NO', tokenId: string, shares: number, limitPrice: number, config: StrategyRiskConfig): TradeIntent {
  return {
    id: makeId('intent'),
    strategy: 'BTC5M_DUAL_45',
    roundId: snapshot.round.id,
    tokenId,
    label,
    side: 'BUY',
    orderType: 'LIMIT',
    limitPrice,
    shares,
    reason: `Round ${snapshot.round.id} is classified as CHOP before start.`,
    status: 'generated',
    ttlSeconds: config.entryOrderTtlSeconds,
    createdAt: nowIso(),
  };
}

function entryLimitPrice(snapshot: StateSnapshot, config: StrategyRiskConfig): number {
  if (!config.dynamicLimitEnabled) return roundPrice(config.dualLimitPrice);
  const scorePrice = priceFromScore(snapshot.features.chopScore);
  const timeCap = snapshot.round.secondsToStart > 15 ? 0.45 : 0.46;
  const pairCostCap = config.maxPairCost / 2;
  const capped = Math.min(scorePrice, timeCap, config.maxDynamicLimitPrice, pairCostCap);
  return roundPrice(Math.max(config.minDynamicLimitPrice, capped));
}

function entryShares(snapshot: StateSnapshot, config: StrategyRiskConfig): number {
  if (!config.dynamicSharesEnabled) return roundShares(config.orderSharesPerSide);
  const scoreShares = config.orderSharesPerSide * sharesMultiplierFromScore(snapshot.features.chopScore);
  return roundShares(Math.min(scoreShares, config.maxOrderSharesPerSide));
}

function priceFromScore(score: number): number {
  if (score >= 95) return 0.46;
  if (score >= 90) return 0.45;
  if (score >= 80) return 0.44;
  return 0.42;
}

function sharesMultiplierFromScore(score: number): number {
  if (score >= 95) return 1.25;
  if (score >= 80) return 1;
  return 0.5;
}

function reject(base: TradeIntent, reason: string): TradeIntent {
  return { ...base, status: 'rejected', rejectionReason: reason };
}

function quoteFor(snapshot: StateSnapshot, tokenId: string): OrderBookQuote | undefined {
  return snapshot.orderbooks.find((quote) => quote.tokenId === tokenId);
}

function freshQuote(quote: OrderBookQuote | undefined, config: StrategyRiskConfig): boolean {
  if (!quote || quote.source === 'mock') return false;
  const ageMs = Date.now() - new Date(quote.updatedAt).getTime();
  return Number.isFinite(ageMs) && ageMs <= config.maxOrderbookAgeSeconds * 1000;
}

function buyQuoteReady(quote: OrderBookQuote | undefined, config: StrategyRiskConfig): boolean {
  return freshQuote(quote, config) && quote?.bestAsk != null;
}

function quoteAgeLabel(quote: OrderBookQuote | undefined): string {
  if (!quote) return 'missing';
  const ageSeconds = (Date.now() - new Date(quote.updatedAt).getTime()) / 1000;
  const ask = quote.bestAsk == null ? ', ask missing' : '';
  return `${quote.source}, ${Number.isFinite(ageSeconds) ? ageSeconds.toFixed(1) : 'unknown'}s old${ask}`;
}

function entryQueueStats(yesQuote: OrderBookQuote | undefined, noQuote: OrderBookQuote | undefined, limitPrice: number): { yesBidQueue: number | null; noBidQueue: number | null; ratio: number | null } {
  const yesBidQueue = bidQueueAtOrAbove(yesQuote, limitPrice);
  const noBidQueue = bidQueueAtOrAbove(noQuote, limitPrice);
  if (yesBidQueue == null || noBidQueue == null) return { yesBidQueue, noBidQueue, ratio: null };
  const smaller = Math.min(yesBidQueue, noBidQueue);
  const larger = Math.max(yesBidQueue, noBidQueue);
  if (smaller <= 0 && larger <= 0) return { yesBidQueue, noBidQueue, ratio: null };
  if (smaller <= 0) return { yesBidQueue, noBidQueue, ratio: Infinity };
  return { yesBidQueue, noBidQueue, ratio: larger / smaller };
}

function bidQueueAtOrAbove(quote: OrderBookQuote | undefined, limitPrice: number): number | null {
  if (!quote?.bids?.length) return null;
  return quote.bids
    .filter((level) => level.price >= limitPrice)
    .reduce((total, level) => total + level.size, 0);
}

function queueLabel(queue: { yesBidQueue: number | null; noBidQueue: number | null; ratio: number | null }, maxRatio: number): string {
  const yes = queue.yesBidQueue == null ? 'unknown' : queue.yesBidQueue.toFixed(2);
  const no = queue.noBidQueue == null ? 'unknown' : queue.noBidQueue.toFixed(2);
  const ratio = queue.ratio == null ? 'unknown' : Number.isFinite(queue.ratio) ? queue.ratio.toFixed(2) : 'infinite';
  return `YES ${yes} / NO ${no} / ratio ${ratio} / max ${maxRatio.toFixed(2)}`;
}

function ageLabel(value: string): string {
  const ageSeconds = (Date.now() - new Date(value).getTime()) / 1000;
  return Number.isFinite(ageSeconds) ? `${ageSeconds.toFixed(0)}s old` : 'unknown age';
}

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed(value % 1 === 0 ? 0 : 1);
}

function formatRatio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'n/a';
}

function moneyLabel(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'unknown';
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
}

function condition(label: string, passed: boolean, actual: string): StrategyCondition {
  return { label, passed, actual };
}

function roundShares(value: number): number {
  return Math.floor(value * 100) / 100;
}

function roundPrice(value: number): number {
  return Math.round(value * 1000) / 1000;
}
