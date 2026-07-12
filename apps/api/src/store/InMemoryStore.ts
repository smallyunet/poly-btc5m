import fs from 'node:fs';
import path from 'node:path';

import { STRATEGY_RULES } from '../../../../packages/strategy/src';
import type { BotRuntimeStatus, DashboardState, DataFeedStatus, DynamicEntryPriceSelection, EntryRuntimeConfig, ExecutionMode, FillRecord, MarketProfile, MarketProfileId, OrderRecord, RuntimeLogRecord, SettlementRecord, StateSnapshot, StrategyCheck, StrategyId, StrategyProfile, TradeIntent } from '../../../../packages/shared/src';
import { CLASSIC_ENTRY_STRATEGY, EXPERIMENT_STRATEGY, FINAL_SINGLE_FILL_GRACE_MS } from './constants';
import { cooldownCategory, entrySignalScope, fillStrategy, finalSingleFillReviewMs, isExperimentStopLike, isFillRecordLike, isMarketProfileId, isOrderRecordLike, isRoundEnded, isSameCooldownEvent, isSingleFillCooldownEventLike, isSingleFillCooldownLike, isSingleFillHedgeOutcomeLike, isTelegramNotificationStateLike, isTradeIntentLike, matchingOrderFills, maxCooldown, netShares, normalizeCooldownPolicy, optionalEnv, orderStrategy, parseProfileRoundKey, profileAsset, profileDurationMs, profileDurationSeconds, profileIntervals, profileRoundKey, roundMoney, roundStartMs, runtimeVersion, strategyProfileForStrategy, sum, toTime } from './helpers';
import type { ExperimentStopRecord, OpenOrderLike, PendingSingleFillRiskRecord, PersistedRuntimeState, SingleFillCooldownEvent, SingleFillCooldownPolicy, SingleFillCooldownRecord, SingleFillHedgeCandidate, SingleFillHedgeOutcome, SingleFillProfitExitCandidate, StoreOptions, TailCooldownEvent, TailCooldownRecord, TelegramNotificationState } from './types';

export class InMemoryStore {
  private runtime: BotRuntimeStatus;
  private readonly profiles: MarketProfile[];
  private latestSnapshots = new Map<MarketProfileId, StateSnapshot>();
  private latestFeeds = new Map<MarketProfileId, DataFeedStatus>();
  private intents: TradeIntent[] = [];
  private orders: OrderRecord[] = [];
  private fills: FillRecord[] = [];
  private settlements: SettlementRecord[] = [];
  private roundStrikes = new Map<string, number>();
  private singleFillCooldowns = new Map<MarketProfileId, SingleFillCooldownRecord>();
  private singleFillCooldownRoundIds = new Set<string>();
  private pendingSingleFillReviewRoundIds = new Set<string>();
  private singleFillHedgeOutcomes = new Map<string, SingleFillHedgeOutcome>();
  private singleFillCooldownEvents: SingleFillCooldownEvent[] = [];
  private tailCooldowns = new Map<MarketProfileId, TailCooldownRecord>();
  private tailCooldownEvents: TailCooldownEvent[] = [];
  private experimentStop: ExperimentStopRecord | null = null;
  private entrySignalCounts = new Map<string, number>();
  private runtimeLogs: RuntimeLogRecord[] = [];
  private strategyChecksByProfile = new Map<MarketProfileId, StrategyCheck[]>();
  private dynamicEntryPrices = new Map<MarketProfileId, DynamicEntryPriceSelection>();
  private telegramNotifications: TelegramNotificationState = { notifiedRoundSummaryKeys: [] };
  private experimentRunStartedAt = new Date().toISOString();
  private readonly persistencePath?: string;
  private readonly maxRecords: number;

  constructor(mode: ExecutionMode, private readonly tickIntervalMs: number, options: StoreOptions = {}, activeStrategyProfile: StrategyProfile = 'classic', entryConfig?: EntryRuntimeConfig, profiles: MarketProfile[] = []) {
    this.profiles = profiles;
    this.persistencePath = options.persistencePath === false ? undefined : options.persistencePath;
    this.maxRecords = options.maxRecords ?? 10_000;
    const startedAt = new Date();
    this.runtime = {
      status: 'running',
      executionMode: mode,
      startedAt: startedAt.toISOString(),
      nextTickAt: new Date(startedAt.getTime() + tickIntervalMs).toISOString(),
      tickIntervalMs,
      version: runtimeVersion(),
      buildSha: optionalEnv('GIT_SHA') || optionalEnv('BUILD_SHA'),
      buildTime: optionalEnv('BUILD_TIME'),
      dockerReady: true,
      activeStrategyProfile,
      entryConfig,
    };
    this.loadPersistedState();
  }

  getRuntime(): BotRuntimeStatus {
    return this.runtimeWithCooldown();
  }

