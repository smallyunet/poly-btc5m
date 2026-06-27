import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyRegime, evaluateEntry, evaluateExit, type StrategyRiskConfig } from './engine';
import type { OrderRecord, StateSnapshot } from '../../shared/src';

const risk: StrategyRiskConfig = {
  dryRun: true,
  dualLimitPrice: 0.45,
  dynamicLimitEnabled: true,
  minDynamicLimitPrice: 0.42,
  maxDynamicLimitPrice: 0.46,
  maxPairCost: 0.92,
  orderSharesPerSide: 10,
  dynamicSharesEnabled: true,
  maxOrderSharesPerSide: 12.5,
  minOrderShares: 5,
  maxOrderbookAgeSeconds: 5,
  minCross120s: 2,
  maxAbsDrift120s: 40,
  maxAbsMomentum30s: 28,
  minChopScore: 70,
  minRangeBps120s: 3,
  minBiExcursionBps120s: 1,
  maxDriftRatio120s: 0.45,
  maxMomentumRatio30s: 0.55,
  maxEntryQueueImbalance: 5,
  minLiveChopScore: 80,
  minParticipationHoldersPerSide: 3,
  minParticipationTopHolderSharesPerSide: 300,
  minParticipationTopPositionPnl: 40,
  minParticipationPositionPnlSum: 100,
  maxParticipationHolderConcentration: 0.75,
  entryOrderTtlSeconds: 30,
};

test('classifies a high-cross low-drift path as CHOP', () => {
  const snapshot = baseSnapshot({
    cross120s: 3,
    centerCross120s: 3,
    volatility120s: 18,
    drift120s: 5,
    momentum30s: 3,
    rangeBps120s: 6,
    minBiExcursionBps120s: 2,
    centerMinBiExcursionBps120s: 2,
    driftRatio120s: 0.2,
    momentumRatio30s: 0.12,
    chopScore: 84,
    samples120s: 20,
  });
  assert.equal(classifyRegime(snapshot, risk), 'CHOP');
});

test('classifies center-balanced chop even when estimated strike is off-center', () => {
  const snapshot = baseSnapshot({
    cross120s: 0,
    centerPrice120s: 100_080,
    centerCross120s: 4,
    volatility120s: 18,
    drift120s: 4,
    momentum30s: 2,
    rangeBps120s: 6,
    minBiExcursionBps120s: 0,
    centerMinBiExcursionBps120s: 2.5,
    centerExcursionBalance120s: 0.9,
    driftRatio120s: 0.18,
    momentumRatio30s: 0.1,
    chopScore: 86,
    samples120s: 20,
  });

  assert.equal(classifyRegime(snapshot, risk), 'CHOP');
});

test('does not classify one-sided movement as chop just because range is large', () => {
  const snapshot = baseSnapshot({
    cross120s: 0,
    centerCross120s: 0,
    volatility120s: 30,
    drift120s: 65,
    momentum30s: 32,
    rangeBps120s: 12,
    minBiExcursionBps120s: 0,
    centerMinBiExcursionBps120s: 0.2,
    centerExcursionBalance120s: 0.05,
    driftRatio120s: 0.9,
    momentumRatio30s: 0.65,
    chopScore: 52,
    samples120s: 20,
  });

  assert.notEqual(classifyRegime(snapshot, risk), 'CHOP');
});

test('blocks entry outside the decision window', () => {
  const snapshot = { ...baseSnapshot(chopFeatures()), regime: 'CHOP' as const };
  snapshot.round.secondsToStart = 120;
  const result = evaluateEntry(snapshot, risk);
  assert.equal(result.intents.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].rejectionReason || '', /NOT_IN_DECISION_WINDOW/);
});

test('blocks entry during single-fill cooldown', () => {
  const snapshot = { ...baseSnapshot(chopFeatures()), regime: 'CHOP' as const };
  const result = evaluateEntry(snapshot, {
    ...risk,
    entryCooldownUntil: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
    entryCooldownReason: 'single fill on round-0',
  });
  assert.equal(result.intents.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].rejectionReason || '', /SINGLE_FILL_COOLDOWN/);
  assert.equal(result.checks[0].conditions.find((item) => item.label === 'Single-fill cooldown')?.passed, false);
});

test('ignores expired single-fill cooldown', () => {
  const snapshot = { ...baseSnapshot(chopFeatures()), regime: 'CHOP' as const };
  const result = evaluateEntry(snapshot, {
    ...risk,
    entryCooldownUntil: new Date(Date.now() - 1_000).toISOString(),
    entryCooldownReason: 'single fill on round-0',
  });
  assert.equal(result.intents.length, 2);
  assert.equal(result.checks[0].conditions.find((item) => item.label === 'Single-fill cooldown')?.passed, true);
});

