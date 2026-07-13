import assert from 'node:assert/strict';
import test from 'node:test';

import { repriceTailResult } from './reprice-pm-tail-results.mjs';

test('reprices a historical Tail result from saved asks at the live size', () => {
  const sample = {
    selectedSide: 'YES', overroundAsk: 1.01,
    yes: { bestAsk: 0.6, midpoint: 0.59, spread: 0.02, asks: [{ price: 0.6, size: 1 }, { price: 0.62, size: 2 }] },
    no: { bestAsk: 0.41, midpoint: 0.4, spread: 0.02, asks: [{ price: 0.41, size: 3 }] },
  };
  const repriced = repriceTailResult(sample, { winner: 'YES', pnlPerShare: 0.3, pnl: 1.5 }, 2);

  assert.equal(repriced.size, 2);
  assert.equal(repriced.fillable, true);
  assert.equal(repriced.vwap, 0.61);
  assert.equal(repriced.pnlPerShare, 0.39);
  assert.equal(repriced.pnl, 0.78);
  assert.equal(repriced.selectedWon, true);
});
