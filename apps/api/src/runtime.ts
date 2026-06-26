import type { BtcRoundConfig, FillRecord, PositionSnapshot, RoundPhase, RoundSnapshot, SettlementRecord, StateSnapshot, StrategyCheck, TradeIntent } from '../../../packages/shared/src';
import { classifyRegime, evaluateEntry, evaluateExit, type StrategyRiskConfig } from '../../../packages/strategy/src';
import { PolymarketAdapter, type FillTarget } from '../../../packages/polymarket/src';
import type { AppConfig } from './config';
import { buildSingleFillHedgeCheck, executeSingleFillHedges, planSingleFillHedge } from './hedge';
import { executeLiveIntents } from './execution';
import type { MarketDataService } from './marketData';
import type { ParticipationService } from './participation';
import type { Btc5mRoundDiscovery } from './roundDiscovery';
import type { InMemoryStore } from './store';

export async function runBotTick(appConfig: AppConfig, store: InMemoryStore, data: MarketDataService, adapter: PolymarketAdapter, discovery: Btc5mRoundDiscovery, participationService: ParticipationService): Promise<StateSnapshot> {
  const diagnostics: string[] = [];
  const discovered = await discovery.discover({
    latestPrice: data.latestPrice(),
    persistedStrike: (roundId) => store.getRoundStrike(roundId),
  });
  diagnostics.push(...discovered.diagnostics);
  const round = captureOpeningStrike(discovered.round, store, data.latestPrice());
  const hedgeWatchTokenIds = appConfig.singleFillHedgeEnabled
    ? store.hedgeWatchTokenIds(appConfig.singleFillHedgeWindowSeconds, appConfig.singleFillHedgeMinSecondsToEnd)
    : [];
  data.syncClobRound(round, hedgeWatchTokenIds);
  const orderbooks = await data.refreshOrderbooks(round);
  const participation = await participationService.refresh(round);
  diagnostics.push(...participation.diagnostics);
  const features = data.features(round);
  const roundSnapshot = roundToSnapshot(appConfig, store, round);
  const tokenLabels = new Map<string, 'YES' | 'NO'>([
    [round.yesTokenId, 'YES'],
    [round.noTokenId, 'NO'],
  ]);
  const positions = await loadPositions(appConfig, adapter, tokenLabels, diagnostics);
  const baseSnapshot: StateSnapshot = {
    id: `snapshot-${Date.now()}`,
    capturedAt: new Date().toISOString(),
    round: roundSnapshot,
    features,
    regime: 'UNKNOWN',
    orderbooks,
    positions,
    positionReadStatus: appConfig.depositWallet?.trim() ? 'enabled' : 'disabled',
    participation,
    diagnostics,
  };
  const activeCooldown = store.getActiveEntryCooldown();
  const risk = riskConfig(appConfig, store.getRuntime().executionMode !== 'live', activeCooldown?.expiresAt, activeCooldown ? `single fill on ${activeCooldown.roundId}` : undefined);
  const snapshot: StateSnapshot = { ...baseSnapshot, regime: classifyRegime(baseSnapshot, risk) };
  const evaluatedEntry = evaluateEntry(snapshot, risk);
  const entrySignalCount = store.recordEntrySignal(snapshot.round.id, evaluatedEntry.intents.length > 0);
  const entry = applyEntryConfirmation(evaluatedEntry, entrySignalCount, appConfig.entryConfirmTicks);
  const intents = [...entry.intents];
  store.recordIntents([...intents, ...entry.rejected]);
  const executionDiagnostics = await executeLiveIntents({ appConfig, adapter, store, snapshot, intents, risk });
  await reconcileFills(appConfig, adapter, store, roundSnapshot, tokenLabels, diagnostics);
  await reconcileTrackedOrders(appConfig, adapter, store, diagnostics);
  const hedgeCandidates = appConfig.singleFillHedgeEnabled
    ? store.singleFillHedgeCandidates(appConfig.singleFillHedgeWindowSeconds, appConfig.singleFillHedgeMinSecondsToEnd)
    : [];
  const hedgeOrderbooks = data.refreshOrderbooksForTokenIds(hedgeCandidates.flatMap((candidate) => [candidate.yesTokenId, candidate.noTokenId]));
  const hedgeDiagnostics = await executeSingleFillHedges({ appConfig, adapter, store, candidates: hedgeCandidates, orderbooks: hedgeOrderbooks });
  const exit = evaluateExit(snapshot, positions, risk, { orders: store.roundOrders(snapshot.round.id), fills: store.roundFills(snapshot.round.id) });
  const hedgeCheck = buildCurrentRoundHedgeCheck(appConfig, store, snapshot, [...orderbooks, ...hedgeOrderbooks]);
  await reconcileSettlements(appConfig, store, diagnostics);
  maybeRecordEstimatedSettlement(store, snapshot);
  const finalSnapshot = { ...snapshot, diagnostics: [...diagnostics, ...entry.diagnostics, ...executionDiagnostics, ...hedgeDiagnostics] };
  store.recordSnapshot(finalSnapshot, data.status());
  store.recordStrategyChecks([...entry.checks, ...exit.checks, hedgeCheck]);
  return finalSnapshot;
}

