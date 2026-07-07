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
  'BTC_15M_PROFILE_STATUS',
  'BTC_1H_PROFILE_STATUS',
  'ETH_5M_PROFILE_STATUS',
  'ETH_15M_PROFILE_STATUS',
  'ETH_1H_PROFILE_STATUS',
  'ETH_15M_SINGLE_FILL_COOLDOWN_BASE_MS',
  'SOL_5M_PROFILE_STATUS',
  'SOL_15M_PROFILE_STATUS',
  'SOL_1H_PROFILE_STATUS',
  'SOL_15M_SINGLE_FILL_COOLDOWN_BASE_MS',
  'DOGE_5M_PROFILE_STATUS',
  'DOGE_15M_PROFILE_STATUS',
  'DOGE_1H_PROFILE_STATUS',
  'DOGE_15M_SINGLE_FILL_COOLDOWN_BASE_MS',
  'XRP_5M_PROFILE_STATUS',
  'XRP_15M_PROFILE_STATUS',
  'XRP_1H_PROFILE_STATUS',
  'XRP_15M_SINGLE_FILL_COOLDOWN_BASE_MS',
  'HYPE_5M_PROFILE_STATUS',
  'HYPE_15M_PROFILE_STATUS',
  'HYPE_1H_PROFILE_STATUS',
  'HYPE_15M_SINGLE_FILL_COOLDOWN_BASE_MS',
  'BINANCE_WS_URL',
  'PM5M_SIM_PRICE_ENABLED',
  'PM5M_SIM_PRICE_MIN_ROUNDS',
  'PM5M_SIM_REQUIRE_POSITIVE_EV',
  'PM5M_SIM_MIN_EV_PER_SHARE',
  'PM5M_ASSET_SELECTOR_ENABLED',
  'PM5M_ASSET_SELECTOR_MAX_ASSETS',
  'PM5M_ASSET_SELECTOR_SINGLE_PENALTY',
  'BTC_5M_SIM_PRICE_ENABLED',
  'BTC_5M_SIM_PRICE_MIN_ROUNDS',
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

