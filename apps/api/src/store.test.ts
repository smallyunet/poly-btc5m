import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FillRecord, OrderRecord } from '../../../packages/shared/src';
import { InMemoryStore } from './store';

test('does not start single-fill cooldown before the round is final', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 4 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES'));
  store.recordFills([fill(roundId, 'YES')]);

  assert.equal(store.maybeStartSingleFillCooldown([fill(roundId, 'YES')], 4 * 60 * 60_000, nowMs), null);
  assert.equal(store.getActiveEntryCooldown(nowMs), null);
});

test('starts single-fill cooldown only after final round state is single-sided', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES'));
  store.recordFills([fill(roundId, 'YES')]);
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES')], 4 * 60 * 60_000, nowMs - 2 * 60_000);

  const cooldown = store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs);

  assert.equal(cooldown?.roundId, roundId);
  assert.equal(cooldown?.yesShares, 10);
  assert.equal(cooldown?.noShares, 0);
  assert.equal(store.getActiveEntryCooldown(nowMs)?.roundId, roundId);
});

test('does not start cooldown when the final round state is paired', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES'));
  store.recordOrder(order(roundId, 'NO'));
  store.recordFills([fill(roundId, 'YES'), fill(roundId, 'NO')]);
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES'), fill(roundId, 'NO')], 4 * 60 * 60_000, nowMs - 2 * 60_000);

  assert.equal(store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs), null);
  assert.equal(store.getActiveEntryCooldown(nowMs), null);
});

test('does not start cooldown when the single filled side was sold out', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES'));
  store.recordFills([fill(roundId, 'YES'), fill(roundId, 'YES', { side: 'SELL', price: 0.57 })]);
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES')], 4 * 60 * 60_000, nowMs - 2 * 60_000);

  assert.equal(store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs), null);
  assert.equal(store.getActiveEntryCooldown(nowMs), null);
});

test('clears an active cooldown if later fills make the round paired', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES'));
  store.recordOrder(order(roundId, 'NO'));
  store.recordFills([fill(roundId, 'YES')]);
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES')], 4 * 60 * 60_000, nowMs - 2 * 60_000);
  assert.equal(store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs)?.roundId, roundId);

  store.recordFills([fill(roundId, 'NO')]);

  assert.equal(store.getActiveEntryCooldown(nowMs), null);
});

test('uses shorter cooldown for price-capped single-fill hedge misses', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES'));
  store.recordFills([fill(roundId, 'YES')]);
  store.recordSingleFillHedgeOutcome({
    roundId,
    status: 'blocked',
    reason: 'HEDGE_ASK_ABOVE_CAP',
    recordedAt: new Date(nowMs).toISOString(),
  });
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES')], policy(), nowMs - 2 * 60_000);

  const cooldown = store.maybeStartSingleFillCooldown([], policy(), nowMs);

  assert.equal(cooldown?.category, 'price-cap');
  assert.equal(cooldown?.hedgeReason, 'HEDGE_ASK_ABOVE_CAP');
  assert.equal(new Date(cooldown?.expiresAt || 0).getTime(), nowMs + 60 * 60_000);
});

test('escalates cooldown for repeated final single fills inside the repeat window', () => {
  const nowMs = Date.now();
  const firstRoundId = roundIdFromStart(nowMs - 100 * 60_000);
  const secondRoundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(firstRoundId, 'YES'));
  store.recordFills([fill(firstRoundId, 'YES')]);
  store.maybeStartSingleFillCooldown([fill(firstRoundId, 'YES')], policy(), nowMs - 95 * 60_000);
  store.maybeStartSingleFillCooldown([], policy(), nowMs - 94 * 60_000);

  store.recordOrder(order(secondRoundId, 'NO'));
  store.recordFills([fill(secondRoundId, 'NO')]);
  store.maybeStartSingleFillCooldown([fill(secondRoundId, 'NO')], policy(), nowMs - 2 * 60_000);
  const cooldown = store.maybeStartSingleFillCooldown([], policy(), nowMs);

  assert.equal(cooldown?.roundId, secondRoundId);
  assert.equal(cooldown?.recentSingleFillCount, 2);
  assert.equal(new Date(cooldown?.expiresAt || 0).getTime(), nowMs + 2 * 60 * 60_000);
});

test('does not scan historical fills without a pending final review', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordOrder(order(roundId, 'YES'));
  store.recordFills([fill(roundId, 'YES')]);

  assert.equal(store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs), null);
  assert.equal(store.getActiveEntryCooldown(nowMs), null);
});

test('does not start cooldown for external fills without tracked strategy orders', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordFills([fill(roundId, 'YES')]);

  assert.equal(store.maybeStartSingleFillCooldown([fill(roundId, 'YES')], 4 * 60 * 60_000, nowMs - 2 * 60_000), null);
  assert.equal(store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs), null);
  assert.equal(store.getActiveEntryCooldown(nowMs), null);
});

test('clears legacy cooldown records that were not created from final review', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poly-btc5m-store-')), 'runtime-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    savedAt: new Date(nowMs).toISOString(),
    intents: [],
    orders: [],
    fills: [fill(roundId, 'YES')],
    settlements: [],
    singleFillCooldown: {
      roundId,
      triggeredAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 4 * 60 * 60_000).toISOString(),
      yesShares: 10,
      noShares: 0,
    },
  }));

  const store = new InMemoryStore('live', 2_000, { persistencePath: statePath });

  assert.equal(store.getActiveEntryCooldown(nowMs), null);
});

function roundIdFromStart(startMs: number): string {
  return `btc-updown-5m-${Math.floor(startMs / 1000)}`;
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
