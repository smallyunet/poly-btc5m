import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FillRecord, OrderRecord } from '../../../packages/shared/src';
import { InMemoryStore } from './store';

const PROFILE = 'btc-5m';

test('does not start single-fill cooldown before the round is final', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 4 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES'));
  store.recordFills([fill(roundId, 'YES')]);

  assert.equal(store.maybeStartSingleFillCooldown([fill(roundId, 'YES')], 4 * 60 * 60_000, nowMs, 'UPDOWN_DUAL_ENTRY', PROFILE), null);
  assert.equal(store.getActiveEntryCooldown(PROFILE, nowMs), null);
});

test('starts single-fill cooldown only after final round state is single-sided', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES'));
  store.recordFills([fill(roundId, 'YES')]);
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES')], 4 * 60 * 60_000, nowMs - 2 * 60_000, 'UPDOWN_DUAL_ENTRY', PROFILE);

  const cooldown = store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs, 'UPDOWN_DUAL_ENTRY', PROFILE);

  assert.equal(cooldown?.roundId, roundId);
  assert.equal(cooldown?.yesShares, 10);
  assert.equal(cooldown?.noShares, 0);
  assert.equal(store.getActiveEntryCooldown(PROFILE, nowMs)?.roundId, roundId);
});

test('does not start cooldown when the final round state is paired', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES'));
  store.recordOrder(order(roundId, 'NO'));
  store.recordFills([fill(roundId, 'YES'), fill(roundId, 'NO')]);
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES'), fill(roundId, 'NO')], 4 * 60 * 60_000, nowMs - 2 * 60_000, 'UPDOWN_DUAL_ENTRY', PROFILE);

  assert.equal(store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs, 'UPDOWN_DUAL_ENTRY', PROFILE), null);
  assert.equal(store.getActiveEntryCooldown(PROFILE, nowMs), null);
});

test('does not start cooldown when the single filled side was sold out', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES'));
  store.recordFills([fill(roundId, 'YES'), fill(roundId, 'YES', { side: 'SELL', price: 0.57 })]);
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES')], 4 * 60 * 60_000, nowMs - 2 * 60_000, 'UPDOWN_DUAL_ENTRY', PROFILE);

  assert.equal(store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs, 'UPDOWN_DUAL_ENTRY', PROFILE), null);
  assert.equal(store.getActiveEntryCooldown(PROFILE, nowMs), null);
});

test('clears an active cooldown if later fills make the round paired', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES'));
  store.recordOrder(order(roundId, 'NO'));
  store.recordFills([fill(roundId, 'YES')]);
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES')], 4 * 60 * 60_000, nowMs - 2 * 60_000, 'UPDOWN_DUAL_ENTRY', PROFILE);
  assert.equal(store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs, 'UPDOWN_DUAL_ENTRY', PROFILE)?.roundId, roundId);

  store.recordFills([fill(roundId, 'NO')]);

  assert.equal(store.getActiveEntryCooldown(PROFILE, nowMs), null);
});

test('uses shorter cooldown for price-capped single-fill hedge misses', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES'));
  store.recordFills([fill(roundId, 'YES')]);
  store.recordSingleFillHedgeOutcome({
    profileId: PROFILE,
    roundId,
    status: 'blocked',
    reason: 'HEDGE_ASK_ABOVE_CAP',
    recordedAt: new Date(nowMs).toISOString(),
  });
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES')], policy(), nowMs - 2 * 60_000, 'UPDOWN_DUAL_ENTRY', PROFILE);

  const cooldown = store.maybeStartSingleFillCooldown([], policy(), nowMs, 'UPDOWN_DUAL_ENTRY', PROFILE);

  assert.equal(cooldown?.category, 'price-cap');
  assert.equal(cooldown?.hedgeReason, 'HEDGE_ASK_ABOVE_CAP');
  assert.equal(new Date(cooldown?.expiresAt || 0).getTime(), finalReviewMs(roundId) + 60 * 60_000);
});

test('escalates cooldown for repeated final single fills inside the repeat window', () => {
  const nowMs = Date.now();
  const firstRoundId = roundIdFromStart(nowMs - 100 * 60_000);
  const secondRoundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(firstRoundId, 'YES'));
  store.recordFills([fill(firstRoundId, 'YES')]);
  store.maybeStartSingleFillCooldown([fill(firstRoundId, 'YES')], policy(), nowMs - 95 * 60_000, 'UPDOWN_DUAL_ENTRY', PROFILE);
  store.maybeStartSingleFillCooldown([], policy(), nowMs - 94 * 60_000, 'UPDOWN_DUAL_ENTRY', PROFILE);

  store.recordOrder(order(secondRoundId, 'NO'));
  store.recordFills([fill(secondRoundId, 'NO')]);
  store.maybeStartSingleFillCooldown([fill(secondRoundId, 'NO')], policy(), nowMs - 2 * 60_000, 'UPDOWN_DUAL_ENTRY', PROFILE);
  const cooldown = store.maybeStartSingleFillCooldown([], policy(), nowMs, 'UPDOWN_DUAL_ENTRY', PROFILE);

  assert.equal(cooldown?.roundId, secondRoundId);
  assert.equal(cooldown?.recentSingleFillCount, 2);
  assert.equal(new Date(cooldown?.expiresAt || 0).getTime(), finalReviewMs(secondRoundId) + 2 * 60 * 60_000);
});

