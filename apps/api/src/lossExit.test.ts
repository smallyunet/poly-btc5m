import test from 'node:test';
import assert from 'node:assert/strict';

import type { AppConfig } from './config';
import { executeSingleFillLossExits, planSingleFillLossExit } from './lossExit';
import { planSingleFillHedge } from './hedge';
import { InMemoryStore } from './store';
import type { OrderBookQuote, OrderRecord, TradeIntent } from '../../../packages/shared/src';
import type { PolymarketAdapter } from '../../../packages/polymarket/src';
import type { SingleFillProfitExitCandidate } from './store';

const nowMs = new Date('2026-06-26T00:02:00.000Z').getTime();

test('plans a capped sell loss exit for losing single-fill exposure inside budget', () => {
  const plan = planSingleFillLossExit({
    candidate: candidate(),
    orders: [
      order('YES', 'BUY', { filledSize: 5, avgFillPrice: 0.45, status: 'filled' }),
      order('NO', 'BUY', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }),
    ],
    orderbooks: [quote('yes-token', 0.34)],
    appConfig: config(),
    nowMs,
  });

  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.intent.side, 'SELL');
  assert.equal(plan.intent.strategy, 'UPDOWN_SINGLE_FILL_LOSS_EXIT');
  assert.equal(plan.intent.label, 'YES');
  assert.equal(plan.intent.limitPrice, 0.33);
  assert.equal(plan.intent.shares, 5);
  assert.equal(plan.expectedLossUsd, 0.6);
});

test('blocks loss exit when the expected loss is already above budget', () => {
  const plan = planSingleFillLossExit({
    candidate: candidate(),
    orders: [
      order('YES', 'BUY', { filledSize: 5, avgFillPrice: 0.45, status: 'filled' }),
      order('NO', 'BUY', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }),
    ],
    orderbooks: [quote('yes-token', 0.29)],
    appConfig: { ...config(), singleFillLossExitMinBid: 0.25 },
    nowMs,
  });

  assert.deepEqual(plan, { ok: false, reason: 'LOSS_EXIT_LOSS_ABOVE_MAX' });
});

test('blocks loss exit when the filled side is not losing', () => {
  const plan = planSingleFillLossExit({
    candidate: candidate(),
    orders: [
      order('YES', 'BUY', { filledSize: 5, avgFillPrice: 0.45, status: 'filled' }),
      order('NO', 'BUY', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }),
    ],
    orderbooks: [quote('yes-token', 0.48)],
    appConfig: config(),
    nowMs,
  });

  assert.deepEqual(plan, { ok: false, reason: 'LOSS_EXIT_NOT_LOSS' });
});

