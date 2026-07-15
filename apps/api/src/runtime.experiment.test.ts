import assert from 'node:assert/strict';
import test from 'node:test';

import type { StateSnapshot } from '../../../packages/shared/src';
import type { AppConfig } from './config';
import { evaluateExperimentEntry } from './runtime';
import { InMemoryStore } from './store';

test('generates paired 50c experiment intents without orderbook readiness', () => {
  const store = new InMemoryStore('monitor', 2_000, { persistencePath: false }, 'experiment_next_round');
  const evaluation = evaluateExperimentEntry(snapshot(), config(), store);

  assert.equal(evaluation.rejected.length, 0);
  assert.equal(evaluation.intents.length, 2);
  assert.deepEqual(evaluation.intents.map((intent) => [intent.label, intent.limitPrice, intent.shares]), [
    ['YES', 0.5, 5],
    ['NO', 0.5, 5],
  ]);
  assert.equal(evaluation.checks[0]?.status, 'eligible');
  assert.deepEqual(evaluation.checks[0]?.blockers, []);
  assert.match(evaluation.checks[0]?.conditions.find((item) => item.label === 'Classic entry gates')?.actual || '', /bypassed/);
});

function config(): AppConfig {
  return {
    activeStrategyProfile: 'experiment_next_round',
    entryMinSecondsToStart: 15,
    experimentNextRoundUpLimitPrice: 0.5,
    experimentNextRoundDownLimitPrice: 0.5,
    experimentNextRoundSharesPerSide: 5,
    experimentStopOnSingle: false,
    minOrderShares: 5,
  } as AppConfig;
}

function snapshot(): StateSnapshot {
  const now = Date.now();
  return {
    id: 'experiment-snapshot',
    profileId: 'btc-5m',
    asset: 'btc',
    interval: '5m',
    capturedAt: new Date(now).toISOString(),
    round: {
      id: 'btc-updown-5m-next',
      phase: 'decision',
      eventSlug: 'btc-updown-5m-next',
      startAt: new Date(now + 60_000).toISOString(),
      endAt: new Date(now + 360_000).toISOString(),
      secondsToStart: 60,
      secondsToEnd: 360,
      strike: 60_000,
      strikeStatus: 'estimated',
      yesTokenId: 'yes-token',
      noTokenId: 'no-token',
    },
    features: {} as StateSnapshot['features'],
    regime: 'UNKNOWN',
    orderbooks: [],
    positions: [],
    positionReadStatus: 'disabled',
    diagnostics: [],
  };
}