  setActiveStrategyProfile(profile: StrategyProfile): void {
    if (this.runtime.activeStrategyProfile === profile) return;
    this.runtime = { ...this.runtime, activeStrategyProfile: profile };
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
    this.latestSnapshots.set(snapshot.profileId, snapshot);
    this.latestFeeds.set(snapshot.profileId, feed);
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
    const nextFills = fills
      .filter((item) => !seen.has(item.id))
      .map((fill) => this.fillWithStrategySource(fill));
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

  getActiveTailCooldown(profileId: MarketProfileId, nowMs = Date.now()): TailCooldownRecord | null {
    const active = this.tailCooldowns.get(profileId) || null;
    if (!active) return null;
    if (toTime(active.expiresAt) > nowMs) return active;
    this.tailCooldowns.delete(profileId);
    this.persistState();
    return null;
  }

  recordTailLoss(profileId: MarketProfileId, roundId: string, pnl: number, policy: { baseMs: number; repeatWindowMs: number; secondMs: number; thirdMs: number }, nowMs = Date.now()): TailCooldownRecord | null {
    if (!(pnl < 0) || this.tailCooldownEvents.some((event) => event.profileId === profileId && event.roundId === roundId)) return null;
    const recent = this.tailCooldownEvents.filter((event) => event.profileId === profileId && nowMs - toTime(event.triggeredAt) <= policy.repeatWindowMs);
    const recentLossCount = recent.length + 1;
    const durationMs = recentLossCount >= 3 ? policy.thirdMs : recentLossCount === 2 ? policy.secondMs : policy.baseMs;
    const record: TailCooldownRecord = {
      profileId,
      roundId,
      triggeredAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + durationMs).toISOString(),
      recentLossCount,
      pnl,
    };
    this.tailCooldownEvents = [{ profileId, roundId, triggeredAt: record.triggeredAt }, ...recent].slice(0, 100);
    this.tailCooldowns.set(profileId, record);
    this.persistState();
    return record;
  }

  settledPnl(): number {
    return roundMoney(sum(this.settlements.filter((settlement) => settlement.status === 'settled').map((settlement) => settlement.pnl)));
  }

  recordStrategyChecks(checks: StrategyCheck[], profileId: MarketProfileId): void {
    this.strategyChecksByProfile.set(profileId, checks);
  }

  recordDynamicEntryPrice(selection: DynamicEntryPriceSelection): void {
    this.dynamicEntryPrices.set(selection.profileId, selection);
  }

