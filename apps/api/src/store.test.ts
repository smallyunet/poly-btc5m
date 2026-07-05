import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FillRecord, MarketProfile, OrderRecord } from '../../../packages/shared/src';
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

test('refreshes persisted active cooldown expiry from the current profile policy', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const reviewMs = finalReviewMs(roundId);
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poly-btc5m-store-')), 'runtime-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 2,
    savedAt: new Date(nowMs).toISOString(),
    intents: [],
    orders: [order(roundId, 'YES')],
    fills: [fill(roundId, 'YES')],
    settlements: [],
    singleFillCooldowns: {
      [PROFILE]: {
        profileId: PROFILE,
        roundId,
        sourceProfileId: PROFILE,
        sourceRoundId: roundId,
        triggeredAt: new Date(reviewMs).toISOString(),
        finalizedAt: new Date(reviewMs).toISOString(),
        expiresAt: new Date(reviewMs + 30 * 60_000).toISOString(),
        yesShares: 10,
        noShares: 0,
        category: 'unhedged',
        recentSingleFillCount: 1,
      },
    },
    singleFillCooldownEvents: [
      { profileId: PROFILE, sourceProfileId: PROFILE, roundId, sourceRoundId: roundId, triggeredAt: new Date(reviewMs).toISOString(), category: 'unhedged' },
    ],
  }));
  const store = new InMemoryStore('live', 2_000, { persistencePath: statePath }, 'classic', undefined, [
    marketProfile(PROFILE, { baseMs: 90 * 60_000 }),
  ]);

  assert.deepEqual(store.refreshActiveSingleFillCooldowns(nowMs), { refreshed: 1, cleared: 0 });
  const cooldown = store.getActiveEntryCooldown(PROFILE, nowMs);
  assert.equal(new Date(cooldown?.expiresAt || 0).getTime(), reviewMs + 90 * 60_000);
  assert.equal(cooldown?.recentSingleFillCount, 1);
});

test('refresh clears persisted active cooldown when the current profile policy has expired it', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const reviewMs = finalReviewMs(roundId);
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poly-btc5m-store-')), 'runtime-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 2,
    savedAt: new Date(nowMs).toISOString(),
    intents: [],
    orders: [order(roundId, 'YES')],
    fills: [fill(roundId, 'YES')],
    settlements: [],
    singleFillCooldowns: {
      [PROFILE]: {
        profileId: PROFILE,
        roundId,
        sourceProfileId: PROFILE,
        sourceRoundId: roundId,
        triggeredAt: new Date(reviewMs).toISOString(),
        finalizedAt: new Date(reviewMs).toISOString(),
        expiresAt: new Date(reviewMs + 30 * 60_000).toISOString(),
        yesShares: 10,
        noShares: 0,
        category: 'unhedged',
        recentSingleFillCount: 1,
      },
    },
  }));
  const store = new InMemoryStore('live', 2_000, { persistencePath: statePath }, 'classic', undefined, [
    marketProfile(PROFILE, { baseMs: 30_000 }),
  ]);

  assert.deepEqual(store.refreshActiveSingleFillCooldowns(nowMs), { refreshed: 0, cleared: 1 });
  assert.equal(store.getActiveEntryCooldown(PROFILE, nowMs), null);
});

test('single-fill cooldown is shared to sibling intervals and keeps each target policy length', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false }, 'classic', undefined, [
    marketProfile('btc-5m', { baseMs: 30 * 60_000 }),
    marketProfile('btc-15m', { baseMs: 90 * 60_000 }),
    marketProfile('btc-1h', { baseMs: 6 * 60 * 60_000 }),
  ]);

  store.recordOrder(order(roundId, 'YES', { profileId: 'btc-5m' }));
  store.recordFills([fill(roundId, 'YES', { profileId: 'btc-5m' })]);
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES', { profileId: 'btc-5m' })], 4 * 60 * 60_000, nowMs - 2 * 60_000, 'UPDOWN_DUAL_ENTRY', 'btc-5m');
  store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs, 'UPDOWN_DUAL_ENTRY', 'btc-5m');

  const fiveMinuteCooldown = store.getActiveEntryCooldown('btc-5m', nowMs);
  const fifteenMinuteCooldown = store.getActiveEntryCooldown('btc-15m', nowMs);
  const oneHourCooldown = store.getActiveEntryCooldown('btc-1h', nowMs);
  assert.equal(fiveMinuteCooldown?.roundId, roundId);
  assert.equal(fifteenMinuteCooldown?.sourceProfileId, 'btc-5m');
  assert.equal(fifteenMinuteCooldown?.sourceRoundId, roundId);
  assert.equal(new Date(fifteenMinuteCooldown?.expiresAt || 0).getTime(), finalReviewMs(roundId) + 90 * 60_000);
  assert.equal(new Date(oneHourCooldown?.expiresAt || 0).getTime(), finalReviewMs(roundId) + 6 * 60 * 60_000);
});

