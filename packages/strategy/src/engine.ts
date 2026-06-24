import type { OrderBookQuote, PositionSnapshot, StateSnapshot, StrategyCheck, StrategyCondition, TradeIntent } from '../../shared/src';

export type StrategyRiskConfig = {
  dryRun: boolean;
  dualLimitPrice: number;
  orderSharesPerSide: number;
  minOrderShares: number;
  maxOrderbookAgeSeconds: number;
  minCross120s: number;
  minVolatility120s: number;
  maxAbsDrift120s: number;
  maxAbsMomentum30s: number;
  singleFillGraceSeconds: number;
  entryOrderTtlSeconds: number;
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
  if (f.cross120s >= config.minCross120s && f.volatility120s >= config.minVolatility120s && Math.abs(f.drift120s) <= config.maxAbsDrift120s && Math.abs(f.momentum30s) <= config.maxAbsMomentum30s) {
    return 'CHOP';
  }
  if (f.cross120s === 0 && (Math.abs(f.drift120s) > config.maxAbsDrift120s || Math.abs(f.momentum30s) > config.maxAbsMomentum30s)) {
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
  const booksFresh = freshQuote(yesQuote, config) && freshQuote(noQuote, config);
  const shares = roundShares(config.orderSharesPerSide);

  if (!inDecisionWindow) reasons.push('NOT_IN_DECISION_WINDOW');
  if (snapshot.regime !== 'CHOP') reasons.push(`REGIME_${snapshot.regime}`);
  if (!booksFresh) reasons.push('ORDERBOOK_STALE_OR_MISSING');
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
      condition('cross_120s threshold', snapshot.features.cross120s >= config.minCross120s, `${snapshot.features.cross120s} / ${config.minCross120s}`),
      condition('volatility_120s threshold', snapshot.features.volatility120s >= config.minVolatility120s, `${snapshot.features.volatility120s.toFixed(2)} / ${config.minVolatility120s}`),
      condition('drift_120s capped', Math.abs(snapshot.features.drift120s) <= config.maxAbsDrift120s, `${snapshot.features.drift120s.toFixed(2)} / ${config.maxAbsDrift120s}`),
      condition('momentum_30s capped', Math.abs(snapshot.features.momentum30s) <= config.maxAbsMomentum30s, `${snapshot.features.momentum30s.toFixed(2)} / ${config.maxAbsMomentum30s}`),
      condition('YES book fresh', freshQuote(yesQuote, config), quoteAgeLabel(yesQuote)),
      condition('NO book fresh', freshQuote(noQuote, config), quoteAgeLabel(noQuote)),
      condition('Shares per side', shares >= config.minOrderShares, `${shares.toFixed(2)} / min ${config.minOrderShares}`),
    ],
  }];

  return { intents, rejected, diagnostics, checks };
}

export function evaluateExit(snapshot: StateSnapshot, positions: PositionSnapshot[], config: StrategyRiskConfig): StrategyEvaluation {
  const intents: TradeIntent[] = [];
  const rejected: TradeIntent[] = [];
  const diagnostics: string[] = [];
  const yes = positions.find((item) => item.label === 'YES' && item.shares > 0);
  const no = positions.find((item) => item.label === 'NO' && item.shares > 0);
  const paired = Math.min(yes?.shares || 0, no?.shares || 0);
  const unpaired = [yes, no].filter((item): item is PositionSnapshot => Boolean(item && item.shares - paired > 0.01));
  const shouldExit = snapshot.regime === 'TREND' || snapshot.round.secondsToEnd <= 30 || snapshot.features.source === 'none';

  for (const position of unpaired) {
    const quote = quoteFor(snapshot, position.tokenId);
    if (!shouldExit) continue;
    if (!quote?.bestBid) {
      rejected.push(reject(exitIntent(snapshot, position, 0), 'NO_EXIT_BID'));
      continue;
    }
    intents.push(exitIntent(snapshot, position, quote.bestBid));
  }

  const checks: StrategyCheck[] = [{
    strategy: 'BTC5M_SINGLE_EXIT',
    title: 'BTC 5m Single-Side Exit',
    status: unpaired.length ? (intents.length ? 'eligible' : 'blocked') : 'not-applicable',
    summary: 'Exit single-sided fill when the chop thesis is invalidated.',
    reason: unpaired.length ? (shouldExit ? 'Single-sided exposure should be reduced.' : 'Single-sided exposure exists, but grace conditions still allow waiting.') : 'No single-sided exposure.',
    blockers: rejected.map((item) => item.rejectionReason || 'REJECTED'),
    conditions: [
      condition('Single-sided exposure exists', unpaired.length > 0, `${unpaired.length}`),
      condition('Exit trigger active', shouldExit, snapshot.regime === 'TREND' ? 'TREND' : `${snapshot.round.secondsToEnd.toFixed(1)}s to end`),
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

function exitIntent(snapshot: StateSnapshot, position: PositionSnapshot, bid: number): TradeIntent {
  return {
    id: makeId('exit'),
    strategy: 'BTC5M_SINGLE_EXIT',
    roundId: snapshot.round.id,
    tokenId: position.tokenId,
    label: position.label,
    side: 'SELL',
    orderType: 'LIMIT',
    limitPrice: bid,
    shares: Math.floor(position.shares * 100) / 100,
    reason: `Single-sided ${position.label} exposure is no longer protected by a CHOP setup.`,
    status: 'generated',
    ttlSeconds: 20,
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

function quoteAgeLabel(quote: OrderBookQuote | undefined): string {
  if (!quote) return 'missing';
  const ageSeconds = (Date.now() - new Date(quote.updatedAt).getTime()) / 1000;
  return `${quote.source}, ${Number.isFinite(ageSeconds) ? ageSeconds.toFixed(1) : 'unknown'}s old`;
}

function condition(label: string, passed: boolean, actual: string): StrategyCondition {
  return { label, passed, actual };
}

function roundShares(value: number): number {
  return Math.floor(value * 100) / 100;
}
