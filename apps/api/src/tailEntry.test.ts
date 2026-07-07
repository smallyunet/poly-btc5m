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

function tailConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm5m-tail-test-'));
  const summaryPath = path.join(dir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    completed: {
      byCheckpointSize: [{
        checkpointSeconds: 60,
        size: 5,
        rows: 25,
        fillable: 13,
        fillRate: 0.52,
        avgPnlPerShare: 0.13,
        avgVwap: 0.66,
      }],
    },
  }));
  const config = loadConfig();
  config.pm5mTailEntryEnabled = true;
  config.pm5mTailEntrySummaryPath = summaryPath;
  config.pm5mTailEntryMaxSummaryAgeMs = 60_000;
  config.pm5mTailEntryMinRounds = 20;
  config.pm5mTailEntryMinEvPerShare = 0.03;
  config.pm5mTailEntryMinFillRate = 0.45;
  config.pm5mTailEntryCheckpoints = [60];
  config.pm5mTailEntrySize = 5;
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

function snapshot(): StateSnapshot {
  const now = Date.now();
  const startAt = new Date(now - 240_000).toISOString();
  const endAt = new Date(now + 59_000).toISOString();
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
      secondsToStart: -240,
      secondsToEnd: 59,
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
      quote('yes-token', 0.59, 0.61, [{ price: 0.61, size: 5 }]),
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
