import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { MarketProfileId, StateSnapshot, StrategyCheck, TradeIntent } from '../../../../packages/shared/src';
import type { DurableEntityType, DurableRuntimeLedger } from '../store/types';

export type PaperLedgerOptions = {
  databasePath: string;
  runId: string;
  codeSha?: string;
  configHash: string;
  fillModelVersion: string;
  observationSampleIntervalMs?: number;
  config: unknown;
  now?: () => number;
};

export type PaperLedgerEvent = {
  seq: number;
  runId: string;
  occurredAt: string;
  recordedAt: string;
  entityType: DurableEntityType;
  entityId: string;
  eventType: string;
  strategyId?: string;
  profileId?: string;
  roundId?: string;
  payload: unknown;
};

export type PaperLedgerPage = {
  rows: PaperLedgerEvent[];
  nextCursor: number | null;
};

type EventRow = {
  seq: number;
  run_id: string;
  occurred_at: string;
  recorded_at: string;
  entity_type: DurableEntityType;
  entity_id: string;
  event_type: string;
  strategy_id: string | null;
  profile_id: string | null;
  round_id: string | null;
  payload_json: string;
};

export class PaperLedger implements DurableRuntimeLedger {
  private readonly database: Database.Database;
  private readonly insertEvent: Database.Statement;
  private readonly runId: string;
  private readonly observationSampleIntervalMs: number;
  private readonly now: () => number;
  private readonly observationStates = new Map<string, { fingerprint: string; recordedAtMs: number }>();

