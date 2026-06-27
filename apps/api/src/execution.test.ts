import test from 'node:test';
import assert from 'node:assert/strict';

import type { AppConfig } from './config';
import { executeLiveIntents } from './execution';
import { InMemoryStore } from './store';
import type { PolymarketAdapter } from '../../../packages/polymarket/src';
import type { StateSnapshot, TradeIntent } from '../../../packages/shared/src';
import type { StrategyRiskConfig } from '../../../packages/strategy/src';

test('blocks a paired live entry batch when active BUY orders leave insufficient collateral', async () => {
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });
  const intents = [intent('YES'), intent('NO')];
  store.recordIntents(intents);
  let posted = 0;
  const adapter = {
    async getCollateralBalanceAllowance() {
      return { balance: 6.5, allowance: 20 };
    },
    async getOpenOrders() {
      return [
        {
          id: 'existing-buy',
          tokenId: 'other-token',
          side: 'BUY',
          price: 0.44,
          size: 10,
          sizeMatched: 0,
          status: 'live',
          raw: {},
        },
      ];
    },
    async executeLimitIntent() {
      posted += 1;
      return { ok: true, orderId: 'unexpected', price: 0.44, size: 10 };
    },
  } as unknown as PolymarketAdapter;

  const diagnostics = await executeLiveIntents({
    appConfig: appConfig(),
    adapter,
    store,
    snapshot: snapshot(),
    intents,
    risk: risk(),
  });

  assert.equal(posted, 0);
  assert.match(diagnostics[0], /INSUFFICIENT_AVAILABLE_COLLATERAL/);
  const storedIntents = (store as unknown as { intents: TradeIntent[] }).intents;
  assert.equal(storedIntents.filter((item) => item.status === 'rejected').length, 2);
  assert.ok(storedIntents.every((item) => item.rejectionReason === 'INSUFFICIENT_AVAILABLE_COLLATERAL'));
});

test('posts live entry orders as GTD limits expiring at round start', async () => {
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });
  const intents = [intent('YES')];
  store.recordIntents(intents);
  const startAt = new Date(Date.now() + 20_000).toISOString();
  let postedOptions: { execute: boolean; orderType?: string; expiration?: number } | undefined;
  const adapter = {
    async getCollateralBalanceAllowance() {
      return { balance: 20, allowance: 20 };
    },
    async getOpenOrders() {
      return [];
    },
    async executeLimitIntent(_intent: TradeIntent, options: { execute: boolean; orderType?: string; expiration?: number }) {
      postedOptions = options;
      return { ok: true, orderId: 'entry-order', price: 0.44, size: 10 };
    },
  } as unknown as PolymarketAdapter;

  const diagnostics = await executeLiveIntents({
    appConfig: appConfig(),
    adapter,
    store,
    snapshot: snapshot({ startAt }),
    intents,
    risk: risk(),
  });

  assert.deepEqual(diagnostics, []);
  assert.equal(postedOptions?.orderType, 'GTD');
  assert.equal(postedOptions?.expiration, Math.floor(new Date(startAt).getTime() / 1000));
});

test('blocks duplicate experimental side after a non-failed order already exists', async () => {
  const store = new InMemoryStore('live', 2_000, { persistencePath: false }, 'experiment_next_round');
  const existing = intent('NO', { strategy: 'BTC5M_NEXT_ROUND_50_49_STOP_ON_SINGLE' });
  store.recordOrder({
    id: 'filled-experiment-down',
    intentId: existing.id,
    strategy: existing.strategy,
    strategyProfile: 'experiment_next_round',
    executionKey: [existing.roundId, existing.strategy, existing.tokenId, existing.side].join(':'),
    roundId: existing.roundId,
    eventSlug: existing.roundId,
    tokenId: existing.tokenId,
    label: existing.label,
    side: existing.side,
    price: existing.limitPrice,
    size: existing.shares,
    status: 'filled',
    createdAt: new Date().toISOString(),
  });
  let posted = 0;
  const adapter = adapterStub(() => {
    posted += 1;
    return { ok: true, orderId: 'unexpected', price: 0.49, size: 5 };
  });

  const diagnostics = await executeLiveIntents({
    appConfig: appConfig(),
    adapter,
    store,
    snapshot: snapshot({ startAt: new Date(Date.now() + 20_000).toISOString() }),
    intents: [existing],
    risk: risk(),
  });

  assert.equal(posted, 0);
  assert.match(diagnostics[0], /LOCAL_STRATEGY_ORDER_EXISTS/);
});

