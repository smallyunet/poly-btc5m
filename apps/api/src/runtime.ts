import type { BtcRoundConfig, FillRecord, MarketProfile, OrderBookQuote, OrderbookCapacityTier, OrderbookDepthLevel, OrderbookDepthSnapshot, PortfolioSnapshot, PositionSnapshot, RoundPhase, RoundSnapshot, SettlementRecord, StateSnapshot, StrategyCheck, StrategyCondition, TradeIntent } from '../../../packages/shared/src';
import { classifyRegime, evaluateEntry, evaluateExit, type StrategyEvaluation, type StrategyRiskConfig } from '../../../packages/strategy/src';
import { PolymarketAdapter, type FillTarget } from '../../../packages/polymarket/src';
import type { AppConfig } from './config';
import { activeHedgeWindowSeconds, buildSingleFillHedgeCheck, executeSingleFillHedges, hedgeExposureOrders, planSingleFillHedge } from './hedge';
import { executeLiveIntents } from './execution';
import { buildSingleFillProfitExitCheck, executeSingleFillProfitExits, planSingleFillProfitExit, profitExitExposureOrders } from './profitExit';
import type { MarketDataService } from './marketData';
import type { ParticipationService } from './participation';
import type { RecurringCryptoRoundDiscovery } from './roundDiscovery';
import type { InMemoryStore, SingleFillCooldownRecord } from './store';

export async function runAllProfilesTick(appConfig: AppConfig, store: InMemoryStore, data: MarketDataService, adapter: PolymarketAdapter, discovery: RecurringCryptoRoundDiscovery, participationService: ParticipationService): Promise<StateSnapshot[]> {
  const enabledProfiles = appConfig.marketProfiles.filter((profile) => profile.status !== 'disabled');
  const snapshots: StateSnapshot[] = [];
  for (const profile of enabledProfiles) {
    snapshots.push(await runBotTick(appConfigForProfile(appConfig, profile), store, data, adapter, discovery, participationService, profile));
  }
  return snapshots;
}

