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
  assert.equal(evaluation.intent.maxSpendUsd, 3.055);
  assert.equal(evaluation.check.status, 'eligible');
});

test('evaluates BTC 15m tail entry from the interval-specific simulator summary', () => {
  const config = tailConfig();
  config.pm15mTailEntrySummaryPath = config.pm5mTailEntrySummaryPath;
  const current = snapshot();
  const fifteenMinute = {
    ...current,
    profileId: 'btc-15m' as const,
    interval: '15m' as const,
    round: {
      ...current.round,
      id: 'btc-updown-15m-test',
      eventSlug: 'btc-updown-15m-test',
      title: 'BTC 15m test',
    },
  };

  const evaluation = evaluateTailEntry(fifteenMinute, config, new InMemoryStore('monitor', 2_000, { persistencePath: false }));

  assert.equal(evaluation.ok, true);
  if (evaluation.ok) {
    assert.equal(evaluation.intent.profileId, 'btc-15m');
    assert.equal(evaluation.intent.interval, '15m');
    assert.match(evaluation.intent.reason, /^BTC 15m tail entry/);
  }
});

test('executes non-BTC live tail entries as FAK orders', async () => {
  const config = tailConfig({
    assetRows: [
      { asset: 'eth', checkpointSeconds: 60, rows: 25, fillable: 13, fillRate: 0.52, avgPnlPerShare: 0.13, totalPnl: 16.25, avgVwap: 0.66 },
    ],
    assetBandRows: [
      { asset: 'eth', checkpointSeconds: 60, askBand: '55-65c', rows: 4, fillable: 4, fillRate: 1, avgPnlPerShare: 0.13, totalPnl: 16.25, avgVwap: 0.61 },
    ],
  });
  config.ownerPrivateKey = '0xabc';
  config.depositWallet = '0xwallet';
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });
  const currentSnapshot = snapshot({ asset: 'eth' });
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
  assert.equal(store.roundOrders('eth-5m', currentSnapshot.round.id, 'UPDOWN_TAIL_ENTRY')[0]?.profileId, 'eth-5m');
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

test('selects the best executable simulator checkpoint and ask-band pair by per-share edge', () => {
  const config = tailConfig({
    rows: [
      { checkpointSeconds: 60, rows: 40, fillable: 24, fillRate: 0.6, avgPnlPerShare: 0.08, totalPnl: 16, avgVwap: 0.55 },
      { checkpointSeconds: 45, rows: 40, fillable: 30, fillRate: 0.75, avgPnlPerShare: 0.22, totalPnl: 33, avgVwap: 0.48 },
    ],
    checkpoints: [60, 45, 30],
  });
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const currentSnapshot = snapshot({ secondsToEnd: 44, yesAskSize: 10 });
  const evaluation = evaluateTailEntry(currentSnapshot, config, store);

  assert.equal(evaluation.ok, true, evaluation.check.reason);
  if (!evaluation.ok) return;
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'Selected simulation pair')?.actual, '45s / 55-65c / per-share EV 0.2200 / PnL $33.00');
  assert.equal(evaluation.intent.shares, 5);
  assert.equal(evaluation.check.reason, 'Tail entry eligible: buy YES 5.00 @ 0.610 VWAP from best simulation checkpoint and ask-band pair.');
});

test('auto-select mode ignores a fixed checkpoint allowlist and follows the best fresh simulation row', () => {
  const config = tailConfig({
    rows: [
      { checkpointSeconds: 20, rows: 40, fillable: 24, fillRate: 0.6, avgPnlPerShare: 0.24, totalPnl: 28, avgVwap: 0.72 },
      { checkpointSeconds: 15, rows: 40, fillable: 30, fillRate: 0.75, avgPnlPerShare: 0.08, totalPnl: 12, avgVwap: 0.8 },
    ],
    checkpoints: [15],
  });
  config.pm5mTailEntryAutoSelectCheckpoint = true;
  const evaluation = evaluateTailEntry(snapshot({ secondsToEnd: 19 }), config, new InMemoryStore('monitor', 2_000, { persistencePath: false }));

  assert.equal(evaluation.ok, true, evaluation.check.reason);
  if (!evaluation.ok) return;
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'Selected simulation pair')?.actual, '20s / 55-65c / per-share EV 0.2400 / PnL $28.00');
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'Checkpoint selection')?.actual, '20s auto-selected from fresh simulation');
});