test('does not queue stale pending cooldown after an active cooldown expires', () => {
  const nowMs = Date.now();
  const activeRoundId = roundIdFromStart(nowMs - 7 * 60_000);
  const staleRoundId = roundIdFromStart(nowMs - 66 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(activeRoundId, 'YES'));
  store.recordFills([fill(activeRoundId, 'YES')]);
  store.maybeStartSingleFillCooldown([fill(activeRoundId, 'YES')], policy(), nowMs - 2 * 60_000, 'UPDOWN_DUAL_ENTRY', PROFILE);
  const activeCooldown = store.maybeStartSingleFillCooldown([], policy(), nowMs, 'UPDOWN_DUAL_ENTRY', PROFILE);
  assert.equal(activeCooldown?.roundId, activeRoundId);

  store.recordOrder(order(staleRoundId, 'NO'));
  store.recordFills([fill(staleRoundId, 'NO')]);
  assert.equal(store.maybeStartSingleFillCooldown([fill(staleRoundId, 'NO')], policy(), nowMs, 'UPDOWN_DUAL_ENTRY', PROFILE), null);
  assert.equal(store.getActiveEntryCooldown(PROFILE, nowMs)?.roundId, activeRoundId);

  const afterActiveExpiresMs = finalReviewMs(activeRoundId) + policy().baseMs + 1;
  assert.equal(store.getActiveEntryCooldown(PROFILE, afterActiveExpiresMs), null);
  assert.equal(store.maybeStartSingleFillCooldown([], policy(), afterActiveExpiresMs, 'UPDOWN_DUAL_ENTRY', PROFILE), null);
});

test('does not scan historical fills without a pending final review', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES'));
  store.recordFills([fill(roundId, 'YES')]);

  assert.equal(store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs, 'UPDOWN_DUAL_ENTRY', PROFILE), null);
  assert.equal(store.getActiveEntryCooldown(PROFILE, nowMs), null);
});

test('does not start cooldown for external fills without tracked strategy orders', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordFills([fill(roundId, 'YES')]);

  assert.equal(store.maybeStartSingleFillCooldown([fill(roundId, 'YES')], 4 * 60 * 60_000, nowMs - 2 * 60_000, 'UPDOWN_DUAL_ENTRY', PROFILE), null);
  assert.equal(store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs, 'UPDOWN_DUAL_ENTRY', PROFILE), null);
  assert.equal(store.getActiveEntryCooldown(PROFILE, nowMs), null);
});

test('stops experimental profile after final experimental single fill', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false }, 'experiment_next_round');

  store.recordOrder(order(roundId, 'YES', {
    strategy: 'UPDOWN_NEXT_ROUND_50_49_STOP_ON_SINGLE',
    strategyProfile: 'experiment_next_round',
  }));
  store.recordFills([fill(roundId, 'YES')]);

  const stop = store.maybeStopExperimentOnSingle([], nowMs);

  assert.equal(stop?.roundId, roundId);
  assert.equal(stop?.reason, 'EXPERIMENT_SINGLE_FILL');
  assert.equal(store.getRuntime().experimentStoppedRoundId, roundId);
});

test('experimental single fill does not trigger classic cooldown', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false }, 'experiment_next_round');

  store.recordOrder(order(roundId, 'NO', {
    strategy: 'UPDOWN_NEXT_ROUND_50_49_STOP_ON_SINGLE',
    strategyProfile: 'experiment_next_round',
  }));
  const newFills = store.recordFills([fill(roundId, 'NO')]);

  assert.equal(store.maybeStartSingleFillCooldown(newFills, 4 * 60 * 60_000, nowMs, 'UPDOWN_DUAL_ENTRY', PROFILE), null);
  assert.equal(store.getActiveEntryCooldown('btc-5m', nowMs), null);
});

test('new experimental process ignores persisted experiment stop from before startup', () => {
  const nowMs = Date.now();
  const oldRoundId = roundIdFromStart(nowMs - 20 * 60_000);
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poly-btc5m-store-')), 'runtime-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 2,
    savedAt: new Date(nowMs - 10_000).toISOString(),
    intents: [],
    orders: [],
    fills: [],
    settlements: [],
    experimentStop: {
      profileId: PROFILE,
      roundId: oldRoundId,
      stoppedAt: new Date(nowMs - 10_000).toISOString(),
      reason: 'EXPERIMENT_SINGLE_FILL',
      yesShares: 5,
      noShares: 0,
    },
  }));

  const store = new InMemoryStore('live', 2_000, { persistencePath: statePath }, 'experiment_next_round');

  assert.equal(store.getExperimentStop(), null);
  assert.equal(store.getRuntime().experimentStoppedRoundId, undefined);
});