  constructor(options: PaperLedgerOptions) {
    fs.mkdirSync(path.dirname(options.databasePath), { recursive: true });
    this.database = new Database(options.databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = NORMAL');
    this.database.pragma('foreign_keys = ON');
    this.migrate();
    this.runId = options.runId;
    this.observationSampleIntervalMs = options.observationSampleIntervalMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.database.prepare(`
      INSERT INTO paper_runs (
        run_id, started_at, code_sha, config_hash, fill_model_version, config_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO NOTHING
    `).run(
      options.runId,
      new Date().toISOString(),
      options.codeSha || null,
      options.configHash,
      options.fillModelVersion,
      stringify(options.config),
    );
    const existingRun = this.database.prepare(`
      SELECT code_sha, config_hash, fill_model_version
      FROM paper_runs
      WHERE run_id = ?
    `).get(options.runId) as { code_sha: string | null; config_hash: string; fill_model_version: string };
    const requestedCodeSha = options.codeSha || null;
    if (
      existingRun.config_hash !== options.configHash
      || existingRun.fill_model_version !== options.fillModelVersion
      || existingRun.code_sha !== requestedCodeSha
    ) {
      this.database.close();
      throw new Error(`PAPER_RUN_ID "${options.runId}" already exists with a different code, config, or fill model. Start a new run id.`);
    }
    this.insertEvent = this.database.prepare(`
      INSERT INTO paper_events (
        run_id, occurred_at, recorded_at, entity_type, entity_id, event_type,
        strategy_id, profile_id, round_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  record(entityType: DurableEntityType, entityId: string, eventType: string, payload: unknown, occurredAt = new Date().toISOString()): void {
    const dimensions = dimensionsFrom(payload);
    this.insertEvent.run(
      this.runId,
      occurredAt,
      new Date().toISOString(),
      entityType,
      entityId,
      eventType,
      dimensions.strategyId,
      dimensions.profileId,
      dimensions.roundId,
      stringify(payload),
    );
  }

  recordIntent(intent: TradeIntent, eventType: 'recorded' | 'updated'): void {
    const occurredAt = eventType === 'recorded' ? intent.createdAt : new Date(this.now()).toISOString();
    if (intent.status === 'executed' || intent.status === 'failed') {
      this.record('intent', intent.id, eventType, intent, occurredAt);
      return;
    }
    const scope = [
      'intent',
      intent.profileId,
      intent.roundId,
      intent.strategy,
      intent.tokenId,
      intent.side,
      eventType,
      intent.status,
      intent.rejectionReason || 'none',
    ].join(':');
    if (!this.shouldRecordObservation(scope, intentFingerprint(intent))) return;
    this.record('intent', intent.id, eventType, intent, occurredAt);
  }

  recordSnapshot(snapshot: StateSnapshot): void {
    const scope = `snapshot:${snapshot.profileId}`;
    if (!this.shouldRecordObservation(scope, snapshotFingerprint(snapshot))) return;
    this.record('snapshot', snapshot.id, 'captured', snapshot, snapshot.capturedAt);
  }

  recordStrategyChecks(checks: StrategyCheck[], profileId: MarketProfileId, observedRoundId?: string): void {
    const recordedAt = new Date(this.now()).toISOString();
    const insertMany = this.database.transaction((items: StrategyCheck[]) => {
      for (const check of items) {
        const effectiveCheck = check.roundId || !observedRoundId ? check : { ...check, roundId: observedRoundId };
        const scope = ['strategy_check', profileId, effectiveCheck.roundId || 'current', effectiveCheck.strategy].join(':');
        if (!this.shouldRecordObservation(scope, strategyCheckFingerprint(effectiveCheck))) continue;
        const entityId = [profileId, effectiveCheck.roundId || 'current', effectiveCheck.strategy, recordedAt].join(':');
        this.record('strategy_check', entityId, 'evaluated', effectiveCheck, recordedAt);
      }
    });
    insertMany(checks);
  }

  page(params: { entityType?: DurableEntityType; strategyId?: string; profileId?: string; runId?: string; cursor?: number; limit: number }): PaperLedgerPage {
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (params.entityType) {
      where.push('entity_type = ?');
      values.push(params.entityType);
    }
    if (params.strategyId) {
      where.push('strategy_id = ?');
      values.push(params.strategyId);
    }
    if (params.profileId) {
      where.push('profile_id = ?');
      values.push(params.profileId);
    }
    if (params.runId) {
      where.push('run_id = ?');
      values.push(params.runId);
    }
    if (params.cursor != null) {
      where.push('seq < ?');
      values.push(params.cursor);
    }
    const rows = this.database.prepare(`
      SELECT * FROM paper_events
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY seq DESC
      LIMIT ?
    `).all(...values, params.limit + 1) as EventRow[];
    const hasMore = rows.length > params.limit;
    const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
    return {
      rows: pageRows.map(eventFromRow),
      nextCursor: hasMore ? pageRows.at(-1)?.seq ?? null : null,
    };
  }

  stats(runId = this.runId): { runId: string; totalEvents: number; byEntityType: Record<string, number> } {
    const total = this.database.prepare('SELECT COUNT(*) AS count FROM paper_events WHERE run_id = ?').get(runId) as { count: number };
    const grouped = this.database.prepare('SELECT entity_type, COUNT(*) AS count FROM paper_events WHERE run_id = ? GROUP BY entity_type').all(runId) as Array<{ entity_type: string; count: number }>;
    return {
      runId,
      totalEvents: total.count,
      byEntityType: Object.fromEntries(grouped.map((row) => [row.entity_type, row.count])),
    };
  }

  close(): void {
    this.database.close();
  }

  private shouldRecordObservation(scope: string, fingerprint: string): boolean {
    const nowMs = this.now();
    const previous = this.observationStates.get(scope);
    if (
      previous
      && previous.fingerprint === fingerprint
      && nowMs - previous.recordedAtMs < this.observationSampleIntervalMs
    ) return false;
    this.observationStates.set(scope, { fingerprint, recordedAtMs: nowMs });
    return true;
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS paper_runs (
        run_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        code_sha TEXT,
        config_hash TEXT NOT NULL,
        fill_model_version TEXT NOT NULL,
        config_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS paper_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES paper_runs(run_id),
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        strategy_id TEXT,
        profile_id TEXT,
        round_id TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS paper_events_run_seq_idx ON paper_events(run_id, seq DESC);
      CREATE INDEX IF NOT EXISTS paper_events_entity_idx ON paper_events(entity_type, seq DESC);
      CREATE INDEX IF NOT EXISTS paper_events_strategy_idx ON paper_events(strategy_id, profile_id, round_id, seq DESC);
    `);
  }
}

function intentFingerprint(intent: TradeIntent): string {
  return stringify({
    profileId: intent.profileId,
    strategy: intent.strategy,
    roundId: intent.roundId,
    tokenId: intent.tokenId,
    label: intent.label,
    side: intent.side,
    orderType: intent.orderType,
    status: intent.status,
    rejectionReason: intent.rejectionReason,
  });
}

function snapshotFingerprint(snapshot: StateSnapshot): string {
  return stringify({
    profileId: snapshot.profileId,
    roundId: snapshot.round.id,
    phase: snapshot.round.phase,
    strikeStatus: snapshot.round.strikeStatus,
    regime: snapshot.regime,
    orderbookSources: snapshot.orderbooks.map((quote) => [quote.tokenId, quote.source]),
    positionReadStatus: snapshot.positionReadStatus,
    participationStatus: snapshot.participation?.status,
  });
}

function strategyCheckFingerprint(check: StrategyCheck): string {
  return stringify({
    status: check.status,
    blockers: check.blockers,
    conditions: check.conditions.map((condition) => [condition.label, condition.passed]),
  });
}

function dimensionsFrom(payload: unknown): { strategyId: string | null; profileId: string | null; roundId: string | null } {
  if (!payload || typeof payload !== 'object') return { strategyId: null, profileId: null, roundId: null };
  const value = payload as Record<string, unknown>;
  const round = value.round && typeof value.round === 'object' ? value.round as Record<string, unknown> : undefined;
  return {
    strategyId: typeof value.strategy === 'string' ? value.strategy : null,
    profileId: typeof value.profileId === 'string' ? value.profileId : null,
    roundId: typeof value.roundId === 'string' ? value.roundId : typeof round?.id === 'string' ? round.id : null,
  };
}

function eventFromRow(row: EventRow): PaperLedgerEvent {
  return {
    seq: row.seq,
    runId: row.run_id,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    entityType: row.entity_type,
    entityId: row.entity_id,
    eventType: row.event_type,
    strategyId: row.strategy_id || undefined,
    profileId: row.profile_id || undefined,
    roundId: row.round_id || undefined,
    payload: JSON.parse(row.payload_json),
  };
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => typeof nested === 'bigint' ? nested.toString() : nested);
}