function applyEntryConfirmation(entry: ReturnType<typeof evaluateEntry>, signalCount: number, requiredTicks: number): ReturnType<typeof evaluateEntry> {
  const confirmed = signalCount >= requiredTicks;
  const check = entry.checks[0];
  const confirmationCondition = {
    label: 'Entry signal confirmation',
    passed: confirmed,
    actual: `${signalCount} / ${requiredTicks} consecutive eligible ticks`,
  };
  if (!entry.intents.length) {
    return { ...entry, checks: [{ ...check, conditions: [...check.conditions, confirmationCondition] }] };
  }
  if (confirmed) {
    return { ...entry, checks: [{ ...check, conditions: [...check.conditions, confirmationCondition] }] };
  }
  const reason = 'ENTRY_SIGNAL_CONFIRMING';
  const rejected = entry.intents.map((intent): TradeIntent => ({ ...intent, status: 'rejected', rejectionReason: reason }));
  const blockedCheck: StrategyCheck = {
    ...check,
    status: 'blocked',
    reason: `${check.reason}; waiting for entry signal confirmation.`,
    blockers: [...check.blockers, reason],
    conditions: [...check.conditions, confirmationCondition],
  };
  return { ...entry, intents: [], rejected: [...entry.rejected, ...rejected], checks: [blockedCheck] };
}

function buildCurrentRoundHedgeCheck(appConfig: AppConfig, store: InMemoryStore, snapshot: StateSnapshot, orderbooks: StateSnapshot['orderbooks']) {
  const candidate = {
    roundId: snapshot.round.id,
    eventSlug: snapshot.round.eventSlug,
    marketTitle: snapshot.round.title,
    imageUrl: snapshot.round.imageUrl,
    startAt: snapshot.round.startAt,
    endAt: snapshot.round.endAt,
    secondsToEnd: snapshot.round.secondsToEnd,
    yesTokenId: snapshot.round.yesTokenId,
    noTokenId: snapshot.round.noTokenId,
  };
  const orders = store.roundOrders(snapshot.round.id);
  const plan = planSingleFillHedge({ candidate, orders, orderbooks, appConfig });
  const executionKey = plan.ok ? [plan.intent.roundId, plan.intent.strategy, plan.intent.tokenId, plan.intent.side].join(':') : undefined;
  return buildSingleFillHedgeCheck({
    candidate,
    orders,
    orderbooks,
    appConfig,
    runtimeStatus: store.getRuntime().status,
    outcome: store.getSingleFillHedgeOutcome(snapshot.round.id),
    hasRecentHedgeOrder: executionKey ? store.hasRecentOrder(executionKey, appConfig.singleFillHedgeWindowSeconds * 1000) : false,
    hasRecentFailedHedgeOrder: executionKey ? store.hasRecentFailedOrder(executionKey, 60_000) : false,
  });
}

