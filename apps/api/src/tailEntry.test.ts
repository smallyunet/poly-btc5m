import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { PolymarketAdapter } from '../../../packages/polymarket/src';
import type { OrderBookQuote, StateSnapshot, TradeIntent } from '../../../packages/shared/src';
import { loadConfig } from './config';
import { InMemoryStore } from './store';
import { evaluateTailEntry, executeTailEntry } from './tailEntry';

test('evaluates BTC 5m tail entry from simulator row and live VWAP', () => {
  const config = tailConfig();
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const evaluation = evaluateTailEntry(snapshot(), config, store);

  assert.equal(evaluation.ok, true, evaluation.check.reason);
  if (!evaluation.ok) return;
  assert.equal(evaluation.intent.strategy, 'UPDOWN_TAIL_ENTRY');
  assert.equal(evaluation.intent.label, 'YES');
  assert.equal(evaluation.intent.limitPrice, 0.611);
  assert.equal(evaluation.intent.shares, 5);
  assert.equal(evaluation.check.status, 'eligible');
});

test('executes live tail entries as FAK orders', async () => {
  const config = tailConfig();
  config.ownerPrivateKey = '0xabc';
  config.depositWallet = '0xwallet';
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });
  const currentSnapshot = snapshot();
  const evaluation = evaluateTailEntry(currentSnapshot, config, store);
  assert.equal(evaluation.ok, true, evaluation.check.reason);

  let postedOptions: { execute: boolean; orderType?: string } | undefined;
  const adapter = {
    async getCollateralBalanceAllowance() {
      return { balance: 100, allowance: 100 };
    },
    async getOpenOrders() {
      return [];
    },
    async executeLimitIntent(_intent: TradeIntent, options: { execute: boolean; orderType?: string }) {
      postedOptions = options;
      return { ok: true, orderId: 'tail-order', price: 0.611, size: 5 };
    },
  } as unknown as PolymarketAdapter;

  const diagnostics = await executeTailEntry({ appConfig: config, adapter, store, snapshot: currentSnapshot, evaluation });

  assert.deepEqual(diagnostics, []);
  assert.equal(postedOptions?.orderType, 'FAK');
  assert.equal(postedOptions?.execute, true);
});

test('retries tail entry FAK no-match errors before recording the outcome', async () => {
  const config = tailConfig();
  config.ownerPrivateKey = '0xabc';
  config.depositWallet = '0xwallet';
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });
  const currentSnapshot = snapshot();
  const evaluation = evaluateTailEntry(currentSnapshot, config, store);
  assert.equal(evaluation.ok, true, evaluation.check.reason);

  let attempts = 0;
  const noMatch = 'no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.';
  const adapter = {
    async getCollateralBalanceAllowance() {
      return { balance: 100, allowance: 100 };
    },
    async getOpenOrders() {
      return [];
    },
    async executeLimitIntent(_intent: TradeIntent, options: { execute: boolean; orderType?: string }) {
      attempts += 1;
      assert.equal(options.orderType, 'FAK');
      if (attempts < 3) {
        return { ok: false, price: 0.611, size: 5, error: noMatch, raw: { error: noMatch } };
      }
      return { ok: true, orderId: 'tail-order-after-retry', price: 0.611, size: 5, raw: { orderID: 'tail-order-after-retry' } };
    },
  } as unknown as PolymarketAdapter;

  const diagnostics = await executeTailEntry({ appConfig: config, adapter, store, snapshot: currentSnapshot, evaluation });

  assert.deepEqual(diagnostics, []);
  assert.equal(attempts, 3);
  const orders = store.roundOrders(currentSnapshot.profileId, currentSnapshot.round.id, 'UPDOWN_TAIL_ENTRY');
  assert.equal(orders.length, 1);
  assert.equal(orders[0]?.status, 'posted');
  assert.equal(orders[0]?.clobOrderId, 'tail-order-after-retry');
});

test('selects the best positive-PnL simulator checkpoint and size', () => {
  const config = tailConfig({
    rows: [
      { checkpointSeconds: 60, size: 5, rows: 40, fillable: 24, fillRate: 0.6, avgPnlPerShare: 0.08, totalPnl: 16, avgVwap: 0.55 },
      { checkpointSeconds: 45, size: 5, rows: 40, fillable: 28, fillRate: 0.7, avgPnlPerShare: 0.16, totalPnl: 32, avgVwap: 0.49 },
      { checkpointSeconds: 45, size: 10, rows: 40, fillable: 30, fillRate: 0.75, avgPnlPerShare: 0.22, totalPnl: 66, avgVwap: 0.48 },
    ],
    checkpoints: [60, 45, 30],
  });
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const currentSnapshot = snapshot({ secondsToEnd: 44, yesAskSize: 10 });
  const evaluation = evaluateTailEntry(currentSnapshot, config, store);

  assert.equal(evaluation.ok, true, evaluation.check.reason);
  if (!evaluation.ok) return;
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'Summary selected row')?.actual, '45s / 10 shares / PnL $66.00');
  assert.equal(evaluation.intent.shares, 10);
  assert.equal(evaluation.check.reason, 'Tail entry eligible: buy YES 10.00 @ 0.610 VWAP from best 12h PnL row.');
});

