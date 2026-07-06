import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AppConfig } from './config';
import { selectBtc5mEntryPrice } from './simPriceSelector';
import type { MarketProfile, RoundSnapshot } from '../../../packages/shared/src';

test('selects the best positive-EV BTC simulator price for btc-5m', () => {
  const summaryPath = writeSummary([
    row('btc', 0.36, 0.025, 0.356),
    row('btc', 0.40, 0.013, 0.279),
    row('eth', 0.36, 0.1, 0.1),
  ]);
  const selected = selectBtc5mEntryPrice(config(summaryPath), profile(), round('btc-updown-5m-test-1'));
  assert.equal(selected.source, 'simulator');
  assert.equal(selected.selectedPrice, 0.36);
  assert.equal(selected.estimatedEvPerShare, 0.025);
});

test('falls back when no BTC simulator row passes filters', () => {
  const summaryPath = writeSummary([
    row('btc', 0.36, -0.001, 0.356),
    row('btc', 0.40, 0.02, 0.5),
  ]);
  const selected = selectBtc5mEntryPrice(config(summaryPath), profile(), round('btc-updown-5m-test-2'));
  assert.equal(selected.source, 'fallback');
  assert.equal(selected.selectedPrice, 0.45);
});

function writeSummary(rows: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm5m-selector-'));
  const summaryPath = path.join(dir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    completed: { byAssetPrice: rows },
  }));
  return summaryPath;
}

function row(asset: string, price: number, ev: number, singleRate: number) {
  return {
    asset,
    price,
    rounds: 120,
    pairedRate: 0.6,
    singleRate,
    noneRate: 0.1,
    estimatedEvPerShare: ev,
  };
}

function config(summaryPath: string): AppConfig {
  return {
    btc5mSimPriceEnabled: true,
    btc5mSimPriceSummaryPath: summaryPath,
    btc5mSimPriceRefreshMs: 0,
    btc5mSimPriceMin: 0.29,
    btc5mSimPriceMax: 0.49,
    btc5mSimPriceMinRounds: 100,
    btc5mSimPriceMaxSingleRate: 0.4,
    btc5mSimPriceMaxNoneRate: 0.15,
    btc5mSimPriceMinEv: 0,
    btc5mSimPriceFallback: 0.45,
    btc5mSimPriceMaxSummaryAgeMs: 600_000,
    dualLimitPrice: 0.45,
  } as AppConfig;
}

function profile(): MarketProfile {
  return { id: 'btc-5m' } as MarketProfile;
}

function round(id: string): RoundSnapshot {
  return {
    id,
    endAt: new Date(Date.now() + 300_000).toISOString(),
  } as RoundSnapshot;
}
