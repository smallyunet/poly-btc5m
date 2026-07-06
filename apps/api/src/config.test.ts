import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from './config';

const COOLDOWN_ENV_KEYS = [
  'SINGLE_FILL_COOLDOWN_BASE_MS',
  'SINGLE_FILL_COOLDOWN_PRICE_CAP_MS',
  'SINGLE_FILL_COOLDOWN_EXECUTION_MS',
  'SINGLE_FILL_COOLDOWN_REPEAT_WINDOW_MS',
  'SINGLE_FILL_COOLDOWN_SECOND_MS',
  'SINGLE_FILL_COOLDOWN_THIRD_MS',
  'BTC_5M_SINGLE_FILL_COOLDOWN_BASE_MS',
  'BTC_15M_SINGLE_FILL_COOLDOWN_BASE_MS',
  'BTC_1H_SINGLE_FILL_COOLDOWN_BASE_MS',
  'ETH_5M_PROFILE_STATUS',
  'ETH_15M_PROFILE_STATUS',
  'ETH_1H_PROFILE_STATUS',
  'ETH_15M_SINGLE_FILL_COOLDOWN_BASE_MS',
  'DOGE_5M_PROFILE_STATUS',
  'DOGE_15M_PROFILE_STATUS',
  'DOGE_1H_PROFILE_STATUS',
  'DOGE_15M_SINGLE_FILL_COOLDOWN_BASE_MS',
  'BINANCE_WS_URL',
  '5M_SINGLE_FILL_COOLDOWN_BASE_MS',
  '15M_SINGLE_FILL_COOLDOWN_BASE_MS',
  '1H_SINGLE_FILL_COOLDOWN_BASE_MS',
  'SINGLE_FILL_LOSS_EXIT_ENABLED',
  'SINGLE_FILL_LOSS_EXIT_MAX_LOSS_USD',
  'SINGLE_FILL_LOSS_EXIT_MIN_BID',
  'SINGLE_FILL_LOSS_EXIT_PRICE_OFFSET',
  'SINGLE_FILL_LOSS_EXIT_MAX_ORDERBOOK_AGE_MS',
  'SINGLE_FILL_LOSS_EXIT_MIN_SECONDS_TO_END',
  'SINGLE_FILL_LOSS_EXIT_MAX_SECONDS_TO_END',
  'CROSS_PROFILE_SINGLE_FILL_RISK_ENABLED',
];

test('market profile cooldown defaults use the five-minute baseline for every interval', () => {
  withEnv(COOLDOWN_ENV_KEYS, {}, () => {
    const config = loadConfig();
    const byId = new Map(config.marketProfiles.map((profile) => [profile.id, profile]));

    assert.equal(byId.get('btc-5m')?.cooldown.baseMs, 30 * 60_000);
    assert.equal(byId.get('btc-15m')?.cooldown.baseMs, 30 * 60_000);
    assert.equal(byId.get('btc-1h')?.cooldown.baseMs, 30 * 60_000);
    assert.equal(byId.get('btc-15m')?.cooldown.priceCapMs, 60 * 60_000);
    assert.equal(byId.get('btc-1h')?.cooldown.executionMs, 2 * 60 * 60_000);
    assert.equal(config.crossProfileSingleFillRiskEnabled, true);
  });
});

test('cross-profile single-fill risk can be disabled by env override', () => {
  withEnv(COOLDOWN_ENV_KEYS, {
    CROSS_PROFILE_SINGLE_FILL_RISK_ENABLED: 'false',
  }, () => {
    const config = loadConfig();

    assert.equal(config.crossProfileSingleFillRiskEnabled, false);
  });
});

test('market profile cooldown supports profile-specific env override', () => {
  withEnv(COOLDOWN_ENV_KEYS, {
    SINGLE_FILL_COOLDOWN_BASE_MS: String(11 * 60_000),
    BTC_15M_SINGLE_FILL_COOLDOWN_BASE_MS: String(22 * 60_000),
  }, () => {
    const config = loadConfig();
    const byId = new Map(config.marketProfiles.map((profile) => [profile.id, profile]));

    assert.equal(config.singleFillCooldownBaseMs, 11 * 60_000);
    assert.equal(byId.get('btc-5m')?.cooldown.baseMs, 30 * 60_000);
    assert.equal(byId.get('btc-15m')?.cooldown.baseMs, 22 * 60_000);
    assert.equal(byId.get('btc-1h')?.cooldown.baseMs, 30 * 60_000);
  });
});

test('ETH and DOGE recurring profiles can be enabled independently from BTC profiles', () => {
  withEnv(COOLDOWN_ENV_KEYS, {
    ETH_5M_PROFILE_STATUS: 'monitor',
    ETH_15M_PROFILE_STATUS: 'live',
    ETH_1H_PROFILE_STATUS: 'disabled',
    ETH_15M_SINGLE_FILL_COOLDOWN_BASE_MS: String(44 * 60_000),
    DOGE_5M_PROFILE_STATUS: 'monitor',
    DOGE_15M_PROFILE_STATUS: 'live',
    DOGE_1H_PROFILE_STATUS: 'disabled',
    DOGE_15M_SINGLE_FILL_COOLDOWN_BASE_MS: String(55 * 60_000),
  }, () => {
    const config = loadConfig();
    const byId = new Map(config.marketProfiles.map((profile) => [profile.id, profile]));

    assert.equal(byId.get('eth-5m')?.status, 'monitor');
    assert.equal(byId.get('eth-15m')?.status, 'live');
    assert.equal(byId.get('eth-1h')?.status, 'disabled');
    assert.equal(byId.get('eth-5m')?.seriesSlug, 'eth-updown-5m');
    assert.equal(byId.get('eth-15m')?.priceFeedSymbol, 'ethusdt');
    assert.equal(byId.get('eth-15m')?.cooldown.baseMs, 44 * 60_000);
    assert.equal(byId.get('doge-5m')?.status, 'monitor');
    assert.equal(byId.get('doge-15m')?.status, 'live');
    assert.equal(byId.get('doge-1h')?.status, 'disabled');
    assert.equal(byId.get('doge-5m')?.seriesSlug, 'doge-updown-5m');
    assert.equal(byId.get('doge-15m')?.priceFeedSymbol, 'dogeusdt');
    assert.equal(byId.get('doge-15m')?.cooldown.baseMs, 55 * 60_000);
    assert.equal(byId.get('sol-5m')?.status, 'disabled');
  });
});

test('enabled DOGE profiles are added to an existing Binance multi-stream URL', () => {
  withEnv(COOLDOWN_ENV_KEYS, {
    BINANCE_WS_URL: 'wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/ethusdt@aggTrade',
    DOGE_5M_PROFILE_STATUS: 'monitor',
  }, () => {
    const config = loadConfig();

    assert.match(config.binanceWsUrl, /btcusdt@aggTrade/);
    assert.match(config.binanceWsUrl, /ethusdt@aggTrade/);
    assert.match(config.binanceWsUrl, /dogeusdt@aggTrade/);
  });
});

test('enabled DOGE profiles upgrade an existing Binance single-stream URL', () => {
  withEnv(COOLDOWN_ENV_KEYS, {
    BINANCE_WS_URL: 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade',
    DOGE_5M_PROFILE_STATUS: 'monitor',
  }, () => {
    const config = loadConfig();

    assert.equal(config.binanceWsUrl, 'wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/dogeusdt@aggTrade');
  });
});

function withEnv(keys: string[], patch: Record<string, string>, fn: () => void): void {
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, patch);
  try {
    fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
