import fs from 'node:fs';
import path from 'node:path';

import { STRATEGY_RULES } from '../../../packages/strategy/src';
import type { BotRuntimeStatus, DashboardState, DataFeedStatus, ExecutionMode, FillRecord, OrderRecord, RuntimeLogRecord, SettlementRecord, StateSnapshot, StrategyCheck, TradeIntent } from '../../../packages/shared/src';

type StoreOptions = {
  persistencePath?: string | false;
  maxRecords?: number;
};

type PersistedRuntimeState = {
  version: 1;
  savedAt: string;
  intents: TradeIntent[];
  orders: OrderRecord[];
  fills: FillRecord[];
  settlements: SettlementRecord[];
};

export class InMemoryStore {
  private runtime: BotRuntimeStatus;
  private latestSnapshot: StateSnapshot | null = null;
  private latestFeed: DataFeedStatus = { rtdsConnected: false, clobConnected: false, priceSamples: 0, source: 'unavailable' };
  private intents: TradeIntent[] = [];
  private orders: OrderRecord[] = [];
  private fills: FillRecord[] = [];
  private settlements: SettlementRecord[] = [];
  private runtimeLogs: RuntimeLogRecord[] = [];
  private strategyChecks: StrategyCheck[] = [];
  private readonly persistencePath?: string;
  private readonly maxRecords: number;

  constructor(mode: ExecutionMode, private readonly tickIntervalMs: number, options: StoreOptions = {}) {
    this.persistencePath = options.persistencePath === false ? undefined : options.persistencePath;
    this.maxRecords = options.maxRecords ?? 10_000;
    const startedAt = new Date();
    this.runtime = {
      status: 'running',
      executionMode: mode,
      startedAt: startedAt.toISOString(),
      nextTickAt: new Date(startedAt.getTime() + tickIntervalMs).toISOString(),
      tickIntervalMs,
      version: '0.1.0',
      dockerReady: true,
    };
    this.loadPersistedState();
  }

  getRuntime(): BotRuntimeStatus {
    return this.runtime;
  }

  markDegraded(): BotRuntimeStatus {
    this.runtime = { ...this.runtime, status: 'degraded' };
    return this.runtime;
  }

  markRunningIfDegraded(): BotRuntimeStatus {
    if (this.runtime.status !== 'degraded') return this.runtime;
    this.runtime = { ...this.runtime, status: 'running' };
    return this.runtime;
  }

  recordSnapshot(snapshot: StateSnapshot, feed: DataFeedStatus): void {
    this.latestSnapshot = snapshot;
    this.latestFeed = feed;
    const capturedAtMs = new Date(snapshot.capturedAt).getTime();
    this.runtime = {
      ...this.runtime,
      lastTickAt: snapshot.capturedAt,
      nextTickAt: new Date(capturedAtMs + this.tickIntervalMs).toISOString(),
    };
  }

  recordIntents(intents: TradeIntent[]): void {
    const seen = new Set(this.intents.map((item) => item.id));
    this.intents = [...intents.filter((item) => !seen.has(item.id)), ...this.intents].slice(0, this.maxRecords);
    this.persistState();
  }

  updateIntent(intentId: string, patch: Partial<TradeIntent>): TradeIntent | null {
    let updated: TradeIntent | null = null;
    this.intents = this.intents.map((intent) => {
      if (intent.id !== intentId) return intent;
      updated = { ...intent, ...patch };
      return updated;
    });
    if (updated) this.persistState();
    return updated;
  }

  recordOrder(order: OrderRecord): void {
    const existing = this.orders.findIndex((item) => item.id === order.id || (order.clobOrderId && item.clobOrderId === order.clobOrderId));
    if (existing >= 0) {
      this.orders[existing] = { ...this.orders[existing], ...order, updatedAt: new Date().toISOString() };
    } else {
      this.orders = [order, ...this.orders].slice(0, this.maxRecords);
    }
    this.persistState();
  }

  recordFills(fills: FillRecord[]): void {
    if (!fills.length) return;
    const seen = new Set(this.fills.map((item) => item.id));
    this.fills = [...fills.filter((item) => !seen.has(item.id)), ...this.fills].slice(0, this.maxRecords);
    this.persistState();
  }

