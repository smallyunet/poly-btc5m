import fs from 'node:fs';
import path from 'node:path';

import { STRATEGY_RULES } from '../../../packages/strategy/src';
import type { BotRuntimeStatus, DashboardState, DataFeedStatus, ExecutionMode, FillRecord, OrderRecord, RuntimeLogRecord, SettlementRecord, StateSnapshot, StrategyCheck, TradeIntent } from '../../../packages/shared/src';

type OpenOrderLike = {
  id: string;
  tokenId: string;
};

export type SingleFillHedgeCandidate = {
  roundId: string;
  eventSlug: string;
  marketTitle?: string;
  imageUrl?: string;
  startAt: string;
  endAt: string;
  secondsToEnd: number;
  yesTokenId: string;
  noTokenId: string;
};

export type SingleFillHedgeOutcome = {
  roundId: string;
  status: 'posted' | 'blocked' | 'failed' | 'monitor';
  reason: string;
  recordedAt: string;
};

export type SingleFillCooldownPolicy = {
  baseMs: number;
  priceCapMs: number;
  executionMs: number;
  repeatWindowMs: number;
  secondMs: number;
  thirdMs: number;
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
  singleFillCooldown?: SingleFillCooldownRecord | null;
  singleFillCooldownRoundIds?: string[];
  pendingSingleFillReviewRoundIds?: string[];
  singleFillHedgeOutcomes?: Record<string, SingleFillHedgeOutcome>;
  singleFillCooldownEvents?: SingleFillCooldownEvent[];
};

type SingleFillCooldownRecord = {
  roundId: string;
  triggeredAt: string;
  finalizedAt?: string;
  expiresAt: string;
  yesShares: number;
  noShares: number;
  category?: string;
  hedgeReason?: string;
  recentSingleFillCount?: number;
};

type SingleFillCooldownEvent = {
  roundId: string;
  triggeredAt: string;
  category: string;
};

const FINAL_SINGLE_FILL_GRACE_MS = 60_000;
const PRICE_CAP_HEDGE_REASONS = new Set(['HEDGE_ASK_ABOVE_CAP', 'HEDGE_PAIR_COST_ABOVE_CAP']);
const BENIGN_HEDGE_REASONS = new Set(['NO_MATERIAL_SINGLE_FILL_EXPOSURE', 'NOT_IN_HEDGE_WINDOW', 'HEDGE_TOO_CLOSE_TO_EXPIRY']);

export class InMemoryStore {
  private runtime: BotRuntimeStatus;
  private latestSnapshot: StateSnapshot | null = null;
  private latestFeed: DataFeedStatus = { rtdsConnected: false, clobConnected: false, priceSamples: 0, source: 'unavailable' };
  private intents: TradeIntent[] = [];
  private orders: OrderRecord[] = [];
  private fills: FillRecord[] = [];
  private settlements: SettlementRecord[] = [];
  private roundStrikes = new Map<string, number>();
  private singleFillCooldown: SingleFillCooldownRecord | null = null;
  private singleFillCooldownRoundIds = new Set<string>();
  private pendingSingleFillReviewRoundIds = new Set<string>();
  private singleFillHedgeOutcomes = new Map<string, SingleFillHedgeOutcome>();
  private singleFillCooldownEvents: SingleFillCooldownEvent[] = [];
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
    return this.runtimeWithCooldown();
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

