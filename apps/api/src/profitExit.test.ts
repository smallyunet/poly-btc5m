import test from 'node:test';
import assert from 'node:assert/strict';

import type { AppConfig } from './config';
import { planSingleFillProfitExit } from './profitExit';
import { InMemoryStore } from './store';
import type { OrderBookQuote, OrderRecord, TradeIntent } from '../../../packages/shared/src';
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
  assert.equal(plan.intent.limitPrice, 0.49);
  assert.equal(plan.intent.shares, 10);
  assert.equal(plan.expectedPnlUsd, 0.3999999999999998);
});

test('blocks profit exit when the live bid is below the configured profit rate', () => {
  const plan = planSingleFillProfitExit({
    candidate: candidate(),
    orders: [
      order('YES', 'BUY', { filledSize: 10, avgFillPrice: 0.45, status: 'filled' }),
      order('NO', 'BUY', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }),
    ],
    orderbooks: [quote('yes-token', 0.46)],
    appConfig: config(),
    nowMs,
  });

  assert.deepEqual(plan, { ok: false, reason: 'EXIT_PROFIT_RATE_BELOW_MIN' });
});

test('cross-profile risk trigger can evaluate profit exit before the normal exit window', () => {
  const plan = planSingleFillProfitExit({
    candidate: {
      ...candidate(),
      endAt: '2026-06-26T00:15:00.000Z',
      secondsToEnd: 780,
    },
    orders: [
      order('YES', 'BUY', { filledSize: 10, avgFillPrice: 0.45, status: 'filled' }),
      order('NO', 'BUY', { filledSize: 0, status: 'posted', clobOrderId: 'no-open' }),
    ],
    orderbooks: [quote('yes-token', 0.5)],
    appConfig: config(),
    nowMs,
    ignoreTimeWindow: true,
  });

  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.intent.side, 'SELL');
  assert.match(plan.intent.reason, /Cross-profile single-fill risk exit/);
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





function config(): AppConfig {
  return {
    singleFillProfitExitEnabled: true,
    singleFillProfitExitMinRate: 0.05,
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