test('auto-selects a profitable checkpoint and band pair when the highest checkpoint aggregate has no executable band', () => {
  const config = tailConfig({
    rows: [
      { checkpointSeconds: 20, rows: 67, fillable: 67, fillRate: 1, avgPnlPerShare: 0.05, totalPnl: 6.78, avgVwap: 0.72 },
      { checkpointSeconds: 45, rows: 111, fillable: 111, fillRate: 1, avgPnlPerShare: -0.0003, totalPnl: -0.08, avgVwap: 0.7 },
    ],
    askBandRows: [
      { checkpointSeconds: 20, askBand: '75-85c', rows: 40, fillable: 40, fillRate: 1, avgPnlPerShare: 0.01, totalPnl: 0.8, avgVwap: 0.8 },
      { checkpointSeconds: 45, askBand: '85c+', rows: 82, fillable: 81, fillRate: 0.99, avgPnlPerShare: 0.026, totalPnl: 4.22, avgVwap: 0.88 },
    ],
  });
  config.pm5mTailEntryAutoSelectCheckpoint = true;
  config.pm5mTailEntryMinBandFills = 20;
  config.pm5mTailEntryMinEvPerShare = 0.02;
  config.pm5mTailEntryMaxVwap = 0.99;

  const evaluation = evaluateTailEntry(
    snapshot({ secondsToEnd: 44, yesBid: 0.87, yesAsk: 0.88, noAsk: 0.14 }),
    config,
    new InMemoryStore('monitor', 2_000, { persistencePath: false }),
  );

  assert.equal(evaluation.ok, true, evaluation.check.reason);
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'Selected simulation pair')?.actual, '45s / 85c+ / per-share EV 0.0260 / PnL $4.22');
});

test('blocks a live ask band that differs from the best simulation pair', () => {
  const config = tailConfig({
    askBandRows: [
      { checkpointSeconds: 60, askBand: '75-85c', rows: 100, fillable: 100, fillRate: 1, avgPnlPerShare: 0.04, totalPnl: 8, avgVwap: 0.8 },
      { checkpointSeconds: 60, askBand: '55-65c', rows: 100, fillable: 100, fillRate: 1, avgPnlPerShare: 0.03, totalPnl: 6, avgVwap: 0.61 },
    ],
  });

  const evaluation = evaluateTailEntry(snapshot(), config, new InMemoryStore('monitor', 2_000, { persistencePath: false }));

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.check.blockers.includes('TAIL_ASK_BAND_NOT_SELECTED'), true, evaluation.check.reason);
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'Live ask band selected')?.actual, '55-65c live / 75-85c selected');
});

test('manual checkpoint mode keeps the configured checkpoint allowlist', () => {
  const config = tailConfig({
    rows: [
      { checkpointSeconds: 20, rows: 40, fillable: 24, fillRate: 0.6, avgPnlPerShare: 0.24, totalPnl: 28, avgVwap: 0.72 },
      { checkpointSeconds: 15, rows: 40, fillable: 30, fillRate: 0.75, avgPnlPerShare: 0.08, totalPnl: 12, avgVwap: 0.8 },
    ],
    checkpoints: [15],
  });
  config.pm5mTailEntryAutoSelectCheckpoint = false;
  const evaluation = evaluateTailEntry(snapshot({ secondsToEnd: 14 }), config, new InMemoryStore('monitor', 2_000, { persistencePath: false }));

  assert.equal(evaluation.ok, true, evaluation.check.reason);
  if (!evaluation.ok) return;
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'Selected simulation pair')?.actual, '15s / 55-65c / per-share EV 0.0800 / PnL $12.00');
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'Checkpoint selection')?.actual, '15s selected from configured allowlist');
});