  recordFills(fills: FillRecord[]): FillRecord[] {
    if (!fills.length) return [];
    const seen = new Set(this.fills.map((item) => item.id));
    const nextFills = fills.filter((item) => !seen.has(item.id));
    if (!nextFills.length) return [];
    this.fills = [...nextFills, ...this.fills].slice(0, this.maxRecords);
    this.reconcileOrderFillStatus();
    this.persistState();
    return nextFills;
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

  hedgeWatchTokenIds(windowSeconds: number, minSecondsToEnd: number, nowMs = Date.now()): string[] {
    return this.singleFillHedgeCandidates(windowSeconds, minSecondsToEnd, nowMs)
      .flatMap((candidate) => [candidate.yesTokenId, candidate.noTokenId])
      .filter(Boolean);
  }

  singleFillHedgeCandidates(windowSeconds: number, minSecondsToEnd: number, nowMs = Date.now()): SingleFillHedgeCandidate[] {
    const byRound = new Map<string, SingleFillHedgeCandidate>();
    for (const order of this.orders) {
      if (order.side !== 'BUY') continue;
      const startMs = roundStartMs(order.roundId);
      if (startMs == null) continue;
      const endMs = startMs + 5 * 60_000;
      const secondsToEnd = (endMs - nowMs) / 1000;
      if (nowMs < startMs || secondsToEnd > windowSeconds || secondsToEnd <= minSecondsToEnd) continue;

      const existing = byRound.get(order.roundId);
      const candidate: SingleFillHedgeCandidate = existing || {
        roundId: order.roundId,
        eventSlug: order.eventSlug,
        marketTitle: order.marketTitle,
        imageUrl: order.imageUrl,
        startAt: new Date(startMs).toISOString(),
        endAt: new Date(endMs).toISOString(),
        secondsToEnd,
        yesTokenId: '',
        noTokenId: '',
      };
      if (order.label === 'YES') candidate.yesTokenId = order.tokenId;
      if (order.label === 'NO') candidate.noTokenId = order.tokenId;
      byRound.set(order.roundId, candidate);
    }
    return [...byRound.values()].filter((candidate) => candidate.yesTokenId && candidate.noTokenId);
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

  markOrdersCancelled(clobOrderIds: string[], nowIso = new Date().toISOString()): number {
    const ids = new Set(clobOrderIds.filter(Boolean));
    if (!ids.size) return 0;
    let updated = 0;
    this.orders = this.orders.map((order) => {
      if (!order.clobOrderId || !ids.has(order.clobOrderId)) return order;
      if (order.status !== 'posted' && order.status !== 'partially_filled') return order;
      updated += 1;
      return { ...order, status: 'cancelled', updatedAt: nowIso };
    });
    if (updated) this.persistState();
    return updated;
  }

  getRoundStrike(roundId: string): number | undefined {
    return this.roundStrikes.get(roundId);
  }

  getActiveEntryCooldown(nowMs = Date.now()): SingleFillCooldownRecord | null {
    if (!this.singleFillCooldown) return null;
    if (!this.singleFillCooldown.finalizedAt) {
      this.clearSingleFillCooldown();
      return null;
    }
    if (!this.isFinalSingleSidedBuyRound(this.singleFillCooldown.roundId, nowMs)) {
      this.clearSingleFillCooldown();
      return null;
    }
    const expiresAtMs = new Date(this.singleFillCooldown.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      this.clearSingleFillCooldown();
      return null;
    }
    return this.singleFillCooldown;
  }

  recordSingleFillHedgeOutcome(outcome: SingleFillHedgeOutcome): void {
    this.singleFillHedgeOutcomes.set(outcome.roundId, outcome);
    this.persistState();
  }

  maybeStartSingleFillCooldown(newFills: FillRecord[], cooldown: number | SingleFillCooldownPolicy, nowMs = Date.now()): SingleFillCooldownRecord | null {
    const policy = normalizeCooldownPolicy(cooldown);
    let dirty = false;
    for (const fill of newFills) {
      if (fill.side !== 'BUY' || this.singleFillCooldownRoundIds.has(fill.roundId)) continue;
      const before = this.pendingSingleFillReviewRoundIds.size;
      this.pendingSingleFillReviewRoundIds.add(fill.roundId);
      dirty ||= this.pendingSingleFillReviewRoundIds.size !== before;
    }

    if (this.getActiveEntryCooldown(nowMs)) return null;

    for (const roundId of this.pendingSingleFillReviewRoundIds) {
      if (this.singleFillCooldownRoundIds.has(roundId)) continue;
      if (!isRoundEnded(roundId, nowMs, FINAL_SINGLE_FILL_GRACE_MS)) continue;
      const exposure = this.singleSidedBuyExposure(roundId);
      this.pendingSingleFillReviewRoundIds.delete(roundId);
      this.singleFillCooldownRoundIds.add(roundId);
      dirty = true;
      if (!exposure.singleSided) {
        this.persistState();
        continue;
      }

      const cooldownDecision = this.singleFillCooldownDecision(roundId, policy, nowMs);
      const record: SingleFillCooldownRecord = {
        roundId,
        triggeredAt: new Date(nowMs).toISOString(),
        finalizedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + cooldownDecision.cooldownMs).toISOString(),
        yesShares: exposure.yesShares,
        noShares: exposure.noShares,
        category: cooldownDecision.category,
        hedgeReason: cooldownDecision.hedgeReason,
        recentSingleFillCount: cooldownDecision.recentCount,
      };
      this.singleFillCooldownEvents = [
        { roundId, triggeredAt: record.triggeredAt, category: cooldownDecision.category },
        ...this.singleFillCooldownEvents.filter((event) => nowMs - toTime(event.triggeredAt) <= policy.repeatWindowMs),
      ].slice(0, 100);
      this.singleFillCooldown = record;
      this.runtime = {
        ...this.runtime,
        entryCooldownUntil: record.expiresAt,
        entryCooldownReason: `single fill on ${roundId} (${cooldownDecision.category})`,
      };
      this.persistState();
      return record;
    }

    if (dirty) this.persistState();
    return null;
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
      runtime: this.runtimeWithCooldown(),
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
      this.singleFillCooldown = isSingleFillCooldownLike(parsed.singleFillCooldown) ? parsed.singleFillCooldown : null;
      this.singleFillCooldownRoundIds = new Set(Array.isArray(parsed.singleFillCooldownRoundIds) ? parsed.singleFillCooldownRoundIds.filter((roundId): roundId is string => typeof roundId === 'string') : []);
      this.pendingSingleFillReviewRoundIds = new Set(Array.isArray(parsed.pendingSingleFillReviewRoundIds) ? parsed.pendingSingleFillReviewRoundIds.filter((roundId): roundId is string => typeof roundId === 'string') : []);
      this.singleFillHedgeOutcomes = new Map(Object.entries(parsed.singleFillHedgeOutcomes || {}).filter((entry): entry is [string, SingleFillHedgeOutcome] => isSingleFillHedgeOutcomeLike(entry[1])));
      this.singleFillCooldownEvents = Array.isArray(parsed.singleFillCooldownEvents) ? parsed.singleFillCooldownEvents.filter(isSingleFillCooldownEventLike).slice(0, 100) : [];
      this.runtime = this.runtimeWithCooldown();
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
        singleFillCooldown: this.singleFillCooldown,
        singleFillCooldownRoundIds: [...this.singleFillCooldownRoundIds],
        pendingSingleFillReviewRoundIds: [...this.pendingSingleFillReviewRoundIds],
        singleFillHedgeOutcomes: Object.fromEntries(this.singleFillHedgeOutcomes),
        singleFillCooldownEvents: this.singleFillCooldownEvents,
      };
      const tmpPath = `${this.persistencePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
      fs.renameSync(tmpPath, this.persistencePath);
    } catch (error) {
      console.warn('[store] failed to persist runtime state', error);
    }
  }

  private runtimeWithCooldown(nowMs = Date.now()): BotRuntimeStatus {
    const activeCooldown = this.getActiveEntryCooldown(nowMs);
    if (!activeCooldown) {
      const { entryCooldownUntil: _entryCooldownUntil, entryCooldownReason: _entryCooldownReason, ...runtime } = this.runtime;
      return runtime;
    }
    return {
      ...this.runtime,
      entryCooldownUntil: activeCooldown.expiresAt,
      entryCooldownReason: `single fill on ${activeCooldown.roundId}${activeCooldown.category ? ` (${activeCooldown.category})` : ''}`,
    };
  }

  private singleFillCooldownDecision(roundId: string, policy: SingleFillCooldownPolicy, nowMs: number): { cooldownMs: number; category: string; hedgeReason?: string; recentCount: number } {
    const hedgeOutcome = this.singleFillHedgeOutcomes.get(roundId);
    const category = cooldownCategory(hedgeOutcome);
    const baseMs = category === 'price-cap'
      ? policy.priceCapMs
      : category === 'execution'
        ? policy.executionMs
        : policy.baseMs;
    const recentCount = this.singleFillCooldownEvents.filter((event) => nowMs - toTime(event.triggeredAt) <= policy.repeatWindowMs).length + 1;
    const repeatMs = recentCount >= 3 ? policy.thirdMs : recentCount >= 2 ? policy.secondMs : 0;
    return {
      cooldownMs: Math.max(baseMs, repeatMs),
      category,
      hedgeReason: hedgeOutcome?.reason,
      recentCount,
    };
  }

  private isFinalSingleSidedBuyRound(roundId: string, nowMs: number): boolean {
    if (!isRoundEnded(roundId, nowMs, FINAL_SINGLE_FILL_GRACE_MS)) return false;
    return this.singleSidedBuyExposure(roundId).singleSided;
  }

  private singleSidedBuyExposure(roundId: string): { yesShares: number; noShares: number; singleSided: boolean } {
    const buys = this.fills.filter((fill) => fill.roundId === roundId && fill.side === 'BUY');
    const yesShares = sum(buys.filter((fill) => fill.label === 'YES').map((fill) => fill.size));
    const noShares = sum(buys.filter((fill) => fill.label === 'NO').map((fill) => fill.size));
    return {
      yesShares,
      noShares,
      singleSided: (yesShares > 0 && noShares <= 0) || (noShares > 0 && yesShares <= 0),
    };
  }

  private clearSingleFillCooldown(): void {
    if (!this.singleFillCooldown && !this.runtime.entryCooldownUntil && !this.runtime.entryCooldownReason) return;
    this.singleFillCooldown = null;
    const { entryCooldownUntil: _entryCooldownUntil, entryCooldownReason: _entryCooldownReason, ...runtime } = this.runtime;
    this.runtime = runtime;
    this.persistState();
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

function isSingleFillCooldownLike(value: unknown): value is SingleFillCooldownRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SingleFillCooldownRecord>;
  return typeof item.roundId === 'string'
    && typeof item.triggeredAt === 'string'
    && typeof item.expiresAt === 'string'
    && typeof item.yesShares === 'number'
    && typeof item.noShares === 'number';
}

function isSingleFillHedgeOutcomeLike(value: unknown): value is SingleFillHedgeOutcome {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SingleFillHedgeOutcome>;
  return typeof item.roundId === 'string'
    && typeof item.recordedAt === 'string'
    && typeof item.reason === 'string'
    && (item.status === 'posted' || item.status === 'blocked' || item.status === 'failed' || item.status === 'monitor');
}

function isSingleFillCooldownEventLike(value: unknown): value is SingleFillCooldownEvent {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SingleFillCooldownEvent>;
  return typeof item.roundId === 'string'
    && typeof item.triggeredAt === 'string'
    && typeof item.category === 'string';
}

function normalizeCooldownPolicy(value: number | SingleFillCooldownPolicy): SingleFillCooldownPolicy {
  if (typeof value === 'number') {
    return {
      baseMs: value,
      priceCapMs: value,
      executionMs: value,
      repeatWindowMs: 0,
      secondMs: value,
      thirdMs: value,
    };
  }
  return value;
}

function cooldownCategory(outcome: SingleFillHedgeOutcome | undefined): string {
  if (!outcome) return 'unhedged';
  if (outcome.status === 'posted' || outcome.status === 'monitor') return 'hedge-unfilled';
  if (PRICE_CAP_HEDGE_REASONS.has(outcome.reason)) return 'price-cap';
  if (BENIGN_HEDGE_REASONS.has(outcome.reason)) return 'unhedged';
  return 'execution';
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