test('uses the best positive-PnL simulator size row for live order size', () => {
  const config = tailConfig({
    rows: [
      { checkpointSeconds: 45, size: 5, rows: 40, fillable: 28, fillRate: 0.7, avgPnlPerShare: 0.16, totalPnl: 32, avgVwap: 0.49 },
      { checkpointSeconds: 45, size: 10, rows: 40, fillable: 30, fillRate: 0.75, avgPnlPerShare: 0.22, totalPnl: 66, avgVwap: 0.48 },
    ],
    checkpoints: [45],
  });
  config.pm5mTailEntrySize = 2;
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const currentSnapshot = snapshot({ secondsToEnd: 44, yesAskSize: 10 });
  const evaluation = evaluateTailEntry(currentSnapshot, config, store);

  assert.equal(evaluation.ok, true, evaluation.check.reason);
  if (!evaluation.ok) return;
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'Summary selected row')?.actual, '45s / 10 shares / PnL $66.00');
  assert.equal(evaluation.intent.shares, 10);
  assert.equal(evaluation.intent.limitPrice, 0.611);
});

test('does not require simulator fill rate when 12h PnL is positive', () => {
  const config = tailConfig({
    rows: [
      { checkpointSeconds: 20, size: 25, rows: 40, fillable: 8, fillRate: 0.2, avgPnlPerShare: 0.03, totalPnl: 18, avgVwap: 0.7 },
    ],
    checkpoints: [20],
  });
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const currentSnapshot = snapshot({ secondsToEnd: 19, yesAskSize: 25 });
  const evaluation = evaluateTailEntry(currentSnapshot, config, store);

  assert.equal(evaluation.ok, true, evaluation.check.reason);
  if (!evaluation.ok) return;
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'Summary fill rate')?.actual, '20.0% reference only');
  assert.equal(evaluation.intent.shares, 25);
});

test('blocks tail entry when every 12h simulator parameter is losing', () => {
  const config = tailConfig({
    rows: [
      { checkpointSeconds: 60, size: 5, rows: 40, fillable: 28, fillRate: 0.7, avgPnlPerShare: -0.02, totalPnl: -4, avgVwap: 0.55 },
      { checkpointSeconds: 45, size: 10, rows: 40, fillable: 30, fillRate: 0.75, avgPnlPerShare: -0.01, totalPnl: -3, avgVwap: 0.48 },
    ],
    checkpoints: [60, 45],
  });
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const evaluation = evaluateTailEntry(snapshot({ secondsToEnd: 59 }), config, store);

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.check.blockers.includes('TAIL_SUMMARY_12H_PNL_NOT_POSITIVE'), true, evaluation.check.reason);
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'Summary selected row')?.actual, 'missing positive 12h PnL row');
});

test('blocks tail entry when live VWAP is below the simulator strength floor', () => {
  const config = tailConfig({
    rows: [
      { checkpointSeconds: 60, size: 5, rows: 40, fillable: 28, fillRate: 0.7, avgPnlPerShare: 0.1, totalPnl: 14, avgVwap: 0.55 },
    ],
    askBandRows: [
      { checkpointSeconds: 60, size: 5, askBand: '65-75c', rows: 4, fillable: 4, fillRate: 1, avgPnlPerShare: 0.12, totalPnl: 2.4, avgVwap: 0.7 },
    ],
    checkpoints: [60],
  });
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const evaluation = evaluateTailEntry(snapshot({ yesAsk: 0.61 }), config, store);

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.check.blockers.includes('TAIL_VWAP_TOO_LOW'), true, evaluation.check.reason);
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'VWAP floor')?.actual, '0.610 / min 0.650');
});

