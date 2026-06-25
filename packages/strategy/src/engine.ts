import type { FillRecord, OrderBookQuote, OrderRecord, PositionSnapshot, StateSnapshot, StrategyCheck, StrategyCondition, TradeIntent } from '../../shared/src';

export type StrategyRiskConfig = {
  dryRun: boolean;
  dualLimitPrice: number;
  orderSharesPerSide: number;
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
  entryOrderTtlSeconds: number;
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
  const shares = roundShares(config.orderSharesPerSide);

  if (!inDecisionWindow) reasons.push('NOT_IN_DECISION_WINDOW');
  if (snapshot.regime !== 'CHOP') reasons.push(`REGIME_${snapshot.regime}`);
  if (!booksTradable) reasons.push('ORDERBOOK_NOT_TRADABLE');
  if (shares < config.minOrderShares) reasons.push('ORDER_SHARES_TOO_SMALL');
  if (config.dualLimitPrice <= 0 || config.dualLimitPrice >= 1) reasons.push('INVALID_DUAL_LIMIT_PRICE');

  const base = [
    makeIntent(snapshot, 'YES', snapshot.round.yesTokenId, shares, config),
    makeIntent(snapshot, 'NO', snapshot.round.noTokenId, shares, config),
  ];

  if (reasons.length) {
    rejected.push(...base.map((intent) => reject(intent, reasons.join(','))));
  } else {
    intents.push(...base);
  }

  const checks: StrategyCheck[] = [{
    strategy: 'BTC5M_DUAL_45',
    title: 'BTC 5m Dual 45c Pre-Round',
    status: reasons.length ? 'blocked' : 'eligible',
    summary: 'Place paired YES/NO limit buys before the round starts when BTC path structure is choppy.',
    reason: reasons.length ? reasons.join(', ') : 'Chop setup is eligible for paired pre-round liquidity.',
    blockers: reasons,
    amountUsd: shares * config.dualLimitPrice * 2,
    limitPrice: config.dualLimitPrice,
    conditions: [
      condition('Decision window', inDecisionWindow, `${snapshot.round.secondsToStart.toFixed(1)}s to start`),
      condition('Regime is CHOP', snapshot.regime === 'CHOP', snapshot.regime),
      condition('CHOP score threshold', snapshot.features.chopScore >= config.minChopScore, `${snapshot.features.chopScore.toFixed(1)} / ${config.minChopScore}`),
      condition('cross_120s threshold', snapshot.features.cross120s >= config.minCross120s, `${snapshot.features.cross120s} / ${config.minCross120s}`),
      condition('range_120s sufficient', snapshot.features.rangeBps120s >= config.minRangeBps120s, `${snapshot.features.rangeBps120s.toFixed(2)}bps / ${config.minRangeBps120s}`),
      condition('two-sided excursion', snapshot.features.minBiExcursionBps120s >= config.minBiExcursionBps120s, `${snapshot.features.minBiExcursionBps120s.toFixed(2)}bps / ${config.minBiExcursionBps120s}`),
      condition('drift ratio capped', snapshot.features.driftRatio120s <= config.maxDriftRatio120s, `${snapshot.features.driftRatio120s.toFixed(2)} / ${config.maxDriftRatio120s}`),
      condition('momentum ratio capped', snapshot.features.momentumRatio30s <= config.maxMomentumRatio30s, `${snapshot.features.momentumRatio30s.toFixed(2)} / ${config.maxMomentumRatio30s}`),
      condition('YES book tradable', buyQuoteReady(yesQuote, config), quoteAgeLabel(yesQuote)),
      condition('NO book tradable', buyQuoteReady(noQuote, config), quoteAgeLabel(noQuote)),
      condition('Shares per side', shares >= config.minOrderShares, `${shares.toFixed(2)} / min ${config.minOrderShares}`),
    ],
  }];

  return { intents, rejected, diagnostics, checks };
}

export function evaluateExit(snapshot: StateSnapshot, positions: PositionSnapshot[], config: StrategyRiskConfig, context: ExitEvaluationContext = {}): StrategyEvaluation {
  const intents: TradeIntent[] = [];
  const rejected: TradeIntent[] = [];
  const diagnostics: string[] = [];
  const activePositions = positions.filter((item) => item.shares > 0).length;

  const checks: StrategyCheck[] = [{
    strategy: 'BTC5M_SINGLE_EXIT',
    title: 'BTC 5m Settlement-Only After Start',
    status: 'not-applicable',
    summary: 'Sell-side exits are disabled; after round start the bot only reconciles fills and records settlement estimates.',
    reason: 'No add, exit, or rebalance actions are generated after round start.',
    blockers: [],
    conditions: [
      condition('Sell-side exits disabled', true, 'settlement-only'),
      condition('Active positions observed', true, `${activePositions}`),
      condition('Trade generation after start', true, 'disabled'),
    ],
  }];

  return { intents, rejected, diagnostics, checks };
}

function makeIntent(snapshot: StateSnapshot, label: 'YES' | 'NO', tokenId: string, shares: number, config: StrategyRiskConfig): TradeIntent {
  return {
    id: makeId('intent'),
    strategy: 'BTC5M_DUAL_45',
    roundId: snapshot.round.id,
    tokenId,
    label,
    side: 'BUY',
    orderType: 'LIMIT',
    limitPrice: config.dualLimitPrice,
    shares,
    reason: `Round ${snapshot.round.id} is classified as CHOP before start.`,
    status: 'generated',
    ttlSeconds: config.entryOrderTtlSeconds,
    createdAt: nowIso(),
  };
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

function condition(label: string, passed: boolean, actual: string): StrategyCondition {
  return { label, passed, actual };
}

function roundShares(value: number): number {
  return Math.floor(value * 100) / 100;
}