export async function runBotTick(appConfig: AppConfig, store: InMemoryStore, data: MarketDataService, adapter: PolymarketAdapter, discovery: RecurringCryptoRoundDiscovery, participationService: ParticipationService, profile: MarketProfile = appConfig.marketProfiles[0]): Promise<StateSnapshot> {
  const diagnostics: string[] = [];
  store.setActiveStrategyProfile(appConfig.activeStrategyProfile);
  const classicActive = appConfig.activeStrategyProfile === 'classic';
  const discovered = await discovery.discover({
    profile,
    latestPrice: data.latestPrice(profile),
    persistedStrike: (roundId) => store.getRoundStrike(roundId),
  });
  diagnostics.push(...discovered.diagnostics);
  const round = captureOpeningStrike(discovered.round, store, data.latestPrice(profile));
  const hedgeWatchTokenIds = classicActive && appConfig.singleFillHedgeEnabled
    ? store.hedgeWatchTokenIds(profile.id, activeHedgeWindowSeconds(appConfig), appConfig.singleFillHedgeMinSecondsToEnd)
    : [];
  const profitExitWatchTokenIds = classicActive && appConfig.singleFillProfitExitEnabled
    ? store.profitExitWatchTokenIds(profile.id, appConfig.singleFillProfitExitMaxSecondsToEnd, appConfig.singleFillProfitExitMinSecondsToEnd)
    : [];
  data.syncClobRound(round, [...hedgeWatchTokenIds, ...profitExitWatchTokenIds]);
  const orderbooks = await data.refreshOrderbooks(round);
  const participation = await participationService.refresh(round);
  diagnostics.push(...participation.diagnostics);
  const features = data.features(round, profile);
  const roundSnapshot = roundToSnapshot(appConfig, store, round);
  const tokenLabels = new Map<string, 'YES' | 'NO'>([
    [round.yesTokenId, 'YES'],
    [round.noTokenId, 'NO'],
  ]);
  const portfolio = await loadPortfolio(appConfig, adapter, tokenLabels, store.settledPnl(), diagnostics);
  const positions = portfolio.positions.filter((position) => position.label !== 'UNKNOWN');
  const baseSnapshot: StateSnapshot = {
    id: `snapshot-${Date.now()}`,
    profileId: profile.id,
    asset: profile.asset,
    interval: profile.interval,
    capturedAt: new Date().toISOString(),
    round: roundSnapshot,
    features,
    regime: 'UNKNOWN',
    orderbooks,
    positions,
    positionReadStatus: appConfig.depositWallet?.trim() ? 'enabled' : 'disabled',
    portfolio,
    participation,
    diagnostics,
  };
  const activeCooldown = store.getActiveEntryCooldown(profile.id);
  const risk = riskConfig(appConfig, store.getRuntime().executionMode !== 'live', activeCooldown?.expiresAt, activeCooldown ? `single fill on ${activeCooldown.roundId}` : undefined);
  const snapshot: StateSnapshot = { ...baseSnapshot, regime: classifyRegime(baseSnapshot, risk) };
  snapshot.orderbookDepth = buildOrderbookDepthSnapshot(snapshot, appConfig);
  const evaluatedEntry = classicActive ? evaluateEntry(snapshot, risk) : evaluateExperimentEntry(snapshot, appConfig, store);
  const entry = classicActive
    ? applyEntryConfirmation(
      evaluatedEntry,
      appConfig.bypassEntryScoreGating ? appConfig.entryConfirmTicks : store.recordEntrySignal(`${profile.id}:${snapshot.round.id}`, evaluatedEntry.intents.length > 0),
      appConfig.entryConfirmTicks,
      appConfig.bypassEntryScoreGating,
    )
    : evaluatedEntry;
  const intents = entry.intents.map((intent) => withProfile(intent, profile));
  store.recordIntents([...intents, ...entry.rejected.map((intent) => withProfile(intent, profile))]);
  const executionDiagnostics = await executeLiveIntents({
    appConfig,
    adapter,
    store,
    snapshot,
    intents,
    risk,
    experimentRunStartedAt: classicActive ? undefined : store.getExperimentRunStartedAt(),
  });
  const fillCooldowns = await reconcileFills(appConfig, adapter, store, roundSnapshot, tokenLabels, diagnostics, profile);
  const orderCooldowns = await reconcileTrackedOrders(appConfig, adapter, store, diagnostics, profile);
  const crossProfileRiskDiagnostics = classicActive
    ? await executeCrossProfileSingleFillRisk(appConfig, store, data, adapter, [...fillCooldowns, ...orderCooldowns])
    : [];
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
    ? store.singleFillHedgeCandidates(profile.id, activeHedgeWindowSeconds(appConfig), appConfig.singleFillHedgeMinSecondsToEnd)
    : [];
  const profitExitCandidates = classicActive && appConfig.singleFillProfitExitEnabled
    ? store.singleFillProfitExitCandidates(profile.id, appConfig.singleFillProfitExitMaxSecondsToEnd, appConfig.singleFillProfitExitMinSecondsToEnd)
    : [];
  const hedgeOrderbooks = data.refreshOrderbooksForTokenIds([
    ...hedgeCandidates.flatMap((candidate) => [candidate.yesTokenId, candidate.noTokenId]),
    ...profitExitCandidates.flatMap((candidate) => [candidate.yesTokenId, candidate.noTokenId]),
  ]);
  const profitExitDiagnostics = classicActive ? await executeSingleFillProfitExits({ appConfig, adapter, store, candidates: profitExitCandidates, orderbooks: hedgeOrderbooks }) : [];
  const hedgeDiagnostics = classicActive ? await executeSingleFillHedges({ appConfig, adapter, store, candidates: hedgeCandidates, orderbooks: hedgeOrderbooks }) : [];
  const exit = classicActive
    ? evaluateExit(snapshot, positions, risk, { orders: store.roundOrders(profile.id, snapshot.round.id, 'UPDOWN_DUAL_ENTRY'), fills: store.roundFillsByStrategy(profile.id, snapshot.round.id, 'UPDOWN_DUAL_ENTRY') })
    : disabledExperimentExitCheck(snapshot);
  const hedgeCheck = classicActive ? buildCurrentRoundHedgeCheck(appConfig, store, snapshot, [...orderbooks, ...hedgeOrderbooks]) : disabledClassicCheck(snapshot, 'UPDOWN_SINGLE_FILL_HEDGE', 'Up/Down Single-Fill Hedge', 'Disabled while experimental profile is active.');
  const profitExitCheck = classicActive ? buildCurrentRoundProfitExitCheck(appConfig, store, snapshot, [...orderbooks, ...hedgeOrderbooks]) : disabledClassicCheck(snapshot, 'UPDOWN_SINGLE_FILL_PROFIT_EXIT', 'Up/Down Single-Fill Profit Exit', 'Disabled while experimental profile is active.');
  await reconcileSettlements(appConfig, store, diagnostics, profile);
  maybeRecordEstimatedSettlement(store, snapshot, profile);
  const finalSnapshot = { ...snapshot, diagnostics: [...diagnostics, ...entry.diagnostics, ...executionDiagnostics, ...crossProfileRiskDiagnostics, ...hedgeDiagnostics, ...profitExitDiagnostics] };
  store.recordSnapshot(finalSnapshot, data.status(profile, [round.yesTokenId, round.noTokenId]));
  store.recordStrategyChecks([...entry.checks, ...exit.checks, hedgeCheck, profitExitCheck].map((check) => withProfile(check, profile)), profile.id);
  return finalSnapshot;
}

