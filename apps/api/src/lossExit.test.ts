import test from 'node:test';
import assert from 'node:assert/strict';

import type { AppConfig } from './config';
import { planSingleFillLossExit } from './lossExit';
import { planSingleFillHedge } from './hedge';
import { InMemoryStore } from './store';
import type { OrderBookQuote, OrderRecord, TradeIntent } from '../../../packages/shared/src';
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