function captureOpeningStrike(round: BtcRoundConfig, store: InMemoryStore, latestPrice: number | null): BtcRoundConfig {
  const persisted = store.getRoundStrike(round.eventSlug);
  if (persisted) return { ...round, strike: persisted };
  const startMs = new Date(round.startAt).getTime();
  if (Date.now() < startMs || latestPrice == null || !Number.isFinite(latestPrice) || latestPrice <= 0) return round;
  store.recordRoundStrike(round.eventSlug, latestPrice);
  return { ...round, strike: latestPrice };
}

function roundToSnapshot(appConfig: AppConfig, store: InMemoryStore, round: BtcRoundConfig): RoundSnapshot {
  const now = Date.now();
  const start = new Date(round.startAt).getTime();
  const end = new Date(round.endAt).getTime();
  return {
    id: round.eventSlug,
    phase: roundPhase(now, start, end, appConfig.marketConfig.decisionLeadSeconds, appConfig.marketConfig.avoidExpirySeconds),
    eventSlug: round.eventSlug,
    conditionId: round.conditionId,
    title: round.title,
    startAt: round.startAt,
    endAt: round.endAt,
    secondsToStart: (start - now) / 1000,
    secondsToEnd: (end - now) / 1000,
    strike: round.strike,
    strikeStatus: store.getRoundStrike(round.eventSlug) ? 'locked' : 'estimated',
    yesTokenId: round.yesTokenId,
    noTokenId: round.noTokenId,
    sourceUrl: round.sourceUrl,
    imageUrl: round.imageUrl,
  };
}

function roundPhase(now: number, start: number, end: number, decisionLeadSeconds: number, avoidExpirySeconds: number): RoundPhase {
  if (now < start - decisionLeadSeconds * 1000) return 'observing';
  if (now < start) return 'decision';
  if (now < start + 10_000) return 'posting';
  if (now < end - avoidExpirySeconds * 1000) return 'monitoring';
  if (now < end) return 'settling';
  return 'settled';
}

