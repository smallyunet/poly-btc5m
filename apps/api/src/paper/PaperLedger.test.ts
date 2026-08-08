import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { StateSnapshot, StrategyCheck, TradeIntent } from '../../../../packages/shared/src';
import { PaperLedger } from './PaperLedger';

test('paper ledger retains uncapped append-only events and paginates by cursor', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-btc5m-paper-ledger-'));
  const databasePath = path.join(tempDir, 'paper.sqlite');
  const ledger = new PaperLedger({
    databasePath,
    runId: 'test-run',
    codeSha: 'test-sha',
    configHash: 'test-config-hash',
    fillModelVersion: 'touch-v1',
    config: { executionMode: 'paper' },
  });

  try {
    for (let index = 0; index < 1_205; index += 1) {
      const intent = testIntent(index);
      ledger.record('intent', intent.id, 'recorded', intent, intent.createdAt);
    }

    assert.deepEqual(ledger.stats(), {
      runId: 'test-run',
      totalEvents: 1_205,
      byEntityType: { intent: 1_205 },
    });
    const first = ledger.page({ entityType: 'intent', limit: 500 });
    assert.equal(first.rows.length, 500);
    assert.ok(first.nextCursor);
    assert.equal(first.rows[0].entityId, 'intent-1204');
    const second = ledger.page({ entityType: 'intent', cursor: first.nextCursor!, limit: 500 });
    assert.equal(second.rows.length, 500);
    assert.equal(second.rows[0].entityId, 'intent-704');
    const third = ledger.page({ entityType: 'intent', cursor: second.nextCursor!, limit: 500 });
    assert.equal(third.rows.length, 205);
    assert.equal(third.nextCursor, null);
  } finally {
    ledger.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('paper ledger can reopen the same run without losing history', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-btc5m-paper-reopen-'));
  const databasePath = path.join(tempDir, 'paper.sqlite');
  const options = {
    databasePath,
    runId: 'reopen-run',
    configHash: 'same-config',
    fillModelVersion: 'touch-v1',
    config: {},
  };
  const first = new PaperLedger(options);
  first.record('intent', 'intent-before-restart', 'recorded', testIntent(1));
  first.close();

  const second = new PaperLedger(options);
  try {
    second.record('intent', 'intent-after-restart', 'recorded', testIntent(2));
    assert.equal(second.stats().totalEvents, 2);
  } finally {
    second.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('paper ledger rejects reusing a run id with changed assumptions', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-btc5m-paper-frozen-run-'));
  const databasePath = path.join(tempDir, 'paper.sqlite');
  const first = new PaperLedger({
    databasePath,
    runId: 'frozen-run',
    codeSha: 'sha-a',
    configHash: 'config-a',
    fillModelVersion: 'touch-v1',
    config: {},
  });
  first.close();

  try {
    assert.throws(() => new PaperLedger({
      databasePath,
      runId: 'frozen-run',
      codeSha: 'sha-b',
      configHash: 'config-a',
      fillModelVersion: 'touch-v1',
      config: {},
    }), /Start a new run id/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('paper ledger records observation transitions plus periodic heartbeats', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-btc5m-paper-sampling-'));
  const databasePath = path.join(tempDir, 'paper.sqlite');
  let nowMs = 0;
  const ledger = new PaperLedger({
    databasePath,
    runId: 'sampling-run',
    configHash: 'sampling-config',
    fillModelVersion: 'touch-v1',
    observationSampleIntervalMs: 30_000,
    config: {},
    now: () => nowMs,
  });

  try {
    const generated = testIntent(1);
    const rejected = { ...generated, status: 'rejected' as const, rejectionReason: 'LOCAL_STRATEGY_ORDER_EXISTS' };
    ledger.recordSnapshot(testSnapshot(1));
    ledger.recordStrategyChecks([testCheck(false, '10s remaining')], 'btc-5m', 'btc-updown-5m-1782432000');
    ledger.recordIntent(generated, 'recorded');
    ledger.recordIntent(rejected, 'updated');

    nowMs = 2_000;
    ledger.recordSnapshot(testSnapshot(2));
    ledger.recordStrategyChecks([testCheck(false, '8s remaining')], 'btc-5m', 'btc-updown-5m-1782432000');
    ledger.recordIntent({ ...generated, id: 'intent-repeat', createdAt: new Date(nowMs).toISOString() }, 'recorded');
    ledger.recordIntent({ ...rejected, id: 'intent-repeat', createdAt: new Date(nowMs).toISOString() }, 'updated');

    ledger.recordSnapshot(testSnapshot(3, 'TREND'));
    ledger.recordStrategyChecks([testCheck(true, 'gate passed')], 'btc-5m', 'btc-updown-5m-1782432000');
    ledger.recordIntent({ ...generated, id: 'intent-executed', status: 'executed', createdAt: new Date(nowMs).toISOString() }, 'updated');

    nowMs = 32_000;
    ledger.recordSnapshot(testSnapshot(4, 'TREND'));
    ledger.recordStrategyChecks([testCheck(true, 'still passed')], 'btc-5m', 'btc-updown-5m-1782432000');
    ledger.recordIntent({ ...generated, id: 'intent-heartbeat', createdAt: new Date(nowMs).toISOString() }, 'recorded');
    ledger.recordIntent({ ...rejected, id: 'intent-heartbeat', createdAt: new Date(nowMs).toISOString() }, 'updated');

    assert.deepEqual(ledger.stats(), {
      runId: 'sampling-run',
      totalEvents: 11,
      byEntityType: { intent: 5, snapshot: 3, strategy_check: 3 },
    });
    assert.ok(ledger.page({ entityType: 'strategy_check', limit: 10 }).rows.every((row) => row.roundId === 'btc-updown-5m-1782432000'));
  } finally {
    ledger.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function testIntent(index: number): TradeIntent {
  return {
    id: `intent-${index}`,
    profileId: 'btc-5m',
    asset: 'btc',
    interval: '5m',
    strategy: 'UPDOWN_DUAL_ENTRY',
    roundId: 'btc-updown-5m-1782432000',
    tokenId: 'yes-token',
    label: 'YES',
    side: 'BUY',
    orderType: 'LIMIT',
    limitPrice: 0.45,
    shares: 5,
    reason: 'test',
    status: 'generated',
    ttlSeconds: 30,
    createdAt: new Date(1_780_000_000_000 + index).toISOString(),
  };
}

function testSnapshot(index: number, regime: StateSnapshot['regime'] = 'UNKNOWN'): StateSnapshot {
  return {
    id: `snapshot-${index}`,
    profileId: 'btc-5m',
    asset: 'btc',
    interval: '5m',
    capturedAt: new Date(index * 1_000).toISOString(),
    round: {
      id: 'btc-updown-5m-1782432000',
      phase: 'observing',
      eventSlug: 'btc-updown-5m-1782432000',
      startAt: new Date(1_782_432_000_000).toISOString(),
      endAt: new Date(1_782_432_300_000).toISOString(),
      secondsToStart: 30,
      secondsToEnd: 330,
      strike: 65_000,
      strikeStatus: 'estimated',
      yesTokenId: 'yes-token',
      noTokenId: 'no-token',
    },
    features: {} as StateSnapshot['features'],
    regime,
    orderbooks: [],
    positions: [],
    positionReadStatus: 'disabled',
    diagnostics: [],
  };
}

function testCheck(passed: boolean, actual: string): StrategyCheck {
  return {
    profileId: 'btc-5m',
    asset: 'btc',
    interval: '5m',
    strategy: 'UPDOWN_DUAL_ENTRY',
    title: 'Dual Entry',
    status: passed ? 'eligible' : 'blocked',
    summary: 'test',
    reason: actual,
    blockers: passed ? [] : ['DECISION_WINDOW'],
    conditions: [{ label: 'Decision window', passed, actual }],
    limitPrice: passed ? 0.45 : undefined,
  };
}