test('uses configured tail entry size for live order size', () => {
  const config = tailConfig({
    rows: [
      { checkpointSeconds: 60, rows: 40, fillable: 28, fillRate: 0.7, avgPnlPerShare: 0.16, totalPnl: 32, avgVwap: 0.49 },
      { checkpointSeconds: 45, rows: 40, fillable: 30, fillRate: 0.75, avgPnlPerShare: 0.22, totalPnl: 33, avgVwap: 0.48 },
    ],
    checkpoints: [45],
  });
  config.pm5mTailEntrySize = 2;
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const currentSnapshot = snapshot({ secondsToEnd: 44, yesAskSize: 10 });
  const evaluation = evaluateTailEntry(currentSnapshot, config, store);

  assert.equal(evaluation.ok, true, evaluation.check.reason);
  if (!evaluation.ok) return;
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'Selected simulation pair')?.actual, '45s / 55-65c / per-share EV 0.2200 / PnL $33.00');
  assert.equal(evaluation.intent.shares, 2);
  assert.equal(evaluation.intent.limitPrice, 0.611);
});

test('does not require simulator fill rate when simulation-window PnL is positive', () => {
  const config = tailConfig({
    rows: [
      { checkpointSeconds: 20, rows: 40, fillable: 8, fillRate: 0.2, avgPnlPerShare: 0.03, totalPnl: 18, avgVwap: 0.7 },
    ],
    checkpoints: [20],
  });
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const currentSnapshot = snapshot({ secondsToEnd: 19, yesAskSize: 25 });
  const evaluation = evaluateTailEntry(currentSnapshot, config, store);

  assert.equal(evaluation.ok, true, evaluation.check.reason);
  if (!evaluation.ok) return;
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'Summary fill rate')?.actual, '20.0% reference only');
  assert.equal(evaluation.intent.shares, 5);
});

test('caps tail entry limit price at the CLOB maximum', () => {
  const config = tailConfig({
    rows: [
      { checkpointSeconds: 60, rows: 40, fillable: 20, fillRate: 0.5, avgPnlPerShare: 0.02, totalPnl: 5, avgVwap: 0.99 },
    ],
    askBandRows: [
      { checkpointSeconds: 60, askBand: '85c+', rows: 40, fillable: 20, fillRate: 0.5, avgPnlPerShare: 0.02, totalPnl: 5, avgVwap: 0.99 },
    ],
    checkpoints: [60],
  });
  config.pm5mTailEntryMaxVwap = 0.99;
  config.pm5mTailEntryMinEvPerShare = 0.02;
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const evaluation = evaluateTailEntry(snapshot({ yesBid: 0.98, yesAsk: 0.99, noAsk: 0.02 }), config, store);

  assert.equal(evaluation.ok, true, evaluation.check.reason);
  if (!evaluation.ok) return;
  assert.equal(evaluation.intent.limitPrice, 0.99);
  assert.equal(evaluation.check.limitPrice, 0.99);
});

test('blocks tail entry when every simulation checkpoint and ask-band pair is losing', () => {
  const config = tailConfig({
    rows: [
      { checkpointSeconds: 60, rows: 40, fillable: 28, fillRate: 0.7, avgPnlPerShare: -0.02, totalPnl: -4, avgVwap: 0.55 },
      { checkpointSeconds: 45, rows: 40, fillable: 30, fillRate: 0.75, avgPnlPerShare: -0.01, totalPnl: -3, avgVwap: 0.48 },
    ],
    askBandRows: [
      { checkpointSeconds: 60, askBand: '55-65c', rows: 40, fillable: 28, fillRate: 0.7, avgPnlPerShare: -0.02, totalPnl: -4, avgVwap: 0.61 },
      { checkpointSeconds: 45, askBand: '55-65c', rows: 40, fillable: 30, fillRate: 0.75, avgPnlPerShare: -0.01, totalPnl: -3, avgVwap: 0.61 },
    ],
    checkpoints: [60, 45],
  });
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const evaluation = evaluateTailEntry(snapshot({ secondsToEnd: 59 }), config, store);

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.check.blockers.includes('TAIL_SIMULATION_PAIR_MISSING'), true, evaluation.check.reason);
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'Selected simulation pair')?.actual, 'no checkpoint and ask-band pair clears simulation gates');
});

