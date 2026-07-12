import assert from 'node:assert/strict';
import test from 'node:test';

import type { MarketProfile } from '../../../packages/shared/src';
import type { PolymarketAdapter } from '../../../packages/polymarket/src';
import { loadConfig } from './config';
import { runAllProfilesTick, runBotTick } from './runtime';
import { InMemoryStore } from './store';

test('entry signal confirmation counts are isolated by market profile', () => {
  const store = new InMemoryStore('live', 2_000, { persistencePath: false });

  assert.equal(store.recordEntrySignal('btc-5m:round-a', true), 1);
  assert.equal(store.recordEntrySignal('btc-15m:round-b', true), 1);
  assert.equal(store.recordEntrySignal('btc-5m:round-a', true), 2);
  assert.equal(store.recordEntrySignal('btc-15m:round-b', true), 2);

  assert.equal(store.recordEntrySignal('btc-5m:round-c', true), 1);
  assert.equal(store.recordEntrySignal('btc-15m:round-b', true), 3);
  assert.equal(store.recordEntrySignal('btc-5m:round-a', true), 1);
});

test('runAllProfilesTick captures isolated six-asset 5m, 15m, and 1h profile snapshots', async () => {
  const config = loadConfig();
  config.executionMode = 'monitor';
  config.ownerPrivateKey = undefined;
  config.depositWallet = undefined;
  config.pm5mSimPriceEnabled = false;
  config.pm5mSimRequirePositiveEv = false;
  config.pm5mSimRequireAvailable = false;
  config.pm5mAssetSelectorEnabled = false;
  config.pm5mTailEntryEnabled = false;
  config.dualEntryEnabled = true;
  config.marketProfiles = config.marketProfiles.map((profile) => (
    { ...profile, status: 'monitor' }
  ));
  const enabledProfiles = config.marketProfiles.filter((profile) => profile.status !== 'disabled');
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false }, 'classic', undefined, config.marketProfiles);
  const syncedTokens: string[][] = [];
  let activeDiscoveries = 0;
  let maxConcurrentDiscoveries = 0;

  const data = {
    latestPrice() {
      return 100000;
    },
    syncClobRound(round: { yesTokenId: string; noTokenId: string }, extraTokenIds: string[]) {
      syncedTokens.push([round.yesTokenId, round.noTokenId, ...extraTokenIds].filter(Boolean));
    },
    refreshOrderbooks() {
      return [];
    },
    refreshOrderbooksForTokenIds() {
      return [];
    },
    features(round: { strike: number }) {
      return {
        price: 100000,
        strike: round.strike,
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
        latestRangePosition120s: null,
        upExcursionBps120s: 0,
        downExcursionBps120s: 0,
        minBiExcursionBps120s: 0,
        excursionBalance120s: 0,
        centerUpExcursionBps120s: 0,
        centerDownExcursionBps120s: 0,
        centerMinBiExcursionBps120s: 0,
        centerExcursionBalance120s: 0,
        driftRatio120s: 1,
        momentumRatio30s: 1,
        rangePercentile120s: null,
        chopScore: 0,
        samples120s: 1,
        source: 'binance' as const,
        updatedAt: new Date().toISOString(),
      };
    },
    status() {
      return { binanceConnected: true, clobConnected: true, priceSamples: 1, source: 'live' as const };
    },
  };
  const discovery = {
    async discover(params: { profile: MarketProfile }) {
      activeDiscoveries += 1;
      maxConcurrentDiscoveries = Math.max(maxConcurrentDiscoveries, activeDiscoveries);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeDiscoveries -= 1;
      const nowSec = Math.floor(Date.now() / 1000);
      const startSec = Math.floor(nowSec / params.profile.roundDurationSeconds) * params.profile.roundDurationSeconds + params.profile.roundDurationSeconds;
      const slug = `${params.profile.seriesSlug}-${startSec}`;
      return {
        diagnostics: [],
        round: {
          eventSlug: slug,
          title: `${params.profile.label} test round`,
          startAt: new Date((Date.now() + 60_000)).toISOString(),
          endAt: new Date(Date.now() + 60_000 + params.profile.roundDurationSeconds * 1000).toISOString(),
          strike: 100000,
          yesTokenId: `${params.profile.id}-yes`,
          noTokenId: `${params.profile.id}-no`,
        },
      };
    },
  };
  const participation = {
    async refresh() {
      return {
        status: 'disabled' as const,
        updatedAt: new Date().toISOString(),
        topHoldersPerSide: 0,
        maxPositionPnl: null,
        totalTopHolderShares: 0,
        totalPositionPnl: 0,
        sides: [],
        diagnostics: [],
      };
    },
  };
  const adapter = {
    async getPortfolioPositions() {
      return [];
    },
    async getCollateralBalanceAllowance() {
      return { balance: 0, allowance: 0 };
    },
  } as unknown as PolymarketAdapter;

  const snapshots = await runAllProfilesTick(config, store, data as never, adapter, discovery as never, participation as never);
  const dashboard = store.dashboardState();
  const entryChecks = dashboard.profiles
    .map((item) => item.strategyChecks.find((check) => check.strategy === 'UPDOWN_DUAL_ENTRY'))
    .filter(Boolean);

  assert.deepEqual(snapshots.map((snapshot) => snapshot.profileId).sort(), enabledProfiles.map((profile) => profile.id).sort());
  assert.ok(maxConcurrentDiscoveries > 1);
  assert.equal(dashboard.profiles.length, enabledProfiles.length);
  assert.deepEqual(dashboard.profiles.map((item) => item.profile.id).sort(), [
    'btc-15m', 'btc-1h', 'btc-5m',
    'doge-15m', 'doge-1h', 'doge-5m',
    'eth-15m', 'eth-1h', 'eth-5m',
    'hype-15m', 'hype-1h', 'hype-5m',
    'sol-15m', 'sol-1h', 'sol-5m',
    'xrp-15m', 'xrp-1h', 'xrp-5m',
  ]);
  assert.deepEqual(syncedTokens.flat().filter((token) => token.endsWith('-yes')).sort(), [
    'btc-15m-yes', 'btc-1h-yes', 'btc-5m-yes',
    'doge-15m-yes', 'doge-1h-yes', 'doge-5m-yes',
    'eth-15m-yes', 'eth-1h-yes', 'eth-5m-yes',
    'hype-15m-yes', 'hype-1h-yes', 'hype-5m-yes',
    'sol-15m-yes', 'sol-1h-yes', 'sol-5m-yes',
    'xrp-15m-yes', 'xrp-1h-yes', 'xrp-5m-yes',
  ]);
  assert.equal(entryChecks.length, enabledProfiles.length);
  assert.ok(entryChecks.every((check) => check?.status === 'eligible'));
  assert.ok(entryChecks.every((check) => /bypassed/.test(check?.conditions.find((condition) => condition.label === 'Entry signal confirmation')?.actual || '')));
});