test('generates paired YES and NO intents in a fresh CHOP decision window', () => {
  const snapshot = { ...baseSnapshot(chopFeatures()), regime: 'CHOP' as const };
  const result = evaluateEntry(snapshot, risk);
  assert.equal(result.intents.length, 2);
  assert.deepEqual(result.intents.map((intent) => intent.label).sort(), ['NO', 'YES']);
  assert.equal(result.intents[0].limitPrice, 0.44);
  assert.equal(result.intents[0].shares, 10);
  assert.equal(result.checks[0].limitPrice, 0.44);
});

test('caps high-score dynamic price before the final 15 seconds', () => {
  const snapshot = { ...baseSnapshot({ ...chopFeatures(), chopScore: 97 }), regime: 'CHOP' as const };
  snapshot.round.secondsToStart = 20;
  const result = evaluateEntry(snapshot, risk);
  assert.equal(result.intents.length, 2);
  assert.equal(result.intents[0].limitPrice, 0.45);
});

test('allows 46c only for very high score near round start', () => {
  const snapshot = { ...baseSnapshot({ ...chopFeatures(), chopScore: 97 }), regime: 'CHOP' as const };
  snapshot.round.secondsToStart = 10;
  const result = evaluateEntry(snapshot, risk);
  assert.equal(result.intents.length, 2);
  assert.equal(result.intents[0].limitPrice, 0.46);
  assert.equal(result.intents[0].shares, 12.5);
  assert.match(result.checks[0].conditions.find((item) => item.label === 'Pair cost cap')?.actual || '', /0\.920/);
  assert.match(result.checks[0].conditions.find((item) => item.label === 'Dynamic shares')?.actual || '', /12\.50 \/ base 10\.00/);
});

test('uses 42c for edge-score entries', () => {
  const snapshot = { ...baseSnapshot({ ...chopFeatures(), chopScore: 75 }), regime: 'CHOP' as const };
  const result = evaluateEntry(snapshot, risk);
  assert.equal(result.intents.length, 2);
  assert.equal(result.intents[0].limitPrice, 0.42);
  assert.equal(result.intents[0].shares, 5);
});

test('blocks edge-score entries in live mode', () => {
  const snapshot = { ...baseSnapshot({ ...chopFeatures(), chopScore: 75 }), regime: 'CHOP' as const };
  const result = evaluateEntry(snapshot, { ...risk, dryRun: false });
  assert.equal(result.intents.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].rejectionReason || '', /ENTRY_SCORE_TOO_LOW_FOR_LIVE/);
  assert.equal(result.checks[0].conditions.find((item) => item.label === 'Live score floor')?.passed, false);
});

test('keeps base shares for mid-score entries', () => {
  const snapshot = { ...baseSnapshot({ ...chopFeatures(), chopScore: 90 }), regime: 'CHOP' as const };
  const result = evaluateEntry(snapshot, risk);
  assert.equal(result.intents.length, 2);
  assert.equal(result.intents[0].limitPrice, 0.45);
  assert.equal(result.intents[0].shares, 10);
});

test('blocks entry only for extreme bid queue imbalance at the entry limit', () => {
  const snapshot = { ...baseSnapshot(chopFeatures()), regime: 'CHOP' as const };
  snapshot.orderbooks = [
    quote('yes', 0.44, [{ price: 0.45, size: 1000 }]),
    quote('no', 0.44, [{ price: 0.45, size: 100 }]),
  ];

  const result = evaluateEntry(snapshot, risk);

  assert.equal(result.intents.length, 0);
  assert.match(result.rejected[0].rejectionReason || '', /ENTRY_QUEUE_IMBALANCE/);
  assert.equal(result.checks[0].conditions.find((item) => item.label === 'Entry queue imbalance')?.passed, false);
});

test('does not block queue imbalance when level data is unavailable', () => {
  const snapshot = { ...baseSnapshot(chopFeatures()), regime: 'CHOP' as const };
  const result = evaluateEntry(snapshot, risk);

  assert.equal(result.intents.length, 2);
  assert.match(result.checks[0].conditions.find((item) => item.label === 'Entry queue imbalance')?.actual || '', /unknown/);
});

