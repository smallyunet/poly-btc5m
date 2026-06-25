import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyRegime, evaluateEntry, evaluateExit, type StrategyRiskConfig } from './engine';
import type { OrderRecord, StateSnapshot } from '../../shared/src';

const risk: StrategyRiskConfig = {
  dryRun: true,
  dualLimitPrice: 0.45,
  orderSharesPerSide: 10,
  minOrderShares: 5,
  maxOrderbookAgeSeconds: 5,
  minCross120s: 2,
  minVolatility120s: 12,
  maxAbsDrift120s: 40,
  maxAbsMomentum30s: 28,
  singleFillGraceSeconds: 75,
  minSingleExitBid: 0.3,
  entryOrderTtlSeconds: 30,
};

test('classifies a high-cross low-drift path as CHOP', () => {
  const snapshot = baseSnapshot({
    cross120s: 3,
    volatility120s: 18,
    drift120s: 5,
    momentum30s: 3,
    samples120s: 20,
  });
  assert.equal(classifyRegime(snapshot, risk), 'CHOP');
});

test('blocks entry outside the decision window', () => {
  const snapshot = { ...baseSnapshot({ cross120s: 3, volatility120s: 18, drift120s: 5, momentum30s: 3, samples120s: 20 }), regime: 'CHOP' as const };
  snapshot.round.secondsToStart = 120;
  const result = evaluateEntry(snapshot, risk);
  assert.equal(result.intents.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].rejectionReason || '', /NOT_IN_DECISION_WINDOW/);
});

test('generates paired YES and NO intents in a fresh CHOP decision window', () => {
  const snapshot = { ...baseSnapshot({ cross120s: 3, volatility120s: 18, drift120s: 5, momentum30s: 3, samples120s: 20 }), regime: 'CHOP' as const };
  const result = evaluateEntry(snapshot, risk);
  assert.equal(result.intents.length, 2);
  assert.deepEqual(result.intents.map((intent) => intent.label).sort(), ['NO', 'YES']);
  assert.equal(result.intents[0].limitPrice, 0.45);
  assert.equal(result.intents[0].shares, 10);
});

test('keeps single-sided exposure during the grace window', () => {
  const snapshot = exitSnapshot({ momentum30s: -30, drift120s: -50 });
  const result = evaluateExit(snapshot, [position('YES')], risk, {
    orders: [order('YES', new Date().toISOString())],
  });
  assert.equal(result.intents.length, 0);
});

test('does not sell single-sided YES exposure when trend is favorable', () => {
  const snapshot = exitSnapshot({ momentum30s: 30, drift120s: 50 });
  const result = evaluateExit(snapshot, [position('YES')], risk, {
    orders: [order('YES', secondsAgo(90))],
  });
  assert.equal(result.intents.length, 0);
});

test('sells single-sided YES exposure when trend is unfavorable after grace', () => {
  const snapshot = exitSnapshot({ momentum30s: -30, drift120s: -50 });
  const result = evaluateExit(snapshot, [position('YES')], risk, {
    orders: [order('YES', secondsAgo(90))],
  });
  assert.equal(result.intents.length, 1);
  assert.equal(result.intents[0].side, 'SELL');
  assert.equal(result.intents[0].shares, 5);
});

test('blocks single-sided exit when bid is below configured minimum', () => {
  const snapshot = exitSnapshot({ momentum30s: -30, drift120s: -50 });
  snapshot.orderbooks = [quote('yes', 0.12), quote('no')];
  const result = evaluateExit(snapshot, [position('YES')], risk, {
    orders: [order('YES', secondsAgo(90))],
  });
  assert.equal(result.intents.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].rejectionReason || '', /EXIT_BID_TOO_LOW/);
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
      samples120s: 0,
      source: 'rtds',
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

function exitSnapshot(features: Partial<StateSnapshot['features']>): StateSnapshot {
  return { ...baseSnapshot({ samples120s: 20, ...features }), regime: 'TREND' };
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

function quote(tokenId: string, bestBid = 0.44): StateSnapshot['orderbooks'][number] {
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
  };
}