test('clears persisted profile cooldown records that were not created from final review', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poly-btc5m-store-')), 'runtime-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 2,
    savedAt: new Date(nowMs).toISOString(),
    intents: [],
    orders: [],
    fills: [fill(roundId, 'YES')],
    settlements: [],
    singleFillCooldowns: {
      [PROFILE]: {
        profileId: PROFILE,
      roundId,
      triggeredAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 4 * 60 * 60_000).toISOString(),
      yesShares: 10,
      noShares: 0,
      },
    },
  }));

  const store = new InMemoryStore('live', 2_000, { persistencePath: statePath });

  assert.equal(store.getActiveEntryCooldown(PROFILE, nowMs), null);
});

test('profile cooldown does not block another interval', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES', { profileId: 'btc-5m' }));
  store.recordFills([fill(roundId, 'YES', { profileId: 'btc-5m' })]);
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES', { profileId: 'btc-5m' })], 4 * 60 * 60_000, nowMs - 2 * 60_000, 'UPDOWN_DUAL_ENTRY', 'btc-5m');
  store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs, 'UPDOWN_DUAL_ENTRY', 'btc-5m');

  assert.equal(store.getActiveEntryCooldown('btc-5m', nowMs)?.roundId, roundId);
  assert.equal(store.getActiveEntryCooldown('btc-15m', nowMs), null);
});

test('profile duration controls final single-fill review timing', () => {
  const nowMs = Date.now();
  const roundId = `btc-updown-15m-${Math.floor((nowMs - 7 * 60_000) / 1000)}`;
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES', { profileId: 'btc-15m' }));
  store.recordFills([fill(roundId, 'YES', { profileId: 'btc-15m' })]);
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES', { profileId: 'btc-15m' })], 4 * 60 * 60_000, nowMs, 'UPDOWN_DUAL_ENTRY', 'btc-15m');

  assert.equal(store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs, 'UPDOWN_DUAL_ENTRY', 'btc-15m'), null);
  assert.equal(store.getActiveEntryCooldown('btc-15m', nowMs), null);
});

test('open-order reconciliation only cancels orders for the requested profile', () => {
  const nowMs = Date.now();
  const fiveMinuteRound = roundIdFromStart(nowMs - 7 * 60_000);
  const fifteenMinuteRound = `btc-updown-15m-${Math.floor((nowMs - 20 * 60_000) / 1000)}`;
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(fiveMinuteRound, 'YES', { profileId: 'btc-5m' }));
  store.recordOrder(order(fifteenMinuteRound, 'YES', { profileId: 'btc-15m', interval: '15m' }));

  assert.equal(store.reconcileOpenOrderStatuses('btc-5m', []), 1);
  store.recordFills([fill(fifteenMinuteRound, 'YES', { profileId: 'btc-15m', interval: '15m' })]);

  const orders = store.dashboardState().orders;
  const fiveMinuteOrder = orders.find((item) => item.profileId === 'btc-5m');
  const fifteenMinuteOrder = orders.find((item) => item.profileId === 'btc-15m');
  assert.equal(fiveMinuteOrder?.status, 'cancelled');
  assert.equal(fifteenMinuteOrder?.status, 'filled');
  assert.equal(fifteenMinuteOrder?.filledSize, 10);
});

function roundIdFromStart(startMs: number): string {
  return `btc-updown-5m-${Math.floor(startMs / 1000)}`;
}

function finalReviewMs(roundId: string): number {
  return Number(roundId.match(/btc-updown-5m-(\d+)$/)?.[1]) * 1000 + 6 * 60_000;
}

function policy() {
  return {
    baseMs: 30 * 60_000,
    priceCapMs: 60 * 60_000,
    executionMs: 2 * 60 * 60_000,
    repeatWindowMs: 2 * 60 * 60_000,
    secondMs: 2 * 60 * 60_000,
    thirdMs: 4 * 60 * 60_000,
  };
}

function fill(roundId: string, label: 'YES' | 'NO', patch: Partial<FillRecord> = {}): FillRecord {
  return {
    id: `fill-${roundId}-${label}-${patch.side ?? 'BUY'}`,
    profileId: PROFILE,
    asset: 'btc',
    interval: '5m',
    roundId,
    tokenId: `${label.toLowerCase()}-token`,
    label,
    side: 'BUY',
    price: 0.44,
    size: 10,
    matchedAt: new Date().toISOString(),
    ...patch,
  };
}

function order(roundId: string, label: 'YES' | 'NO', patch: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: `order-${roundId}-${label}`,
    profileId: PROFILE,
    asset: 'btc',
    interval: '5m',
    intentId: `intent-${roundId}-${label}`,
    roundId,
    eventSlug: roundId,
    tokenId: `${label.toLowerCase()}-token`,
    label,
    side: 'BUY',
    price: 0.44,
    size: 10,
    status: 'posted',
    createdAt: new Date().toISOString(),
    ...patch,
  };
}
