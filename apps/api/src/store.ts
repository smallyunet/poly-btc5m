import fs from 'node:fs';
import path from 'node:path';

import { STRATEGY_RULES } from '../../../packages/strategy/src';
import type { BotRuntimeStatus, DashboardState, DataFeedStatus, ExecutionMode, FillRecord, OrderRecord, RuntimeLogRecord, SettlementRecord, StateSnapshot, StrategyCheck, TradeIntent } from '../../../packages/shared/src';

type OpenOrderLike = {
  id: string;
  tokenId: string;
};

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
  roundStrikes?: Record<string, number>;
};

export class InMemoryStore {
  private runtime: BotRuntimeStatus;
  private latestSnapshot: StateSnapshot | null = null;
  private latestFeed: DataFeedStatus = { rtdsConnected: false, clobConnected: false, priceSamples: 0, source: 'unavailable' };
  private intents: TradeIntent[] = [];
  private orders: OrderRecord[] = [];
  private fills: FillRecord[] = [];
  private settlements: SettlementRecord[] = [];
  private roundStrikes = new Map<string, number>();
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
    const nextFills = fills.filter((item) => !seen.has(item.id));
    if (!nextFills.length) return;
    this.fills = [...nextFills, ...this.fills].slice(0, this.maxRecords);
    this.reconcileOrderFillStatus();
    this.persistState();
  }

  recordSettlement(settlement: SettlementRecord): void {
    const existing = this.settlements.findIndex((item) => item.id === settlement.id);
    if (existing >= 0) {
      if (this.settlements[existing].status === 'settled' && settlement.status === 'estimated') return;
      this.settlements[existing] = settlement;
    } else {
      this.settlements = [settlement, ...this.settlements].slice(0, this.maxRecords);
    }
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

  roundOrders(roundId: string): OrderRecord[] {
    return this.orders.filter((order) => order.roundId === roundId);
  }

  ordersNeedingReconciliation(limit = 200): OrderRecord[] {
    return this.orders
      .filter((order) => order.status === 'posted' || order.status === 'partially_filled')
      .sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt))
      .slice(0, limit);
  }

  roundsNeedingSettlement(limit = 50): Array<{ roundId: string; eventSlug: string; marketTitle?: string; imageUrl?: string; strike?: number }> {
    const settled = new Set(this.settlements.map((settlement) => settlement.roundId));
    const byRound = new Map<string, { roundId: string; eventSlug: string; marketTitle?: string; imageUrl?: string; latestTime: number; strike?: number }>();
    for (const fill of this.fills) {
      if (settled.has(fill.roundId) || !isRoundEnded(fill.roundId, Date.now(), 0)) continue;
      const existing = byRound.get(fill.roundId);
      const latestTime = Math.max(existing?.latestTime ?? 0, toTime(fill.matchedAt));
      byRound.set(fill.roundId, {
        roundId: fill.roundId,
        eventSlug: fill.eventSlug || fill.roundId,
        marketTitle: fill.marketTitle || existing?.marketTitle,
        imageUrl: fill.imageUrl || existing?.imageUrl,
        latestTime,
        strike: this.roundStrikes.get(fill.roundId),
      });
    }
    return [...byRound.values()]
      .sort((a, b) => b.latestTime - a.latestTime)
      .slice(0, limit)
      .map(({ latestTime: _latestTime, ...round }) => round);
  }

  reconcileOpenOrderStatuses(openOrders: OpenOrderLike[]): number {
    const openOrderIds = new Set(openOrders.map((order) => order.id).filter(Boolean));
    const openTokenIds = new Set(openOrders.map((order) => order.tokenId).filter(Boolean));
    let updated = 0;
    this.orders = this.orders.map((order) => {
      if (order.status !== 'posted' && order.status !== 'partially_filled') return order;
      if (order.clobOrderId && openOrderIds.has(order.clobOrderId)) return order;
      if (!order.clobOrderId && openTokenIds.has(order.tokenId)) return order;
      if (!isRoundEnded(order.roundId, Date.now(), 60_000)) return order;
      const fills = matchingOrderFills(order, this.fills);
      const filledSize = sum(fills.map((fill) => fill.size));
      if (filledSize >= order.size - 0.01) return order;
      updated += 1;
      return {
        ...order,
        status: 'cancelled',
        filledSize: filledSize > 0 ? filledSize : order.filledSize,
        updatedAt: new Date().toISOString(),
      };
    });
    if (updated) this.persistState();
    return updated;
  }

  getRoundStrike(roundId: string): number | undefined {
    return this.roundStrikes.get(roundId);
  }

  recordRoundStrike(roundId: string, strike: number): void {
    if (!Number.isFinite(strike) || strike <= 0) return;
    if (this.roundStrikes.get(roundId) === strike) return;
    this.roundStrikes.set(roundId, strike);
    this.persistState();
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
      this.roundStrikes = new Map(Object.entries(parsed.roundStrikes || {}).filter(([, strike]) => Number.isFinite(strike) && strike > 0));
      this.reconcileOrderFillStatus();
    } catch (error) {
      console.warn('[store] failed to load persisted runtime state', error);
    }
  }

  private reconcileOrderFillStatus(): void {
    this.orders = this.orders.map((order) => {
      if (order.status === 'failed' || order.status === 'cancelled') return order;
      const fills = matchingOrderFills(order, this.fills);
      if (!fills.length) return order;

      const filledSize = sum(fills.map((fill) => fill.size));
      const totalCost = sum(fills.map((fill) => fill.price * fill.size));
      const avgFillPrice = filledSize > 0 ? totalCost / filledSize : undefined;
      const nextStatus = filledSize >= order.size - 0.01 ? 'filled' : 'partially_filled';

      if (
        order.status === nextStatus
        && order.filledSize === filledSize
        && order.avgFillPrice === avgFillPrice
      ) {
        return order;
      }

      return {
        ...order,
        status: nextStatus,
        filledSize,
        avgFillPrice,
        updatedAt: new Date().toISOString(),
      };
    });
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
        roundStrikes: Object.fromEntries(this.roundStrikes),
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
  if (typeof item.id !== 'string' || typeof item.roundId !== 'string' || typeof item.tokenId !== 'string') return false;
  const raw = item.raw as { trader_side?: unknown; maker_orders?: unknown } | undefined;
  return !(String(raw?.trader_side || '').toUpperCase() === 'MAKER' && Array.isArray(raw?.maker_orders) && !item.clobOrderId);
}

function matchingOrderFills(order: OrderRecord, fills: FillRecord[]): FillRecord[] {
  const exact = order.clobOrderId
    ? fills.filter((fill) => fill.clobOrderId === order.clobOrderId)
    : [];
  if (exact.length) return exact;
  return fills.filter((fill) => (
    fill.roundId === order.roundId
    && fill.tokenId === order.tokenId
    && fill.side === order.side
  ));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function isRoundEnded(roundId: string, nowMs: number, graceMs: number): boolean {
  const startMs = roundStartMs(roundId);
  if (startMs == null) return false;
  return nowMs >= startMs + 5 * 60_000 + graceMs;
}

function roundStartMs(roundId: string): number | null {
  const match = roundId.match(/btc-updown-5m-(\d+)$/);
  const parsed = Number(match?.[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed * 1000;
}

function toTime(value: string): number {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}