test('uses each profile asset\'s own tail rows when the recorder contains multiple assets', () => {
  const config = tailConfig({
    rows: [
      { checkpointSeconds: 60, rows: 80, fillable: 50, fillRate: 0.625, avgPnlPerShare: 0.12, totalPnl: 30, avgVwap: 0.6 },
    ],
    assetRows: [
      { asset: 'btc', checkpointSeconds: 60, rows: 40, fillable: 20, fillRate: 0.5, avgPnlPerShare: -0.03, totalPnl: -3, avgVwap: 0.62 },
      { asset: 'eth', checkpointSeconds: 60, rows: 40, fillable: 30, fillRate: 0.75, avgPnlPerShare: 0.25, totalPnl: 33, avgVwap: 0.55 },
    ],
    assetBandRows: [
      { asset: 'btc', checkpointSeconds: 60, askBand: '55-65c', rows: 4, fillable: 4, fillRate: 1, avgPnlPerShare: -0.03, totalPnl: -1, avgVwap: 0.61 },
      { asset: 'eth', checkpointSeconds: 60, askBand: '55-65c', rows: 4, fillable: 4, fillRate: 1, avgPnlPerShare: 0.2, totalPnl: 4, avgVwap: 0.61 },
    ],
    checkpoints: [60],
  });
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const evaluation = evaluateTailEntry(snapshot({ secondsToEnd: 59 }), config, store);

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.check.blockers.includes('TAIL_SIMULATION_PAIR_MISSING'), true, evaluation.check.reason);

  const ethEvaluation = evaluateTailEntry(snapshot({ asset: 'eth', secondsToEnd: 59 }), config, store);
  assert.equal(ethEvaluation.ok, true, ethEvaluation.check.reason);
  if (ethEvaluation.ok) {
    assert.equal(ethEvaluation.intent.profileId, 'eth-5m');
    assert.match(ethEvaluation.intent.reason, /^ETH 5m tail entry/);
  }
});

test('blocks non-BTC tail entry when only a legacy combined summary is available', () => {
  const config = tailConfig();
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const evaluation = evaluateTailEntry(snapshot({ asset: 'sol', secondsToEnd: 59 }), config, store);

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.check.blockers.includes('TAIL_SIMULATION_PAIR_MISSING'), true, evaluation.check.reason);
});

test('blocks tail entry when live VWAP is below the simulator strength floor', () => {
  const config = tailConfig({
    rows: [
      { checkpointSeconds: 60, rows: 40, fillable: 28, fillRate: 0.7, avgPnlPerShare: 0.1, totalPnl: 14, avgVwap: 0.55 },
    ],
    askBandRows: [
      { checkpointSeconds: 60, askBand: '65-75c', rows: 4, fillable: 4, fillRate: 1, avgPnlPerShare: 0.12, totalPnl: 2.4, avgVwap: 0.7 },
    ],
    checkpoints: [60],
  });
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const evaluation = evaluateTailEntry(snapshot({ yesAsk: 0.61 }), config, store);

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.check.blockers.includes('TAIL_VWAP_TOO_LOW'), true, evaluation.check.reason);
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'VWAP floor')?.actual, '0.610 / min 0.650');
});

test('blocks tail entry when live VWAP exceeds the configured ceiling', () => {
  const config = tailConfig();
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const evaluation = evaluateTailEntry(snapshot({ yesBid: 0.87, yesAsk: 0.88, noAsk: 0.14 }), config, store);

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.check.blockers.includes('TAIL_VWAP_TOO_HIGH'), true, evaluation.check.reason);
  assert.equal(evaluation.check.conditions.find((condition) => condition.label === 'VWAP ceiling')?.actual, '0.880 / max 0.850');
});

