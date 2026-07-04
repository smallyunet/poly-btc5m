import test from 'node:test';
import assert from 'node:assert/strict';

import type { MarketProfile } from '../../../packages/shared/src';
import type { AppConfig } from './config';
import { RecurringCryptoRoundDiscovery } from './roundDiscovery';

const btc1hProfile: MarketProfile = {
  id: 'btc-1h',
  asset: 'btc',
  assetSymbol: 'BTC',
  interval: '1h',
  label: 'BTC 1h',
  status: 'live',
  seriesSlug: 'btc-updown-1h',
  title: 'Polymarket BTC 1h',
  roundDurationSeconds: 3600,
  decisionLeadSeconds: 1800,
  avoidExpirySeconds: 120,
  priceFeedSymbol: 'btcusdt',
  entry: {
    enabled: true,
    limitPrice: 0.45,
    sharesPerSide: 5,
    minSecondsToStart: 15,
    confirmTicks: 3,
  },
  profitExit: {
    enabled: true,
    minProfitRate: 0.05,
    minPnlUsd: 0.3,
    priceOffset: 0.01,
    maxOrderbookAgeMs: 1000,
    minSecondsToEnd: 60,
    maxSecondsToEnd: 2700,
  },
  hedge: {
    enabled: true,
    earlyWindowSeconds: 1800,
    earlyMaxPairCost: 1.02,
    emergencyWindowSeconds: 60,
    emergencyMaxPrice: 0.75,
    emergencyMaxPairCost: 1.2,
    finalWindowSeconds: 600,
    minSecondsToEnd: 15,
    maxPrice: 0.65,
    priceOffset: 0.01,
    maxPairCost: 1.1,
  },
  cooldown: {
    baseMs: 30 * 60_000,
    priceCapMs: 60 * 60_000,
    executionMs: 2 * 60 * 60_000,
    repeatWindowMs: 2 * 60 * 60_000,
    secondMs: 2 * 60 * 60_000,
    thirdMs: 4 * 60 * 60_000,
  },
};

test('discovers BTC 1h human-readable hourly slug when unix slug is absent', async () => {
  const originalNow = Date.now;
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  Date.now = () => 1783182600 * 1000;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const slug = decodeURIComponent(url.split('/').pop() || '');
    if (slug === 'bitcoin-up-or-down-july-4-2026-12pm-et') {
      return {
        ok: true,
        json: async () => ({
          slug,
          question: 'Bitcoin Up or Down - July 4, 12PM ET',
          endDate: '2026-07-04T17:00:00Z',
          active: true,
          closed: false,
          acceptingOrders: true,
          outcomes: '["Up", "Down"]',
          clobTokenIds: '["up-token", "down-token"]',
          conditionId: 'condition-1',
        }),
      } as Response;
    }
    return {
      ok: false,
      json: async () => null,
    } as Response;
  };

  try {
    const discovery = new RecurringCryptoRoundDiscovery(configWithProfile(btc1hProfile));
    const result = await discovery.discover({ profile: btc1hProfile, latestPrice: 100_000 });

    assert.ok(urls.some((url) => url.endsWith('/markets/slug/btc-updown-1h-1783184400')));
    assert.ok(urls.some((url) => url.endsWith('/markets/slug/bitcoin-up-or-down-july-4-2026-12pm-et')));
    assert.equal(result.round.eventSlug, 'bitcoin-up-or-down-july-4-2026-12pm-et');
    assert.equal(result.round.yesTokenId, 'up-token');
    assert.equal(result.round.noTokenId, 'down-token');
    assert.equal(result.round.startAt, '2026-07-04T17:00:00.000Z');
    assert.equal(result.round.endAt, '2026-07-04T17:00:00.000Z');
    assert.equal(result.diagnostics.length, 0);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

function configWithProfile(profile: MarketProfile): AppConfig {
  return {
    gammaApiUrl: 'https://gamma-api.polymarket.com',
    marketConfig: {
      seriesSlug: profile.seriesSlug,
      title: profile.title,
      roundDurationSeconds: profile.roundDurationSeconds,
      decisionLeadSeconds: profile.decisionLeadSeconds,
      avoidExpirySeconds: profile.avoidExpirySeconds,
      strike: 100_000,
    },
    marketProfiles: [profile],
  } as AppConfig;
}
