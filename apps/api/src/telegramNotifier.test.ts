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
  let parseMode = '';
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
      profileId: 'btc-5m',
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
      profileId: 'btc-5m',
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
      profileId: 'btc-5m',
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
    const body = JSON.parse(String(init?.body));
    sentText = body.text;
    parseMode = body.parse_mode;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, async () => {
    await notifier.notifyAfterTick(state);
  });

  assert.equal(balanceReads, 1);
  assert.deepEqual(markedRoundKeys, [`btc-5m:${roundId}:settled`]);
  assert.equal(parseMode, 'HTML');
  assert.match(sentText, /BTC 5m Round Summary/);
  assert.match(sentText, /<b>PnL<\/b>/);
  assert.match(sentText, /Round: 🟢 PROFIT \+\$5\.50/);
  assert.match(sentText, /Settled: 🟢 PROFIT \+\$5\.50/);
  assert.match(sentText, /<b>Account<\/b>/);
  assert.match(sentText, /Balance: \$12\.34/);
  assert.doesNotMatch(sentText, /<pre>/);
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
      profileId: 'btc-5m',
      asset: 'btc',
      interval: '5m',
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
  assert.deepEqual(markedRoundKeys, ['btc-5m:btc-updown-5m-2000:settled']);
});

test('sends idle summary with per-profile rows', async () => {
  let sentText = '';
  const notificationState: TelegramNotificationState = { notifiedRoundSummaryKeys: [] };
  const notifier = new TelegramNotifier({
    appConfig: { ...config(), telegramIdleSummaryIntervalMs: 1 },
    store: fakeStore({
      getTelegramNotificationState: () => notificationState,
      markTelegramIdleSummaryNotified: (sentAt?: string) => {
        notificationState.lastIdleSummaryAt = sentAt || new Date().toISOString();
      },
    }),
    adapter: {
      async getCollateralBalanceAllowance() {
        return { balance: 12.34, allowance: 20 };
      },
    } as PolymarketAdapter,
  });

  const oldTime = new Date(Date.now() - 60_000).toISOString();
  const state = dashboardState({
    runtime: {
      ...dashboardState().runtime,
      startedAt: oldTime,
    },
    profiles: dashboardState().profiles.map((profile) => ({
      ...profile,
      latestSnapshot: profile.latestSnapshot ? { ...profile.latestSnapshot, capturedAt: oldTime } : undefined,
    })),
  });

  await withFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    sentText = body.text;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, async () => {
    await notifier.notifyAfterTick(state);
  });

  assert.match(sentText, /Profile Idle Summary/);
  assert.match(sentText, /BTC 5m:/);
  assert.match(sentText, /BTC 15m:/);
  assert.match(sentText, /BTC 1h:/);
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
    intents: [],
    orders: [],
    fills: [],
    settlements: [],
    runtimeLogs: [],
    rules: [],
    profiles: [
      profileState('btc-5m', 'BTC 5m', '5m'),
      profileState('btc-15m', 'BTC 15m', '15m'),
      profileState('btc-1h', 'BTC 1h', '1h'),
    ],
    ...overrides,
  };
}

function profileState(id: 'btc-5m' | 'btc-15m' | 'btc-1h', label: string, interval: '5m' | '15m' | '1h'): DashboardState['profiles'][number] {
  const duration = interval === '5m' ? 300 : interval === '15m' ? 900 : 3600;
  const snapshot = {
    ...baseSnapshot(),
    profileId: id,
    interval,
    round: {
      ...baseSnapshot().round,
      id: `btc-updown-${interval}-3000`,
      eventSlug: `btc-updown-${interval}-3000`,
      title: `${label} current round`,
    },
  };
  return {
    profile: {
      id,
      asset: 'btc',
      assetSymbol: 'BTC',
      interval,
      label,
      status: interval === '5m' ? 'live' : 'monitor',
      seriesSlug: `btc-updown-${interval}`,
      title: `Polymarket ${label}`,
      roundDurationSeconds: duration,
      decisionLeadSeconds: interval === '5m' ? 30 : 90,
      avoidExpirySeconds: 30,
      priceFeedSymbol: 'btcusdt',
      entry: { enabled: true, limitPrice: 0.45, sharesPerSide: 5, minSecondsToStart: 15, confirmTicks: 3 },
      profitExit: { enabled: true, minProfitRate: 0.05, minPnlUsd: 0.3, priceOffset: 0.01, maxOrderbookAgeMs: 1000, minSecondsToEnd: 20, maxSecondsToEnd: 240 },
      hedge: { enabled: true, earlyWindowSeconds: 60, earlyMaxPairCost: 1.02, emergencyWindowSeconds: 15, emergencyMaxPrice: 0.75, emergencyMaxPairCost: 1.2, finalWindowSeconds: 30, minSecondsToEnd: 5, maxPrice: 0.65, priceOffset: 0.01, maxPairCost: 1.1 },
      cooldown: { baseMs: 900000, priceCapMs: 1800000, executionMs: 3600000, repeatWindowMs: 3600000, secondMs: 3600000, thirdMs: 3600000 },
    },
    feed: { binanceConnected: true, clobConnected: true, priceSamples: 1, source: 'live' },
    latestSnapshot: snapshot,
    strategyChecks: [],
    stats: { orders: 0, fills: 0, settlements: 0, settledPnl: 0 },
  };
}

function baseSnapshot(): NonNullable<DashboardState['profiles'][number]['latestSnapshot']> {
  return {
    profileId: 'btc-5m',
    asset: 'btc',
    interval: '5m',
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