function appConfigForProfile(appConfig: AppConfig, profile: MarketProfile): AppConfig {
  return {
    ...appConfig,
    executionMode: profile.status === 'live' ? appConfig.executionMode : 'monitor',
    marketConfig: {
      seriesSlug: profile.seriesSlug,
      title: profile.title,
      roundDurationSeconds: profile.roundDurationSeconds,
      decisionLeadSeconds: profile.decisionLeadSeconds,
      avoidExpirySeconds: profile.avoidExpirySeconds,
    },
    dualLimitPrice: profile.entry.limitPrice,
    dynamicLimitEnabled: false,
    orderSharesPerSide: profile.entry.sharesPerSide,
    dynamicSharesEnabled: false,
    maxOrderSharesPerSide: profile.entry.sharesPerSide,
    entryConfirmTicks: profile.entry.confirmTicks,
    entryMinSecondsToStart: profile.entry.minSecondsToStart,
    singleFillHedgeEnabled: profile.hedge.enabled,
    singleFillEarlyHedgeWindowSeconds: profile.hedge.earlyWindowSeconds,
    singleFillEarlyHedgeMaxPairCost: profile.hedge.earlyMaxPairCost,
    singleFillEmergencyHedgeWindowSeconds: profile.hedge.emergencyWindowSeconds,
    singleFillEmergencyHedgeMaxPrice: profile.hedge.emergencyMaxPrice,
    singleFillEmergencyHedgeMaxPairCost: profile.hedge.emergencyMaxPairCost,
    singleFillHedgeWindowSeconds: profile.hedge.finalWindowSeconds,
    singleFillHedgeMinSecondsToEnd: profile.hedge.minSecondsToEnd,
    singleFillHedgeMaxPrice: profile.hedge.maxPrice,
    singleFillHedgePriceOffset: profile.hedge.priceOffset,
    singleFillHedgeMaxPairCost: profile.hedge.maxPairCost,
    singleFillProfitExitEnabled: profile.profitExit.enabled,
    singleFillProfitExitMinRate: profile.profitExit.minProfitRate,
    singleFillProfitExitMinPrice: 0,
    singleFillProfitExitMinPnlUsd: profile.profitExit.minPnlUsd,
    singleFillProfitExitPriceOffset: profile.profitExit.priceOffset,
    singleFillProfitExitMaxOrderbookAgeMs: profile.profitExit.maxOrderbookAgeMs,
    singleFillProfitExitMinSecondsToEnd: profile.profitExit.minSecondsToEnd,
    singleFillProfitExitMaxSecondsToEnd: profile.profitExit.maxSecondsToEnd,
    singleFillCooldownBaseMs: profile.cooldown.baseMs,
    singleFillCooldownPriceCapMs: profile.cooldown.priceCapMs,
    singleFillCooldownExecutionMs: profile.cooldown.executionMs,
    singleFillCooldownRepeatWindowMs: profile.cooldown.repeatWindowMs,
    singleFillCooldownSecondMs: profile.cooldown.secondMs,
    singleFillCooldownThirdMs: profile.cooldown.thirdMs,
  };
}

function withProfile<T extends object>(value: T, profile: MarketProfile): T {
  return { ...value, profileId: profile.id, asset: profile.asset, interval: profile.interval };
}

