import test from 'node:test';
import assert from 'node:assert/strict';

import { tickLogLevel } from './runtimeLogPolicy';

test('expected Paper duplicate guards remain informational', () => {
  assert.equal(tickLogLevel([
    'Paper execution blocked for YES: LOCAL_STRATEGY_ORDER_EXISTS.',
    'Paper execution blocked for NO: LOCAL_STRATEGY_ORDER_EXISTS.',
    'Paper simulation recorded 2 GTC order intents.',
  ]), 'info');
});

test('actionable failures, stale data, and other blockers remain warnings', () => {
  assert.equal(tickLogLevel(['CLOB orderbook stale for YES.']), 'warn');
  assert.equal(tickLogLevel(['Paper execution blocked for YES: INVALID_PRICE.']), 'warn');
  assert.equal(tickLogLevel(['Settlement reconciliation failed.']), 'warn');
});
