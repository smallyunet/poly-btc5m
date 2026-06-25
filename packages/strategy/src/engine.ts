import type { FillRecord, OrderBookQuote, OrderRecord, PositionSnapshot, StateSnapshot, StrategyCheck, StrategyCondition, TradeIntent } from '../../shared/src';

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
  minSingleExitBid: number;
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

export function evaluateExit(snapshot: StateSnapshot, positions: PositionSnapshot[], config: StrategyRiskConfig, context: ExitEvaluationContext = {}): StrategyEvaluation {
  const intents: TradeIntent[] = [];
  const rejected: TradeIntent[] = [];
  const diagnostics: string[] = [];
  const yes = positions.find((item) => item.label === 'YES' && item.shares > 0);
  const no = positions.find((item) => item.label === 'NO' && item.shares > 0);
  const paired = Math.min(yes?.shares || 0, no?.shares || 0);
  const unpaired = [yes, no]
    .filter((item): item is PositionSnapshot => Boolean(item && item.shares - paired > 0.01))
    .map((position) => ({ position, unpairedShares: roundShares(position.shares - paired) }));

  for (const { position, unpairedShares } of unpaired) {
    const quote = quoteFor(snapshot, position.tokenId);
    const ageSeconds = exposureAgeSeconds(snapshot, position, context);
    const inGrace = ageSeconds == null || ageSeconds < config.singleFillGraceSeconds;
    const oppositeOpen = hasOppositeOpenBuyOrder(snapshot, position, context.orders || []);
    const nearExpiry = snapshot.round.secondsToEnd <= 30;
    const unfavorableTrend = isUnfavorableTrend(snapshot, position);
    const shouldExit = !inGrace && (!oppositeOpen || nearExpiry) && (unfavorableTrend || nearExpiry);

    if (!shouldExit) continue;
    if (!quote?.bestBid) {
      rejected.push(reject(exitIntent(snapshot, position, 0, unpairedShares), 'NO_EXIT_BID'));
      continue;
    }
    if (quote.bestBid < config.minSingleExitBid) {
      rejected.push(reject(exitIntent(snapshot, position, quote.bestBid, unpairedShares), `EXIT_BID_TOO_LOW:${quote.bestBid.toFixed(3)}<${config.minSingleExitBid.toFixed(3)}`));
      continue;
    }
    intents.push(exitIntent(snapshot, position, quote.bestBid, unpairedShares));
  }

  const hasExitTrigger = unpaired.some(({ position }) => isUnfavorableTrend(snapshot, position) || snapshot.round.secondsToEnd <= 30);
  const hasOppositeOpen = unpaired.some(({ position }) => hasOppositeOpenBuyOrder(snapshot, position, context.orders || []));
  const youngestAge = minDefined(unpaired.map(({ position }) => exposureAgeSeconds(snapshot, position, context)));
  const gracePassed = youngestAge != null && youngestAge >= config.singleFillGraceSeconds;
  const bidBlocks = rejected.filter((item) => (item.rejectionReason || '').includes('EXIT_BID_TOO_LOW')).length;

  const checks: StrategyCheck[] = [{
    strategy: 'BTC5M_SINGLE_EXIT',
    title: 'BTC 5m Single-Side Exit',
    status: unpaired.length ? (intents.length ? 'eligible' : 'blocked') : 'not-applicable',
    summary: 'Conservatively exit unpaired exposure only after grace, missing opposite fill, and an adverse trend or expiry risk.',
    reason: unpaired.length ? (intents.length ? 'Single-sided exposure qualifies for risk exit.' : 'Single-sided exposure exists, but exit guardrails are still blocking.') : 'No single-sided exposure.',
    blockers: rejected.map((item) => item.rejectionReason || 'REJECTED'),
    conditions: [
      condition('Single-sided exposure exists', unpaired.length > 0, `${unpaired.length}`),
      condition('Grace window passed', gracePassed, youngestAge == null ? 'unknown' : `${youngestAge.toFixed(1)}s / ${config.singleFillGraceSeconds}s`),
      condition('Opposite open order absent', !hasOppositeOpen, hasOppositeOpen ? 'waiting for opposite fill' : 'none'),
      condition('Adverse trend or expiry risk', hasExitTrigger, snapshot.round.secondsToEnd <= 30 ? `${snapshot.round.secondsToEnd.toFixed(1)}s to end` : `${snapshot.regime}, momentum ${snapshot.features.momentum30s.toFixed(2)}, drift ${snapshot.features.drift120s.toFixed(2)}`),
      condition('Minimum exit bid', bidBlocks === 0, `${config.minSingleExitBid.toFixed(3)} min`),
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

function exitIntent(snapshot: StateSnapshot, position: PositionSnapshot, bid: number, shares: number): TradeIntent {
  return {
    id: makeId('exit'),
    strategy: 'BTC5M_SINGLE_EXIT',
    roundId: snapshot.round.id,
    tokenId: position.tokenId,
    label: position.label,
    side: 'SELL',
    orderType: 'LIMIT',
    limitPrice: bid,
    shares: roundShares(shares),
    reason: `Unpaired ${position.label} exposure met conservative exit guardrails.`,
    status: 'generated',
    ttlSeconds: 20,
    createdAt: nowIso(),
  };
}

function exposureAgeSeconds(snapshot: StateSnapshot, position: PositionSnapshot, context: ExitEvaluationContext): number | null {
  const timestamps = [
    ...(context.fills || [])
      .filter((fill) => fill.roundId === snapshot.round.id && fill.label === position.label && fill.side === 'BUY')
      .map((fill) => toTime(fill.matchedAt)),
    ...(context.orders || [])
      .filter((order) => order.roundId === snapshot.round.id && order.label === position.label && order.side === 'BUY')
      .map((order) => toTime(order.createdAt)),
  ].filter((time): time is number => time != null);
  if (!timestamps.length) return null;
  return Math.max(0, (Date.now() - Math.min(...timestamps)) / 1000);
}

function hasOppositeOpenBuyOrder(snapshot: StateSnapshot, position: PositionSnapshot, orders: OrderRecord[]): boolean {
  const opposite = position.label === 'YES' ? 'NO' : 'YES';
  return orders.some((order) => (
    order.roundId === snapshot.round.id
    && order.label === opposite
    && order.side === 'BUY'
    && (order.status === 'local' || order.status === 'posted' || order.status === 'partially_filled')
  ));
}

function isUnfavorableTrend(snapshot: StateSnapshot, position: PositionSnapshot): boolean {
  if (snapshot.regime !== 'TREND') return false;
  const momentum = snapshot.features.momentum30s;
  const drift = snapshot.features.drift120s;
  const bearish = momentum < -0.000001 || drift < -0.000001;
  const bullish = momentum > 0.000001 || drift > 0.000001;
  return position.label === 'YES' ? bearish : bullish;
}

function toTime(value: string | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function minDefined(values: Array<number | null>): number | null {
  const defined = values.filter((value): value is number => value != null);
  return defined.length ? Math.min(...defined) : null;
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
