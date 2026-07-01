import assert from 'node:assert/strict';
import test from 'node:test';

import type { DashboardState } from '../../../packages/shared/src';
import type { PolymarketAdapter } from '../../../packages/polymarket/src';
import type { AppConfig } from './config';
import type { InMemoryStore, TelegramNotificationState } from './store';
import { TelegramNotifier } from './telegramNotifier';

test('does not read balance when no Telegram notification is pending', async () => {
  let balanceReads = 0;
  const notifier = new TelegramNotifier({
    appConfig: config(),
    store: fakeStore(),
    adapter: {
      async getCollateralBalanceAllowance() {
        balanceReads += 1;
        return { balance: 10, allowance: 10 };
      },
    } as PolymarketAdapter,
  });

  await withFetch(async () => {
    await notifier.notifyAfterTick(dashboardState());
  });

  assert.equal(balanceReads, 0);
});

test('sends a round summary with on-demand balance and marks the summary notified', async () => {
  let balanceReads = 0;
  let sentText = '';
  const markedRoundKeys: string[] = [];
  const roundId = futureRoundId();
  const notifier = new TelegramNotifier({
    appConfig: config(),
    store: fakeStore({
      markTelegramRoundSummaryNotified: (key) => {
        markedRoundKeys.push(key);
      },
    }),
    adapter: {
      async getCollateralBalanceAllowance() {
        balanceReads += 1;
        return { balance: 12.34, allowance: 20 };
      },
    } as PolymarketAdapter,
  });

  const state = dashboardState({
    orders: [{
      id: 'order-1',
      intentId: 'intent-1',
      roundId,
      eventSlug: roundId,
      tokenId: 'yes-token',
      label: 'YES',
      side: 'BUY',
      price: 0.45,
      size: 10,
      status: 'filled',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    }],
    fills: [{
      id: 'fill-1',
      roundId,
      eventSlug: roundId,
      tokenId: 'yes-token',
      label: 'YES',
      side: 'BUY',
      price: 0.45,
      size: 10,
      matchedAt: new Date(Date.now() - 30_000).toISOString(),
    }],
    settlements: [{
      id: `settlement-${roundId}`,
      roundId,
      eventSlug: roundId,
      marketTitle: 'BTC test round',
      resolvedAt: new Date().toISOString(),
      winningLabel: 'YES',
      yesShares: 10,
      noShares: 0,
      totalCost: 4.5,
      payout: 10,
      pnl: 5.5,
      status: 'settled',
    }],
  });

  await withFetch(async (_url, init) => {
    sentText = JSON.parse(String(init?.body)).text;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, async () => {
    await notifier.notifyAfterTick(state);
  });

  assert.equal(balanceReads, 1);
  assert.deepEqual(markedRoundKeys, [`${roundId}:settled`]);
  assert.match(sentText, /BTC5M Round Summary/);
  assert.match(sentText, /Account: balance \$12\.34/);
  assert.doesNotMatch(sentText, /allowance/i);
});

test('bootstraps historical round summaries without sending backlog notifications', async () => {
  let balanceReads = 0;
  let fetchCalls = 0;
  const markedRoundKeys: string[] = [];
  const notificationState: TelegramNotificationState = { notifiedRoundSummaryKeys: [] };
  const notifier = new TelegramNotifier({
    appConfig: config(),
    store: fakeStore({
      getTelegramNotificationState: () => notificationState,
      markTelegramRoundSummaryNotified: (key) => {
        notificationState.notifiedRoundSummaryKeys.push(key);
        markedRoundKeys.push(key);
      },
    }),
    adapter: {
      async getCollateralBalanceAllowance() {
        balanceReads += 1;
        return { balance: 12.34, allowance: 20 };
      },
    } as PolymarketAdapter,
  });

  const state = dashboardState({
    orders: [{
      id: 'old-order-1',
      intentId: 'old-intent-1',
      roundId: 'btc-updown-5m-2000',
      eventSlug: 'btc-updown-5m-2000',
      tokenId: 'yes-token',
      label: 'YES',
      side: 'BUY',
      price: 0.45,
      size: 10,
      status: 'filled',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    }],
    settlements: [{
      id: 'settlement-btc-updown-5m-2000',
      roundId: 'btc-updown-5m-2000',
      eventSlug: 'btc-updown-5m-2000',
      resolvedAt: new Date().toISOString(),
      winningLabel: 'YES',
      yesShares: 10,
      noShares: 0,
      totalCost: 4.5,
      payout: 10,
      pnl: 5.5,
      status: 'settled',
    }],
  });

  await withFetch(async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, async () => {
    await notifier.notifyAfterTick(state);
  });

  assert.equal(balanceReads, 0);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(markedRoundKeys, ['btc-updown-5m-2000:settled']);
});

function config(): AppConfig {
  return {
    telegramNotifyEnabled: true,
    telegramBotToken: 'token',
    telegramChatId: '123',
    telegramRoundSummaryOnOrderOnly: true,
    telegramIdleSummaryIntervalMs: 4 * 60 * 60_000,
  } as AppConfig;
}

function fakeStore(overrides: Partial<InMemoryStore> = {}): InMemoryStore {
  const state: TelegramNotificationState = { notifiedRoundSummaryKeys: [] };
  return {
    getTelegramNotificationState: () => state,
    markTelegramRoundSummaryNotified: (key: string) => state.notifiedRoundSummaryKeys.push(key),
    markTelegramIdleSummaryNotified: (sentAt?: string) => {
      state.lastIdleSummaryAt = sentAt || new Date().toISOString();
    },
    recordRuntimeLog: () => ({
      id: 'log-1',
      createdAt: new Date().toISOString(),
      level: 'info',
      source: 'telegram',
      message: 'test',
    }),
    ...overrides,
  } as unknown as InMemoryStore;
}

function dashboardState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    runtime: {
      status: 'running',
      executionMode: 'monitor',
      startedAt: new Date().toISOString(),
      tickIntervalMs: 2000,
      version: 'test',
      dockerReady: true,
      activeStrategyProfile: 'classic',
    },
    feed: { binanceConnected: true, clobConnected: true, priceSamples: 1, source: 'live' },
    latestSnapshot: {
      id: 'snapshot-1',
      capturedAt: new Date().toISOString(),
      round: {
        id: 'btc-updown-5m-3000',
        phase: 'decision',
        eventSlug: 'btc-updown-5m-3000',
        title: 'BTC current round',
        startAt: new Date(Date.now() + 60_000).toISOString(),
        endAt: new Date(Date.now() + 360_000).toISOString(),
        secondsToStart: 60,
        secondsToEnd: 360,
        strike: 100000,
        strikeStatus: 'locked',
        yesTokenId: 'yes-token',
        noTokenId: 'no-token',
      },
      features: {
        price: 100000,
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
        centerPrice120s: 100000,
        centerCross120s: 0,
        latestRangePosition120s: 0,
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
        updatedAt: new Date().toISOString(),
      },
      regime: 'UNKNOWN',
      orderbooks: [],
      positions: [],
      positionReadStatus: 'enabled',
      diagnostics: [],
    },
    intents: [],
    orders: [],
    fills: [],
    settlements: [],
    runtimeLogs: [],
    rules: [],
    strategyChecks: [],
    ...overrides,
  };
}

function futureRoundId(): string {
  return `btc-updown-5m-${Math.floor(Date.now() / 1000) + 60}`;
}

async function withFetch(run: () => Promise<void>): Promise<void>;
async function withFetch(fetchImpl: typeof fetch, run: () => Promise<void>): Promise<void>;
async function withFetch(first: typeof fetch | (() => Promise<void>), second?: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const fetchImpl = second ? first as typeof fetch : async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  const run = second || first as () => Promise<void>;
  globalThis.fetch = fetchImpl;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
