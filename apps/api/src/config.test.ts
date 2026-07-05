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
  '5M_SINGLE_FILL_COOLDOWN_BASE_MS',
  '15M_SINGLE_FILL_COOLDOWN_BASE_MS',
  '1H_SINGLE_FILL_COOLDOWN_BASE_MS',
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

test('ETH recurring profiles can be enabled independently from BTC profiles', () => {
  withEnv(COOLDOWN_ENV_KEYS, {
    ETH_5M_PROFILE_STATUS: 'monitor',
    ETH_15M_PROFILE_STATUS: 'live',
    ETH_1H_PROFILE_STATUS: 'disabled',
    ETH_15M_SINGLE_FILL_COOLDOWN_BASE_MS: String(44 * 60_000),
  }, () => {
    const config = loadConfig();
    const byId = new Map(config.marketProfiles.map((profile) => [profile.id, profile]));

    assert.equal(byId.get('eth-5m')?.status, 'monitor');
    assert.equal(byId.get('eth-15m')?.status, 'live');
    assert.equal(byId.get('eth-1h')?.status, 'disabled');
    assert.equal(byId.get('eth-5m')?.seriesSlug, 'eth-updown-5m');
    assert.equal(byId.get('eth-15m')?.priceFeedSymbol, 'ethusdt');
    assert.equal(byId.get('eth-15m')?.cooldown.baseMs, 44 * 60_000);
    assert.equal(byId.get('sol-5m')?.status, 'disabled');
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
