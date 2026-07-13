import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateTailResults } from './pm5m-tail-summary.mjs';

test('tail summary counts wins only for fillable rows and groups ask bands by VWAP', () => {
  const summary = aggregateTailResults([
    { asset: 'btc', checkpointSeconds: 20, fillable: true, selectedWon: true, vwap: 0.7, selectedBestAsk: 0.69, pnlPerShare: 0.3, pnl: 0.6 },
    { asset: 'btc', checkpointSeconds: 20, fillable: false, selectedWon: true, vwap: 0.7, selectedBestAsk: 0.6, pnlPerShare: null, pnl: null },
    { asset: 'btc', checkpointSeconds: 20, fillable: true, selectedWon: false, vwap: 0.7, selectedBestAsk: 0.69, pnlPerShare: -0.7, pnl: -1.4 },
  ]);

  const row = summary.byAssetAskBand[0];
  assert.equal(summary.byAssetAskBand.length, 1);
  assert.equal(row.askBand, '65-75c');
  assert.equal(row.rows, 3);
  assert.equal(row.fillable, 2);
  assert.equal(row.wins, 1);
  assert.equal(row.winRate, 0.5);
  assert.equal(row.avgPnlPerShare, -0.2);
});
