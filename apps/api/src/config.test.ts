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
  '5M_SINGLE_FILL_COOLDOWN_BASE_MS',
  '15M_SINGLE_FILL_COOLDOWN_BASE_MS',
  '1H_SINGLE_FILL_COOLDOWN_BASE_MS',
];

test('market profile cooldown defaults scale with interval duration', () => {
  withEnv(COOLDOWN_ENV_KEYS, {}, () => {
    const config = loadConfig();
    const byId = new Map(config.marketProfiles.map((profile) => [profile.id, profile]));

    assert.equal(byId.get('btc-5m')?.cooldown.baseMs, 30 * 60_000);
    assert.equal(byId.get('btc-15m')?.cooldown.baseMs, 90 * 60_000);
    assert.equal(byId.get('btc-1h')?.cooldown.baseMs, 360 * 60_000);
    assert.equal(byId.get('btc-15m')?.cooldown.priceCapMs, 180 * 60_000);
    assert.equal(byId.get('btc-1h')?.cooldown.executionMs, 24 * 60 * 60_000);
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
    assert.equal(byId.get('btc-1h')?.cooldown.baseMs, 360 * 60_000);
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