test('blocks GTD posting when round start is too close', async () => {
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });
  const nearStart = new Date(Date.now() + 1_000).toISOString();
  let posted = 0;
  const adapter = adapterStub(() => {
    posted += 1;
    return { ok: true, orderId: 'unexpected', price: 0.44, size: 10 };
  });

  const diagnostics = await executeLiveIntents({
    appConfig: appConfig(),
    adapter,
    store,
    snapshot: snapshot({ startAt: nearStart, secondsToStart: 1 }),
    intents: [intent('YES')],
    risk: risk(),
  });

  assert.equal(posted, 0);
  assert.match(diagnostics[0], /ROUND_START_TOO_CLOSE_FOR_GTD/);
});

function intent(label: 'YES' | 'NO', patch: Partial<TradeIntent> = {}): TradeIntent {
  return {
    id: `intent-${label}`,
    strategy: 'BTC5M_DUAL_45',
    roundId: 'btc-updown-5m-1782432000',
    tokenId: `${label.toLowerCase()}-token`,
    label,
    side: 'BUY',
    orderType: 'LIMIT',
    limitPrice: 0.44,
    shares: 10,
    reason: 'test paired entry',
    status: 'generated',
    ttlSeconds: 30,
    createdAt: new Date().toISOString(),
    ...patch,
  };
}

function adapterStub(executeLimitIntent: () => { ok: boolean; orderId: string; price: number; size: number }): PolymarketAdapter {
  return {
    async getCollateralBalanceAllowance() {
      return { balance: 20, allowance: 20 };
    },
    async getOpenOrders() {
      return [];
    },
    async executeLimitIntent() {
      return executeLimitIntent();
    },
  } as unknown as PolymarketAdapter;
}

function appConfig(): AppConfig {
  return {
    ownerPrivateKey: '0xabc',
    depositWallet: '0xwallet',
    marketConfig: {
      avoidExpirySeconds: 30,
    },
  } as AppConfig;
}

function risk(): StrategyRiskConfig {
  return {
    maxOrderbookAgeSeconds: 5,
  } as StrategyRiskConfig;
}

function snapshot(patch: Partial<StateSnapshot['round']> = {}): StateSnapshot {
  const now = Date.now();
  return {
    id: 'snapshot-test',
    capturedAt: new Date(now).toISOString(),
    round: {
      id: 'btc-updown-5m-1782432000',
      phase: 'decision',
      eventSlug: 'btc-updown-5m-1782432000',
      startAt: new Date(now + 20_000).toISOString(),
      endAt: new Date(now + 320_000).toISOString(),
      secondsToStart: 20,
      secondsToEnd: 320,
      strike: 60_000,
      strikeStatus: 'estimated',
      yesTokenId: 'yes-token',
      noTokenId: 'no-token',
      ...patch,
    },
    features: {} as StateSnapshot['features'],
    regime: 'CHOP',
    orderbooks: [
      quote('yes-token'),
      quote('no-token'),
    ],
    positions: [],
    positionReadStatus: 'disabled',
    diagnostics: [],
  };
}

function quote(tokenId: string): StateSnapshot['orderbooks'][number] {
  return {
    tokenId,
    bestBid: 0.43,
    bestAsk: 0.45,
    midpoint: 0.44,
    spread: 0.02,
    bidDepth: 100,
    askDepth: 100,
    imbalance: 0,
    updatedAt: new Date().toISOString(),
    source: 'ws',
  };
}