  recordEntrySignal(signalKey: string, passed: boolean): number {
    const next = passed ? (this.entrySignalCounts.get(signalKey) ?? 0) + 1 : 0;
    this.entrySignalCounts.set(signalKey, next);
    const scope = entrySignalScope(signalKey);
    for (const key of this.entrySignalCounts.keys()) {
      if (key !== signalKey && entrySignalScope(key) === scope) this.entrySignalCounts.delete(key);
    }
    return next;
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

  hasNonFailedOrder(executionKey: string, options: { since?: string } = {}): boolean {
    const sinceMs = options.since ? toTime(options.since) : 0;
    return this.orders.some((order) => (
      order.executionKey === executionKey
      && order.status !== 'failed'
      && (!sinceMs || toTime(order.createdAt) >= sinceMs)
    ));
  }

  roundFills(profileId: MarketProfileId, roundId: string): FillRecord[] {
    return this.fills.filter((fill) => fill.roundId === roundId && fill.profileId === profileId);
  }

  roundFillsByStrategy(profileId: MarketProfileId, roundId: string, strategy: StrategyId): FillRecord[] {
    return this.fills.filter((fill) => fill.roundId === roundId && fill.profileId === profileId && fillStrategy(fill) === strategy);
  }

  roundOrders(profileId: MarketProfileId, roundId: string, strategy?: StrategyId): OrderRecord[] {
    return this.orders.filter((order) => order.roundId === roundId && order.profileId === profileId && (!strategy || orderStrategy(order) === strategy));
  }

  hedgeWatchTokenIds(profileId: MarketProfileId, windowSeconds: number, minSecondsToEnd: number, nowMs = Date.now()): string[] {
    return this.singleFillHedgeCandidates(profileId, windowSeconds, minSecondsToEnd, nowMs)
      .flatMap((candidate) => [candidate.yesTokenId, candidate.noTokenId])
      .filter(Boolean);
  }

  profitExitWatchTokenIds(profileId: MarketProfileId, maxSecondsToEnd: number, minSecondsToEnd: number, nowMs = Date.now()): string[] {
    return this.singleFillProfitExitCandidates(profileId, maxSecondsToEnd, minSecondsToEnd, nowMs)
      .flatMap((candidate) => [candidate.yesTokenId, candidate.noTokenId])
      .filter(Boolean);
  }

  singleFillHedgeCandidates(profileId: MarketProfileId, windowSeconds: number, minSecondsToEnd: number, nowMs = Date.now(), strategy: StrategyId = CLASSIC_ENTRY_STRATEGY): SingleFillHedgeCandidate[] {
    const byRound = new Map<string, SingleFillHedgeCandidate>();
    for (const order of this.orders) {
      if (order.side !== 'BUY') continue;
      if (order.profileId !== profileId) continue;
      if (orderStrategy(order) !== strategy) continue;
      const startMs = roundStartMs(order.roundId);
      if (startMs == null) continue;
      const endMs = startMs + profileDurationMs(profileId);
      const secondsToEnd = (endMs - nowMs) / 1000;
      if (nowMs < startMs || secondsToEnd > windowSeconds || secondsToEnd <= minSecondsToEnd) continue;

      const existing = byRound.get(order.roundId);
      const candidate: SingleFillHedgeCandidate = existing || {
        roundId: order.roundId,
        profileId,
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

  singleFillProfitExitCandidates(profileId: MarketProfileId, maxSecondsToEnd: number, minSecondsToEnd: number, nowMs = Date.now(), strategy: StrategyId = CLASSIC_ENTRY_STRATEGY): SingleFillProfitExitCandidate[] {
    const byRound = new Map<string, SingleFillProfitExitCandidate>();
    for (const order of this.orders) {
      if (order.side !== 'BUY') continue;
      if (order.profileId !== profileId) continue;
      if (orderStrategy(order) !== strategy) continue;
      const startMs = roundStartMs(order.roundId);
      if (startMs == null) continue;
      const endMs = startMs + profileDurationMs(profileId);
      const secondsToEnd = (endMs - nowMs) / 1000;
      if (nowMs < startMs || secondsToEnd > maxSecondsToEnd || secondsToEnd <= minSecondsToEnd) continue;

      const existing = byRound.get(order.roundId);
      const candidate: SingleFillProfitExitCandidate = existing || {
        roundId: order.roundId,
        profileId,
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

  crossProfileSingleFillRiskCandidates(sourceProfileId: MarketProfileId, nowMs = Date.now(), strategy: StrategyId = CLASSIC_ENTRY_STRATEGY): SingleFillHedgeCandidate[] {
    const sourceAsset = profileAsset(sourceProfileId);
    const targetProfileIds = this.profiles
      .filter((profile) => profile.asset === sourceAsset && profile.status !== 'disabled' && profile.id !== sourceProfileId && profile.interval !== '5m')
      .map((profile) => profile.id);
    if (!targetProfileIds.length) return [];

    const targets = new Set(targetProfileIds);
    const byRound = new Map<string, SingleFillHedgeCandidate>();
    for (const order of this.orders) {
      if (order.side !== 'BUY') continue;
      if (!targets.has(order.profileId)) continue;
      if (orderStrategy(order) !== strategy) continue;
      const startMs = roundStartMs(order.roundId);
      if (startMs == null) continue;
      const endMs = startMs + profileDurationMs(order.profileId);
      const secondsToEnd = (endMs - nowMs) / 1000;
      if (nowMs < startMs || secondsToEnd <= 0) continue;

      const key = profileRoundKey(order.profileId, order.roundId);
      const existing = byRound.get(key);
      const candidate: SingleFillHedgeCandidate = existing || {
        roundId: order.roundId,
        profileId: order.profileId,
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
      byRound.set(key, candidate);
    }
    return [...byRound.values()].filter((candidate) => candidate.yesTokenId && candidate.noTokenId);
  }

  ordersNeedingReconciliation(profileId: MarketProfileId, limit = 200): OrderRecord[] {
    return this.orders
      .filter((order) => order.profileId === profileId && (order.status === 'posted' || order.status === 'partially_filled'))
      .sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt))
      .slice(0, limit);
  }

  roundsNeedingSettlement(profileId: MarketProfileId, durationSeconds = 300, limit = 50): Array<{ roundId: string; eventSlug: string; marketTitle?: string; imageUrl?: string; strike?: number }> {
    const settled = new Set(this.settlements.filter((settlement) => settlement.profileId === profileId).map((settlement) => settlement.roundId));
    const byRound = new Map<string, { roundId: string; eventSlug: string; marketTitle?: string; imageUrl?: string; latestTime: number; strike?: number }>();
    for (const fill of this.fills) {
      if (fill.profileId !== profileId) continue;
      if (settled.has(fill.roundId) || !isRoundEnded(fill.roundId, Date.now(), 0, durationSeconds)) continue;
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

  reconcileOpenOrderStatuses(profileId: MarketProfileId, openOrders: OpenOrderLike[]): number {
    const openOrderIds = new Set(openOrders.map((order) => order.id).filter(Boolean));
    const openTokenIds = new Set(openOrders.map((order) => order.tokenId).filter(Boolean));
    let updated = 0;
    this.orders = this.orders.map((order) => {
      if (order.profileId !== profileId) return order;
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

  futureOpenDualOrders(profileId: MarketProfileId, sourceRoundId: string): OrderRecord[] {
    const sourceStartMs = roundStartMs(sourceRoundId);
    if (sourceStartMs == null) return [];
    return this.orders.filter((order) => {
      if (order.profileId !== profileId || order.side !== 'BUY') return false;
      if (orderStrategy(order) !== CLASSIC_ENTRY_STRATEGY) return false;
      if (order.status !== 'posted' && order.status !== 'partially_filled') return false;
      if (!order.clobOrderId) return false;
      const orderStartMs = roundStartMs(order.roundId);
      return orderStartMs != null && orderStartMs > sourceStartMs;
    });
  }

  getPendingSingleFillRisk(profileId: MarketProfileId, nowMs = Date.now()): PendingSingleFillRiskRecord | null {
    const candidates: PendingSingleFillRiskRecord[] = [];
    for (const key of this.pendingSingleFillReviewRoundIds) {
      const { profileId: sourceProfileId, roundId } = parseProfileRoundKey(key);
      if (!sourceProfileId || this.singleFillCooldownRoundIds.has(key)) continue;
      if (!this.sharedCooldownTargetProfileIds(sourceProfileId).includes(profileId)) continue;
      const reviewAtMs = finalSingleFillReviewMs(roundId, sourceProfileId);
      if (reviewAtMs == null) continue;
      const exposure = this.singleSidedBuyExposure(roundId, CLASSIC_ENTRY_STRATEGY, sourceProfileId);
      if (!exposure.singleSided) continue;
      candidates.push({
        profileId,
        sourceProfileId,
        roundId,
        expiresAt: new Date(Math.max(reviewAtMs, nowMs + 60_000)).toISOString(),
        yesShares: exposure.yesShares,
        noShares: exposure.noShares,
      });
    }
    return candidates.sort((left, right) => toTime(right.expiresAt) - toTime(left.expiresAt))[0] ?? null;
  }

  getRoundStrike(roundId: string): number | undefined {
    return this.roundStrikes.get(roundId);
  }

  getActiveEntryCooldown(profileId: MarketProfileId, nowMs = Date.now()): SingleFillCooldownRecord | null {
    const active = this.singleFillCooldowns.get(profileId) || null;
    if (!active) return null;
    const sourceProfileId = active.sourceProfileId || active.profileId;
    const sourceRoundId = active.sourceRoundId || active.roundId;
    if (!active.finalizedAt) {
      this.clearSingleFillCooldown(profileId);
      return null;
    }
    if (!this.isFinalSingleSidedBuyRound(sourceRoundId, nowMs, sourceProfileId)) {
      this.clearSingleFillCooldown(profileId);
      return null;
    }
    const expiresAtMs = new Date(active.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      this.clearSingleFillCooldown(profileId);
      return null;
    }
    return active;
  }

  refreshActiveSingleFillCooldowns(nowMs = Date.now()): { refreshed: number; cleared: number } {
    let refreshed = 0;
    let cleared = 0;
    let dirty = false;

    for (const [profileId, active] of [...this.singleFillCooldowns.entries()]) {
      const sourceProfileId = active.sourceProfileId || active.profileId;
      const sourceRoundId = active.sourceRoundId || active.roundId;
      if (!active.finalizedAt || !this.isFinalSingleSidedBuyRound(sourceRoundId, nowMs, sourceProfileId)) {
        this.singleFillCooldowns.delete(profileId);
        cleared += 1;
        dirty = true;
        continue;
      }

      const configured = this.profiles.find((profile) => profile.id === profileId);
      if (!configured) continue;
      const referenceMs = finalSingleFillReviewMs(sourceRoundId, sourceProfileId) ?? toTime(active.finalizedAt || active.triggeredAt);
      const cooldownDecision = this.singleFillCooldownDecision(sourceRoundId, configured.cooldown, referenceMs, profileId, sourceProfileId, active);
      const expiresAt = new Date(referenceMs + cooldownDecision.cooldownMs).toISOString();
      if (toTime(expiresAt) <= nowMs) {
        this.singleFillCooldowns.delete(profileId);
        cleared += 1;
        dirty = true;
        continue;
      }

      const next: SingleFillCooldownRecord = {
        ...active,
        profileId,
        sourceProfileId,
        sourceRoundId,
        triggeredAt: new Date(referenceMs).toISOString(),
        finalizedAt: new Date(referenceMs).toISOString(),
        expiresAt,
        category: cooldownDecision.category,
        hedgeReason: cooldownDecision.hedgeReason,
        recentSingleFillCount: cooldownDecision.recentCount,
      };
      if (
        active.expiresAt !== next.expiresAt
        || active.category !== next.category
        || active.hedgeReason !== next.hedgeReason
        || active.recentSingleFillCount !== next.recentSingleFillCount
      ) {
        this.singleFillCooldowns.set(profileId, next);
        refreshed += 1;
        dirty = true;
      }
    }

    if (dirty) this.persistState();
    return { refreshed, cleared };
  }

  recordSingleFillHedgeOutcome(outcome: SingleFillHedgeOutcome): void {
    this.singleFillHedgeOutcomes.set(profileRoundKey(outcome.profileId, outcome.roundId), outcome);
    this.persistState();
  }

  getSingleFillHedgeOutcome(profileId: MarketProfileId, roundId: string): SingleFillHedgeOutcome | undefined {
    return this.singleFillHedgeOutcomes.get(profileRoundKey(profileId, roundId));
  }

  getExperimentRunStartedAt(): string {
    return this.experimentRunStartedAt;
  }

  getExperimentStop(): ExperimentStopRecord | null {
    if (!this.experimentStop || toTime(this.experimentStop.stoppedAt) < toTime(this.experimentRunStartedAt)) return null;
    return this.experimentStop;
  }

  maybeStopExperimentOnSingle(newFills: FillRecord[], nowMs = Date.now()): ExperimentStopRecord | null {
    if (this.getExperimentStop()) return null;
    const runStartedAtMs = toTime(this.experimentRunStartedAt);
    const roundKeys = new Set<string>();
    for (const fill of [...newFills, ...this.fills]) {
      if (fill.side !== 'BUY') continue;
      if (fillStrategy(fill) !== EXPERIMENT_STRATEGY) continue;
      if (toTime(fill.matchedAt) < runStartedAtMs) continue;
      roundKeys.add(profileRoundKey(fill.profileId, fill.roundId));
    }
    for (const key of roundKeys) {
      const { profileId, roundId } = parseProfileRoundKey(key);
      if (!profileId) continue;
      if (!isRoundEnded(roundId, nowMs, FINAL_SINGLE_FILL_GRACE_MS, profileDurationSeconds(profileId))) continue;
      const exposure = this.singleSidedBuyExposure(roundId, EXPERIMENT_STRATEGY, profileId);
      if (!exposure.singleSided) continue;
      const record: ExperimentStopRecord = {
        profileId,
        roundId,
        stoppedAt: new Date(nowMs).toISOString(),
        reason: 'EXPERIMENT_SINGLE_FILL',
        yesShares: exposure.yesShares,
        noShares: exposure.noShares,
      };
      this.experimentStop = record;
      this.persistState();
      return record;
    }
    return null;
  }

  maybeStartSingleFillCooldown(newFills: FillRecord[], cooldown: number | SingleFillCooldownPolicy, nowMs = Date.now(), strategy: StrategyId = CLASSIC_ENTRY_STRATEGY, profileId: MarketProfileId): SingleFillCooldownRecord | null {
    const policy = normalizeCooldownPolicy(cooldown);
    let dirty = false;
    for (const fill of newFills) {
      if (fill.profileId !== profileId) continue;
      const key = profileRoundKey(profileId, fill.roundId);
      if (fill.side !== 'BUY' || this.singleFillCooldownRoundIds.has(key)) continue;
      if (fillStrategy(fill) !== strategy) continue;
      if (!this.hasTrackedBuyOrderForFill(fill, strategy, profileId)) continue;
      const before = this.pendingSingleFillReviewRoundIds.size;
      this.pendingSingleFillReviewRoundIds.add(key);
      dirty ||= this.pendingSingleFillReviewRoundIds.size !== before;
    }

    const activeCooldowns = new Map<MarketProfileId, SingleFillCooldownRecord | null>();
    for (const targetProfileId of this.sharedCooldownTargetProfileIds(profileId)) {
      activeCooldowns.set(targetProfileId, this.getActiveEntryCooldown(targetProfileId, nowMs));
    }
    const cooldownCandidates: SingleFillCooldownRecord[] = [];

    for (const key of this.pendingSingleFillReviewRoundIds) {
      const { profileId: pendingProfileId, roundId } = parseProfileRoundKey(key);
      const effectiveProfileId = pendingProfileId || profileId;
      if (effectiveProfileId !== profileId) continue;
      if (this.singleFillCooldownRoundIds.has(key)) continue;
      if (!isRoundEnded(roundId, nowMs, FINAL_SINGLE_FILL_GRACE_MS, profileDurationSeconds(effectiveProfileId))) continue;
      const exposure = this.singleSidedBuyExposure(roundId, strategy, effectiveProfileId);
      this.pendingSingleFillReviewRoundIds.delete(key);
      this.singleFillCooldownRoundIds.add(key);
      dirty = true;
      if (!exposure.singleSided) {
        this.persistState();
        continue;
      }

      const cooldownStartMs = finalSingleFillReviewMs(roundId, effectiveProfileId) ?? nowMs;
      for (const targetProfileId of this.sharedCooldownTargetProfileIds(effectiveProfileId)) {
        const targetPolicy = this.cooldownPolicyForTarget(targetProfileId, policy);
        const cooldownDecision = this.singleFillCooldownDecision(roundId, targetPolicy, cooldownStartMs, targetProfileId, effectiveProfileId);
        const record: SingleFillCooldownRecord = {
          profileId: targetProfileId,
          roundId,
          sourceProfileId: effectiveProfileId,
          sourceRoundId: roundId,
          triggeredAt: new Date(cooldownStartMs).toISOString(),
          finalizedAt: new Date(cooldownStartMs).toISOString(),
          expiresAt: new Date(cooldownStartMs + cooldownDecision.cooldownMs).toISOString(),
          yesShares: exposure.yesShares,
          noShares: exposure.noShares,
          category: cooldownDecision.category,
          hedgeReason: cooldownDecision.hedgeReason,
          recentSingleFillCount: cooldownDecision.recentCount,
        };
        this.singleFillCooldownEvents = [
          { profileId: targetProfileId, sourceProfileId: effectiveProfileId, roundId, sourceRoundId: roundId, triggeredAt: record.triggeredAt, category: cooldownDecision.category },
          ...this.singleFillCooldownEvents.filter((event) => event.profileId !== targetProfileId || nowMs - toTime(event.triggeredAt) <= targetPolicy.repeatWindowMs),
        ].slice(0, 100);
        cooldownCandidates.push(record);
      }
    }

    if (cooldownCandidates.length > 0) {
      let returnedCooldown: SingleFillCooldownRecord | null = null;
      const targetProfileIds = new Set(cooldownCandidates.map((record) => record.profileId));
      for (const targetProfileId of targetProfileIds) {
        const activeCooldown = activeCooldowns.get(targetProfileId) || null;
        const activeCandidates = cooldownCandidates.filter((record) => record.profileId === targetProfileId && toTime(record.expiresAt) > nowMs);
        const selectableCooldowns = [activeCooldown, ...activeCandidates].filter((record): record is SingleFillCooldownRecord => Boolean(record));
        if (!selectableCooldowns.length) continue;
        const nextCooldown = maxCooldown(selectableCooldowns);
        const changedActiveCooldown = !activeCooldown
          || activeCooldown.roundId !== nextCooldown.roundId
          || activeCooldown.sourceProfileId !== nextCooldown.sourceProfileId
          || activeCooldown.expiresAt !== nextCooldown.expiresAt;
        this.singleFillCooldowns.set(targetProfileId, nextCooldown);
        if (changedActiveCooldown && targetProfileId === profileId) returnedCooldown = nextCooldown;
      }
      this.persistState();
      return returnedCooldown;
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

  getTelegramNotificationState(): TelegramNotificationState {
    return {
      notifiedRoundSummaryKeys: [...this.telegramNotifications.notifiedRoundSummaryKeys],
      lastIdleSummaryAt: this.telegramNotifications.lastIdleSummaryAt,
    };
  }

  markTelegramRoundSummaryNotified(key: string): void {
    if (!key.trim()) return;
    const keys = new Set(this.telegramNotifications.notifiedRoundSummaryKeys);
    keys.add(key);
    this.telegramNotifications = {
      ...this.telegramNotifications,
      notifiedRoundSummaryKeys: [...keys].slice(-this.telegramNotificationHistoryLimit()),
    };
    this.persistState();
  }

  markTelegramIdleSummaryNotified(sentAt = new Date().toISOString()): void {
    this.telegramNotifications = {
      ...this.telegramNotifications,
      lastIdleSummaryAt: sentAt,
    };
    this.persistState();
  }

  dashboardState(): DashboardState {
    const profiles = this.profiles.filter((profile) => profile.status !== 'disabled').map((profile) => ({
      profile,
      feed: this.latestFeeds.get(profile.id) || { binanceConnected: false, clobConnected: false, priceSamples: 0, source: 'unavailable' as const },
      latestSnapshot: this.latestSnapshots.get(profile.id),
      strategyChecks: this.strategyChecksByProfile.get(profile.id) || [],
      entryCooldownUntil: this.singleFillCooldowns.get(profile.id)?.expiresAt,
      entryCooldownReason: this.entryCooldownReason(profile.id),
      dynamicEntryPrice: this.dynamicEntryPrices.get(profile.id),
      stats: {
        orders: this.orders.filter((order) => order.profileId === profile.id).length,
        fills: this.fills.filter((fill) => fill.profileId === profile.id).length,
        settlements: this.settlements.filter((settlement) => settlement.profileId === profile.id).length,
        settledPnl: roundMoney(sum(this.settlements.filter((settlement) => settlement.profileId === profile.id && settlement.status === 'settled').map((settlement) => settlement.pnl))),
      },
    }));
    return {
      runtime: this.runtimeWithCooldown(),
      profiles,
      intents: this.intents,
      orders: this.orders,
      fills: this.fills,
      settlements: this.settlements,
      runtimeLogs: this.runtimeLogs,
      rules: STRATEGY_RULES,
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
      this.telegramNotifications = isTelegramNotificationStateLike(parsed.telegramNotifications) ? parsed.telegramNotifications : { notifiedRoundSummaryKeys: [] };
      this.roundStrikes = new Map(Object.entries(parsed.roundStrikes || {}).filter(([, strike]) => Number.isFinite(strike) && strike > 0));
      this.singleFillCooldowns = new Map(Object.entries(parsed.singleFillCooldowns || {}).filter((entry): entry is [MarketProfileId, SingleFillCooldownRecord] => isMarketProfileId(entry[0]) && isSingleFillCooldownLike(entry[1])));
      this.singleFillCooldownRoundIds = new Set(Array.isArray(parsed.singleFillCooldownRoundIds) ? parsed.singleFillCooldownRoundIds.filter((roundId): roundId is string => typeof roundId === 'string') : []);
      this.pendingSingleFillReviewRoundIds = new Set(Array.isArray(parsed.pendingSingleFillReviewRoundIds) ? parsed.pendingSingleFillReviewRoundIds.filter((roundId): roundId is string => typeof roundId === 'string') : []);
      this.singleFillHedgeOutcomes = new Map(Object.entries(parsed.singleFillHedgeOutcomes || {}).filter((entry): entry is [string, SingleFillHedgeOutcome] => isSingleFillHedgeOutcomeLike(entry[1])));
      this.singleFillCooldownEvents = Array.isArray(parsed.singleFillCooldownEvents) ? parsed.singleFillCooldownEvents.filter(isSingleFillCooldownEventLike).slice(0, 100) : [];
      this.tailCooldowns = new Map(Object.entries(parsed.tailCooldowns || {}).filter((entry): entry is [MarketProfileId, TailCooldownRecord] => isMarketProfileId(entry[0]) && Boolean(entry[1]?.roundId && entry[1]?.expiresAt)));
      this.tailCooldownEvents = Array.isArray(parsed.tailCooldownEvents) ? parsed.tailCooldownEvents.filter((event): event is TailCooldownEvent => Boolean(event?.profileId && event?.roundId && event?.triggeredAt)).slice(0, 100) : [];
      this.experimentStop = isExperimentStopLike(parsed.experimentStop) ? parsed.experimentStop : null;
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
        version: 2,
        savedAt: new Date().toISOString(),
        intents: this.intents,
        orders: this.orders,
        fills: this.fills,
        settlements: this.settlements,
        telegramNotifications: this.telegramNotifications,
        roundStrikes: Object.fromEntries(this.roundStrikes),
        singleFillCooldowns: Object.fromEntries(this.singleFillCooldowns),
        singleFillCooldownRoundIds: [...this.singleFillCooldownRoundIds],
        pendingSingleFillReviewRoundIds: [...this.pendingSingleFillReviewRoundIds],
        singleFillHedgeOutcomes: Object.fromEntries(this.singleFillHedgeOutcomes),
        singleFillCooldownEvents: this.singleFillCooldownEvents,
        tailCooldowns: Object.fromEntries(this.tailCooldowns),
        tailCooldownEvents: this.tailCooldownEvents,
        experimentStop: this.experimentStop,
      };
      const tmpPath = `${this.persistencePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
      fs.renameSync(tmpPath, this.persistencePath);
    } catch (error) {
      console.warn('[store] failed to persist runtime state', error);
    }
  }

  private telegramNotificationHistoryLimit(): number {
    return Math.max(500, this.maxRecords * 2);
  }

  private runtimeWithCooldown(nowMs = Date.now()): BotRuntimeStatus {
    const experimentStop = this.getExperimentStop();
    const experimentFields = experimentStop ? {
      experimentStoppedAt: experimentStop.stoppedAt,
      experimentStoppedReason: experimentStop.reason,
      experimentStoppedRoundId: experimentStop.roundId,
    } : {};
    void nowMs;
    return { ...this.runtime, ...experimentFields };
  }

  private singleFillCooldownDecision(roundId: string, policy: SingleFillCooldownPolicy, referenceMs: number, profileId: MarketProfileId, sourceProfileId = profileId, excludeEvent?: Pick<SingleFillCooldownRecord, 'profileId' | 'sourceProfileId' | 'roundId' | 'sourceRoundId' | 'triggeredAt'>): { cooldownMs: number; category: string; hedgeReason?: string; recentCount: number } {
    const hedgeOutcome = this.singleFillHedgeOutcomes.get(profileRoundKey(sourceProfileId, roundId));
    const category = cooldownCategory(hedgeOutcome);
    const baseMs = category === 'price-cap'
      ? policy.priceCapMs
      : category === 'execution'
        ? policy.executionMs
        : policy.baseMs;
    const recentCount = this.singleFillCooldownEvents.filter((event) => {
      const eventMs = toTime(event.triggeredAt);
      if (excludeEvent && isSameCooldownEvent(event, excludeEvent)) return false;
      return event.profileId === profileId && eventMs <= referenceMs && referenceMs - eventMs <= policy.repeatWindowMs;
    }).length + 1;
    const repeatMs = recentCount >= 3 ? policy.thirdMs : recentCount >= 2 ? policy.secondMs : 0;
    return {
      cooldownMs: Math.max(baseMs, repeatMs),
      category,
      hedgeReason: hedgeOutcome?.reason,
      recentCount,
    };
  }

  private isFinalSingleSidedBuyRound(roundId: string, nowMs: number, profileId: MarketProfileId): boolean {
    if (!isRoundEnded(roundId, nowMs, FINAL_SINGLE_FILL_GRACE_MS, profileDurationSeconds(profileId))) return false;
    if (!this.hasTrackedBuyOrderForRound(roundId, CLASSIC_ENTRY_STRATEGY, profileId)) return false;
    return this.singleSidedBuyExposure(roundId, CLASSIC_ENTRY_STRATEGY, profileId).singleSided;
  }

  private singleSidedBuyExposure(roundId: string, strategy: StrategyId, profileId: MarketProfileId): { yesShares: number; noShares: number; singleSided: boolean } {
    const roundFills = this.fills.filter((fill) => fill.roundId === roundId && fill.profileId === profileId && fillStrategy(fill) === strategy);
    const yesShares = netShares(roundFills, 'YES');
    const noShares = netShares(roundFills, 'NO');
    return {
      yesShares,
      noShares,
      singleSided: (yesShares > 0 && noShares <= 0) || (noShares > 0 && yesShares <= 0),
    };
  }

  private hasTrackedBuyOrderForFill(fill: FillRecord, strategy: StrategyId, profileId: MarketProfileId): boolean {
    return this.orders.some((order) => (
      order.roundId === fill.roundId
      && order.profileId === profileId
      && orderStrategy(order) === strategy
      && order.side === 'BUY'
      && order.status !== 'failed'
      && (
        (fill.clobOrderId && order.clobOrderId === fill.clobOrderId)
        || order.tokenId === fill.tokenId
        || order.label === fill.label
      )
    ));
  }

  private hasTrackedBuyOrderForRound(roundId: string, strategy: StrategyId, profileId: MarketProfileId): boolean {
    return this.orders.some((order) => order.roundId === roundId && order.profileId === profileId && orderStrategy(order) === strategy && order.side === 'BUY' && order.status !== 'failed');
  }

  private fillWithStrategySource(fill: FillRecord): FillRecord {
    if (fill.strategy && fill.strategyProfile) return fill;
    const exact = fill.clobOrderId
      ? this.orders.find((order) => order.clobOrderId === fill.clobOrderId)
      : undefined;
    const candidates = exact ? [exact] : this.orders.filter((order) => (
      order.roundId === fill.roundId
      && order.profileId === fill.profileId
      && order.tokenId === fill.tokenId
      && order.label === fill.label
      && order.side === fill.side
      && order.status !== 'failed'
    ));
    const strategies = new Set(candidates.map(orderStrategy));
    if (strategies.size !== 1) return fill;
    const strategy = [...strategies][0];
    return { ...fill, strategy, strategyProfile: strategyProfileForStrategy(strategy) };
  }

  private clearSingleFillCooldown(profileId: MarketProfileId): void {
    this.singleFillCooldowns.delete(profileId);
    this.persistState();
  }

  private sharedCooldownTargetProfileIds(sourceProfileId: MarketProfileId): MarketProfileId[] {
    const asset = profileAsset(sourceProfileId);
    const configured = this.profiles
      .filter((profile) => profile.asset === asset && profile.status !== 'disabled')
      .map((profile) => profile.id);
    const targets = configured.length ? configured : profileIntervals(asset).map((interval) => `${asset}-${interval}` as MarketProfileId);
    return [...new Set(targets)];
  }

  private cooldownPolicyForTarget(targetProfileId: MarketProfileId, sourcePolicy: SingleFillCooldownPolicy): SingleFillCooldownPolicy {
    const configured = this.profiles.find((profile) => profile.id === targetProfileId);
    if (configured) return configured.cooldown;
    return sourcePolicy;
  }

  private entryCooldownReason(profileId: MarketProfileId): string | undefined {
    const cooldown = this.singleFillCooldowns.get(profileId);
    if (!cooldown) return undefined;
    const sourceProfileId = cooldown.sourceProfileId || cooldown.profileId;
    const sourceRoundId = cooldown.sourceRoundId || cooldown.roundId;
    if (sourceProfileId === profileId) return `single fill on ${sourceRoundId}`;
    return `shared single fill from ${sourceProfileId} on ${sourceRoundId}`;
  }
}
