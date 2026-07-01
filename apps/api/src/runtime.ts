import type { BtcRoundConfig, FillRecord, PositionSnapshot, RoundPhase, RoundSnapshot, SettlementRecord, StateSnapshot, StrategyCheck, StrategyCondition, TradeIntent } from '../../../packages/shared/src';
import { classifyRegime, evaluateEntry, evaluateExit, type StrategyEvaluation, type StrategyRiskConfig } from '../../../packages/strategy/src';
import { PolymarketAdapter, type FillTarget } from '../../../packages/polymarket/src';
import type { AppConfig } from './config';
import { activeHedgeWindowSeconds, buildSingleFillHedgeCheck, executeSingleFillHedges, hedgeExposureOrders, planSingleFillHedge } from './hedge';
import { executeLiveIntents } from './execution';
import { buildSingleFillProfitExitCheck, executeSingleFillProfitExits, planSingleFillProfitExit, profitExitExposureOrders } from './profitExit';
import type { MarketDataService } from './marketData';
import type { ParticipationService } from './participation';
import type { Btc5mRoundDiscovery } from './roundDiscovery';
import type { InMemoryStore } from './store';

export async function runBotTick(appConfig: AppConfig, store: InMemoryStore, data: MarketDataService, adapter: PolymarketAdapter, discovery: Btc5mRoundDiscovery, participationService: ParticipationService): Promise<StateSnapshot> {
  const diagnostics: string[] = [];
  store.setActiveStrategyProfile(appConfig.activeStrategyProfile);
  const classicActive = appConfig.activeStrategyProfile === 'classic';
  const discovered = await discovery.discover({
    latestPrice: data.latestPrice(),
    persistedStrike: (roundId) => store.getRoundStrike(roundId),
  });
  diagnostics.push(...discovered.diagnostics);
  const round = captureOpeningStrike(discovered.round, store, data.latestPrice());
  const hedgeWatchTokenIds = classicActive && appConfig.singleFillHedgeEnabled
    ? store.hedgeWatchTokenIds(activeHedgeWindowSeconds(appConfig), appConfig.singleFillHedgeMinSecondsToEnd)
    : [];
  const profitExitWatchTokenIds = classicActive && appConfig.singleFillProfitExitEnabled
    ? store.profitExitWatchTokenIds(appConfig.singleFillProfitExitMaxSecondsToEnd, appConfig.singleFillProfitExitMinSecondsToEnd)
    : [];
  data.syncClobRound(round, [...hedgeWatchTokenIds, ...profitExitWatchTokenIds]);
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
  const evaluatedEntry = classicActive ? evaluateEntry(snapshot, risk) : evaluateExperimentEntry(snapshot, appConfig, store);
  const entry = classicActive
    ? applyEntryConfirmation(evaluatedEntry, store.recordEntrySignal(snapshot.round.id, evaluatedEntry.intents.length > 0), appConfig.entryConfirmTicks)
    : evaluatedEntry;
  const intents = [...entry.intents];
  store.recordIntents([...intents, ...entry.rejected]);
  const executionDiagnostics = await executeLiveIntents({
    appConfig,
    adapter,
    store,
    snapshot,
    intents,
    risk,
    experimentRunStartedAt: classicActive ? undefined : store.getExperimentRunStartedAt(),
  });
  await reconcileFills(appConfig, adapter, store, roundSnapshot, tokenLabels, diagnostics);
  await reconcileTrackedOrders(appConfig, adapter, store, diagnostics);
  const maturedExperimentStop = appConfig.experimentStopOnSingle ? store.maybeStopExperimentOnSingle([]) : null;
  if (maturedExperimentStop) {
    store.recordRuntimeLog({
      level: 'warn',
      source: 'execution',
      message: `Experimental profile stopped after final single-sided fill on ${maturedExperimentStop.roundId}.`,
      details: maturedExperimentStop,
    });
  }
  const hedgeCandidates = classicActive && appConfig.singleFillHedgeEnabled
    ? store.singleFillHedgeCandidates(activeHedgeWindowSeconds(appConfig), appConfig.singleFillHedgeMinSecondsToEnd)
    : [];
  const profitExitCandidates = classicActive && appConfig.singleFillProfitExitEnabled
    ? store.singleFillProfitExitCandidates(appConfig.singleFillProfitExitMaxSecondsToEnd, appConfig.singleFillProfitExitMinSecondsToEnd)
    : [];
  const hedgeOrderbooks = data.refreshOrderbooksForTokenIds([
    ...hedgeCandidates.flatMap((candidate) => [candidate.yesTokenId, candidate.noTokenId]),
    ...profitExitCandidates.flatMap((candidate) => [candidate.yesTokenId, candidate.noTokenId]),
  ]);
  const profitExitDiagnostics = classicActive ? await executeSingleFillProfitExits({ appConfig, adapter, store, candidates: profitExitCandidates, orderbooks: hedgeOrderbooks }) : [];
  const hedgeDiagnostics = classicActive ? await executeSingleFillHedges({ appConfig, adapter, store, candidates: hedgeCandidates, orderbooks: hedgeOrderbooks }) : [];
  const exit = classicActive
    ? evaluateExit(snapshot, positions, risk, { orders: store.roundOrders(snapshot.round.id, 'BTC5M_DUAL_45'), fills: store.roundFillsByStrategy(snapshot.round.id, 'BTC5M_DUAL_45') })
    : disabledExperimentExitCheck(snapshot);
  const hedgeCheck = classicActive ? buildCurrentRoundHedgeCheck(appConfig, store, snapshot, [...orderbooks, ...hedgeOrderbooks]) : disabledClassicCheck('BTC5M_SINGLE_FILL_HEDGE', 'BTC 5m Single-Fill Hedge', 'Disabled while experimental profile is active.');
  const profitExitCheck = classicActive ? buildCurrentRoundProfitExitCheck(appConfig, store, snapshot, [...orderbooks, ...hedgeOrderbooks]) : disabledClassicCheck('BTC5M_SINGLE_FILL_PROFIT_EXIT', 'BTC 5m Single-Fill Profit Exit', 'Disabled while experimental profile is active.');
  await reconcileSettlements(appConfig, store, diagnostics);
  maybeRecordEstimatedSettlement(store, snapshot);
  const finalSnapshot = { ...snapshot, diagnostics: [...diagnostics, ...entry.diagnostics, ...executionDiagnostics, ...hedgeDiagnostics, ...profitExitDiagnostics] };
  store.recordSnapshot(finalSnapshot, data.status());
  store.recordStrategyChecks([...entry.checks, ...exit.checks, hedgeCheck, profitExitCheck]);
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

function evaluateExperimentEntry(snapshot: StateSnapshot, appConfig: AppConfig, store: InMemoryStore): StrategyEvaluation {
  const reasons: string[] = [];
  const stopped = store.getExperimentStop();
  const inDecisionWindow = snapshot.round.secondsToStart >= appConfig.entryMinSecondsToStart;
  const shares = roundShares(appConfig.experimentNextRoundSharesPerSide);
  const upPrice = roundPrice(appConfig.experimentNextRoundUpLimitPrice);
  const downPrice = roundPrice(appConfig.experimentNextRoundDownLimitPrice);
  const yesQuote = snapshot.orderbooks.find((quote) => quote.tokenId === snapshot.round.yesTokenId);
  const noQuote = snapshot.orderbooks.find((quote) => quote.tokenId === snapshot.round.noTokenId);
  const yesReady = buyQuoteReady(yesQuote, appConfig.maxOrderbookAgeSeconds);
  const noReady = buyQuoteReady(noQuote, appConfig.maxOrderbookAgeSeconds);
  const upExecutionKey = experimentExecutionKey(snapshot, 'YES');
  const downExecutionKey = experimentExecutionKey(snapshot, 'NO');
  const experimentRunStartedAt = store.getExperimentRunStartedAt();
  const upAlreadyPlaced = store.hasNonFailedOrder(upExecutionKey, { since: experimentRunStartedAt });
  const downAlreadyPlaced = store.hasNonFailedOrder(downExecutionKey, { since: experimentRunStartedAt });

  if (stopped) reasons.push('EXPERIMENT_STOPPED_ON_SINGLE');
  if (!inDecisionWindow) reasons.push('ROUND_ALREADY_STARTED');
  if (!Number.isFinite(upPrice) || upPrice <= 0 || upPrice >= 1) reasons.push('INVALID_UP_LIMIT_PRICE');
  if (!Number.isFinite(downPrice) || downPrice <= 0 || downPrice >= 1) reasons.push('INVALID_DOWN_LIMIT_PRICE');
  if (shares < appConfig.minOrderShares) reasons.push('ORDER_SHARES_TOO_SMALL');
  if (!yesReady) reasons.push('UP_ORDERBOOK_NOT_TRADABLE');
  if (!noReady) reasons.push('DOWN_ORDERBOOK_NOT_TRADABLE');

  const base = [
    ...(!upAlreadyPlaced ? [experimentIntent(snapshot, 'YES', snapshot.round.yesTokenId, shares, upPrice)] : []),
    ...(!downAlreadyPlaced ? [experimentIntent(snapshot, 'NO', snapshot.round.noTokenId, shares, downPrice)] : []),
  ];
  if (!base.length && !reasons.length) reasons.push('EXPERIMENT_ORDERS_ALREADY_PLACED');
  const rejected = reasons.length ? base.map((intent) => ({ ...intent, status: 'rejected' as const, rejectionReason: reasons.join(',') })) : [];
  const intents = reasons.length ? [] : base;
  const check: StrategyCheck = {
    strategy: 'BTC5M_NEXT_ROUND_50_49_STOP_ON_SINGLE',
    title: 'BTC 5m Experimental Next-Round 50/49',
    status: reasons.includes('EXPERIMENT_ORDERS_ALREADY_PLACED') ? 'not-applicable' : reasons.length ? 'blocked' : 'eligible',
    summary: 'Posts fixed next-round UP and DOWN BUY limits and stops after a final single-sided experimental fill.',
    reason: reasons.length ? reasons.join(', ') : `Experimental entry eligible: UP ${upPrice.toFixed(3)} / DOWN ${downPrice.toFixed(3)} / ${shares.toFixed(2)} shares.`,
    blockers: reasons,
    amountUsd: shares * (upPrice + downPrice),
    limitPrice: Math.max(upPrice, downPrice),
    conditions: [
      condition('Active profile', appConfig.activeStrategyProfile === 'experiment_next_round', appConfig.activeStrategyProfile),
      condition('Experiment not stopped', !stopped, stopped ? `${stopped.reason} on ${stopped.roundId}` : 'active'),
      condition('Round before start', inDecisionWindow, `${snapshot.round.secondsToStart.toFixed(1)}s to start / min ${appConfig.entryMinSecondsToStart}s`),
      condition('UP limit price', upPrice > 0 && upPrice < 1, upPrice.toFixed(3)),
      condition('DOWN limit price', downPrice > 0 && downPrice < 1, downPrice.toFixed(3)),
      condition('Shares per side', shares >= appConfig.minOrderShares, `${shares.toFixed(2)} / min ${appConfig.minOrderShares.toFixed(2)}`),
      condition('UP order not already placed', !upAlreadyPlaced, upAlreadyPlaced ? 'already placed for this round' : 'clear'),
      condition('DOWN order not already placed', !downAlreadyPlaced, downAlreadyPlaced ? 'already placed for this round' : 'clear'),
      condition('UP book tradable', yesReady, quoteAgeLabel(yesQuote)),
      condition('DOWN book tradable', noReady, quoteAgeLabel(noQuote)),
      condition('Profit exit disabled', true, 'no SELL generated by experimental profile'),
      condition('Hedge disabled', true, 'no single-fill hedge generated by experimental profile'),
    ],
  };
  return { intents, rejected, diagnostics: [], checks: [check] };
}

function experimentExecutionKey(snapshot: StateSnapshot, label: 'YES' | 'NO'): string {
  const tokenId = label === 'YES' ? snapshot.round.yesTokenId : snapshot.round.noTokenId;
  return [snapshot.round.id, 'BTC5M_NEXT_ROUND_50_49_STOP_ON_SINGLE', tokenId, 'BUY'].join(':');
}

function experimentIntent(snapshot: StateSnapshot, label: 'YES' | 'NO', tokenId: string, shares: number, limitPrice: number): TradeIntent {
  return {
    id: `experiment-intent-${Date.now()}-${label}-${Math.random().toString(16).slice(2, 8)}`,
    strategy: 'BTC5M_NEXT_ROUND_50_49_STOP_ON_SINGLE',
    roundId: snapshot.round.id,
    tokenId,
    label,
    side: 'BUY',
    orderType: 'LIMIT',
    limitPrice,
    shares,
    reason: `Experimental fixed next-round ${label === 'YES' ? 'UP' : 'DOWN'} entry for ${snapshot.round.id}.`,
    status: 'generated',
    ttlSeconds: Math.max(1, Math.ceil(snapshot.round.secondsToStart)),
    createdAt: snapshot.capturedAt,
  };
}

function disabledExperimentExitCheck(snapshot: StateSnapshot): StrategyEvaluation {
  const check: StrategyCheck = {
    strategy: 'BTC5M_SINGLE_EXIT',
    title: 'BTC 5m Experimental Exit Policy',
    status: 'not-applicable',
    summary: 'Experimental profile has no profit exit, hedge, sell, or rebalance path.',
    reason: 'No exit intent is generated while the experimental profile is active.',
    blockers: [],
    conditions: [
      condition('Experimental round', true, snapshot.round.id),
      condition('SELL generation', true, 'disabled'),
      condition('Profit exit', true, 'disabled'),
      condition('Single-fill hedge', true, 'disabled'),
    ],
  };
  return { intents: [], rejected: [], diagnostics: [], checks: [check] };
}

function disabledClassicCheck(strategy: StrategyCheck['strategy'], title: string, reason: string): StrategyCheck {
  return {
    strategy,
    title,
    status: 'not-applicable',
    summary: reason,
    reason,
    blockers: [],
    conditions: [condition('Active profile', true, 'experiment_next_round')],
  };
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
  const orders = hedgeExposureOrders(store.roundOrders(snapshot.round.id));
  const plan = planSingleFillHedge({ candidate, orders, orderbooks, appConfig });
  const executionKey = plan.ok ? [plan.intent.roundId, plan.intent.strategy, plan.intent.tokenId, plan.intent.side].join(':') : undefined;
  return buildSingleFillHedgeCheck({
    candidate,
    orders,
    orderbooks,
    appConfig,
    runtimeStatus: store.getRuntime().status,
    outcome: store.getSingleFillHedgeOutcome(snapshot.round.id),
    hasRecentHedgeOrder: executionKey ? store.hasRecentOrder(executionKey, activeHedgeWindowSeconds(appConfig) * 1000) : false,
    hasRecentFailedHedgeOrder: executionKey ? store.hasRecentFailedOrder(executionKey, 60_000) : false,
  });
}

function buildCurrentRoundProfitExitCheck(appConfig: AppConfig, store: InMemoryStore, snapshot: StateSnapshot, orderbooks: StateSnapshot['orderbooks']) {
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
  const orders = profitExitExposureOrders(store.roundOrders(snapshot.round.id));
  const plan = planSingleFillProfitExit({ candidate, orders, orderbooks, appConfig });
  const executionKey = plan.ok ? [plan.intent.roundId, plan.intent.strategy, plan.intent.tokenId, plan.intent.side].join(':') : undefined;
  return buildSingleFillProfitExitCheck({
    candidate,
    orders,
    orderbooks,
    appConfig,
    runtimeStatus: store.getRuntime().status,
    hasRecentExitOrder: executionKey ? store.hasRecentOrder(executionKey, 5_000) : false,
    hasRecentFailedExitOrder: executionKey ? store.hasRecentFailedOrder(executionKey, 60_000) : false,
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
  const experimentStop = appConfig.experimentStopOnSingle ? store.maybeStopExperimentOnSingle(newFills) : null;
  if (experimentStop) {
    store.recordRuntimeLog({
      level: 'warn',
      source: 'execution',
      message: `Experimental profile stopped after single-sided fill on ${experimentStop.roundId}.`,
      details: experimentStop,
    });
  }
  if (appConfig.activeStrategyProfile !== 'classic') return;
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
      const settlementValues = calculateSettlementValues(fills, winningLabel);
      const settlement: SettlementRecord = {
        id: `settlement-${round.roundId}`,
        roundId: round.roundId,
        eventSlug: round.eventSlug,
        marketTitle: round.marketTitle,
        imageUrl: round.imageUrl,
        resolvedAt: new Date().toISOString(),
        winningLabel,
        ...settlementValues,
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
  const winningLabel = snapshot.features.price == null ? undefined : snapshot.features.price >= snapshot.round.strike ? 'YES' : 'NO';
  const settlementValues = calculateSettlementValues(fills, winningLabel);
  const settlement: SettlementRecord = {
    id: `settlement-${snapshot.round.id}`,
    roundId: snapshot.round.id,
    eventSlug: snapshot.round.eventSlug,
    marketTitle: snapshot.round.title,
    imageUrl: snapshot.round.imageUrl,
    resolvedAt: snapshot.capturedAt,
    winningLabel,
    ...settlementValues,
    status: 'estimated',
  };
  store.recordSettlement(settlement);
}

export function calculateSettlementValues(fills: FillRecord[], winningLabel?: 'YES' | 'NO'): Pick<SettlementRecord, 'yesShares' | 'noShares' | 'totalCost' | 'payout' | 'pnl'> {
  const yesShares = netShares(fills, 'YES');
  const noShares = netShares(fills, 'NO');
  const buyCost = sum(fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.price * fill.size));
  const sellProceeds = sum(fills.filter((fill) => fill.side === 'SELL').map((fill) => fill.price * fill.size));
  const totalCost = roundMoney(buyCost - sellProceeds);
  const payout = winningLabel === 'YES' ? yesShares : winningLabel === 'NO' ? noShares : 0;
  return {
    yesShares,
    noShares,
    totalCost,
    payout,
    pnl: roundMoney(payout - totalCost),
  };
}

function netShares(fills: FillRecord[], label: 'YES' | 'NO'): number {
  const labelFills = fills.filter((fill) => fill.label === label);
  const buyShares = sum(labelFills.filter((fill) => fill.side === 'BUY').map((fill) => fill.size));
  const sellShares = sum(labelFills.filter((fill) => fill.side === 'SELL').map((fill) => fill.size));
  return Math.max(0, buyShares - sellShares);
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
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
    entryMinSecondsToStart: appConfig.entryMinSecondsToStart,
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

function buyQuoteReady(quote: StateSnapshot['orderbooks'][number] | undefined, maxAgeSeconds: number): boolean {
  if (!quote || quote.source === 'mock' || quote.bestAsk == null) return false;
  const ageMs = Date.now() - new Date(quote.updatedAt).getTime();
  return Number.isFinite(ageMs) && ageMs <= maxAgeSeconds * 1000;
}

function quoteAgeLabel(quote: StateSnapshot['orderbooks'][number] | undefined): string {
  if (!quote) return 'missing';
  const ageSeconds = (Date.now() - new Date(quote.updatedAt).getTime()) / 1000;
  const ask = quote.bestAsk == null ? ', ask missing' : '';
  return `${quote.source}, ${Number.isFinite(ageSeconds) ? ageSeconds.toFixed(1) : 'unknown'}s old${ask}`;
}

function condition(label: string, passed: boolean, actual: string): StrategyCondition {
  return { label, passed, actual };
}

function roundShares(value: number): number {
  return Math.floor(value * 100) / 100;
}

function roundPrice(value: number): number {
  return Math.round(value * 1000) / 1000;
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
