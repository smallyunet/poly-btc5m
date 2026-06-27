import test from 'node:test';
import assert from 'node:assert/strict';

import type { AppConfig } from './config';
import { executeSingleFillHedges, planSingleFillHedge } from './hedge';
import { InMemoryStore, type SingleFillHedgeCandidate } from './store';
import type { PolymarketAdapter } from '../../../packages/polymarket/src';
import type { OrderBookQuote, OrderRecord, TradeIntent } from '../../../packages/shared/src';

const nowMs = new Date('2026-06-26T00:04:35.000Z').getTime();
const earlyNowMs = new Date('2026-06-26T00:04:15.000Z').getTime();

test('plans a capped buy hedge for material single-fill exposure', () => {
  const plan = planSingleFillHedge({
    candidate: candidate(),
    orders: [
      order('YES', { filledSize: 10, avgFillPrice: 0.44, status: 'filled' }),
      order('NO', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }),
    ],
    orderbooks: [quote('no-token', 0.59)],
    appConfig: config(),
    nowMs,
  });

  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.intent.label, 'NO');
  assert.equal(plan.intent.tokenId, 'no-token');
  assert.equal(plan.intent.limitPrice, 0.6);
  assert.equal(plan.intent.shares, 10);
  assert.equal(plan.expectedPnlPerShare, -0.040000000000000036);
});

test('blocks a hedge when missing-side ask is above the configured cap', () => {
  const plan = planSingleFillHedge({
    candidate: candidate(),
    orders: [
      order('YES', { filledSize: 10, avgFillPrice: 0.44, status: 'filled' }),
      order('NO', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }),
    ],
    orderbooks: [quote('no-token', 0.66)],
    appConfig: config(),
    nowMs,
  });

  assert.deepEqual(plan, { ok: false, reason: 'HEDGE_ASK_ABOVE_CAP' });
});

test('blocks a hedge when combined pair cost is above the configured cap', () => {
  const plan = planSingleFillHedge({
    candidate: candidate(),
    orders: [
      order('YES', { filledSize: 10, avgFillPrice: 0.55, status: 'filled' }),
      order('NO', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }),
    ],
    orderbooks: [quote('no-token', 0.59)],
    appConfig: { ...config(), singleFillHedgeMaxPairCost: 1.1 },
    nowMs,
  });

  assert.deepEqual(plan, { ok: false, reason: 'HEDGE_PAIR_COST_ABOVE_CAP' });
});

test('blocks early hedge when pair cost is above the tighter early cap', () => {
  const plan = planSingleFillHedge({
    candidate: candidate(),
    orders: [
      order('YES', { filledSize: 10, avgFillPrice: 0.44, status: 'filled' }),
      order('NO', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }),
    ],
    orderbooks: [quote('no-token', 0.59)],
    appConfig: config(),
    nowMs: earlyNowMs,
  });

  assert.deepEqual(plan, { ok: false, reason: 'EARLY_HEDGE_PAIR_COST_ABOVE_CAP' });
});

test('allows early hedge only when it can lock near breakeven', () => {
  const plan = planSingleFillHedge({
    candidate: candidate(),
    orders: [
      order('YES', { filledSize: 10, avgFillPrice: 0.44, status: 'filled' }),
      order('NO', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }),
    ],
    orderbooks: [quote('no-token', 0.57)],
    appConfig: config(),
    nowMs: earlyNowMs,
  });

  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.hedgeMode, 'early');
  assert.equal(plan.pairCostCap, 1.02);
  assert.equal(plan.intent.limitPrice, 0.58);
});

test('does not hedge after the single filled side was sold by profit exit', () => {
  const plan = planSingleFillHedge({
    candidate: candidate(),
    orders: [
      order('YES', { filledSize: 10, avgFillPrice: 0.44, status: 'filled' }),
      order('YES', { side: 'SELL', filledSize: 10, avgFillPrice: 0.57, status: 'filled' }),
      order('NO', { filledSize: 0, status: 'cancelled', clobOrderId: 'no-cancelled' }),
    ],
    orderbooks: [quote('no-token', 0.59)],
    appConfig: config(),
    nowMs,
  });

  assert.deepEqual(plan, { ok: false, reason: 'NO_MATERIAL_SINGLE_FILL_EXPOSURE' });
});

