import assert from 'node:assert/strict';
import test from 'node:test';

import type { OrderRecord } from '../../../packages/shared/src';
import { cancelFutureDualOrdersForPendingRisk } from './pendingSingleFillRisk';
import { InMemoryStore } from './store';

test('cancels and records later Dual orders while pending single-fill risk is active', async () => {
  const nowMs = Date.now();
  const sourceRoundId = roundId(nowMs - 4 * 60_000);
  const futureRoundId = roundId(nowMs + 60_000);
  const store = new InMemoryStore(2_000, { persistencePath: false });
  store.recordOrder(order(futureRoundId, 'YES', 'future-yes'));
  store.recordOrder(order(futureRoundId, 'NO', 'future-no'));
  const diagnostics = await cancelFutureDualOrdersForPendingRisk(store, {
    profileId: 'btc-5m',
    sourceProfileId: 'btc-5m',
    roundId: sourceRoundId,
    expiresAt: new Date(nowMs + 2 * 60_000).toISOString(),
    yesShares: 5,
    noShares: 0,
  });

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(store.roundOrders('btc-5m', futureRoundId, 'UPDOWN_DUAL_ENTRY').map((item) => item.status), ['cancelled', 'cancelled']);
  assert.equal(store.dashboardState().runtimeLogs[0]?.details?.reason, 'PENDING_SINGLE_FILL_RISK');
});

function roundId(startMs: number): string {
  return `btc-updown-5m-${Math.floor(startMs / 1000)}`;
}

function order(round: string, label: 'YES' | 'NO', clobOrderId: string): OrderRecord {
  return {
    id: `order-${label}`,
    profileId: 'btc-5m',
    asset: 'btc',
    interval: '5m',
    intentId: `intent-${label}`,
    strategy: 'UPDOWN_DUAL_ENTRY',
    strategyProfile: 'classic',
    roundId: round,
    eventSlug: round,
    tokenId: `${label.toLowerCase()}-token`,
    label,
    side: 'BUY',
    price: 0.3,
    size: 5,
    status: 'posted',
    clobOrderId,
    createdAt: new Date().toISOString(),
  };
}