function buildOrderbookDepthSnapshot(snapshot: StateSnapshot, appConfig: AppConfig): OrderbookDepthSnapshot {
  const activeLimitPrice = strategyEntryLimitPrice(snapshot, appConfig);
  const baseSharesPerSide = appConfig.dynamicSharesEnabled
    ? Math.min(appConfig.orderSharesPerSide * sharesMultiplierFromScore(snapshot.features.chopScore), appConfig.maxOrderSharesPerSide)
    : appConfig.orderSharesPerSide;
  const yesQuote = snapshot.orderbooks.find((quote) => quote.tokenId === snapshot.round.yesTokenId);
  const noQuote = snapshot.orderbooks.find((quote) => quote.tokenId === snapshot.round.noTokenId);
  const diagnostics: string[] = [];
  if (!yesQuote) diagnostics.push('UP book is missing from current WSS snapshot.');
  if (!noQuote) diagnostics.push('DOWN book is missing from current WSS snapshot.');
  if (!yesQuote?.bids?.length || !yesQuote.asks?.length) diagnostics.push('UP book depth levels are incomplete.');
  if (!noQuote?.bids?.length || !noQuote.asks?.length) diagnostics.push('DOWN book depth levels are incomplete.');

  const levels = [0.42, 0.44, 0.45, 0.46, 0.49, 0.5, 0.51, 0.55, 0.6, 0.65]
    .map((limitPrice) => depthLevel(limitPrice, yesQuote, noQuote));
  const activeLevel = levels.find((level) => Math.abs(level.limitPrice - activeLimitPrice) < 0.000001)
    || depthLevel(activeLimitPrice, yesQuote, noQuote);
  const tiers = capacityTiers(activeLevel, activeLimitPrice);

  return {
    status: diagnostics.length ? 'insufficient' : 'ready',
    updatedAt: new Date().toISOString(),
    roundId: snapshot.round.id,
    activeLimitPrice,
    baseSharesPerSide: roundShares(baseSharesPerSide),
    levels,
    tiers,
    diagnostics,
  };
}

function depthLevel(limitPrice: number, yesQuote: OrderBookQuote | undefined, noQuote: OrderBookQuote | undefined): OrderbookDepthLevel {
  const yes = sideDepth(limitPrice, yesQuote);
  const no = sideDepth(limitPrice, noQuote);
  const pairedImmediateShares = Math.min(yes.askShares, no.askShares);
  const pairedImmediateCostUsd = pairedImmediateShares > 0
    ? costForShares(yesQuote?.asks || [], pairedImmediateShares, limitPrice) + costForShares(noQuote?.asks || [], pairedImmediateShares, limitPrice)
    : 0;
  const minBidQueueShares = Math.min(yes.bidQueueShares, no.bidQueueShares);
  const minBidAtLimitShares = Math.min(yes.bidAtLimitShares, no.bidAtLimitShares);
  const smallerQueue = Math.min(yes.bidQueueShares, no.bidQueueShares);
  const largerQueue = Math.max(yes.bidQueueShares, no.bidQueueShares);
  return {
    limitPrice,
    pairedImmediateShares: roundShares(pairedImmediateShares),
    pairedImmediateCostUsd: roundMoney(pairedImmediateCostUsd),
    maxPairNotionalUsd: roundMoney(pairedImmediateShares * limitPrice * 2),
    minBidQueueShares: roundShares(minBidQueueShares),
    minBidAtLimitShares: roundShares(minBidAtLimitShares),
    queueRatio: smallerQueue > 0 ? roundRatio(largerQueue / smallerQueue) : null,
  };
}

function sideDepth(limitPrice: number, quote: OrderBookQuote | undefined): { askShares: number; bidQueueShares: number; bidAtLimitShares: number } {
  const asks = quote?.asks || [];
  const bids = quote?.bids || [];
  return {
    askShares: asks.filter((level) => level.price <= limitPrice + 0.000001).reduce((total, level) => total + level.size, 0),
    bidQueueShares: bids.filter((level) => level.price >= limitPrice - 0.000001).reduce((total, level) => total + level.size, 0),
    bidAtLimitShares: bids.filter((level) => Math.abs(level.price - limitPrice) < 0.000001).reduce((total, level) => total + level.size, 0),
  };
}