test('pauses hedge while a profit-exit sell order is awaiting reconciliation', () => {
  const plan = planSingleFillHedge({
    candidate: candidate(),
    orders: [
      order('YES', { filledSize: 10, avgFillPrice: 0.44, status: 'filled' }),
      order('YES', { side: 'SELL', status: 'posted', clobOrderId: 'exit-posted' }),
      order('NO', { filledSize: 0, status: 'cancelled', clobOrderId: 'no-cancelled' }),
    ],
    orderbooks: [quote('no-token', 0.59)],
    appConfig: config(),
    nowMs,
  });

  assert.deepEqual(plan, { ok: false, reason: 'PROFIT_EXIT_ORDER_ACTIVE' });
});

test('blocks a marketable hedge below the Polymarket minimum notional', () => {
  const plan = planSingleFillHedge({
    candidate: candidate(),
    orders: [
      order('YES', { filledSize: 10, avgFillPrice: 0.44, status: 'filled' }),
      order('NO', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }),
    ],
    orderbooks: [quote('no-token', 0.01)],
    appConfig: config(),
    nowMs,
  });

  assert.deepEqual(plan, { ok: false, reason: 'HEDGE_NOTIONAL_BELOW_MIN' });
});

test('executes final-window hedge as a FAK limit', async () => {
  const now = Date.now();
  const activeCandidate = candidate({
    startAt: new Date(now - 4 * 60_000).toISOString(),
    endAt: new Date(now + 25_000).toISOString(),
    secondsToEnd: 25,
  });
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });
  store.recordOrder(order('YES', { roundId: activeCandidate.roundId, eventSlug: activeCandidate.eventSlug, filledSize: 10, avgFillPrice: 0.44, status: 'filled' }));
  store.recordOrder(order('NO', { roundId: activeCandidate.roundId, eventSlug: activeCandidate.eventSlug, filledSize: 0, status: 'posted', clobOrderId: 'no-open' }));
  let postedOptions: { execute: boolean; orderType?: string } | undefined;
  const adapter = {
    async getRecentFillsForTargets() {
      return [];
    },
    async cancelOrders() {
      return {};
    },
    async executeLimitIntent(_intent: TradeIntent, options: { execute: boolean; orderType?: string }) {
      postedOptions = options;
      return { ok: true, orderId: 'hedge-order', price: 0.6, size: 10 };
    },
  } as unknown as PolymarketAdapter;

  const diagnostics = await executeSingleFillHedges({
    appConfig: { ...config(), executionMode: 'live', ownerPrivateKey: '0xabc', depositWallet: '0xwallet' },
    adapter,
    store,
    candidates: [activeCandidate],
    orderbooks: [quote('no-token', 0.59)],
  });

  assert.deepEqual(diagnostics, []);
  assert.equal(postedOptions?.orderType, 'FAK');
});