test('runBotTick blocks 5m entry intents when the asset selector does not select the profile', async () => {
  const config = loadConfig();
  config.executionMode = 'monitor';
  config.ownerPrivateKey = undefined;
  config.depositWallet = undefined;
  config.pm5mSimPriceEnabled = false;
  config.pm5mSimRequirePositiveEv = false;
  config.pm5mSimRequireAvailable = false;
  config.pm5mAssetSelectorEnabled = true;
  config.pm5mTailEntryEnabled = false;
  config.dualEntryEnabled = true;
  const profile = { ...config.marketProfiles.find((item) => item.id === 'btc-5m')!, status: 'monitor' as const };
  config.marketProfiles = [profile];
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false }, 'classic', undefined, config.marketProfiles);

  const data = {
    latestPrice() {
      return 100000;
    },
    syncClobRound() {},
    refreshOrderbooks() {
      return [];
    },
    refreshOrderbooksForTokenIds() {
      return [];
    },
    features(round: { strike: number }) {
      return {
        price: 100000,
        strike: round.strike,
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
        latestRangePosition120s: null,
        upExcursionBps120s: 0,
        downExcursionBps120s: 0,
        minBiExcursionBps120s: 0,
        excursionBalance120s: 0,
        centerUpExcursionBps120s: 0,
        centerDownExcursionBps120s: 0,
        centerMinBiExcursionBps120s: 0,
        centerExcursionBalance120s: 0,
        driftRatio120s: 1,
        momentumRatio30s: 1,
        rangePercentile120s: null,
        chopScore: 0,
        samples120s: 1,
        source: 'binance' as const,
        updatedAt: new Date().toISOString(),
      };
    },
    status() {
      return { binanceConnected: true, clobConnected: true, priceSamples: 1, source: 'live' as const };
    },
  };
  const discovery = {
    async discover(params: { profile: MarketProfile }) {
      return {
        diagnostics: [],
        round: {
          eventSlug: `${params.profile.seriesSlug}-1`,
          title: `${params.profile.label} test round`,
          startAt: new Date(Date.now() + 60_000).toISOString(),
          endAt: new Date(Date.now() + 360_000).toISOString(),
          strike: 100000,
          yesTokenId: `${params.profile.id}-yes`,
          noTokenId: `${params.profile.id}-no`,
        },
      };
    },
  };
  const participation = {
    async refresh() {
      return {
        status: 'disabled' as const,
        updatedAt: new Date().toISOString(),
        topHoldersPerSide: 0,
        maxPositionPnl: null,
        totalTopHolderShares: 0,
        totalPositionPnl: 0,
        sides: [],
        diagnostics: [],
      };
    },
  };
  const adapter = {
    async getPortfolioPositions() {
      return [];
    },
    async getCollateralBalanceAllowance() {
      return { balance: 0, allowance: 0 };
    },
  } as unknown as PolymarketAdapter;

  await runBotTick(config, store, data as never, adapter, discovery as never, participation as never, profile, {
    profileId: 'btc-5m',
    selected: false,
    rank: 2,
    score: 0.01,
    reason: '5m asset selector rejected rank #2; outside top 1',
  });

  const dashboard = store.dashboardState();
  const entryCheck = dashboard.profiles[0].strategyChecks.find((check) => check.strategy === 'UPDOWN_DUAL_ENTRY');

  assert.equal(entryCheck?.status, 'blocked');
  assert.ok(entryCheck?.blockers.includes('PM_ASSET_NOT_SELECTED'));
  assert.equal(dashboard.intents.filter((intent) => intent.status === 'generated').length, 0);
  assert.equal(dashboard.intents.filter((intent) => intent.rejectionReason === 'PM_ASSET_NOT_SELECTED').length, 2);
});