function tailConfig(options: {
  rows?: Array<{
    checkpointSeconds: number;
    size: number;
    askBand?: string;
    rows: number;
    fillable: number;
    fillRate: number;
    avgPnlPerShare: number;
    totalPnl?: number;
    avgVwap: number;
  }>;
  askBandRows?: Array<{
    checkpointSeconds: number;
    size: number;
    askBand: string;
    rows: number;
    fillable: number;
    fillRate: number;
    avgPnlPerShare: number;
    totalPnl?: number;
    avgVwap: number;
  }>;
  checkpoints?: number[];
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm5m-tail-test-'));
  const summaryPath = path.join(dir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    completed: {
      byCheckpointSize: options.rows || [{
        checkpointSeconds: 60,
        size: 5,
        rows: 25,
        fillable: 13,
        fillRate: 0.52,
        avgPnlPerShare: 0.13,
        totalPnl: 16.25,
        avgVwap: 0.66,
      }],
      byAskBand: options.askBandRows || [{
        checkpointSeconds: 60,
        size: 5,
        askBand: '55-65c',
        rows: 4,
        fillable: 4,
        fillRate: 1,
        avgPnlPerShare: 0.13,
        totalPnl: 16.25,
        avgVwap: 0.61,
      }],
    },
  }));
  const config = loadConfig();
  config.pm5mTailEntryEnabled = true;
  config.pm5mTailEntrySummaryPath = summaryPath;
  config.pm5mTailEntryMaxSummaryAgeMs = 60_000;
  config.pm5mTailEntryMinRounds = 20;
  config.pm5mTailEntryMinEvPerShare = 0.03;
  config.pm5mTailEntryCheckpoints = options.checkpoints || [60];
  config.pm5mTailEntrySize = 5;
  config.pm5mTailEntryMinVwap = 0.55;
  config.pm5mTailEntryMinBandRows = 2;
  config.pm5mTailEntryMaxVwap = 0.85;
  config.pm5mTailEntryMaxSpread = 0.02;
  config.pm5mTailEntryMaxOverround = 1.03;
  config.pm5mTailEntryMinMidpointGap = 0.08;
  config.pm5mTailEntryQuoteMaxAgeMs = 2_000;
  config.pm5mTailEntryMaxSlippage = 0.02;
  config.pm5mTailEntryPriceOffset = 0.001;
  config.pm5mTailEntryMaxOrdersPerRound = 1;
  return config;
}

function snapshot(options: { secondsToEnd?: number; yesAsk?: number; yesAskSize?: number } = {}): StateSnapshot {
  const now = Date.now();
  const secondsToEnd = options.secondsToEnd ?? 59;
  const startAt = new Date(now - (300 - secondsToEnd) * 1000).toISOString();
  const endAt = new Date(now + secondsToEnd * 1000).toISOString();
  return {
    id: 'snapshot-tail',
    profileId: 'btc-5m',
    asset: 'btc',
    interval: '5m',
    capturedAt: new Date(now).toISOString(),
    round: {
      id: 'btc-updown-5m-test',
      phase: 'monitoring',
      eventSlug: 'btc-updown-5m-test',
      title: 'BTC 5m test',
      startAt,
      endAt,
      secondsToStart: -(300 - secondsToEnd),
      secondsToEnd,
      strike: 100000,
      strikeStatus: 'locked',
      yesTokenId: 'yes-token',
      noTokenId: 'no-token',
    },
    features: {
      price: 100100,
      strike: 100000,
      cross120s: 0,
      crossFrequency: 0,
      volatility120s: 0,
      drift120s: 0,
      momentum30s: 0,
      range120s: 0,
      range300s: 0,
      rangeBps120s: 0,
      rangeBps300s: 0,
      centerPrice120s: 100100,
      centerCross120s: 0,
      latestRangePosition120s: null,
      upExcursionBps120s: 0,
      downExcursionBps120s: 0,
      minBiExcursionBps120s: 0,
      excursionBalance120s: 0,
      centerUpExcursionBps120s: 0,
      centerDownExcursionBps120s: 0,
      centerMinBiExcursionBps120s: 0,
      centerExcursionBalance120s: 0,
      driftRatio120s: 0,
      momentumRatio30s: 0,
      rangePercentile120s: null,
      chopScore: 0,
      samples120s: 1,
      source: 'binance',
      updatedAt: new Date(now).toISOString(),
    },
    regime: 'UNKNOWN',
    orderbooks: [
      quote('yes-token', 0.59, options.yesAsk ?? 0.61, [{ price: options.yesAsk ?? 0.61, size: options.yesAskSize ?? 5 }]),
      quote('no-token', 0.39, 0.41, [{ price: 0.41, size: 5 }]),
    ],
    positions: [],
    positionReadStatus: 'disabled',
    diagnostics: [],
  };
}

function quote(tokenId: string, bestBid: number, bestAsk: number, asks: { price: number; size: number }[]): OrderBookQuote {
  return {
    tokenId,
    bestBid,
    bestAsk,
    midpoint: (bestBid + bestAsk) / 2,
    spread: bestAsk - bestBid,
    bidDepth: 10,
    askDepth: 10,
    imbalance: null,
    updatedAt: new Date().toISOString(),
    source: 'ws',
    bids: [{ price: bestBid, size: 10 }],
    asks,
  };
}
