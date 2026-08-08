import type { BtcRoundConfig, FillRecord, MarketProfile, OrderBookQuote, OrderbookCapacityTier, OrderbookDepthLevel, OrderbookDepthSnapshot, PortfolioSnapshot, RoundPhase, RoundSnapshot, SettlementRecord, StateSnapshot, StrategyCheck, StrategyCondition, TradeIntent } from '../../../packages/shared/src';
import { classifyRegime, evaluateEntry, evaluateExit, type StrategyEvaluation, type StrategyRiskConfig } from '../../../packages/strategy/src';
import type { AppConfig } from './config';
import { activeHedgeWindowSeconds, buildSingleFillHedgeCheck, hedgeExposureOrders, planSingleFillHedge } from './hedge';
import { executePaperIntents, reconcilePaperOrders } from './execution';
import { buildSingleFillProfitExitCheck, planSingleFillProfitExit, profitExitExposureOrders } from './profitExit';
import { buildSingleFillLossExitCheck, lossExitExposureOrders, planSingleFillLossExit } from './lossExit';
import type { MarketDataService } from './marketData';
import type { ParticipationService } from './participation';
import type { RecurringCryptoRoundDiscovery } from './roundDiscovery';
import { cancelFutureDualOrdersForPendingRisk } from './pendingSingleFillRisk';
import type { InMemoryStore, SingleFillCooldownRecord } from './store';
import { rankIntervalAssetCandidates, selectProfileEntryPrice, type IntervalAssetSelection } from './simPriceSelector';
import { evaluateTailEntry, executeTailEntry } from './tailEntry';

export async function runAllProfilesTick(appConfig: AppConfig, store: InMemoryStore, data: MarketDataService, discovery: RecurringCryptoRoundDiscovery, participationService: ParticipationService): Promise<StateSnapshot[]> {
  const enabledProfiles = appConfig.marketProfiles.filter((profile) => profile.status !== 'disabled');
  const intervalAssetSelections = rankIntervalAssetCandidates(appConfig, enabledProfiles);
  return Promise.all(enabledProfiles.map((profile) => runBotTick(
    appConfigForProfile(appConfig, profile),
    store,
    data,
    discovery,
    participationService,
    profile,
    intervalAssetSelections.get(profile.id),
  )));
}