function config(): AppConfig {
  return {
    port: 8788,
    executionMode: 'monitor',
    clobApiUrl: 'https://clob.polymarket.com',
    gammaApiUrl: 'https://gamma-api.polymarket.com',
    dataApiUrl: 'https://data-api.polymarket.com',
    chainId: 137,
    tickIntervalMs: 2_000,
    runtimeStatePath: 'data/runtime-state.json',
    runtimeMaxRecords: 1000,
    binanceWsUrl: 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade',
    binancePriceSampleMs: 1_000,
    clobWsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    dualLimitPrice: 0.45,
    dynamicLimitEnabled: true,
    minDynamicLimitPrice: 0.42,
    maxDynamicLimitPrice: 0.46,
    maxPairCost: 0.92,
    orderSharesPerSide: 10,
    dynamicSharesEnabled: true,
    maxOrderSharesPerSide: 12.5,
    minOrderShares: 5,
    maxOrderbookAgeSeconds: 5,
    minCross120s: 2,
    maxAbsDrift120s: 40,
    maxAbsMomentum30s: 28,
    minChopScore: 70,
    minRangeBps120s: 3,
    minBiExcursionBps120s: 1,
    maxDriftRatio120s: 0.45,
    maxMomentumRatio30s: 0.55,
    maxEntryQueueImbalance: 5,
    minLiveChopScore: 80,
    entryConfirmTicks: 3,
    participationEnabled: true,
    participationCacheMs: 30_000,
    participationTopHoldersPerSide: 8,
    minParticipationHoldersPerSide: 3,
    minParticipationTopHolderSharesPerSide: 300,
    minParticipationTopPositionPnl: 40,
    minParticipationPositionPnlSum: 100,
    maxParticipationHolderConcentration: 0.75,
    singleFillCooldownMs: 4 * 60 * 60_000,
    singleFillCooldownBaseMs: 30 * 60_000,
    singleFillCooldownPriceCapMs: 60 * 60_000,
    singleFillCooldownExecutionMs: 2 * 60 * 60_000,
    singleFillCooldownRepeatWindowMs: 2 * 60 * 60_000,
    singleFillCooldownSecondMs: 2 * 60 * 60_000,
    singleFillCooldownThirdMs: 4 * 60 * 60_000,
    singleFillHedgeEnabled: true,
    singleFillEarlyHedgeWindowSeconds: 60,
    singleFillEarlyHedgeMaxPairCost: 1.02,
    singleFillHedgeWindowSeconds: 30,
    singleFillHedgeMinSecondsToEnd: 5,
    singleFillHedgeMaxPrice: 0.65,
    singleFillHedgePriceOffset: 0.01,
    singleFillHedgeMaxPairCost: 1.05,
    singleFillProfitExitEnabled: true,
    singleFillProfitExitMinPrice: 0.5,
    singleFillProfitExitMinPnlUsd: 0.3,
    singleFillProfitExitPriceOffset: 0.01,
    singleFillProfitExitMaxOrderbookAgeMs: 1_000,
    singleFillProfitExitMinSecondsToEnd: 20,
    singleFillProfitExitMaxSecondsToEnd: 240,
    marketConfig: {
      seriesSlug: 'btc-updown-5m',
      title: 'Polymarket BTC 5m',
      roundDurationSeconds: 300,
      decisionLeadSeconds: 30,
      avoidExpirySeconds: 30,
    },
  };
}

function candidate(patch: Partial<SingleFillHedgeCandidate> = {}): SingleFillHedgeCandidate {
  return {
    roundId: 'btc-updown-5m-1782432000',
    eventSlug: 'btc-updown-5m-1782432000',
    startAt: '2026-06-26T00:00:00.000Z',
    endAt: '2026-06-26T00:05:00.000Z',
    secondsToEnd: 25,
    yesTokenId: 'yes-token',
    noTokenId: 'no-token',
    ...patch,
  };
}

function order(label: 'YES' | 'NO', patch: Partial<OrderRecord>): OrderRecord {
  return {
    id: `order-${label}`,
    intentId: `intent-${label}`,
    roundId: 'btc-updown-5m-1782432000',
    eventSlug: 'btc-updown-5m-1782432000',
    tokenId: label === 'YES' ? 'yes-token' : 'no-token',
    label,
    side: 'BUY',
    price: 0.44,
    size: 10,
    status: 'posted',
    createdAt: '2026-06-26T00:00:00.000Z',
    ...patch,
  };
}

function quote(tokenId: string, bestAsk: number): OrderBookQuote {
  return {
    tokenId,
    bestBid: bestAsk - 0.01,
    bestAsk,
    midpoint: bestAsk - 0.005,
    spread: 0.01,
    bidDepth: 10,
    askDepth: 10,
    imbalance: 0,
    updatedAt: new Date().toISOString(),
    source: 'ws',
  };
}