test('caps tail limit offset at the configured VWAP ceiling', () => {
  const config = tailConfig({
    askBandRows: [{ checkpointSeconds: 60, askBand: '85c+', rows: 100, fillable: 100, fillRate: 1, avgPnlPerShare: 0.13, totalPnl: 65, avgVwap: 0.85 }],
  });
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const evaluation = evaluateTailEntry(snapshot({ yesBid: 0.84, yesAsk: 0.85, noAsk: 0.17 }), config, store);

  assert.equal(evaluation.ok, true, evaluation.check.reason);
  if (!evaluation.ok) return;
  assert.equal(evaluation.intent.limitPrice, 0.85);
});

test('execution gate rejects a stale tail intent above the configured ceiling', async () => {
  const config = tailConfig();
  config.ownerPrivateKey = '0xabc';
  config.depositWallet = '0xwallet';
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });
  const currentSnapshot = snapshot();
  const evaluation = evaluateTailEntry(currentSnapshot, config, store);
  assert.equal(evaluation.ok, true, evaluation.check.reason);
  if (!evaluation.ok) return;
  let posted = false;
  const adapter = {
    async executeLimitIntent() {
      posted = true;
      return { ok: true, orderId: 'unexpected', price: 0.86, size: 5 };
    },
  } as unknown as PolymarketAdapter;

  const diagnostics = await executeTailEntry({
    appConfig: config,
    adapter,
    store,
    snapshot: currentSnapshot,
    evaluation: { ...evaluation, intent: { ...evaluation.intent, limitPrice: 0.86 } },
  });

  assert.equal(posted, false);
  assert.match(diagnostics[0] || '', /TAIL_LIMIT_PRICE_ABOVE_MAX/);
});

test('blocks the live ask band when its conservative win probability does not clear price plus margin', () => {
  const config = tailConfig({
    askBandRows: [{ checkpointSeconds: 60, askBand: '55-65c', rows: 100, fillable: 100, fillRate: 1, wins: 70, winRate: 0.7, avgPnlPerShare: 0.09, totalPnl: 45, avgVwap: 0.61 }],
  });
  config.pm5mTailEntryWinProbabilityMargin = 0.01;
  config.pm5mTailEntryRequireWinProbabilityMargin = true;
  const evaluation = evaluateTailEntry(snapshot(), config, new InMemoryStore('monitor', 2_000, { persistencePath: false }));

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.check.blockers.includes('TAIL_WIN_PROBABILITY_MARGIN_TOO_LOW'), true, evaluation.check.reason);
});

test('keeps conservative win probability as reference-only when its hard gate is disabled', () => {
  const config = tailConfig({
    askBandRows: [{ checkpointSeconds: 60, askBand: '55-65c', rows: 100, fillable: 100, fillRate: 1, wins: 70, winRate: 0.7, avgPnlPerShare: 0.09, totalPnl: 45, avgVwap: 0.61 }],
  });
  config.pm5mTailEntryRequireWinProbabilityMargin = false;
  config.pm5mTailEntryWinProbabilityMargin = 0.01;
  const evaluation = evaluateTailEntry(snapshot(), config, new InMemoryStore('monitor', 2_000, { persistencePath: false }));

  assert.equal(evaluation.ok, true, evaluation.check.reason);
  assert.equal(evaluation.check.blockers.includes('TAIL_WIN_PROBABILITY_MARGIN_TOO_LOW'), false);
  assert.match(evaluation.check.conditions.find((condition) => condition.label === 'Conservative win probability')?.actual || '', /reference only/);
});

test('requires fillable ask-band samples instead of observed rows', () => {
  const config = tailConfig({
    askBandRows: [{ checkpointSeconds: 60, askBand: '55-65c', rows: 100, fillable: 5, fillRate: 0.05, wins: 5, winRate: 1, avgPnlPerShare: 0.09, totalPnl: 2.25, avgVwap: 0.61 }],
  });
  config.pm5mTailEntryMinBandFills = 20;
  const evaluation = evaluateTailEntry(snapshot(), config, new InMemoryStore('monitor', 2_000, { persistencePath: false }));

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.check.blockers.includes('TAIL_SIMULATION_PAIR_MISSING'), true, evaluation.check.reason);
});