test('market profile cooldown defaults match the documented global cooldown policy', () => {
  withEnv(COOLDOWN_ENV_KEYS, {}, () => {
    const config = loadConfig();
    const byId = new Map(config.marketProfiles.map((profile) => [profile.id, profile]));

    assert.equal(config.singleFillCooldownBaseMs, 15 * 60_000);
    assert.equal(config.singleFillCooldownPriceCapMs, 30 * 60_000);
    assert.equal(config.singleFillCooldownExecutionMs, 60 * 60_000);
    assert.equal(config.singleFillCooldownRepeatWindowMs, 60 * 60_000);
    assert.equal(config.singleFillCooldownSecondMs, 60 * 60_000);
    assert.equal(config.singleFillCooldownThirdMs, 60 * 60_000);
    assert.equal(byId.get('btc-5m')?.cooldown.baseMs, 15 * 60_000);
    assert.equal(byId.get('btc-15m')?.cooldown.baseMs, 15 * 60_000);
    assert.equal(byId.get('btc-1h')?.cooldown.baseMs, 15 * 60_000);
    assert.equal(byId.get('btc-15m')?.cooldown.priceCapMs, 30 * 60_000);
    assert.equal(byId.get('btc-1h')?.cooldown.executionMs, 60 * 60_000);
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

test('PM 5m simulator price config supports generic env and legacy BTC env fallback', () => {
  withEnv(COOLDOWN_ENV_KEYS, {
    BTC_5M_SIM_PRICE_ENABLED: 'true',
    BTC_5M_SIM_PRICE_MIN_ROUNDS: '80',
  }, () => {
    const config = loadConfig();

    assert.equal(config.pm5mSimPriceEnabled, true);
    assert.equal(config.pm5mSimPriceMinRounds, 80);
  });

  withEnv(COOLDOWN_ENV_KEYS, {
    PM5M_SIM_PRICE_ENABLED: 'false',
    PM5M_SIM_PRICE_MIN_ROUNDS: '120',
    BTC_5M_SIM_PRICE_ENABLED: 'true',
    BTC_5M_SIM_PRICE_MIN_ROUNDS: '80',
  }, () => {
    const config = loadConfig();

    assert.equal(config.pm5mSimPriceEnabled, false);
    assert.equal(config.pm5mSimPriceMinRounds, 120);
  });
});

test('PM 5m asset selector config supports live top-N routing env', () => {
  withEnv(COOLDOWN_ENV_KEYS, {
    PM5M_ASSET_SELECTOR_ENABLED: 'true',
    PM5M_ASSET_SELECTOR_MAX_ASSETS: '2',
    PM5M_ASSET_SELECTOR_SINGLE_PENALTY: '0.07',
    PM5M_SIM_REQUIRE_POSITIVE_EV: 'true',
    PM5M_SIM_MIN_EV_PER_SHARE: '0.01',
  }, () => {
    const config = loadConfig();

    assert.equal(config.pm5mAssetSelectorEnabled, true);
    assert.equal(config.pm5mAssetSelectorMaxAssets, 2);
    assert.equal(config.pm5mAssetSelectorSinglePenalty, 0.07);
    assert.equal(config.pm5mSimRequirePositiveEv, true);
    assert.equal(config.pm5mSimMinEvPerShare, 0.01);
  });
});

test('profile status accepts disable as an alias for disabled', () => {
  withEnv(COOLDOWN_ENV_KEYS, {
    BTC_15M_PROFILE_STATUS: 'disable',
    BTC_1H_PROFILE_STATUS: 'disable',
  }, () => {
    const config = loadConfig();
    const byId = new Map(config.marketProfiles.map((profile) => [profile.id, profile]));

    assert.equal(byId.get('btc-15m')?.status, 'disabled');
    assert.equal(byId.get('btc-1h')?.status, 'disabled');
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
    assert.equal(byId.get('btc-5m')?.cooldown.baseMs, 11 * 60_000);
    assert.equal(byId.get('btc-15m')?.cooldown.baseMs, 22 * 60_000);
    assert.equal(byId.get('btc-1h')?.cooldown.baseMs, 11 * 60_000);
  });
});

test('all recurring asset profiles can be enabled independently from BTC profiles', () => {
  withEnv(COOLDOWN_ENV_KEYS, {
    ETH_5M_PROFILE_STATUS: 'monitor',
    ETH_15M_PROFILE_STATUS: 'live',
    ETH_1H_PROFILE_STATUS: 'disabled',
    ETH_15M_SINGLE_FILL_COOLDOWN_BASE_MS: String(44 * 60_000),
    SOL_5M_PROFILE_STATUS: 'monitor',
    SOL_15M_PROFILE_STATUS: 'live',
    SOL_1H_PROFILE_STATUS: 'disabled',
    SOL_15M_SINGLE_FILL_COOLDOWN_BASE_MS: String(50 * 60_000),
    DOGE_5M_PROFILE_STATUS: 'monitor',
    DOGE_15M_PROFILE_STATUS: 'live',
    DOGE_1H_PROFILE_STATUS: 'disabled',
    DOGE_15M_SINGLE_FILL_COOLDOWN_BASE_MS: String(55 * 60_000),
    XRP_5M_PROFILE_STATUS: 'monitor',
    XRP_15M_PROFILE_STATUS: 'live',
    XRP_1H_PROFILE_STATUS: 'disabled',
    XRP_15M_SINGLE_FILL_COOLDOWN_BASE_MS: String(60 * 60_000),
    HYPE_5M_PROFILE_STATUS: 'monitor',
    HYPE_15M_PROFILE_STATUS: 'live',
    HYPE_1H_PROFILE_STATUS: 'disabled',
    HYPE_15M_SINGLE_FILL_COOLDOWN_BASE_MS: String(65 * 60_000),
  }, () => {
    const config = loadConfig();
    const byId = new Map(config.marketProfiles.map((profile) => [profile.id, profile]));

    assert.equal(byId.get('eth-5m')?.status, 'monitor');
    assert.equal(byId.get('eth-15m')?.status, 'live');
    assert.equal(byId.get('eth-1h')?.status, 'disabled');
    assert.equal(byId.get('eth-5m')?.seriesSlug, 'eth-updown-5m');
    assert.equal(byId.get('eth-15m')?.priceFeedSymbol, 'ethusdt');
    assert.equal(byId.get('eth-15m')?.cooldown.baseMs, 44 * 60_000);
    assert.equal(byId.get('sol-5m')?.status, 'monitor');
    assert.equal(byId.get('sol-15m')?.status, 'live');
    assert.equal(byId.get('sol-1h')?.status, 'disabled');
    assert.equal(byId.get('sol-5m')?.seriesSlug, 'sol-updown-5m');
    assert.equal(byId.get('sol-15m')?.priceFeedSymbol, 'solusdt');
    assert.equal(byId.get('sol-15m')?.cooldown.baseMs, 50 * 60_000);
    assert.equal(byId.get('doge-5m')?.status, 'monitor');
    assert.equal(byId.get('doge-15m')?.status, 'live');
    assert.equal(byId.get('doge-1h')?.status, 'disabled');
    assert.equal(byId.get('doge-5m')?.seriesSlug, 'doge-updown-5m');
    assert.equal(byId.get('doge-15m')?.priceFeedSymbol, 'dogeusdt');
    assert.equal(byId.get('doge-15m')?.cooldown.baseMs, 55 * 60_000);
    assert.equal(byId.get('xrp-5m')?.status, 'monitor');
    assert.equal(byId.get('xrp-15m')?.status, 'live');
    assert.equal(byId.get('xrp-1h')?.status, 'disabled');
    assert.equal(byId.get('xrp-5m')?.seriesSlug, 'xrp-updown-5m');
    assert.equal(byId.get('xrp-15m')?.priceFeedSymbol, 'xrpusdt');
    assert.equal(byId.get('xrp-15m')?.cooldown.baseMs, 60 * 60_000);
    assert.equal(byId.get('hype-5m')?.status, 'monitor');
    assert.equal(byId.get('hype-15m')?.status, 'live');
    assert.equal(byId.get('hype-1h')?.status, 'disabled');
    assert.equal(byId.get('hype-5m')?.seriesSlug, 'hype-updown-5m');
    assert.equal(byId.get('hype-15m')?.priceFeedSymbol, 'hypeusdt');
    assert.equal(byId.get('hype-15m')?.cooldown.baseMs, 65 * 60_000);
  });
});

test('enabled non-BTC profiles are added to an existing Binance multi-stream URL', () => {
  withEnv(COOLDOWN_ENV_KEYS, {
    BINANCE_WS_URL: 'wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/ethusdt@aggTrade',
    SOL_5M_PROFILE_STATUS: 'monitor',
    DOGE_5M_PROFILE_STATUS: 'monitor',
    XRP_5M_PROFILE_STATUS: 'monitor',
    HYPE_5M_PROFILE_STATUS: 'monitor',
  }, () => {
    const config = loadConfig();

    assert.match(config.binanceWsUrl, /btcusdt@aggTrade/);
    assert.match(config.binanceWsUrl, /ethusdt@aggTrade/);
    assert.match(config.binanceWsUrl, /solusdt@aggTrade/);
    assert.match(config.binanceWsUrl, /dogeusdt@aggTrade/);
    assert.match(config.binanceWsUrl, /xrpusdt@aggTrade/);
    assert.match(config.binanceWsUrl, /hypeusdt@aggTrade/);
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
