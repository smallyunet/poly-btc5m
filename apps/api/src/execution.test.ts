import test from 'node:test';
import assert from 'node:assert/strict';

import type { OrderBookQuote, StateSnapshot, TradeIntent } from '../../../packages/shared/src';
import { executePaperIntents, reconcilePaperOrders } from './execution';
import { InMemoryStore } from './store';

test('Paper Dual fills immediately when the live ask touches the limit', () => {
  const store = new InMemoryStore(2_000, { persistencePath: false });
  const trade = intent(0.45);
  store.recordIntents([trade]);
  const diagnostics = executePaperIntents({ store, snapshot: snapshot(quote(0.45)), intents: [trade] });
  const state = store.dashboardState();
  assert.match(diagnostics[0], /Paper simulation/);
  assert.equal(state.orders[0].status, 'filled');
  assert.equal(state.fills[0].price, 0.45);
});

test('Paper Dual rests until a later ask touches the limit', () => {
  const store = new InMemoryStore(2_000, { persistencePath: false });
  const trade = intent(0.44);
  store.recordIntents([trade]);
  executePaperIntents({ store, snapshot: snapshot(quote(0.45)), intents: [trade] });
  assert.equal(store.dashboardState().orders[0].status, 'posted');
  assert.equal(store.dashboardState().fills.length, 0);

  const fills = reconcilePaperOrders({ store, profileId: 'btc-5m', quotes: [quote(0.43)] });
  assert.equal(fills.length, 1);
  assert.equal(fills[0].price, 0.43);
  assert.equal(store.dashboardState().orders[0].status, 'filled');
});

test('Paper Dual ignores stale touch quotes and records auditable fresh-quote evidence', () => {
  const store = new InMemoryStore(2_000, { persistencePath: false });
  const trade = intent(0.45);
  store.recordIntents([trade]);
  executePaperIntents({
    store,
    snapshot: snapshot(quote(0.44, new Date(Date.now() - 6_000).toISOString())),
    intents: [trade],
    maxQuoteAgeSeconds: 5,
    fillModelVersion: 'best-ask-touch-full-fill-v2',
  });
  assert.equal(store.dashboardState().orders[0].status, 'posted');
  assert.equal(store.dashboardState().fills.length, 0);

  const nowMs = Date.now();
  const fills = reconcilePaperOrders({
    store,
    profileId: 'btc-5m',
    quotes: [quote(0.44, new Date(nowMs - 250).toISOString())],
    nowMs,
    maxQuoteAgeSeconds: 5,
    fillModelVersion: 'best-ask-touch-full-fill-v2',
  });
  assert.equal(fills.length, 1);
  assert.equal(fills[0].raw?.fillModel, 'best-ask-touch-full-fill-v2');
  assert.deepEqual(fills[0].raw?.decision, {
    observedAt: new Date(nowMs).toISOString(),
    orderCreatedAt: store.dashboardState().orders[0].createdAt,
    quoteUpdatedAt: new Date(nowMs - 250).toISOString(),
    quoteAgeMs: 250,
    bestAsk: 0.44,
    limitPrice: 0.45,
    maxQuoteAgeMs: 5_000,
  });
});

function intent(limitPrice: number): TradeIntent {
  const startSeconds = Math.floor(Date.now() / 1_000) + 300;
  return {
    id: 'paper-intent',
    profileId: 'btc-5m',
    asset: 'btc',
    interval: '5m',
    strategy: 'UPDOWN_DUAL_ENTRY',
    roundId: `btc-updown-5m-${startSeconds}`,
    tokenId: 'yes-token',
    label: 'YES',
    side: 'BUY',
    orderType: 'LIMIT',
    limitPrice,
    shares: 5,
    reason: 'test',
    status: 'generated',
    ttlSeconds: 30,
    createdAt: new Date().toISOString(),
  };
}

function snapshot(book: OrderBookQuote): StateSnapshot {
  const now = Date.now();
  const startSeconds = Math.floor(now / 1_000) + 300;
  const roundId = `btc-updown-5m-${startSeconds}`;
  return {
    id: 'snapshot',
    profileId: 'btc-5m',
    asset: 'btc',
    interval: '5m',
    capturedAt: new Date(now).toISOString(),
    round: {
      id: roundId,
      eventSlug: roundId,
      title: 'BTC Up or Down',
      phase: 'decision',
      startAt: new Date(startSeconds * 1_000).toISOString(),
      endAt: new Date((startSeconds + 300) * 1_000).toISOString(),
      secondsToStart: 300,
      secondsToEnd: 600,
      strike: 60_000,
      strikeStatus: 'locked',
      yesTokenId: 'yes-token',
      noTokenId: 'no-token',
    },
    features: { price: 60_000 } as StateSnapshot['features'],
    regime: 'CHOP',
    orderbooks: [book],
    positions: [],
    positionReadStatus: 'disabled',
    diagnostics: [],
  };
}

function quote(bestAsk: number, updatedAt = new Date().toISOString()): OrderBookQuote {
  return {
    tokenId: 'yes-token',
    bestBid: bestAsk - 0.01,
    bestAsk,
    midpoint: bestAsk - 0.005,
    spread: 0.01,
    bidDepth: 10,
    askDepth: 10,
    imbalance: 0,
    updatedAt,
    source: 'ws',
    bids: [{ price: bestAsk - 0.01, size: 10 }],
    asks: [{ price: bestAsk, size: 10 }],
  };
}