test('executes loss exit before hedge and prevents a later hedge from seeing open exposure', async () => {
  const now = Date.now();
  const activeCandidate = {
    ...candidate(),
    startAt: new Date(now - 3 * 60_000).toISOString(),
    endAt: new Date(now + 90_000).toISOString(),
    secondsToEnd: 90,
  };
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });
  store.recordOrder(order('YES', 'BUY', {
    id: 'classic-yes-buy',
    roundId: activeCandidate.roundId,
    eventSlug: activeCandidate.eventSlug,
    filledSize: 5,
    avgFillPrice: 0.45,
    status: 'filled',
    strategy: 'UPDOWN_DUAL_ENTRY',
  }));
  store.recordOrder(order('NO', 'BUY', {
    id: 'classic-no-buy',
    roundId: activeCandidate.roundId,
    eventSlug: activeCandidate.eventSlug,
    filledSize: 0,
    status: 'posted',
    clobOrderId: 'no-open',
    strategy: 'UPDOWN_DUAL_ENTRY',
  }));

  const cancelled: string[] = [];
  const adapter = {
    async getRecentFillsForTargets() {
      return [];
    },
    async cancelOrders(ids: string[]) {
      cancelled.push(...ids);
      return {};
    },
    async getAvailableShares() {
      return 5;
    },
    async executeLimitIntent(intent: TradeIntent, options: { execute: boolean; orderType?: string }) {
      assert.equal(options.orderType, 'FAK');
      assert.equal(intent.strategy, 'UPDOWN_SINGLE_FILL_LOSS_EXIT');
      return { ok: true, orderId: 'loss-exit-order', price: intent.limitPrice, size: intent.shares };
    },
  } as unknown as PolymarketAdapter;

  const diagnostics = await executeSingleFillLossExits({
    appConfig: { ...config(), executionMode: 'live', ownerPrivateKey: '0xabc', depositWallet: '0xwallet' },
    adapter,
    store,
    candidates: [activeCandidate],
    orderbooks: [{ ...quote('yes-token', 0.34), updatedAt: new Date().toISOString() }],
  });

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(cancelled, ['no-open']);

  const hedgePlan = planSingleFillHedge({
    candidate: activeCandidate,
    orders: store.roundOrders(activeCandidate.profileId, activeCandidate.roundId),
    orderbooks: [{ ...askQuote('no-token', 0.59), updatedAt: new Date().toISOString() }],
    appConfig: {
      ...config(),
      singleFillHedgeEnabled: true,
      singleFillEarlyHedgeWindowSeconds: 60,
      singleFillHedgeWindowSeconds: 120,
      singleFillEmergencyHedgeWindowSeconds: 15,
      singleFillHedgeMinSecondsToEnd: 5,
      singleFillHedgeMaxPrice: 0.65,
      singleFillHedgePriceOffset: 0.01,
      singleFillHedgeMaxPairCost: 1.1,
      singleFillEarlyHedgeMaxPairCost: 1.02,
      singleFillEmergencyHedgeMaxPrice: 0.75,
      singleFillEmergencyHedgeMaxPairCost: 1.2,
      maxOrderbookAgeSeconds: 5,
    } as AppConfig,
    nowMs: now,
  });
  assert.deepEqual(hedgePlan, { ok: false, reason: 'PROFIT_EXIT_ORDER_ACTIVE' });
});

function config(): AppConfig {
  return {
    singleFillLossExitEnabled: true,
    singleFillLossExitMaxLossUsd: 0.75,
    singleFillLossExitMinBid: 0.3,
    singleFillLossExitPriceOffset: 0.01,
    singleFillLossExitMaxOrderbookAgeMs: 1_000,
    singleFillLossExitMinSecondsToEnd: 20,
    singleFillLossExitMaxSecondsToEnd: 180,
    minOrderShares: 5,
  } as AppConfig;
}

function candidate(): SingleFillProfitExitCandidate {
  return {
    profileId: 'btc-5m',
    roundId: 'btc-updown-5m-1782432000',
    eventSlug: 'btc-updown-5m-1782432000',
    startAt: '2026-06-26T00:00:00.000Z',
    endAt: '2026-06-26T00:05:00.000Z',
    secondsToEnd: 180,
    yesTokenId: 'yes-token',
    noTokenId: 'no-token',
  };
}

function order(label: 'YES' | 'NO', side: 'BUY' | 'SELL', patch: Partial<OrderRecord>): OrderRecord {
  return {
    id: `order-${label}-${side}`,
    profileId: 'btc-5m',
    asset: 'btc',
    interval: '5m',
    intentId: `intent-${label}-${side}`,
    roundId: 'btc-updown-5m-1782432000',
    eventSlug: 'btc-updown-5m-1782432000',
    tokenId: label === 'YES' ? 'yes-token' : 'no-token',
    label,
    side,
    price: 0.45,
    size: 5,
    status: 'posted',
    createdAt: '2026-06-26T00:00:00.000Z',
    ...patch,
  };
}

function quote(tokenId: string, bestBid: number): OrderBookQuote {
  return {
    tokenId,
    bestBid,
    bestAsk: bestBid + 0.01,
    midpoint: bestBid + 0.005,
    spread: 0.01,
    bidDepth: 10,
    askDepth: 10,
    imbalance: 0,
    updatedAt: new Date(nowMs).toISOString(),
    source: 'ws',
  };
}

function askQuote(tokenId: string, bestAsk: number): OrderBookQuote {
  return {
    tokenId,
    bestBid: bestAsk - 0.01,
    bestAsk,
    midpoint: bestAsk - 0.005,
    spread: 0.01,
    bidDepth: 10,
    askDepth: 10,
    imbalance: 0,
    updatedAt: new Date(nowMs).toISOString(),
    source: 'ws',
  };
}
