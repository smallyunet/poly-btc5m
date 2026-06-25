import test from 'node:test';
import assert from 'node:assert/strict';

import type { FillRecord } from '../../../packages/shared/src';
import { InMemoryStore } from './store';

test('does not start single-fill cooldown before the round is final', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 4 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordFills([fill(roundId, 'YES')]);

  assert.equal(store.maybeStartSingleFillCooldown(4 * 60 * 60_000, nowMs), null);
  assert.equal(store.getActiveEntryCooldown(nowMs), null);
});

test('starts single-fill cooldown only after final round state is single-sided', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordFills([fill(roundId, 'YES')]);

  const cooldown = store.maybeStartSingleFillCooldown(4 * 60 * 60_000, nowMs);

  assert.equal(cooldown?.roundId, roundId);
  assert.equal(cooldown?.yesShares, 10);
  assert.equal(cooldown?.noShares, 0);
  assert.equal(store.getActiveEntryCooldown(nowMs)?.roundId, roundId);
});

test('does not start cooldown when the final round state is paired', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordFills([fill(roundId, 'YES'), fill(roundId, 'NO')]);

  assert.equal(store.maybeStartSingleFillCooldown(4 * 60 * 60_000, nowMs), null);
  assert.equal(store.getActiveEntryCooldown(nowMs), null);
});

test('clears an active cooldown if later fills make the round paired', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordFills([fill(roundId, 'YES')]);
  assert.equal(store.maybeStartSingleFillCooldown(4 * 60 * 60_000, nowMs)?.roundId, roundId);

  store.recordFills([fill(roundId, 'NO')]);

  assert.equal(store.getActiveEntryCooldown(nowMs), null);
});

function roundIdFromStart(startMs: number): string {
  return `btc-updown-5m-${Math.floor(startMs / 1000)}`;
}

function fill(roundId: string, label: 'YES' | 'NO'): FillRecord {
  return {
    id: `fill-${roundId}-${label}`,
    roundId,
    tokenId: `${label.toLowerCase()}-token`,
    label,
    side: 'BUY',
    price: 0.44,
    size: 10,
    matchedAt: new Date().toISOString(),
  };
}