  recordSettlement(settlement: SettlementRecord): void {
    const existing = this.settlements.findIndex((item) => item.id === settlement.id);
    if (existing >= 0) this.settlements[existing] = settlement;
    else this.settlements = [settlement, ...this.settlements].slice(0, this.maxRecords);
    this.persistState();
  }

  recordStrategyChecks(checks: StrategyCheck[]): void {
    this.strategyChecks = checks;
  }

  hasRecentOrder(executionKey: string, windowMs: number, options: { includeFailed?: boolean } = {}): boolean {
    const cutoff = Date.now() - windowMs;
    return this.orders.some((order) => {
      if (order.executionKey !== executionKey) return false;
      const active = order.status === 'local' || order.status === 'posted' || order.status === 'partially_filled';
      if (!active && !(options.includeFailed && order.status === 'failed')) return false;
      return new Date(order.createdAt).getTime() >= cutoff;
    });
  }

  hasRecentFailedOrder(executionKey: string, windowMs: number): boolean {
    return this.hasRecentOrder(executionKey, windowMs, { includeFailed: true });
  }

  roundFills(roundId: string): FillRecord[] {
    return this.fills.filter((fill) => fill.roundId === roundId);
  }

  recordRuntimeLog(log: Omit<RuntimeLogRecord, 'id' | 'createdAt'> & { createdAt?: string }): RuntimeLogRecord {
    const record: RuntimeLogRecord = {
      id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      createdAt: log.createdAt || new Date().toISOString(),
      level: log.level,
      source: log.source,
      message: log.message,
      details: log.details,
    };
    this.runtimeLogs = [record, ...this.runtimeLogs].slice(0, 300);
    return record;
  }

  dashboardState(): DashboardState {
    if (!this.latestSnapshot) throw new Error('No snapshot has been captured yet.');
    return {
      runtime: this.runtime,
      feed: this.latestFeed,
      latestSnapshot: this.latestSnapshot,
      intents: this.intents,
      orders: this.orders,
      fills: this.fills,
      settlements: this.settlements,
      runtimeLogs: this.runtimeLogs,
      rules: STRATEGY_RULES,
      strategyChecks: this.strategyChecks,
    };
  }

  private loadPersistedState(): void {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.persistencePath, 'utf8')) as Partial<PersistedRuntimeState>;
      this.intents = Array.isArray(parsed.intents) ? parsed.intents.filter(isTradeIntentLike).slice(0, this.maxRecords) : [];
      this.orders = Array.isArray(parsed.orders) ? parsed.orders.filter(isOrderRecordLike).slice(0, this.maxRecords) : [];
      this.fills = Array.isArray(parsed.fills) ? parsed.fills.filter(isFillRecordLike).slice(0, this.maxRecords) : [];
      this.settlements = Array.isArray(parsed.settlements) ? parsed.settlements.slice(0, this.maxRecords) : [];
    } catch (error) {
      console.warn('[store] failed to load persisted runtime state', error);
    }
  }

  private persistState(): void {
    if (!this.persistencePath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true });
      const payload: PersistedRuntimeState = {
        version: 1,
        savedAt: new Date().toISOString(),
        intents: this.intents,
        orders: this.orders,
        fills: this.fills,
        settlements: this.settlements,
      };
      const tmpPath = `${this.persistencePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
      fs.renameSync(tmpPath, this.persistencePath);
    } catch (error) {
      console.warn('[store] failed to persist runtime state', error);
    }
  }
}

function isTradeIntentLike(value: unknown): value is TradeIntent {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<TradeIntent>;
  return typeof item.id === 'string' && typeof item.tokenId === 'string' && (item.side === 'BUY' || item.side === 'SELL');
}

function isOrderRecordLike(value: unknown): value is OrderRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<OrderRecord>;
  return typeof item.id === 'string' && typeof item.intentId === 'string' && typeof item.tokenId === 'string' && (item.side === 'BUY' || item.side === 'SELL');
}

function isFillRecordLike(value: unknown): value is FillRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<FillRecord>;
  return typeof item.id === 'string' && typeof item.roundId === 'string' && typeof item.tokenId === 'string';
}