test('blocks entry when visible participation is weak', () => {
  const snapshot = { ...baseSnapshot(chopFeatures()), regime: 'CHOP' as const };
  snapshot.participation = {
    status: 'enabled',
    updatedAt: new Date().toISOString(),
    topHoldersPerSide: 8,
    maxPositionPnl: 12,
    totalTopHolderShares: 140,
    totalPositionPnl: 22,
    diagnostics: [],
    sides: [
      participationSide('YES', { holderCount: 2, topHolderShares: 80, topPositionPnl: 12, positionPnlSum: 14 }),
      participationSide('NO', { holderCount: 1, topHolderShares: 60, topPositionPnl: 8, positionPnlSum: 8 }),
    ],
  };

  const result = evaluateEntry(snapshot, risk);

  assert.equal(result.intents.length, 0);
  assert.match(result.rejected[0].rejectionReason || '', /PARTICIPATION_WEAK/);
  assert.equal(result.checks[0].conditions.find((item) => item.label === 'Holder count depth')?.passed, false);
});

test('does not block entry for weak sample participation pnl when holder depth passes', () => {
  const snapshot = { ...baseSnapshot(chopFeatures()), regime: 'CHOP' as const };
  snapshot.participation = {
    status: 'enabled',
    updatedAt: new Date().toISOString(),
    topHoldersPerSide: 8,
    maxPositionPnl: -5,
    totalTopHolderShares: 900,
    totalPositionPnl: -120,
    diagnostics: [],
    sides: [
      participationSide('YES', { holderCount: 4, topHolderShares: 450, largestHolderShareRatio: 0.4, topPositionPnl: -5, positionPnlSum: -70 }),
      participationSide('NO', { holderCount: 4, topHolderShares: 450, largestHolderShareRatio: 0.4, topPositionPnl: -10, positionPnlSum: -50 }),
    ],
  };

  const result = evaluateEntry(snapshot, risk);

  assert.equal(result.intents.length, 2);
  assert.equal(result.checks[0].conditions.find((item) => item.label === 'Top position PnL')?.passed, true);
  assert.match(result.checks[0].conditions.find((item) => item.label === 'Visible position PnL sum')?.actual || '', /not blocking/);
});

test('does not block entry when participation data is unavailable', () => {
  const snapshot = { ...baseSnapshot(chopFeatures()), regime: 'CHOP' as const };
  snapshot.participation = {
    status: 'unavailable',
    updatedAt: new Date().toISOString(),
    topHoldersPerSide: 8,
    maxPositionPnl: null,
    totalTopHolderShares: 0,
    totalPositionPnl: 0,
    diagnostics: ['temporary failure'],
    sides: [
      participationSide('YES'),
      participationSide('NO'),
    ],
  };

  const result = evaluateEntry(snapshot, risk);

  assert.equal(result.intents.length, 2);
  assert.equal(result.checks[0].conditions.find((item) => item.label === 'Participation data')?.passed, true);
});

test('caps dynamic shares at configured maximum', () => {
  const snapshot = { ...baseSnapshot({ ...chopFeatures(), chopScore: 98 }), regime: 'CHOP' as const };
  const result = evaluateEntry(snapshot, { ...risk, orderSharesPerSide: 20, maxOrderSharesPerSide: 22 });
  assert.equal(result.intents.length, 2);
  assert.equal(result.intents[0].shares, 22);
});

test('uses fixed shares when dynamic shares are disabled', () => {
  const snapshot = { ...baseSnapshot({ ...chopFeatures(), chopScore: 97 }), regime: 'CHOP' as const };
  const result = evaluateEntry(snapshot, { ...risk, dynamicSharesEnabled: false });
  assert.equal(result.intents.length, 2);
  assert.equal(result.intents[0].shares, 10);
});

test('does not generate sell intents for single-sided exposure', () => {
  const snapshot = exitSnapshot({ momentum30s: -30, drift120s: -50 });
  const result = evaluateExit(snapshot, [position('YES')], risk, {
    orders: [order('YES', secondsAgo(90))],
  });
  assert.equal(result.intents.length, 0);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.checks[0].status, 'not-applicable');
  assert.match(result.checks[0].reason, /No sell-side exit/);
});

test('does not sell only because the data source is unavailable', () => {
  const snapshot = { ...exitSnapshot({ momentum30s: 0, drift120s: 0, source: 'none' }), regime: 'LOW_ACTIVITY' as const };
  const result = evaluateExit(snapshot, [position('YES')], risk, {
    orders: [order('YES', secondsAgo(90))],
  });
  assert.equal(result.intents.length, 0);
});