test('blocks Tail when Dual already allocated the same round', () => {
  const config = tailConfig();
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const current = snapshot();
  store.recordOrder({
    id: 'dual-order', profileId: 'btc-5m', asset: 'btc', interval: '5m', intentId: 'dual-intent', strategy: 'UPDOWN_DUAL_ENTRY', strategyProfile: 'classic', executionKey: 'dual-key', roundId: current.round.id, eventSlug: current.round.eventSlug, tokenId: current.round.yesTokenId, label: 'YES', side: 'BUY', price: 0.31, size: 5, status: 'cancelled', createdAt: current.capturedAt,
  });
  const evaluation = evaluateTailEntry(current, config, store);

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.check.blockers.includes('TAIL_DUAL_ROUND_CONFLICT'), true, evaluation.check.reason);
});

test('blocks Tail while its loss cooldown is active', () => {
  const config = tailConfig();
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false });
  const current = snapshot();
  store.recordTailLoss('btc-5m', 'previous-tail-round', -2, { baseMs: 900_000, repeatWindowMs: 3_600_000, secondMs: 3_600_000, thirdMs: 14_400_000 });
  const evaluation = evaluateTailEntry(current, config, store);

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.check.blockers.includes('TAIL_COOLDOWN'), true, evaluation.check.reason);
});

test('revalidates Tail immediately before live submit', async () => {
  const config = tailConfig();
  config.ownerPrivateKey = '0xabc';
  config.depositWallet = '0xwallet';
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });
  const current = snapshot();
  const evaluation = evaluateTailEntry(current, config, store);
  assert.equal(evaluation.ok, true, evaluation.check.reason);
  if (!evaluation.ok) return;
  let posted = false;
  const adapter = {
    async getCollateralBalanceAllowance() { return { balance: 100, allowance: 100 }; },
    async getOpenOrders() { return []; },
    async executeLimitIntent() { posted = true; return { ok: true, price: 0.61, size: 5 }; },
  } as unknown as PolymarketAdapter;
  const diagnostics = await executeTailEntry({ appConfig: config, adapter, store, snapshot: current, evaluation, revalidate: () => ({ ok: false, check: { ...evaluation.check, status: 'blocked', reason: 'TAIL_SIDE_NOT_SELECTABLE', blockers: ['TAIL_SIDE_NOT_SELECTABLE'] } }) });

  assert.equal(posted, false);
  assert.match(diagnostics[0] || '', /TAIL_REVALIDATION_BLOCKED/);
});