export async function runBotTick(appConfig: AppConfig, store: InMemoryStore, data: MarketDataService, discovery: RecurringCryptoRoundDiscovery, participationService: ParticipationService, profile: MarketProfile = appConfig.marketProfiles[0], intervalAssetSelection?: IntervalAssetSelection): Promise<StateSnapshot> {
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
  const tailDiscovered = classicActive && shouldEvaluateCurrentTailEntry(appConfig, profile)
    ? await discovery.discover({
      profile,
      latestPrice: data.latestPrice(profile),
      persistedStrike: (roundId) => store.getRoundStrike(roundId),
      target: 'current',
    })
    : null;
  if (tailDiscovered?.diagnostics.length) diagnostics.push(...tailDiscovered.diagnostics.map((item) => `Tail entry current round: ${item}`));
  const tailRound = tailDiscovered ? captureOpeningStrike(tailDiscovered.round, store, data.latestPrice(profile)) : null;
  const hedgeWatchTokenIds = classicActive && appConfig.singleFillHedgeEnabled
    ? store.hedgeWatchTokenIds(profile.id, activeHedgeWindowSeconds(appConfig), appConfig.singleFillHedgeMinSecondsToEnd)
    : [];
  const profitExitWatchTokenIds = classicActive && appConfig.singleFillProfitExitEnabled
    ? store.profitExitWatchTokenIds(profile.id, appConfig.singleFillProfitExitMaxSecondsToEnd, appConfig.singleFillProfitExitMinSecondsToEnd)
    : [];
  const lossExitWatchTokenIds = classicActive && appConfig.singleFillLossExitEnabled
    ? store.profitExitWatchTokenIds(profile.id, appConfig.singleFillLossExitMaxSecondsToEnd, appConfig.singleFillLossExitMinSecondsToEnd)
    : [];
  const tailTokenIds = tailRound ? [tailRound.yesTokenId, tailRound.noTokenId] : [];
  const paperOrders = store.ordersNeedingReconciliation(profile.id, 1_000);
  const paperWatchTokenIds = paperOrders.map((order) => order.tokenId);
  data.syncClobRound(round, [...tailTokenIds, ...hedgeWatchTokenIds, ...profitExitWatchTokenIds, ...lossExitWatchTokenIds, ...paperWatchTokenIds]);
  const orderbooks = await data.refreshOrderbooks(round);
  const tailOrderbooks = tailRound ? await data.refreshOrderbooks(tailRound) : [];
  const paperOrderbooks = paperWatchTokenIds.length ? data.refreshOrderbooksForTokenIds(paperWatchTokenIds) : [];
  reconcilePaperOrders({ store, profileId: profile.id, quotes: paperOrderbooks });
  const participation = await participationService.refresh(round);
  diagnostics.push(...participation.diagnostics);
  const features = data.features(round, profile);
  const portfolio = paperPortfolio(store.settledPnl());
  const positions = portfolio.positions;
  const roundSnapshot = roundToSnapshot(appConfig, store, round);
  const pendingSingleFillRisk = store.getPendingSingleFillRisk(profile.id);
  if (pendingSingleFillRisk) {
    diagnostics.push(...await cancelFutureDualOrdersForPendingRisk(store, pendingSingleFillRisk));
  }
  const dynamicEntryPrice = withAssetSelection(selectProfileEntryPrice(appConfig, profile, roundSnapshot), intervalAssetSelection);
  store.recordDynamicEntryPrice(dynamicEntryPrice);
  const entryAppConfig = { ...appConfig, dualLimitPrice: dynamicEntryPrice.selectedPrice };
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
    positionReadStatus: 'disabled',
    portfolio,
    participation,
    diagnostics,
  };
  const activeCooldown = store.getActiveEntryCooldown(profile.id);
  const risk = riskConfig(
    entryAppConfig,
    true,
    activeCooldown?.expiresAt,
    activeCooldown ? `single fill on ${activeCooldown.roundId}` : undefined,
    pendingSingleFillRisk?.expiresAt,
    pendingSingleFillRisk ? `pending single fill from ${pendingSingleFillRisk.sourceProfileId} on ${pendingSingleFillRisk.roundId}` : undefined,
  );
  const snapshot: StateSnapshot = { ...baseSnapshot, regime: classifyRegime(baseSnapshot, risk) };
  snapshot.orderbookDepth = buildOrderbookDepthSnapshot(snapshot, entryAppConfig);
  const evaluatedEntry = classicActive
    ? appConfig.dualEntryEnabled ? evaluateEntry(snapshot, risk) : disabledDualEntry(snapshot)
    : evaluateExperimentEntry(snapshot, appConfig, store);
  const confirmedEntry = classicActive
    ? applyEntryConfirmation(
      evaluatedEntry,
      appConfig.bypassEntryScoreGating ? appConfig.entryConfirmTicks : store.recordEntrySignal(`${profile.id}:${snapshot.round.id}`, evaluatedEntry.intents.length > 0),
      appConfig.entryConfirmTicks,
      appConfig.bypassEntryScoreGating,
    )
    : evaluatedEntry;
  const entry = classicActive
    ? applyIntervalAssetSelection(applySimulatorSelection(confirmedEntry, dynamicEntryPrice), intervalAssetSelection)
    : confirmedEntry;
  const intents = entry.intents.map((intent) => withProfile(intent, profile));
  store.recordIntents([...intents, ...entry.rejected.map((intent) => withProfile(intent, profile))]);
  const executionDiagnostics = executePaperIntents({ store, snapshot, intents });
  const tailSnapshot = tailRound ? {
    ...snapshot,
    id: `tail-snapshot-${Date.now()}`,
    round: roundToSnapshot(appConfig, store, tailRound),
    features: data.features(tailRound, profile),
    orderbooks: tailOrderbooks,
  } satisfies StateSnapshot : null;
  if (tailSnapshot) tailSnapshot.orderbookDepth = buildOrderbookDepthSnapshot(tailSnapshot, entryAppConfig);
  const tailEntry = classicActive && tailSnapshot ? evaluateTailEntry(tailSnapshot, appConfig, store) : null;
  const tailEntryDiagnostics = tailEntry && tailSnapshot && tailRound ? await executeTailEntry({
    appConfig,
    store,
    snapshot: tailSnapshot,
    evaluation: tailEntry,
  }) : [];
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
  const lossExitCandidates = classicActive && appConfig.singleFillLossExitEnabled
    ? store.singleFillProfitExitCandidates(profile.id, appConfig.singleFillLossExitMaxSecondsToEnd, appConfig.singleFillLossExitMinSecondsToEnd)
    : [];
  const hedgeOrderbooks = data.refreshOrderbooksForTokenIds([
    ...hedgeCandidates.flatMap((candidate) => [candidate.yesTokenId, candidate.noTokenId]),
    ...profitExitCandidates.flatMap((candidate) => [candidate.yesTokenId, candidate.noTokenId]),
    ...lossExitCandidates.flatMap((candidate) => [candidate.yesTokenId, candidate.noTokenId]),
  ]);
  const exit = classicActive
    ? evaluateExit(snapshot, positions, risk, { orders: store.roundOrders(profile.id, snapshot.round.id, 'UPDOWN_DUAL_ENTRY'), fills: store.roundFillsByStrategy(profile.id, snapshot.round.id, 'UPDOWN_DUAL_ENTRY') })
    : disabledExperimentExitCheck(snapshot);
  const hedgeCheck = classicActive ? buildCurrentRoundHedgeCheck(appConfig, store, snapshot, [...orderbooks, ...hedgeOrderbooks]) : disabledClassicCheck(snapshot, 'UPDOWN_SINGLE_FILL_HEDGE', 'Up/Down Single-Fill Hedge', 'Disabled while experimental profile is active.');
  const profitExitCheck = classicActive ? buildCurrentRoundProfitExitCheck(appConfig, store, snapshot, [...orderbooks, ...hedgeOrderbooks]) : disabledClassicCheck(snapshot, 'UPDOWN_SINGLE_FILL_PROFIT_EXIT', 'Up/Down Single-Fill Profit Exit', 'Disabled while experimental profile is active.');
  const lossExitCheck = classicActive ? buildCurrentRoundLossExitCheck(appConfig, store, snapshot, [...orderbooks, ...hedgeOrderbooks]) : disabledClassicCheck(snapshot, 'UPDOWN_SINGLE_FILL_LOSS_EXIT', 'Up/Down Single-Fill Loss Exit', 'Disabled while experimental profile is active.');
  await reconcileSettlements(appConfig, store, diagnostics, profile);
  maybeRecordEstimatedSettlement(store, snapshot, profile);
  const finalSnapshot = { ...snapshot, diagnostics: [...diagnostics, ...entry.diagnostics, ...executionDiagnostics, ...tailEntryDiagnostics] };
  store.recordSnapshot(finalSnapshot, data.status(profile, [round.yesTokenId, round.noTokenId]));
  store.recordStrategyChecks([...entry.checks, ...(tailEntry ? [tailEntry.check] : []), ...exit.checks, hedgeCheck, profitExitCheck, lossExitCheck].map((check) => withProfile(check, profile)), profile.id);
  return finalSnapshot;
}

