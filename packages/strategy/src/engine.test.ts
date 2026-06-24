import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyRegime, evaluateEntry, type StrategyRiskConfig } from './engine';
import type { StateSnapshot } from '../../shared/src';

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
      source: 'simulated',
      updatedAt: now,
      ...features,
    },
    regime: 'UNKNOWN',
    orderbooks: [
      quote('yes'),
      quote('no'),
    ],
    positions: [],
    diagnostics: [],
  };
}

function quote(tokenId: string): StateSnapshot['orderbooks'][number] {
  return {
    tokenId,
    bestBid: 0.44,
    bestAsk: 0.46,
    midpoint: 0.45,
    spread: 0.02,
    bidDepth: 100,
    askDepth: 100,
    imbalance: 0,
    updatedAt: new Date().toISOString(),
    source: 'clob',
  };
}