function tailConfig(options: {
  rows?: Array<{
    checkpointSeconds: number;
    size?: number;
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
    size?: number;
    askBand: string;
    rows: number;
    fillable: number;
    fillRate: number;
    wins?: number;
    winRate?: number;
    avgPnlPerShare: number;
    totalPnl?: number;
    avgVwap: number;
  }>;
  assetRows?: Array<{
    asset: string;
    checkpointSeconds: number;
    rows: number;
    fillable: number;
    fillRate: number;
    avgPnlPerShare: number;
    totalPnl?: number;
    avgVwap: number;
  }>;
  assetBandRows?: Array<{
    asset: string;
    checkpointSeconds: number;
    askBand: string;
    rows: number;
    fillable: number;
    fillRate: number;
    wins?: number;
    winRate?: number;
    avgPnlPerShare: number;
    totalPnl?: number;
    avgVwap: number;
  }>;
  checkpoints?: number[];
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm5m-tail-test-'));
  const summaryPath = path.join(dir, 'summary.json');
  const checkpointRows = options.rows || [{
    checkpointSeconds: 60,
    rows: 25,
    fillable: 13,
    fillRate: 0.52,
    avgPnlPerShare: 0.13,
    totalPnl: 16.25,
    avgVwap: 0.66,
  }];
  const bands = ['<55c', '55-65c', '65-75c', '75-85c', '85c+'];
  const bandRows = options.askBandRows || checkpointRows.flatMap((row) => bands.map((askBand) => ({
    ...row,
    askBand,
    rows: 100,
    fillable: 100,
    fillRate: 1,
    avgPnlPerShare: askBand === '55-65c' ? row.avgPnlPerShare : row.avgPnlPerShare - 0.01,
    totalPnl: row.totalPnl ?? row.avgPnlPerShare * 500,
  })));
  const assetBandRows = options.assetBandRows || options.assetRows?.flatMap((row) => bands.map((askBand) => ({
    ...row,
    askBand,
    rows: 100,
    fillable: 100,
    fillRate: 1,
    avgPnlPerShare: 0.13,
    totalPnl: 65,
  })));
  fs.writeFileSync(summaryPath, JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    completed: {
      byCheckpoint: checkpointRows,
      byAssetCheckpoint: options.assetRows,
      byAskBand: bandRows,
      byAssetAskBand: assetBandRows,
    },
  }));
  const config = loadConfig();
  config.pm5mTailEntryEnabled = true;
  config.pm5mTailEntrySummaryPath = summaryPath;
  config.pm5mTailEntryMaxSummaryAgeMs = 60_000;
  config.pm5mTailEntryMinRounds = 20;
  config.pm15mTailEntryMinRounds = 20;
  config.pm1hTailEntryMinRounds = 20;
  config.pm5mTailEntryMinEvPerShare = 0.03;
  config.pm5mTailEntryAutoSelectCheckpoint = false;
  config.pm5mTailEntryCheckpoints = options.checkpoints || [60];
  config.pm5mTailEntrySize = 5;
  config.pm5mTailEntryMinVwap = 0.55;
  config.pm5mTailEntryMinBandFills = 2;
  config.pm15mTailEntryMinBandFills = 2;
  config.pm1hTailEntryMinBandFills = 2;
  config.pm5mTailEntryMaxVwap = 0.85;
  config.pm5mTailEntryMaxSpread = 0.02;
  config.pm5mTailEntryMaxOverround = 1.03;
  config.pm5mTailEntryMinMidpointGap = 0.08;
  config.pm5mTailEntryQuoteMaxAgeMs = 2_000;
  config.pm5mTailEntryMaxSlippage = 0.02;
  config.pm5mTailEntryPriceOffset = 0.001;
  config.pm5mTailEntryMaxOrdersPerRound = 1;
  config.pm5mTailEntryRequireWinProbabilityMargin = false;
  config.pm5mTailEntryWinProbabilityMargin = -1;
  return config;
}

function snapshot(options: { asset?: 'btc' | 'eth' | 'sol' | 'doge' | 'xrp' | 'hype'; secondsToEnd?: number; yesBid?: number; yesAsk?: number; yesAskSize?: number; noAsk?: number } = {}): StateSnapshot {
  const now = Date.now();
  const asset = options.asset ?? 'btc';
  const secondsToEnd = options.secondsToEnd ?? 59;
  const startAt = new Date(now - (300 - secondsToEnd) * 1000).toISOString();
  const endAt = new Date(now + secondsToEnd * 1000).toISOString();
  return {
    id: 'snapshot-tail',
    profileId: `${asset}-5m`,
    asset,
    interval: '5m',
    capturedAt: new Date(now).toISOString(),
    round: {
      id: `${asset}-updown-5m-test`,
      phase: 'monitoring',
      eventSlug: `${asset}-updown-5m-test`,
      title: `${asset.toUpperCase()} 5m test`,
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
      quote('yes-token', options.yesBid ?? 0.59, options.yesAsk ?? 0.61, [{ price: options.yesAsk ?? 0.61, size: options.yesAskSize ?? 5 }]),
      quote('no-token', 0.01, options.noAsk ?? 0.41, [{ price: options.noAsk ?? 0.41, size: 5 }]),
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
