import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from './config';
import { MarketDataService, scoreChop } from './marketData';
import { InMemoryStore } from './store';
import type { MarketProfile } from '../../../packages/shared/src';

test('does not reward range beyond the minimum activity gate', () => {
  const base = {
    cross120s: 3,
    rangeBps120s: 3,
    minBiExcursionBps120s: 2,
    excursionBalance120s: 1,
    driftRatio120s: 0.2,
    momentumRatio30s: 0.12,
    rangePercentile120s: null,
  };

  assert.equal(scoreChop({ ...base, rangeBps120s: 30 }), scoreChop(base));
});

test('penalizes one-sided excursion even when total range is large', () => {
  const balanced = scoreChop({
    cross120s: 3,
    rangeBps120s: 10,
    minBiExcursionBps120s: 2,
    excursionBalance120s: 1,
    driftRatio120s: 0.2,
    momentumRatio30s: 0.12,
    rangePercentile120s: null,
  });
  const oneSided = scoreChop({
    cross120s: 3,
    rangeBps120s: 10,
    minBiExcursionBps120s: 0.4,
    excursionBalance120s: 0.08,
    driftRatio120s: 0.2,
    momentumRatio30s: 0.12,
    rangePercentile120s: null,
  });

  assert.ok(balanced - oneSided >= 30);
});

test('keeps Binance price samples isolated by profile symbol', () => {
  const config = loadConfig();
  config.binancePriceSampleMs = 1;
  const btcProfile = config.marketProfiles.find((profile) => profile.id === 'btc-5m') as MarketProfile;
  const ethProfile = config.marketProfiles.find((profile) => profile.id === 'eth-5m') as MarketProfile;
  const dogeProfile = config.marketProfiles.find((profile) => profile.id === 'doge-5m') as MarketProfile;
  const service = new MarketDataService(config, new InMemoryStore('monitor', 2_000, { persistencePath: false }));
  const injected = service as unknown as {
    binanceConnected: boolean;
    handleBinancePriceMessage(data: string): void;
    handleOrderbookMessage(data: string): void;
  };

  injected.binanceConnected = true;
  injected.handleBinancePriceMessage(JSON.stringify({ stream: 'btcusdt@aggTrade', data: { s: 'BTCUSDT', p: '100000' } }));
  injected.handleBinancePriceMessage(JSON.stringify({ stream: 'ethusdt@aggTrade', data: { s: 'ETHUSDT', p: '3500' } }));
  injected.handleBinancePriceMessage(JSON.stringify({ stream: 'dogeusdt@aggTrade', data: { s: 'DOGEUSDT', p: '0.20' } }));

  assert.equal(service.latestPrice(btcProfile), 100000);
  assert.equal(service.latestPrice(ethProfile), 3500);
  assert.equal(service.latestPrice(dogeProfile), 0.20);
  assert.equal(service.status(btcProfile).priceSamples, 1);
  assert.equal(service.status(ethProfile).priceSamples, 1);
  assert.equal(service.status(dogeProfile).priceSamples, 1);
  assert.equal(service.features({ eventSlug: 'btc-updown-5m-1', startAt: '', endAt: '', strike: 99990, yesTokenId: 'btc-yes', noTokenId: 'btc-no' }, btcProfile).price, 100000);
  assert.equal(service.features({ eventSlug: 'eth-updown-5m-1', startAt: '', endAt: '', strike: 3490, yesTokenId: 'eth-yes', noTokenId: 'eth-no' }, ethProfile).price, 3500);
  assert.equal(service.features({ eventSlug: 'doge-updown-5m-1', startAt: '', endAt: '', strike: 0.19, yesTokenId: 'doge-yes', noTokenId: 'doge-no' }, dogeProfile).price, 0.20);

  injected.handleOrderbookMessage(JSON.stringify({ asset_id: 'btc-yes', bids: [{ price: '0.45', size: '10' }], asks: [{ price: '0.46', size: '10' }] }));
  const btcBookAt = service.status(btcProfile, ['btc-yes']).lastOrderbookAt;

  injected.handleOrderbookMessage(JSON.stringify({ asset_id: 'eth-yes', bids: [{ price: '0.44', size: '8' }], asks: [{ price: '0.47', size: '8' }] }));
  assert.equal(service.status(btcProfile, ['btc-yes']).lastOrderbookAt, btcBookAt);
  assert.ok(service.status(ethProfile, ['eth-yes']).lastOrderbookAt);
});