function shouldEvaluateCurrentTailEntry(appConfig: AppConfig, profile: MarketProfile): boolean {
  return appConfig.pm5mTailEntryEnabled;
}

function appConfigForProfile(appConfig: AppConfig, profile: MarketProfile): AppConfig {
  return {
    ...appConfig,
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

function withAssetSelection(selection: ReturnType<typeof selectProfileEntryPrice>, assetSelection?: IntervalAssetSelection): ReturnType<typeof selectProfileEntryPrice> {
  if (!assetSelection) return selection;
  return {
    ...selection,
    assetSelectorEnabled: true,
    assetSelectorSelected: assetSelection.selected,
    assetSelectorRank: assetSelection.rank,
    assetSelectorScore: assetSelection.score,
    assetSelectorEv: assetSelection.ev,
    assetSelectorSinglePenalty: assetSelection.singlePenalty,
    reason: `${selection.reason}; ${assetSelection.reason}`,
  };
}

function applyIntervalAssetSelection(entry: StrategyEvaluation, assetSelection?: IntervalAssetSelection): StrategyEvaluation {
  if (!assetSelection) return entry;
  const selectorCondition = condition('Interval asset selector', assetSelection.selected, assetSelection.reason);
  const checks = entry.checks.map((check) => {
    if (check.strategy !== 'UPDOWN_DUAL_ENTRY') return check;
    if (assetSelection.selected) {
      return { ...check, conditions: [...check.conditions, selectorCondition] };
    }
    return {
      ...check,
      status: 'blocked' as const,
      reason: check.reason ? `${check.reason}; PM_ASSET_NOT_SELECTED` : 'PM_ASSET_NOT_SELECTED',
      blockers: [...new Set([...check.blockers, 'PM_ASSET_NOT_SELECTED'])],
      conditions: [...check.conditions, selectorCondition],
    };
  });
  if (assetSelection.selected) return { ...entry, checks };
  return {
    ...entry,
    intents: [],
    rejected: [
      ...entry.rejected,
      ...entry.intents.map((intent) => ({
        ...intent,
        status: 'rejected' as const,
        rejectionReason: 'PM_ASSET_NOT_SELECTED',
        reason: `${intent.reason}; ${assetSelection.reason}`,
      })),
    ],
    checks,
  };
}

function applySimulatorSelection(entry: StrategyEvaluation, selection: ReturnType<typeof selectProfileEntryPrice>): StrategyEvaluation {
  if (selection.enabled || selection.source !== 'disabled' || selection.reason === 'PM_SIM_PRICE_ENABLED=false') return entry;
  const blocker = selection.reason.includes('positive EV') ? 'PM5M_SIM_EV_NOT_POSITIVE' : 'PM_SIMULATOR_UNAVAILABLE';
  const selectorCondition = condition('Simulator gate', false, selection.reason);
  const checks = entry.checks.map((check) => {
    if (check.strategy !== 'UPDOWN_DUAL_ENTRY') return check;
    return {
      ...check,
      status: 'blocked' as const,
      reason: check.reason ? `${check.reason}; ${blocker}` : blocker,
      blockers: [...new Set([...check.blockers, blocker])],
      conditions: [...check.conditions, selectorCondition],
    };
  });
  return {
    ...entry,
    intents: [],
    rejected: [
      ...entry.rejected,
      ...entry.intents.map((intent) => ({
        ...intent,
        status: 'rejected' as const,
        rejectionReason: blocker,
        reason: `${intent.reason}; ${selection.reason}`,
      })),
    ],
    checks,
  };
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

export function evaluateExperimentEntry(snapshot: StateSnapshot, appConfig: AppConfig, store: InMemoryStore): StrategyEvaluation {
  const reasons: string[] = [];
  const stopped = appConfig.experimentStopOnSingle ? store.getExperimentStop() : null;
  const inDecisionWindow = snapshot.round.secondsToStart >= appConfig.entryMinSecondsToStart;
  const shares = roundShares(appConfig.experimentNextRoundSharesPerSide);
  const upPrice = roundPrice(appConfig.experimentNextRoundUpLimitPrice);
  const downPrice = roundPrice(appConfig.experimentNextRoundDownLimitPrice);
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
    title: 'Up/Down Experimental Next-Round 50/50',
    status: reasons.includes('EXPERIMENT_ORDERS_ALREADY_PLACED') ? 'not-applicable' : reasons.length ? 'blocked' : 'eligible',
    summary: 'Posts fixed next-round UP and DOWN BUY limits while bypassing classic strategy-entry gates.',
    reason: reasons.length ? reasons.join(', ') : `Experimental entry eligible: UP ${upPrice.toFixed(3)} / DOWN ${downPrice.toFixed(3)} / ${shares.toFixed(2)} shares.`,
    blockers: reasons,
    amountUsd: shares * (upPrice + downPrice),
    limitPrice: Math.max(upPrice, downPrice),
    conditions: [
      condition('Active profile', appConfig.activeStrategyProfile === 'experiment_next_round', appConfig.activeStrategyProfile),
      condition('Experiment not stopped', !stopped, appConfig.experimentStopOnSingle ? (stopped ? `${stopped.reason} on ${stopped.roundId}` : 'active') : 'stop-on-single disabled'),
      condition('Round before start', inDecisionWindow, `${snapshot.round.secondsToStart.toFixed(1)}s to start / min ${appConfig.entryMinSecondsToStart}s`),
      condition('UP limit price', upPrice > 0 && upPrice < 1, upPrice.toFixed(3)),
      condition('DOWN limit price', downPrice > 0 && downPrice < 1, downPrice.toFixed(3)),
      condition('Shares per side', shares >= appConfig.minOrderShares, `${shares.toFixed(2)} / min ${appConfig.minOrderShares.toFixed(2)}`),
      condition('UP order not already placed', !upAlreadyPlaced, upAlreadyPlaced ? 'already placed for this round' : 'clear'),
      condition('DOWN order not already placed', !downAlreadyPlaced, downAlreadyPlaced ? 'already placed for this round' : 'clear'),
      condition('Classic entry gates', true, 'score, confirmation, simulator, asset selector, participation, and orderbook readiness bypassed'),
      condition('Execution safety gates', true, 'collateral, credentials, token, timing, price/size, and duplicate-order checks remain enabled'),
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

function disabledDualEntry(snapshot: StateSnapshot): StrategyEvaluation {
  return {
    intents: [],
    rejected: [],
    diagnostics: ['Dual entry disabled by DUAL_ENTRY_ENABLED=false.'],
    checks: [disabledClassicCheck(snapshot, 'UPDOWN_DUAL_ENTRY', 'Up/Down Dual Entry', 'Disabled by DUAL_ENTRY_ENABLED=false.')],
  };
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

function buildCurrentRoundLossExitCheck(appConfig: AppConfig, store: InMemoryStore, snapshot: StateSnapshot, orderbooks: StateSnapshot['orderbooks']) {
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
  const orders = lossExitExposureOrders(store.roundOrders(snapshot.profileId, snapshot.round.id));
  const plan = planSingleFillLossExit({ candidate, orders, orderbooks, appConfig });
  const executionKey = plan.ok ? [snapshot.profileId, plan.intent.roundId, plan.intent.strategy, plan.intent.tokenId, plan.intent.side].filter(Boolean).join(':') : undefined;
  return buildSingleFillLossExitCheck({
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

function paperPortfolio(settledPnl: number): PortfolioSnapshot {
  const roundedSettledPnl = roundMoney(settledPnl);
  return {
    status: 'disabled',
    updatedAt: new Date().toISOString(),
    hasOwnerPrivateKey: false,
    hasDepositWallet: false,
    positions: [],
    positionCount: 0,
    positionValue: 0,
    positionCost: 0,
    unrealizedPnl: 0,
    settledPnl: roundedSettledPnl,
    totalPnl: roundedSettledPnl,
    roiPct: null,
    diagnostics: ['Paper-only runtime does not read a real Polymarket account.'],
  };
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
      const tailFills = fills.filter((fill) => fill.strategy === 'UPDOWN_TAIL_ENTRY');
      if (tailFills.some((fill) => fill.side === 'BUY')) {
        const tailPnl = calculateSettlementValues(tailFills, winningLabel).pnl;
        const cooldown = store.recordTailLoss(profile.id, round.roundId, tailPnl, {
          baseMs: appConfig.pm5mTailCooldownBaseMs,
          repeatWindowMs: appConfig.pm5mTailCooldownRepeatWindowMs,
          secondMs: appConfig.pm5mTailCooldownSecondMs,
          thirdMs: appConfig.pm5mTailCooldownThirdMs,
        });
        if (cooldown) diagnostics.push(`Tail loss cooldown active until ${cooldown.expiresAt} after ${round.roundId} (${tailPnl.toFixed(2)} PnL).`);
      }
    } catch (error) {
      diagnostics.push(`Settlement reconciliation failed for ${round.roundId}: ${error instanceof Error ? error.message : String(error)}`);
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

function riskConfig(
  appConfig: AppConfig,
  dryRun: boolean,
  entryCooldownUntil?: string,
  entryCooldownReason?: string,
  pendingSingleFillRiskUntil?: string,
  pendingSingleFillRiskReason?: string,
): StrategyRiskConfig {
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
    minPaperChopScore: appConfig.minPaperChopScore,
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
    pendingSingleFillRiskUntil,
    pendingSingleFillRiskReason,
  };
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