test('single-fill cooldown shared without configured profiles uses the source policy for every interval', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES', { profileId: 'btc-5m' }));
  store.recordFills([fill(roundId, 'YES', { profileId: 'btc-5m' })]);
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES', { profileId: 'btc-5m' })], policy(), nowMs - 2 * 60_000, 'UPDOWN_DUAL_ENTRY', 'btc-5m');
  store.maybeStartSingleFillCooldown([], policy(), nowMs, 'UPDOWN_DUAL_ENTRY', 'btc-5m');

  for (const profileId of ['btc-5m', 'btc-15m', 'btc-1h'] as const) {
    const cooldown = store.getActiveEntryCooldown(profileId, nowMs);
    assert.equal(cooldown?.sourceProfileId, 'btc-5m');
    assert.equal(new Date(cooldown?.expiresAt || 0).getTime(), finalReviewMs(roundId) + policy().baseMs);
  }
});

test('cross-profile single-fill risk candidates include active same-asset long intervals only', () => {
  const nowMs = Date.now();
  const fifteenMinuteRound = `btc-updown-15m-${Math.floor((nowMs - 5 * 60_000) / 1000)}`;
  const oneHourRound = `btc-updown-1h-${Math.floor((nowMs - 10 * 60_000) / 1000)}`;
  const ethRound = `eth-updown-15m-${Math.floor((nowMs - 5 * 60_000) / 1000)}`;
  const store = new InMemoryStore('live', 2_000, { persistencePath: false }, 'classic', undefined, [
    marketProfile('btc-5m'),
    marketProfile('btc-15m'),
    marketProfile('btc-1h'),
    { ...marketProfile('btc-15m'), id: 'eth-15m', asset: 'eth', assetSymbol: 'ETH', label: 'eth-15m', seriesSlug: 'eth-updown-15m', priceFeedSymbol: 'ETHUSDT' },
  ]);

  store.recordOrder(order(fifteenMinuteRound, 'YES', { profileId: 'btc-15m', interval: '15m' }));
  store.recordOrder(order(fifteenMinuteRound, 'NO', { profileId: 'btc-15m', interval: '15m' }));
  store.recordOrder(order(oneHourRound, 'YES', { profileId: 'btc-1h', interval: '1h' }));
  store.recordOrder(order(oneHourRound, 'NO', { profileId: 'btc-1h', interval: '1h' }));
  store.recordOrder(order(ethRound, 'YES', { profileId: 'eth-15m', asset: 'eth', interval: '15m' }));
  store.recordOrder(order(ethRound, 'NO', { profileId: 'eth-15m', asset: 'eth', interval: '15m' }));

  const candidates = store.crossProfileSingleFillRiskCandidates('btc-5m', nowMs);

  assert.deepEqual(candidates.map((candidate) => candidate.profileId).sort(), ['btc-15m', 'btc-1h']);
  assert.deepEqual(candidates.map((candidate) => candidate.roundId).sort(), [fifteenMinuteRound, oneHourRound].sort());
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

test('BTC 1h human-readable round slugs are eligible for settlement after expiry', () => {
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });
  const roundId = 'bitcoin-up-or-down-july-4-2026-11pm-et';

  store.recordFills([fill(roundId, 'YES', {
    profileId: 'btc-1h',
    interval: '1h',
    eventSlug: roundId,
    marketTitle: 'Bitcoin Up or Down - July 4, 11PM ET',
  })]);

  assert.deepEqual(store.roundsNeedingSettlement('btc-1h', 3600), [{
    roundId,
    eventSlug: roundId,
    marketTitle: 'Bitcoin Up or Down - July 4, 11PM ET',
    imageUrl: undefined,
    strike: undefined,
  }]);
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

function marketProfile(id: 'btc-5m' | 'btc-15m' | 'btc-1h', cooldownPatch: Partial<MarketProfile['cooldown']> = {}): MarketProfile {
  const interval = id.endsWith('15m') ? '15m' : id.endsWith('1h') ? '1h' : '5m';
  return {
    id,
    asset: 'btc',
    assetSymbol: 'BTC',
    interval,
    label: id,
    status: 'live',
    seriesSlug: `btc-updown-${interval}`,
    title: id,
    roundDurationSeconds: interval === '15m' ? 900 : interval === '1h' ? 3600 : 300,
    decisionLeadSeconds: 300,
    avoidExpirySeconds: 0,
    priceFeedSymbol: 'BTCUSDT',
    entry: { enabled: true, limitPrice: 0.45, sharesPerSide: 5, minSecondsToStart: 15, confirmTicks: 3 },
    profitExit: { enabled: true, minProfitRate: 0.05, minPnlUsd: 0.3, priceOffset: 0.01, maxOrderbookAgeMs: 5_000, minSecondsToEnd: 5, maxSecondsToEnd: 120 },
    hedge: { enabled: true, earlyWindowSeconds: 60, earlyMaxPairCost: 1.02, emergencyWindowSeconds: 15, emergencyMaxPrice: 0.75, emergencyMaxPairCost: 1.2, finalWindowSeconds: 30, minSecondsToEnd: 5, maxPrice: 0.65, priceOffset: 0.01, maxPairCost: 1.1 },
    cooldown: { ...policy(), ...cooldownPatch },
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