function costForShares(levels: OrderBookQuote['asks'], shares: number, limitPrice: number): number {
  let remaining = shares;
  let cost = 0;
  for (const level of [...(levels || [])].sort((a, b) => a.price - b.price)) {
    if (level.price > limitPrice + 0.000001 || remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    cost += take * level.price;
    remaining -= take;
  }
  return remaining <= 0.000001 ? cost : 0;
}

function capacityTiers(activeLevel: OrderbookDepthLevel, activeLimitPrice: number): OrderbookCapacityTier[] {
  const exactBasis = activeLevel.minBidAtLimitShares > 0 ? activeLevel.minBidAtLimitShares : activeLevel.minBidQueueShares;
  const specs: Array<Pick<OrderbookCapacityTier, 'label' | 'queueSharePct' | 'exactLevelSharePct' | 'tone'>> = [
    { label: 'safe', queueSharePct: 0.05, exactLevelSharePct: 0.1, tone: 'good' },
    { label: 'conservative', queueSharePct: 0.1, exactLevelSharePct: 0.25, tone: 'good' },
    { label: 'aggressive', queueSharePct: 0.2, exactLevelSharePct: 0.5, tone: 'warn' },
    { label: 'stretched', queueSharePct: 0.35, exactLevelSharePct: 0.75, tone: 'bad' },
  ];
  return specs.map((spec) => {
    const byQueue = activeLevel.minBidQueueShares * spec.queueSharePct;
    const byExact = exactBasis * spec.exactLevelSharePct;
    const shares = Math.max(0, Math.min(byQueue, byExact));
    return {
      ...spec,
      maxSharesPerSide: roundShares(shares),
      maxPairAmountUsd: roundMoney(shares * activeLimitPrice * 2),
    };
  });
}

function strategyEntryLimitPrice(snapshot: StateSnapshot, appConfig: AppConfig): number {
  if (!appConfig.dynamicLimitEnabled) return roundPrice(appConfig.dualLimitPrice);
  const scorePrice = priceFromScore(snapshot.features.chopScore);
  const timeCap = snapshot.round.secondsToStart > 15 ? 0.45 : 0.46;
  const pairCostCap = appConfig.maxPairCost / 2;
  const capped = Math.min(scorePrice, timeCap, appConfig.maxDynamicLimitPrice, pairCostCap);
  return roundPrice(Math.max(appConfig.minDynamicLimitPrice, capped));
}

function priceFromScore(score: number): number {
  if (score >= 95) return 0.46;
  if (score >= 90) return 0.45;
  if (score >= 80) return 0.44;
  return 0.42;
}

function sharesMultiplierFromScore(score: number): number {
  if (score >= 95) return 1.25;
  if (score >= 80) return 1;
  return 0.5;
}

function roundRatio(value: number): number {
  return Math.round(value * 100) / 100;
}

function applyEntryConfirmation(entry: ReturnType<typeof evaluateEntry>, signalCount: number, requiredTicks: number, bypassed = false): ReturnType<typeof evaluateEntry> {
  const confirmed = bypassed || signalCount >= requiredTicks;
  const check = entry.checks[0];
  const confirmationCondition = {
    label: 'Entry signal confirmation',
    passed: confirmed,
    actual: bypassed ? `${signalCount} / ${requiredTicks} consecutive eligible ticks (bypassed)` : `${signalCount} / ${requiredTicks} consecutive eligible ticks`,
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
    profileId: snapshot.profileId,
    asset: snapshot.asset,
    interval: snapshot.interval,
    strategy: 'UPDOWN_NEXT_ROUND_50_49_STOP_ON_SINGLE',
    title: 'Up/Down Experimental Next-Round 50/49',
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
  return [snapshot.profileId, snapshot.round.id, 'UPDOWN_NEXT_ROUND_50_49_STOP_ON_SINGLE', tokenId, 'BUY'].filter(Boolean).join(':');
}

function experimentIntent(snapshot: StateSnapshot, label: 'YES' | 'NO', tokenId: string, shares: number, limitPrice: number): TradeIntent {
  return {
    id: `experiment-intent-${Date.now()}-${label}-${Math.random().toString(16).slice(2, 8)}`,
    profileId: snapshot.profileId,
    asset: snapshot.asset,
    interval: snapshot.interval,
    strategy: 'UPDOWN_NEXT_ROUND_50_49_STOP_ON_SINGLE',
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
    profileId: snapshot.profileId,
    asset: snapshot.asset,
    interval: snapshot.interval,
    strategy: 'UPDOWN_SINGLE_EXIT',
    title: 'Up/Down Experimental Exit Policy',
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

function disabledClassicCheck(snapshot: StateSnapshot, strategy: StrategyCheck['strategy'], title: string, reason: string): StrategyCheck {
  return {
    profileId: snapshot.profileId,
    asset: snapshot.asset,
    interval: snapshot.interval,
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
    profileId: snapshot.profileId,
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
  const orders = hedgeExposureOrders(store.roundOrders(snapshot.profileId, snapshot.round.id));
  const plan = planSingleFillHedge({ candidate, orders, orderbooks, appConfig });
  const executionKey = plan.ok ? [snapshot.profileId, plan.intent.roundId, plan.intent.strategy, plan.intent.tokenId, plan.intent.side].filter(Boolean).join(':') : undefined;
  return buildSingleFillHedgeCheck({
    candidate,
    orders,
    orderbooks,
    appConfig,
    runtimeStatus: store.getRuntime().status,
    outcome: store.getSingleFillHedgeOutcome(snapshot.profileId, snapshot.round.id),
    hasRecentHedgeOrder: executionKey ? store.hasRecentOrder(executionKey, activeHedgeWindowSeconds(appConfig) * 1000) : false,
    hasRecentFailedHedgeOrder: executionKey ? store.hasRecentFailedOrder(executionKey, 60_000) : false,
  });
}

function buildCurrentRoundProfitExitCheck(appConfig: AppConfig, store: InMemoryStore, snapshot: StateSnapshot, orderbooks: StateSnapshot['orderbooks']) {
  const candidate = {
    profileId: snapshot.profileId,
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
  const orders = profitExitExposureOrders(store.roundOrders(snapshot.profileId, snapshot.round.id));
  const plan = planSingleFillProfitExit({ candidate, orders, orderbooks, appConfig });
  const executionKey = plan.ok ? [snapshot.profileId, plan.intent.roundId, plan.intent.strategy, plan.intent.tokenId, plan.intent.side].filter(Boolean).join(':') : undefined;
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

async function loadPortfolio(appConfig: AppConfig, adapter: PolymarketAdapter, tokenLabels: Map<string, 'YES' | 'NO'>, settledPnl: number, diagnostics: string[]): Promise<PortfolioSnapshot> {
  const updatedAt = new Date().toISOString();
  const accountAddress = appConfig.depositWallet?.trim() || undefined;
  const hasOwnerPrivateKey = Boolean(appConfig.ownerPrivateKey?.trim());
  const hasDepositWallet = Boolean(accountAddress);
  const portfolioDiagnostics: string[] = [];

  if (!hasDepositWallet) {
    if (appConfig.executionMode === 'live') diagnostics.push('Portfolio reads require POLYMARKET_DEPOSIT_WALLET.');
    return emptyPortfolio({
      status: 'disabled',
      updatedAt,
      accountAddress,
      hasOwnerPrivateKey,
      hasDepositWallet,
      settledPnl: roundMoney(settledPnl),
      diagnostics: ['POLYMARKET_DEPOSIT_WALLET is not configured.'],
    });
  }

  const [positionsResult, balanceResult, profileResult] = await Promise.allSettled([
    adapter.getPortfolioPositions(tokenLabels),
    hasOwnerPrivateKey ? adapter.getCollateralBalanceAllowance() : Promise.resolve(null),
    adapter.getUserProfile?.() ?? Promise.resolve(undefined),
  ]);

  const positionsLoaded = positionsResult.status === 'fulfilled';
  const positions = positionsLoaded ? positionsResult.value : [];
  if (positionsResult.status === 'rejected') {
    const message = `Portfolio positions load failed: ${errorMessage(positionsResult.reason)}`;
    portfolioDiagnostics.push(message);
    diagnostics.push(message);
  }

  const profile = profileResult.status === 'fulfilled' ? profileResult.value : undefined;
  if (profileResult.status === 'rejected') {
    const message = `Portfolio profile load failed: ${errorMessage(profileResult.reason)}`;
    portfolioDiagnostics.push(message);
    diagnostics.push(message);
  }

  let collateralBalance: number | undefined;
  let collateralAllowance: number | null | undefined;
  if (!hasOwnerPrivateKey) {
    portfolioDiagnostics.push('OWNER_PRIVATE_KEY is not configured; collateral balance is unavailable.');
  } else if (balanceResult.status === 'fulfilled' && balanceResult.value) {
    collateralBalance = balanceResult.value.balance;
    collateralAllowance = balanceResult.value.allowance;
  } else if (balanceResult.status === 'rejected') {
    const message = `Portfolio balance load failed: ${errorMessage(balanceResult.reason)}`;
    portfolioDiagnostics.push(message);
    diagnostics.push(message);
  }

  const positionValue = roundMoney(sum(positions.map(positionValueUsd)));
  const positionCost = roundMoney(sum(positions.map(positionCostUsd)));
  const unrealizedPnl = roundMoney(sum(positions.map(positionPnlUsd)));
  const roundedSettledPnl = roundMoney(settledPnl);
  const totalPnl = roundMoney(roundedSettledPnl + unrealizedPnl);

  return {
    status: portfolioDiagnostics.length ? (positionsLoaded || collateralBalance != null ? 'partial' : 'unavailable') : 'enabled',
    updatedAt,
    accountAddress,
    profile,
    hasOwnerPrivateKey,
    hasDepositWallet,
    collateralBalance,
    collateralAllowance,
    positions,
    positionCount: positions.length,
    positionValue,
    positionCost,
    unrealizedPnl,
    settledPnl: roundedSettledPnl,
    totalPnl,
    roiPct: positionCost > 0 ? roundMoney((totalPnl / positionCost) * 100) : null,
    diagnostics: portfolioDiagnostics,
  };
}

function emptyPortfolio(params: Pick<PortfolioSnapshot, 'status' | 'updatedAt' | 'accountAddress' | 'hasOwnerPrivateKey' | 'hasDepositWallet' | 'settledPnl' | 'diagnostics'>): PortfolioSnapshot {
  return {
    ...params,
    positions: [],
    positionCount: 0,
    positionValue: 0,
    positionCost: 0,
    unrealizedPnl: 0,
    totalPnl: params.settledPnl,
    roiPct: null,
  };
}

function positionValueUsd(position: PositionSnapshot): number {
  if (position.currentValue != null) return position.currentValue;
  return position.shares * (position.currentPrice ?? position.avgPrice);
}

function positionCostUsd(position: PositionSnapshot): number {
  return position.shares * position.avgPrice;
}

function positionPnlUsd(position: PositionSnapshot): number {
  if (position.cashPnl != null) return position.cashPnl;
  return positionValueUsd(position) - positionCostUsd(position);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function reconcileFills(appConfig: AppConfig, adapter: PolymarketAdapter, store: InMemoryStore, round: RoundSnapshot, tokenLabels: Map<string, 'YES' | 'NO'>, diagnostics: string[], profile: MarketProfile): Promise<SingleFillCooldownRecord[]> {
  if (!tokenLabels.size) return [];
  try {
    const fills = await adapter.getRecentFills({
      profileId: profile.id,
      asset: profile.asset,
      interval: profile.interval,
      roundId: round.id,
      eventSlug: round.eventSlug,
      tokenLabels,
      marketTitle: round.title,
      imageUrl: round.imageUrl,
    });
    return recordFillsAndMaybeCooldown(appConfig, store, fills, profile);
  } catch (error) {
    if (store.getRuntime().executionMode === 'live') diagnostics.push(`Fill reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return [];
}

async function reconcileTrackedOrders(appConfig: AppConfig, adapter: PolymarketAdapter, store: InMemoryStore, diagnostics: string[], profile: MarketProfile): Promise<SingleFillCooldownRecord[]> {
  const orders = store.ordersNeedingReconciliation(profile.id);
  if (!orders.length) return [];
  try {
    const targets: FillTarget[] = orders.map((order) => ({
      profileId: order.profileId,
      asset: order.asset,
      interval: order.interval,
      roundId: order.roundId,
      eventSlug: order.eventSlug,
      marketTitle: order.marketTitle,
      imageUrl: order.imageUrl,
      tokenId: order.tokenId,
      label: order.label,
      clobOrderId: order.clobOrderId,
    }));
    const fills = await adapter.getRecentFillsForTargets(targets);
    const cooldowns = recordFillsAndMaybeCooldown(appConfig, store, fills, profile);

    const openOrders = await adapter.getOpenOrders();
    const cancelled = store.reconcileOpenOrderStatuses(profile.id, openOrders);
    if (cancelled) {
      store.recordRuntimeLog({
        level: 'info',
        source: 'execution',
        message: `Reconciled ${cancelled} stale Polymarket orders as no longer open.`,
      });
    }
    return cooldowns;
  } catch (error) {
    if (store.getRuntime().executionMode === 'live') diagnostics.push(`Order reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return [];
}

function recordFillsAndMaybeCooldown(appConfig: AppConfig, store: InMemoryStore, fills: FillRecord[], profile: MarketProfile): SingleFillCooldownRecord[] {
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
  if (appConfig.activeStrategyProfile !== 'classic') return [];
  const cooldown = store.maybeStartSingleFillCooldown(newFills, {
    baseMs: appConfig.singleFillCooldownBaseMs,
    priceCapMs: appConfig.singleFillCooldownPriceCapMs,
    executionMs: appConfig.singleFillCooldownExecutionMs,
    repeatWindowMs: appConfig.singleFillCooldownRepeatWindowMs,
    secondMs: appConfig.singleFillCooldownSecondMs,
    thirdMs: appConfig.singleFillCooldownThirdMs,
  }, Date.now(), 'UPDOWN_DUAL_ENTRY', profile.id);
  if (!cooldown) return [];
  store.recordRuntimeLog({
    level: 'warn',
    source: 'execution',
    message: `Final single-sided fill detected on ${cooldown.roundId}; entry cooldown active until ${cooldown.expiresAt}.`,
    details: cooldown,
  });
  return [cooldown];
}

async function executeCrossProfileSingleFillRisk(appConfig: AppConfig, store: InMemoryStore, data: MarketDataService, adapter: PolymarketAdapter, cooldowns: SingleFillCooldownRecord[]): Promise<string[]> {
  if (!appConfig.crossProfileSingleFillRiskEnabled || !cooldowns.length) return [];
  const sourceCooldowns = cooldowns.filter((cooldown) => {
    const sourceProfileId = cooldown.sourceProfileId || cooldown.profileId;
    return sourceProfileId.endsWith('-5m');
  });
  if (!sourceCooldowns.length) return [];

  const diagnostics: string[] = [];
  const seen = new Set<string>();
  for (const cooldown of sourceCooldowns) {
    const sourceProfileId = cooldown.sourceProfileId || cooldown.profileId;
    const candidates = store.crossProfileSingleFillRiskCandidates(sourceProfileId)
      .filter((candidate) => {
        const key = `${candidate.profileId}:${candidate.roundId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (!candidates.length) continue;

    store.recordRuntimeLog({
      level: 'warn',
      source: 'execution',
      message: `Cross-profile single-fill risk check triggered by ${sourceProfileId} on ${cooldown.roundId}.`,
      details: { sourceCooldown: cooldown, candidateCount: candidates.length, candidates: candidates.map((candidate) => ({ profileId: candidate.profileId, roundId: candidate.roundId, secondsToEnd: candidate.secondsToEnd })) },
    });

    for (const candidate of candidates) {
      const targetProfile = appConfig.marketProfiles.find((profile) => profile.id === candidate.profileId);
      if (!targetProfile) continue;
      const targetConfig = appConfigForProfile(appConfig, targetProfile);
      const orderbooks = data.refreshOrderbooksForTokenIds([candidate.yesTokenId, candidate.noTokenId]);
      const profitExitDiagnostics = await executeSingleFillProfitExits({
        appConfig: targetConfig,
        adapter,
        store,
        candidates: [candidate],
        orderbooks,
        ignoreTimeWindow: true,
      });
      diagnostics.push(...profitExitDiagnostics.map((message) => `Cross-profile risk ${candidate.profileId}: ${message}`));

      const hasRecentProfitExit = store.roundOrders(candidate.profileId, candidate.roundId)
        .some((order) => order.side === 'SELL' && order.strategy === 'UPDOWN_SINGLE_FILL_PROFIT_EXIT' && ['local', 'posted', 'partially_filled', 'filled'].includes(order.status));
      if (hasRecentProfitExit) continue;

      const hedgeDiagnostics = await executeSingleFillHedges({
        appConfig: targetConfig,
        adapter,
        store,
        candidates: [candidate],
        orderbooks,
        ignoreTimeWindow: true,
      });
      diagnostics.push(...hedgeDiagnostics.map((message) => `Cross-profile risk ${candidate.profileId}: ${message}`));
    }
  }
  return diagnostics;
}

async function reconcileSettlements(appConfig: AppConfig, store: InMemoryStore, diagnostics: string[], profile: MarketProfile): Promise<void> {
  const rounds = store.roundsNeedingSettlement(profile.id, profile.roundDurationSeconds);
  if (!rounds.length) return;
  for (const round of rounds) {
    try {
      const winningLabel = await resolvedWinningLabel(appConfig, round.eventSlug);
      if (!winningLabel) continue;
      const fills = store.roundFills(profile.id, round.roundId);
      const settlementValues = calculateSettlementValues(fills, winningLabel);
      const settlement: SettlementRecord = {
        id: `settlement-${round.roundId}`,
        profileId: profile.id,
        asset: profile.asset,
        interval: profile.interval,
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

function maybeRecordEstimatedSettlement(store: InMemoryStore, snapshot: StateSnapshot, profile: MarketProfile): void {
  if (snapshot.round.phase !== 'settled') return;
  const fills = store.roundFills(profile.id, snapshot.round.id);
  if (!fills.length) return;
  const winningLabel = snapshot.features.price == null ? undefined : snapshot.features.price >= snapshot.round.strike ? 'YES' : 'NO';
  const settlementValues = calculateSettlementValues(fills, winningLabel);
  const settlement: SettlementRecord = {
    id: `settlement-${snapshot.round.id}`,
    profileId: profile.id,
    asset: profile.asset,
    interval: profile.interval,
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
    bypassEntryScoreGating: appConfig.bypassEntryScoreGating,
    bypassSingleFillCooldown: appConfig.bypassSingleFillCooldown,
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