function baseSnapshot(features: Partial<StateSnapshot['features']>): StateSnapshot {
  const now = new Date().toISOString();
  return {
    id: 'snapshot',
    capturedAt: now,
    round: {
      id: 'round-1',
      phase: 'decision',
      eventSlug: 'round-1',
      title: 'round',
      startAt: new Date(Date.now() + 20_000).toISOString(),
      endAt: new Date(Date.now() + 320_000).toISOString(),
      secondsToStart: 20,
      secondsToEnd: 320,
      strike: 100_000,
      strikeStatus: 'locked',
      yesTokenId: 'yes',
      noTokenId: 'no',
    },
    features: {
      price: 100_001,
      strike: 100_000,
      cross120s: 0,
      crossFrequency: 0,
      volatility120s: 0,
      drift120s: 0,
      momentum30s: 0,
      range120s: 0,
      range300s: 0,
      rangeBps120s: 0,
      rangeBps300s: 0,
      centerPrice120s: null,
      centerCross120s: 0,
      latestRangePosition120s: null,
      upExcursionBps120s: 0,
      downExcursionBps120s: 0,
      minBiExcursionBps120s: 0,
      excursionBalance120s: 0,
      centerUpExcursionBps120s: 0,
      centerDownExcursionBps120s: 0,
      centerMinBiExcursionBps120s: 0,
      centerExcursionBalance120s: 0,
      driftRatio120s: 1,
      momentumRatio30s: 1,
      rangePercentile120s: null,
      chopScore: 0,
      samples120s: 0,
      source: 'binance',
      updatedAt: now,
      ...features,
    },
    regime: 'UNKNOWN',
    orderbooks: [
      quote('yes'),
      quote('no'),
    ],
    positions: [],
    positionReadStatus: 'enabled',
    diagnostics: [],
  };
}

function chopFeatures(): Partial<StateSnapshot['features']> {
  return {
    cross120s: 3,
    volatility120s: 18,
    drift120s: 5,
    momentum30s: 3,
    range120s: 60,
    range300s: 90,
    rangeBps120s: 6,
    rangeBps300s: 9,
    centerPrice120s: 100_000,
    centerCross120s: 3,
    latestRangePosition120s: 0.55,
    upExcursionBps120s: 3,
    downExcursionBps120s: 2,
    minBiExcursionBps120s: 2,
    excursionBalance120s: 2 / 3,
    centerUpExcursionBps120s: 3,
    centerDownExcursionBps120s: 2,
    centerMinBiExcursionBps120s: 2,
    centerExcursionBalance120s: 2 / 3,
    driftRatio120s: 0.2,
    momentumRatio30s: 0.12,
    rangePercentile120s: 0.6,
    chopScore: 84,
    samples120s: 20,
  };
}

function exitSnapshot(features: Partial<StateSnapshot['features']>): StateSnapshot {
  return { ...baseSnapshot({ samples120s: 20, ...features }), regime: 'TREND' };
}

function participationSide(label: 'YES' | 'NO', values: Partial<NonNullable<StateSnapshot['participation']>['sides'][number]> = {}): NonNullable<StateSnapshot['participation']>['sides'][number] {
  return {
    label,
    holderCount: 8,
    topHolderShares: 500,
    largestHolderShares: 180,
    largestHolderShareRatio: 0.36,
    positionCount: 8,
    topPositionPnl: 60,
    positionPnlSum: 120,
    positionCurrentValueSum: 500,
    ...values,
  };
}

function position(label: 'YES' | 'NO'): StateSnapshot['positions'][number] {
  return {
    tokenId: label === 'YES' ? 'yes' : 'no',
    label,
    shares: 5,
    avgPrice: 0.45,
  };
}

function order(label: 'YES' | 'NO', createdAt: string): OrderRecord {
  return {
    id: `order-${label}`,
    intentId: `intent-${label}`,
    roundId: 'round-1',
    eventSlug: 'round-1',
    tokenId: label === 'YES' ? 'yes' : 'no',
    label,
    side: 'BUY',
    price: 0.45,
    size: 5,
    status: 'posted',
    createdAt,
  };
}

function secondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function quote(tokenId: string, bestBid = 0.44, bids?: StateSnapshot['orderbooks'][number]['bids']): StateSnapshot['orderbooks'][number] {
  return {
    tokenId,
    bestBid,
    bestAsk: 0.46,
    midpoint: 0.45,
    spread: 0.02,
    bidDepth: 100,
    askDepth: 100,
    imbalance: 0,
    updatedAt: new Date().toISOString(),
    source: 'ws',
    bids,
  };
}
