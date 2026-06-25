import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FillRecord } from '../../../packages/shared/src';
import { InMemoryStore } from './store';

test('does not start single-fill cooldown before the round is final', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 4 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordFills([fill(roundId, 'YES')]);

  assert.equal(store.maybeStartSingleFillCooldown([fill(roundId, 'YES')], 4 * 60 * 60_000, nowMs), null);
  assert.equal(store.getActiveEntryCooldown(nowMs), null);
});

test('starts single-fill cooldown only after final round state is single-sided', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

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

  store.recordFills([fill(roundId, 'YES'), fill(roundId, 'NO')]);
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES'), fill(roundId, 'NO')], 4 * 60 * 60_000, nowMs - 2 * 60_000);

  assert.equal(store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs), null);
  assert.equal(store.getActiveEntryCooldown(nowMs), null);
});

test('clears an active cooldown if later fills make the round paired', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordFills([fill(roundId, 'YES')]);
  store.maybeStartSingleFillCooldown([fill(roundId, 'YES')], 4 * 60 * 60_000, nowMs - 2 * 60_000);
  assert.equal(store.maybeStartSingleFillCooldown([], 4 * 60 * 60_000, nowMs)?.roundId, roundId);

  store.recordFills([fill(roundId, 'NO')]);

  assert.equal(store.getActiveEntryCooldown(nowMs), null);
});

test('does not scan historical fills without a pending final review', () => {
  const nowMs = Date.now();
  const roundId = roundIdFromStart(nowMs - 7 * 60_000);
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  store.recordFills([fill(roundId, 'YES')]);

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