async function loadPositions(appConfig: AppConfig, adapter: PolymarketAdapter, tokenLabels: Map<string, 'YES' | 'NO'>, diagnostics: string[]): Promise<PositionSnapshot[]> {
  if (!appConfig.depositWallet?.trim()) {
    if (appConfig.executionMode === 'live') diagnostics.push('Position reads require POLYMARKET_DEPOSIT_WALLET.');
    return [];
  }
  try {
    return await adapter.getCurrentPositions(tokenLabels);
  } catch (error) {
    diagnostics.push(`Position load failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function reconcileFills(appConfig: AppConfig, adapter: PolymarketAdapter, store: InMemoryStore, round: RoundSnapshot, tokenLabels: Map<string, 'YES' | 'NO'>, diagnostics: string[]): Promise<void> {
  if (!tokenLabels.size) return;
  try {
    const fills = await adapter.getRecentFills({
      roundId: round.id,
      eventSlug: round.eventSlug,
      tokenLabels,
      marketTitle: round.title,
      imageUrl: round.imageUrl,
    });
    recordFillsAndMaybeCooldown(appConfig, store, fills);
  } catch (error) {
    if (store.getRuntime().executionMode === 'live') diagnostics.push(`Fill reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function reconcileTrackedOrders(appConfig: AppConfig, adapter: PolymarketAdapter, store: InMemoryStore, diagnostics: string[]): Promise<void> {
  const orders = store.ordersNeedingReconciliation();
  if (!orders.length) return;
  try {
    const targets: FillTarget[] = orders.map((order) => ({
      roundId: order.roundId,
      eventSlug: order.eventSlug,
      marketTitle: order.marketTitle,
      imageUrl: order.imageUrl,
      tokenId: order.tokenId,
      label: order.label,
      clobOrderId: order.clobOrderId,
    }));
    const fills = await adapter.getRecentFillsForTargets(targets);
    recordFillsAndMaybeCooldown(appConfig, store, fills);

    const openOrders = await adapter.getOpenOrders();
    const cancelled = store.reconcileOpenOrderStatuses(openOrders);
    if (cancelled) {
      store.recordRuntimeLog({
        level: 'info',
        source: 'execution',
        message: `Reconciled ${cancelled} stale Polymarket orders as no longer open.`,
      });
    }
  } catch (error) {
    if (store.getRuntime().executionMode === 'live') diagnostics.push(`Order reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function recordFillsAndMaybeCooldown(appConfig: AppConfig, store: InMemoryStore, fills: FillRecord[]): void {
  const newFills = store.recordFills(fills);
  const cooldown = store.maybeStartSingleFillCooldown(newFills, {
    baseMs: appConfig.singleFillCooldownBaseMs,
    priceCapMs: appConfig.singleFillCooldownPriceCapMs,
    executionMs: appConfig.singleFillCooldownExecutionMs,
    repeatWindowMs: appConfig.singleFillCooldownRepeatWindowMs,
    secondMs: appConfig.singleFillCooldownSecondMs,
    thirdMs: appConfig.singleFillCooldownThirdMs,
  });
  if (!cooldown) return;
  store.recordRuntimeLog({
    level: 'warn',
    source: 'execution',
    message: `Final single-sided fill detected on ${cooldown.roundId}; entry cooldown active until ${cooldown.expiresAt}.`,
    details: cooldown,
  });
}

async function reconcileSettlements(appConfig: AppConfig, store: InMemoryStore, diagnostics: string[]): Promise<void> {
  const rounds = store.roundsNeedingSettlement();
  if (!rounds.length) return;
  for (const round of rounds) {
    try {
      const winningLabel = await resolvedWinningLabel(appConfig, round.eventSlug);
      if (!winningLabel) continue;
      const fills = store.roundFills(round.roundId);
      const yesShares = sum(fills.filter((fill) => fill.label === 'YES' && fill.side === 'BUY').map((fill) => fill.size));
      const noShares = sum(fills.filter((fill) => fill.label === 'NO' && fill.side === 'BUY').map((fill) => fill.size));
      const totalCost = sum(fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.price * fill.size));
      const payout = winningLabel === 'YES' ? yesShares : noShares;
      const settlement: SettlementRecord = {
        id: `settlement-${round.roundId}`,
        roundId: round.roundId,
        eventSlug: round.eventSlug,
        marketTitle: round.marketTitle,
        imageUrl: round.imageUrl,
        resolvedAt: new Date().toISOString(),
        winningLabel,
        yesShares,
        noShares,
        totalCost,
        payout,
        pnl: payout - totalCost,
        status: 'settled',
      };
      store.recordSettlement(settlement);
    } catch (error) {
      if (store.getRuntime().executionMode === 'live') diagnostics.push(`Settlement reconciliation failed for ${round.roundId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function maybeRecordEstimatedSettlement(store: InMemoryStore, snapshot: StateSnapshot): void {
  if (snapshot.round.phase !== 'settled') return;
  const fills = store.roundFills(snapshot.round.id);
  if (!fills.length) return;
  const yesShares = sum(fills.filter((fill) => fill.label === 'YES' && fill.side === 'BUY').map((fill) => fill.size));
  const noShares = sum(fills.filter((fill) => fill.label === 'NO' && fill.side === 'BUY').map((fill) => fill.size));
  const totalCost = sum(fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.price * fill.size));
  const winningLabel = snapshot.features.price == null ? undefined : snapshot.features.price >= snapshot.round.strike ? 'YES' : 'NO';
  const payout = winningLabel === 'YES' ? yesShares : winningLabel === 'NO' ? noShares : 0;
  const settlement: SettlementRecord = {
    id: `settlement-${snapshot.round.id}`,
    roundId: snapshot.round.id,
    eventSlug: snapshot.round.eventSlug,
    marketTitle: snapshot.round.title,
    imageUrl: snapshot.round.imageUrl,
    resolvedAt: snapshot.capturedAt,
    winningLabel,
    yesShares,
    noShares,
    totalCost,
    payout,
    pnl: payout - totalCost,
    status: 'estimated',
  };
  store.recordSettlement(settlement);
}

async function resolvedWinningLabel(appConfig: AppConfig, eventSlug: string): Promise<'YES' | 'NO' | null> {
  const url = new URL(`/markets/slug/${encodeURIComponent(eventSlug)}`, appConfig.gammaApiUrl.replace(/\/+$/, '') + '/');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Gamma market returned ${response.status}`);
  const market = await response.json() as Record<string, unknown>;
  if (market.closed !== true) return null;
  const outcomes = parseStringArray(market.outcomes).map((item) => item.toLowerCase());
  const prices = parseStringArray(market.outcomePrices).map(Number);
  const upIndex = outcomes.indexOf('up');
  const downIndex = outcomes.indexOf('down');
  const upPrice = upIndex >= 0 ? prices[upIndex] : undefined;
  const downPrice = downIndex >= 0 ? prices[downIndex] : undefined;
  if (upPrice === 1) return 'YES';
  if (downPrice === 1) return 'NO';
  return null;
}

function riskConfig(appConfig: AppConfig, dryRun: boolean, entryCooldownUntil?: string, entryCooldownReason?: string): StrategyRiskConfig {
  return {
    dryRun,
    dualLimitPrice: appConfig.dualLimitPrice,
    dynamicLimitEnabled: appConfig.dynamicLimitEnabled,
    minDynamicLimitPrice: appConfig.minDynamicLimitPrice,
    maxDynamicLimitPrice: appConfig.maxDynamicLimitPrice,
    maxPairCost: appConfig.maxPairCost,
    orderSharesPerSide: appConfig.orderSharesPerSide,
    dynamicSharesEnabled: appConfig.dynamicSharesEnabled,
    maxOrderSharesPerSide: appConfig.maxOrderSharesPerSide,
    minOrderShares: appConfig.minOrderShares,
    maxOrderbookAgeSeconds: appConfig.maxOrderbookAgeSeconds,
    minCross120s: appConfig.minCross120s,
    maxAbsDrift120s: appConfig.maxAbsDrift120s,
    maxAbsMomentum30s: appConfig.maxAbsMomentum30s,
    minChopScore: appConfig.minChopScore,
    minRangeBps120s: appConfig.minRangeBps120s,
    minBiExcursionBps120s: appConfig.minBiExcursionBps120s,
    maxDriftRatio120s: appConfig.maxDriftRatio120s,
    maxMomentumRatio30s: appConfig.maxMomentumRatio30s,
    maxEntryQueueImbalance: appConfig.maxEntryQueueImbalance,
    minLiveChopScore: appConfig.minLiveChopScore,
    minParticipationHoldersPerSide: appConfig.minParticipationHoldersPerSide,
    minParticipationTopHolderSharesPerSide: appConfig.minParticipationTopHolderSharesPerSide,
    minParticipationTopPositionPnl: appConfig.minParticipationTopPositionPnl,
    minParticipationPositionPnlSum: appConfig.minParticipationPositionPnlSum,
    maxParticipationHolderConcentration: appConfig.maxParticipationHolderConcentration,
    entryOrderTtlSeconds: appConfig.marketConfig.decisionLeadSeconds,
    entryCooldownUntil,
    entryCooldownReason,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item ?? '').trim()).filter(Boolean);
  } catch {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}
