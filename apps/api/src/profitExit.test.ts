import test from 'node:test';
import assert from 'node:assert/strict';

import type { AppConfig } from './config';
import { executeSingleFillProfitExits, planSingleFillProfitExit } from './profitExit';
import { InMemoryStore } from './store';
import type { OrderBookQuote, OrderRecord, TradeIntent } from '../../../packages/shared/src';
import type { PolymarketAdapter } from '../../../packages/polymarket/src';
import type { SingleFillProfitExitCandidate } from './store';

const nowMs = new Date('2026-06-26T00:02:00.000Z').getTime();

test('plans a capped sell exit for profitable single-fill exposure', () => {
  const plan = planSingleFillProfitExit({
    candidate: candidate(),
    orders: [
      order('YES', 'BUY', { filledSize: 10, avgFillPrice: 0.45, status: 'filled' }),
      order('NO', 'BUY', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }),
    ],
    orderbooks: [quote('yes-token', 0.5)],
    appConfig: config(),
    nowMs,
  });

  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.intent.side, 'SELL');
  assert.equal(plan.intent.strategy, 'UPDOWN_SINGLE_FILL_PROFIT_EXIT');
  assert.equal(plan.intent.label, 'YES');
  assert.equal(plan.intent.limitPrice, 0.5);
  assert.equal(plan.intent.shares, 10);
  assert.equal(plan.expectedPnlUsd, 0.4999999999999999);
});

test('blocks profit exit when the live bid is below the configured profit rate', () => {
  const plan = planSingleFillProfitExit({
    candidate: candidate(),
    orders: [
      order('YES', 'BUY', { filledSize: 10, avgFillPrice: 0.45, status: 'filled' }),
      order('NO', 'BUY', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }),
    ],
    orderbooks: [quote('yes-token', 0.46)],
    appConfig: { ...config(), singleFillProfitExitMinPrice: 0 },
    nowMs,
  });

  assert.deepEqual(plan, { ok: false, reason: 'EXIT_PROFIT_RATE_BELOW_MIN' });
});

test('blocks profit exit after the filled side has already been sold', () => {
  const plan = planSingleFillProfitExit({
    candidate: candidate(),
    orders: [
      order('YES', 'BUY', { filledSize: 10, avgFillPrice: 0.45, status: 'filled' }),
      order('YES', 'SELL', { filledSize: 10, avgFillPrice: 0.51, status: 'filled', strategy: 'UPDOWN_SINGLE_FILL_PROFIT_EXIT' }),
      order('NO', 'BUY', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }),
    ],
    orderbooks: [quote('yes-token', 0.6)],
    appConfig: config(),
    nowMs,
  });

  assert.deepEqual(plan, { ok: false, reason: 'NO_SINGLE_PROFIT_EXIT_EXPOSURE' });
});

test('retries a profit-exit FAK when the book has no matching orders', async () => {
  const now = Date.now();
  const activeCandidate = {
    ...candidate(),
    startAt: new Date(now - 3 * 60_000).toISOString(),
    endAt: new Date(now + 90_000).toISOString(),
    secondsToEnd: 90,
  };
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });
  store.recordOrder(order('YES', 'BUY', { filledSize: 10, avgFillPrice: 0.45, status: 'filled' }));
  store.recordOrder(order('NO', 'BUY', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }));
  let attempts = 0;
  const adapter = {
    async getRecentFillsForTargets() {
      return [];
    },
    async cancelOrders() {
      return {};
    },
    async getAvailableShares() {
      return 10;
    },
    async executeLimitIntent(_intent: TradeIntent, options: { execute: boolean; orderType?: string }) {
      attempts += 1;
      assert.equal(options.orderType, 'FAK');
      if (attempts === 1) {
        return {
          ok: false,
          price: 0.5,
          size: 10,
          error: 'no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.',
        };
      }
      return { ok: true, orderId: 'profit-exit-order', price: 0.5, size: 10 };
    },
  } as unknown as PolymarketAdapter;

  const diagnostics = await executeSingleFillProfitExits({
    appConfig: { ...config(), executionMode: 'live', ownerPrivateKey: '0xabc', depositWallet: '0xwallet' },
    adapter,
    store,
    candidates: [activeCandidate],
    orderbooks: [{ ...quote('yes-token', 0.5), updatedAt: new Date().toISOString() }],
  });

  assert.deepEqual(diagnostics, []);
  assert.equal(attempts, 2);
});

test('does not execute another profit exit after a prior exit sell fill', async () => {
  const now = Date.now();
  const activeCandidate = {
    ...candidate(),
    startAt: new Date(now - 3 * 60_000).toISOString(),
    endAt: new Date(now + 90_000).toISOString(),
    secondsToEnd: 90,
  };
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });
  store.recordOrder(order('YES', 'BUY', { filledSize: 10, avgFillPrice: 0.45, status: 'filled' }));
  store.recordOrder(order('YES', 'SELL', { filledSize: 10, avgFillPrice: 0.51, status: 'filled', strategy: 'UPDOWN_SINGLE_FILL_PROFIT_EXIT' }));
  store.recordOrder(order('NO', 'BUY', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }));
  let balanceReads = 0;
  const adapter = {
    async getRecentFillsForTargets() {
      return [];
    },
    async getAvailableShares() {
      balanceReads += 1;
      return 0;
    },
    async executeLimitIntent() {
      throw new Error('should not post duplicate profit exit');
    },
  } as unknown as PolymarketAdapter;

  const diagnostics = await executeSingleFillProfitExits({
    appConfig: { ...config(), executionMode: 'live', ownerPrivateKey: '0xabc', depositWallet: '0xwallet' },
    adapter,
    store,
    candidates: [activeCandidate],
    orderbooks: [{ ...quote('yes-token', 0.6), updatedAt: new Date().toISOString() }],
  });

  assert.deepEqual(diagnostics, []);
  assert.equal(balanceReads, 0);
});

function config(): AppConfig {
  return {
    singleFillProfitExitEnabled: true,
    singleFillProfitExitMinRate: 0.05,
    singleFillProfitExitMinPrice: 0.5,
    singleFillProfitExitMinPnlUsd: 0.3,
    singleFillProfitExitPriceOffset: 0.01,
    singleFillProfitExitMaxOrderbookAgeMs: 1_000,
    singleFillProfitExitMinSecondsToEnd: 20,
    singleFillProfitExitMaxSecondsToEnd: 240,
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
    size: 10,
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
