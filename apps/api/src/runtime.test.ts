import test from 'node:test';
import assert from 'node:assert/strict';

import type { FillRecord } from '../../../packages/shared/src';
import { calculateSettlementValues } from './runtime';

test('settlement PnL includes sell proceeds and only redeems net shares', () => {
  const settlement = calculateSettlementValues([
    fill('YES', 'BUY', 0.44, 10),
    fill('YES', 'SELL', 0.57, 10),
    fill('NO', 'BUY', 0.75, 10),
  ], 'NO');

  assert.equal(settlement.yesShares, 0);
  assert.equal(settlement.noShares, 10);
  assert.equal(settlement.totalCost, 6.2);
  assert.equal(settlement.payout, 10);
  assert.equal(settlement.pnl, 3.8);
});

function fill(label: 'YES' | 'NO', side: 'BUY' | 'SELL', price: number, size: number): FillRecord {
  return {
    id: `${label}-${side}-${price}-${size}`,
    roundId: 'btc-updown-5m-1782531600',
    tokenId: `${label.toLowerCase()}-token`,
    label,
    side,
    price,
    size,
    matchedAt: '2026-06-27T03:45:00.000Z',
  };
}
