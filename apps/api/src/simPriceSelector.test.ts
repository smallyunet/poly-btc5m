import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AppConfig } from './config';
import { rankFiveMinuteAssetCandidates, selectFiveMinuteEntryPrice } from './simPriceSelector';
import type { MarketProfile, RoundSnapshot } from '../../../packages/shared/src';

test('selects the highest-score simulator price for each 5m asset profile', () => {
  const summaryPath = writeSummary([
    row('btc', 0.36, 0.025, 0.356),
    row('btc', 0.40, 0.013, 0.279),
    row('eth', 0.36, 0.010, 0.1),
    row('eth', 0.42, 0.030, 0.1),
  ]);
  const appConfig = config(summaryPath);
  const btcSelected = selectFiveMinuteEntryPrice(appConfig, profile('btc-5m', 'btc'), round('btc-updown-5m-test-1'));
  const ethSelected = selectFiveMinuteEntryPrice(appConfig, profile('eth-5m', 'eth'), round('eth-updown-5m-test-1'));

  assert.equal(btcSelected.source, 'simulator');
  assert.equal(btcSelected.selectedPrice, 0.36);
  assert.equal(btcSelected.estimatedEvPerShare, 0.025);
  assert.equal(ethSelected.source, 'simulator');
  assert.equal(ethSelected.selectedPrice, 0.42);
  assert.equal(ethSelected.estimatedEvPerShare, 0.030);
});

test('uses single-adjusted score instead of raw EV when selecting price', () => {
  const summaryPath = writeSummary([
    row('btc', 0.31, 0.020, 0.70),
    row('btc', 0.40, 0.010, 0.20),
  ]);
  const selected = selectFiveMinuteEntryPrice(config(summaryPath), profile('btc-5m', 'btc'), round('btc-updown-5m-test-score'));

  assert.equal(selected.source, 'simulator');
  assert.equal(selected.selectedPrice, 0.40);
  assert.equal(selected.estimatedEvPerShare, 0.010);
  assert.match(selected.reason, /score/);
});

test('selects the highest-score simulator price even when EV is negative', () => {
  const summaryPath = writeSummary([
    row('btc', 0.36, -0.001, 0.356),
    row('btc', 0.40, -0.020, 0.5),
  ]);
  const selected = selectFiveMinuteEntryPrice(config(summaryPath), profile('btc-5m', 'btc'), round('btc-updown-5m-test-2'));
  assert.equal(selected.source, 'simulator');
  assert.equal(selected.selectedPrice, 0.36);
  assert.equal(selected.estimatedEvPerShare, -0.001);
});

test('falls back when no asset-specific simulator row passes range and min-round filters', () => {
  const summaryPath = writeSummary([
    { ...row('btc', 0.36, 0.02, 0.2), rounds: 20 },
    row('eth', 0.40, 0.05, 0.2),
  ]);
  const selected = selectFiveMinuteEntryPrice(config(summaryPath), profile('btc-5m', 'btc'), round('btc-updown-5m-test-3'));
  assert.equal(selected.source, 'fallback');
  assert.equal(selected.selectedPrice, 0.45);
});

test('uses all-time simulator rows when lookback rows do not meet min rounds', () => {
  const summaryPath = writeSummary([
    { ...row('btc', 0.40, 0.010, 0.2), rounds: 20 },
  ], [
    row('btc', 0.42, 0.005, 0.25),
  ]);
  const selected = selectFiveMinuteEntryPrice(config(summaryPath), profile('btc-5m', 'btc'), round('btc-updown-5m-test-alltime'));

  assert.equal(selected.source, 'simulator');
  assert.equal(selected.selectedPrice, 0.42);
  assert.match(selected.reason, /all-time fallback/);
});

test('disables simulator price selection for non-5m profiles', () => {
  const summaryPath = writeSummary([
    row('btc', 0.36, 0.025, 0.356),
  ]);
  const selected = selectFiveMinuteEntryPrice(config(summaryPath), profile('btc-15m', 'btc', '15m'), round('btc-updown-15m-test-1'));
  assert.equal(selected.source, 'disabled');
  assert.equal(selected.selectedPrice, 0.45);
});

test('ranks 5m asset candidates and selects only the configured top N', () => {
  const summaryPath = writeSummary([
    row('btc', 0.36, 0.025, 0.2),
    row('eth', 0.42, 0.030, 0.1),
    row('sol', 0.40, 0.020, 0.1),
  ]);
  const appConfig = { ...config(summaryPath), pm5mAssetSelectorEnabled: true, pm5mAssetSelectorMaxAssets: 1 };
  const decisions = rankFiveMinuteAssetCandidates(appConfig, [
    profile('btc-5m', 'btc'),
    profile('eth-5m', 'eth'),
    profile('sol-5m', 'sol'),
    profile('eth-15m', 'eth', '15m'),
  ]);

  assert.equal(decisions.get('eth-5m')?.selected, true);
  assert.equal(decisions.get('eth-5m')?.rank, 1);
  assert.equal(decisions.get('btc-5m')?.selected, false);
  assert.equal(decisions.get('btc-5m')?.rank, 2);
  assert.equal(decisions.get('sol-5m')?.selected, false);
  assert.equal(decisions.has('eth-15m'), false);
});

test('ranks 5m asset candidates by highest score without requiring positive EV', () => {
  const summaryPath = writeSummary([
    row('btc', 0.36, -0.020, 0.5),
    row('eth', 0.42, -0.005, 0.6),
    row('sol', 0.40, -0.010, 0.7),
  ]);
  const appConfig = { ...config(summaryPath), pm5mAssetSelectorEnabled: true, pm5mAssetSelectorMaxAssets: 1 };
  const decisions = rankFiveMinuteAssetCandidates(appConfig, [
    profile('btc-5m', 'btc'),
    profile('eth-5m', 'eth'),
    profile('sol-5m', 'sol'),
  ]);

  assert.equal(decisions.get('eth-5m')?.selected, true);
  assert.equal(decisions.get('eth-5m')?.rank, 1);
  assert.doesNotMatch(decisions.get('eth-5m')?.reason || '', /relative fallback/);
  assert.equal(decisions.get('btc-5m')?.selected, false);
  assert.equal(decisions.get('sol-5m')?.selected, false);
});

function writeSummary(rows: unknown[], allTimeRows?: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm5m-selector-'));
  const summaryPath = path.join(dir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    config: { lookbackHours: 12 },
    completed: { byAssetPrice: rows },
    completedAllTime: allTimeRows ? { byAssetPrice: allTimeRows } : undefined,
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
    pm5mSimPriceEnabled: true,
    pm5mSimPriceSummaryPath: summaryPath,
    pm5mSimPriceRefreshMs: 0,
    pm5mSimPriceMin: 0.29,
    pm5mSimPriceMax: 0.49,
    pm5mSimPriceMinRounds: 100,
    pm5mSimPriceFallback: 0.45,
    pm5mSimPriceMaxSummaryAgeMs: 600_000,
    pm5mAssetSelectorEnabled: false,
    pm5mAssetSelectorMaxAssets: 1,
    pm5mAssetSelectorSinglePenalty: 0.05,
    dualLimitPrice: 0.45,
  } as AppConfig;
}

function profile(id: MarketProfile['id'], asset: MarketProfile['asset'], interval: MarketProfile['interval'] = '5m'): MarketProfile {
  return { id, asset, interval } as MarketProfile;
}

function round(id: string): RoundSnapshot {
  return {
    id,
    endAt: new Date(Date.now() + 300_000).toISOString(),
  } as RoundSnapshot;
}
