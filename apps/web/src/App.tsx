import React from 'react';
import { 
  AlertTriangle, 
  CheckCircle2, 
  RefreshCw, 
  BookOpen,
  History,
  Terminal,
  Cpu,
  WalletCards,
  Target,
  BarChart3
} from 'lucide-react';

import type { DashboardState } from '../../../packages/shared/src';
import { api, DASHBOARD_REFRESH_MS } from './lib/api';
import { formatMoney, formatNumber, formatSeconds } from './lib/format';
import { formatEtTime, outcomeLabel, outcomeTone, shortenTokenId } from './lib/dashboardFormat';

import { RoundTimelinePipeline } from './components/RoundTimelinePipeline';
import { Badge, DataTable, DecisionMetric, PageIntro, PaginationControls, Shell, ViewHeader } from './components/dashboard/Ui';
import { DynamicEntryPricePanel } from './app/DynamicEntryPricePanel';
import { AllProfilesOverview } from './app/terminal/AllProfilesOverview';
import { ProfileRail } from './app/terminal/ProfileRail';
import { TailEntryPanel } from './app/terminal/TailEntryPanel';
import { LogsTab } from './app/tabs/LogsTab';
import { OrderbooksTab } from './app/tabs/OrderbooksTab';
import { PortfolioTab } from './app/tabs/PortfolioTab';
import { StrategyRulesTab } from './app/tabs/StrategyRulesTab';
import {
  AssetIcon,
  AssetLabel,
  DAILY_PAGE_SIZE,
  LOG_PAGE_SIZE,
  ORDER_PAGE_SIZE,
  ORDER_STRATEGY_FILTERS,
  ROUND_PAGE_SIZE,
  STATS_WINDOW_MS,
  type ActivitySubTab,
  type OrderStrategyFilter,
  type TailSimSummary,
  type TabType,
  type TouchSimSummary,
  type VisibleState,
  blockerDetail,
  buildDailyExecutionSummaries,
  buildExecutionStats,
  buildRoundExecutionSummaries,
  currentRoundExposure,
  formatCooldownRemaining,
  formatEv,
  formatEtRange,
  formatPercentValue,
  formatPriceCents,
  formatRate,
  formatRelativeAge,
  formatShares,
  formatSignedMoney,
  formatSubmittedLeg,
  isRoutineHeartbeatLog,
  orderFailureReason,
  orderMarketTitle,
  orderMatchesStrategyFilter,
  orderStrategyFilterFor,
  orderStrategyFilterLabel,
  portfolioStatusLabel,
  positionCost,
  positionPnl,
  positionValue,
  profileLabelFor,
  roundFillState,
  roundStatusSummary,
  runtimeBuildLabel,
  strategyCheckLabel,
  strategyCheckTone,
  strategySourceLabel,
  strategySourceLabelForStrategy,
  strategySourceTone,
  strategySourceToneForStrategy,
  syncTabToUrl,
  tabFromUrl,
  touchOutcomeTone,
  usePaginatedRows,
} from './app/dashboardHelpers';

type SimulationResearchTab = 'touch' | 'tail';
type SimulationSubTab = 'price' | 'matrix' | 'rounds';
type TailSimulationSubTab = 'checkpoint' | 'bands' | 'rounds';

export function App() {
  const [state, setState] = React.useState<DashboardState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [autoRefreshing, setAutoRefreshing] = React.useState(false);
  const [lastRefreshAt, setLastRefreshAt] = React.useState<string | null>(null);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const [touchSim, setTouchSim] = React.useState<TouchSimSummary | null>(null);
  const [touchSimError, setTouchSimError] = React.useState<string | null>(null);
  const [tailSim, setTailSim] = React.useState<TailSimSummary | null>(null);
  const [tailSimError, setTailSimError] = React.useState<string | null>(null);
  
  // Navigation Tab State
  const [activeTab, setActiveTab] = React.useState<TabType>(() => tabFromUrl());
  const [activitySubTab, setActivitySubTab] = React.useState<ActivitySubTab>('daily');
  const [orderStrategyFilter, setOrderStrategyFilter] = React.useState<OrderStrategyFilter>('all');
  const [simulationResearchTab, setSimulationResearchTab] = React.useState<SimulationResearchTab>('touch');
  const [simulationSubTab, setSimulationSubTab] = React.useState<SimulationSubTab>('price');
  const [tailSimulationSubTab, setTailSimulationSubTab] = React.useState<TailSimulationSubTab>('checkpoint');
  const [simulationAssetTab, setSimulationAssetTab] = React.useState<string>('btc');
  const [selectedProfileId, setSelectedProfileId] = React.useState<string>('all');

  // Logs Search & Filter States
  const [logSearch, setLogSearch] = React.useState('');
  const [logLevel, setLogLevel] = React.useState<string>('all');
  const [logSource, setLogSource] = React.useState<string>('all');
  const [hideRoutineLogs, setHideRoutineLogs] = React.useState(true);

  // Ref for auto-scrolling the log console
  const consoleRef = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(async (silent = false) => {
    try {
      if (silent) setAutoRefreshing(true);
      else setRefreshing(true);
      setError(null);
      setState(await api<DashboardState>('/api/state'));
      setLastRefreshAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (silent) setAutoRefreshing(false);
      else setRefreshing(false);
    }
  }, []);

  const loadTouchSim = React.useCallback(async () => {
    try {
      setTouchSim(await api<TouchSimSummary>('/api/research/pm5m-touch/summary'));
      setTouchSimError(null);
    } catch (err) {
      setTouchSimError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadTailSim = React.useCallback(async () => {
    try {
      setTailSim(await api<TailSimSummary>('/api/research/pm5m-tail/summary'));
      setTailSimError(null);
    } catch (err) {
      setTailSimError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  React.useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), DASHBOARD_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  React.useEffect(() => {
    void loadTouchSim();
    void loadTailSim();
    const timer = setInterval(() => {
      void loadTouchSim();
      void loadTailSim();
    }, DASHBOARD_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadTailSim, loadTouchSim]);

  React.useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  React.useEffect(() => {
    syncTabToUrl(activeTab);
  }, [activeTab]);

  React.useEffect(() => {
    const handlePopState = () => setActiveTab(tabFromUrl());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const visibleState = React.useMemo<VisibleState | null>(() => {
    if (!state) return null;
    const profileState = selectedProfileId === 'all'
      ? state.profiles.find((item) => item.latestSnapshot) || state.profiles[0]
      : state.profiles.find((item) => item.profile.id === selectedProfileId);
    if (!profileState?.latestSnapshot) return null;
    const profileId = profileState.profile.id;
    const filterByProfile = selectedProfileId !== 'all';
    return {
      runtime: state.runtime,
      profiles: state.profiles,
      profileState,
      feed: profileState.feed,
      snapshot: profileState.latestSnapshot,
      strategyChecks: profileState.strategyChecks,
      intents: filterByProfile ? state.intents.filter((intent) => intent.profileId === profileId) : state.intents,
      orders: filterByProfile ? state.orders.filter((order) => order.profileId === profileId) : state.orders,
      fills: filterByProfile ? state.fills.filter((fill) => fill.profileId === profileId) : state.fills,
      settlements: filterByProfile ? state.settlements.filter((settlement) => settlement.profileId === profileId) : state.settlements,
      runtimeLogs: state.runtimeLogs,
      rules: state.rules,
    };
  }, [state, selectedProfileId]);

  // Filter logs in real-time
  const filteredLogs = React.useMemo(() => {
    if (!state?.runtimeLogs) return [];
    return state.runtimeLogs.filter((log) => {
      const matchesProfile = selectedProfileId === 'all' ? true : log.profileId === selectedProfileId;
      const matchesSearch = logSearch
        ? log.message.toLowerCase().includes(logSearch.toLowerCase()) || 
          log.source.toLowerCase().includes(logSearch.toLowerCase())
        : true;
      const matchesLevel = logLevel === 'all' ? true : log.level === logLevel;
      const matchesSource = logSource === 'all' ? true : log.source === logSource;
      const matchesSignalMode = hideRoutineLogs ? !isRoutineHeartbeatLog(log) : true;
      return matchesProfile && matchesSearch && matchesLevel && matchesSource && matchesSignalMode;
    });
  }, [state?.runtimeLogs, selectedProfileId, logSearch, logLevel, logSource, hideRoutineLogs]);

  const roundSummaries = React.useMemo(() => visibleState ? buildRoundExecutionSummaries(visibleState) : [], [visibleState]);
  const dailySummaries = React.useMemo(() => buildDailyExecutionSummaries(roundSummaries), [roundSummaries]);
  const executionStats = React.useMemo(() => visibleState ? buildExecutionStats(visibleState, nowMs) : null, [visibleState, nowMs]);
  const filteredOrders = React.useMemo(() => (
    (visibleState?.orders ?? []).filter((order) => orderMatchesStrategyFilter(order, orderStrategyFilter))
  ), [visibleState?.orders, orderStrategyFilter]);
  const orderStrategyCounts = React.useMemo(() => {
    const counts: Record<OrderStrategyFilter, number> = {
      all: visibleState?.orders.length ?? 0,
      dual: 0,
      tail: 0,
      exit: 0,
      experiment: 0,
    };
    (visibleState?.orders ?? []).forEach((order) => {
      counts[orderStrategyFilterFor(order)] += 1;
    });
    return counts;
  }, [visibleState?.orders]);
  const touchCompletedByPrice = touchSim?.completed?.byPrice ?? [];
  const touchCompletedByAssetPrice = touchSim?.completed?.byAssetPrice ?? [];
  const touchMatrixAssets = React.useMemo(() => (
    [...new Set(touchCompletedByAssetPrice.map((row) => row.asset || 'unknown'))].sort()
  ), [touchCompletedByAssetPrice]);

  const dailyPagination = usePaginatedRows(dailySummaries, DAILY_PAGE_SIZE);
  const roundPagination = usePaginatedRows(roundSummaries, ROUND_PAGE_SIZE);
  const ordersPagination = usePaginatedRows(filteredOrders, ORDER_PAGE_SIZE);
  const logsPagination = usePaginatedRows(filteredLogs, LOG_PAGE_SIZE);

  React.useEffect(() => {
    dailyPagination.setPage(1);
    roundPagination.setPage(1);
  }, [roundSummaries.length]);

  React.useEffect(() => {
    ordersPagination.setPage(1);
  }, [filteredOrders.length, orderStrategyFilter, selectedProfileId]);

  React.useEffect(() => {
    logsPagination.setPage(1);
  }, [selectedProfileId, logSearch, logLevel, logSource, hideRoutineLogs]);

  // Auto-scroll log console to bottom when new logs arrive
  React.useEffect(() => {
    if (consoleRef.current && activeTab === 'logs') {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [filteredLogs, activeTab]);

  if (error) {
    return (
      <Shell>
        <div className="empty">
          <AlertTriangle size={48} className="fail" />
          <p className="emptyText">{error}</p>
          <button type="button" onClick={() => load()}>
            <RefreshCw size={14} /> Retry Connection
          </button>
        </div>
      </Shell>
    );
  }

  if (!state) {
    return (
      <Shell>
        <div className="empty">
          <RefreshCw className="spin" size={48} style={{ color: 'var(--color-primary)' }} />
          <p className="emptyText">Initializing Up/Down Trading Terminal...</p>
        </div>
      </Shell>
    );
  }

  if (!visibleState) {
    return (
      <Shell>
        <div className="empty">
          <RefreshCw className="spin" size={48} style={{ color: 'var(--color-primary)' }} />
          <p className="emptyText">Waiting for profile snapshots...</p>
        </div>
      </Shell>
    );
  }

  const viewState = visibleState;
  const stats = executionStats;
  const isAllProfiles = selectedProfileId === 'all';
  const scopeLabel = isAllProfiles ? 'All profiles' : viewState.profileState.profile.label;
  const enabledProfileCount = state.profiles.filter((item) => item.profile.status !== 'disabled').length;
  const liveProfileCount = state.profiles.filter((item) => item.profile.status === 'live').length;
  const profileOrderCounts = state.profiles.map((item) => item.stats.orders);
  const allProfilePositions = state.profiles.flatMap((item) => (
    item.latestSnapshot?.positions.map((position) => ({
      ...position,
      profileId: item.profile.id,
      profileLabel: item.profile.label,
    })) || []
  ));
  const snapshot = viewState.snapshot;
  const portfolio = snapshot.portfolio;
  const entryCheck = viewState.strategyChecks.find((check) => check.strategy === 'UPDOWN_DUAL_ENTRY');
  const entryEligibleLabel = entryCheck?.status === 'eligible' ? 'entry eligible' : 'entry blocked';
  const entryConditions = entryCheck?.conditions || [];
  const conditionByLabel = (label: string) => entryConditions.find((condition) => condition.label === label);
  const failedEntryConditions = entryConditions.filter((condition) => !condition.passed);
  const activeOrders = viewState.orders.filter((order) => (
    order.status === 'posted'
    || order.status === 'partially_filled'
    || (state.runtime.executionMode === 'monitor' && order.status === 'local')
  )).length;
  const pnl = viewState.settlements.reduce((sum, item) => sum + item.pnl, 0);
  const portfolioPnl = isAllProfiles ? pnl : portfolio?.totalPnl ?? pnl;
  const signalLogCount = state.runtimeLogs.filter((log) => !isRoutineHeartbeatLog(log)).length;
  const alertLogCount = state.runtimeLogs.filter((log) => log.level === 'warn' || log.level === 'error').length;
  const selectedProfile = isAllProfiles
    ? null
    : state.profiles.find((item) => item.profile.id === selectedProfileId)?.profile || null;
  const displayedPositions = isAllProfiles
    ? allProfilePositions
    : snapshot.positions.map((position) => ({
      ...position,
      profileId: viewState.profileState.profile.id,
      profileLabel: viewState.profileState.profile.label,
    }));
  const displayedPositionValue = displayedPositions.reduce((sum, position) => sum + positionValue(position), 0);
  const displayedPositionCost = displayedPositions.reduce((sum, position) => sum + positionCost(position), 0);
  const displayedUnrealizedPnl = displayedPositions.reduce((sum, position) => sum + positionPnl(position), 0);
  const displayedRoiPct = displayedPositionCost > 0 ? (displayedUnrealizedPnl / displayedPositionCost) * 100 : null;
  const portfolioProfileName = portfolio?.profile?.name || portfolio?.profile?.pseudonym;
  const portfolioProfileHandle = portfolio?.profile?.pseudonym && portfolio?.profile?.pseudonym !== portfolioProfileName
    ? portfolio.profile.pseudonym
    : undefined;
  const portfolioAvatarUrl = portfolio?.profile?.profileImageOptimized || portfolio?.profile?.profileImage;
  const portfolioInitial = (portfolioProfileName || portfolio?.accountAddress || '?').trim().slice(0, 1).toUpperCase();
  const refreshIntervalSeconds = Math.round(DASHBOARD_REFRESH_MS / 1000);
  const refreshStatusLabel = `Auto ${refreshIntervalSeconds}s`;
  const lastRefreshLabel = lastRefreshAt ? formatRelativeAge(new Date(lastRefreshAt).getTime(), nowMs) : 'pending';
  const refreshAriaStatus = autoRefreshing || refreshing ? 'Updating now' : `Auto refresh every ${refreshIntervalSeconds} seconds`;

  // Time progress bar calculation
  const secondsToEnd = snapshot.round.secondsToEnd;
  const secondsToStart = snapshot.round.secondsToStart;
  const totalRoundDuration = selectedProfile?.roundDurationSeconds || 300;
  const isRoundStarted = secondsToStart <= 0;
  const roundElapsedSeconds = isRoundStarted ? totalRoundDuration - Math.max(0, secondsToEnd) : 0;
  const progressPct = Math.min(100, Math.max(0, (roundElapsedSeconds / totalRoundDuration) * 100));
  let progressColorClass = 'safe';
  if (!isRoundStarted && secondsToStart <= 30) {
    progressColorClass = 'warning';
  } else if (isRoundStarted && secondsToEnd < 30) {
    progressColorClass = 'danger';
  } else if (isRoundStarted && secondsToEnd <= 120) {
    progressColorClass = 'warning';
  }

  // Round phase detail text logic (prevents negative countdowns once started)
  const roundPhaseDetail = isRoundStarted
    ? `${formatSeconds(secondsToEnd)} remaining`
    : `${formatSeconds(secondsToStart)} to start`;
  const timelineDetail = isRoundStarted ? `${formatSeconds(secondsToEnd)} remaining` : `${formatSeconds(secondsToStart)} to start`;
  const strikeLabel = snapshot.round.strikeStatus === 'locked' ? 'Opening Strike' : 'Estimated Open';
  const entryStatusTone = entryCheck?.status === 'eligible' ? 'good' : entryCheck?.status === 'blocked' ? 'bad' : 'neutral';
  const entryStatusLabel = entryCheck?.status || 'not-loaded';
  const entryLimit = entryCheck?.limitPrice;
  const entryPairCost = entryLimit == null ? null : entryLimit * 2;
  const entryPairEdge = entryPairCost == null ? null : 1 - entryPairCost;
  const entryConfig = state.runtime.entryConfig;
  const entryBypassActive = Boolean(entryConfig?.bypassEntryScoreGating);
  const fixedLimitLabel = entryConfig ? entryConfig.dualLimitPrice.toFixed(3) : '-';
  const fixedSharesLabel = entryConfig ? formatShares(entryConfig.orderSharesPerSide) : '-';
  const entryCooldownActive = Boolean(viewState.profileState.entryCooldownUntil && new Date(viewState.profileState.entryCooldownUntil).getTime() > Date.now());
  const entryCooldownRemaining = formatCooldownRemaining(viewState.profileState.entryCooldownUntil);
  const entryCooldownReason = viewState.profileState.entryCooldownReason || 'no single-fill lockout';
  const cooldownGateLabel = entryConfig?.bypassSingleFillCooldown ? 'BYPASSED' : 'ENFORCED';
  const decisionWindowCondition = conditionByLabel('Decision window');
  const cooldownCondition = conditionByLabel('Single-fill cooldown');
  const entryWindowPassed = decisionWindowCondition?.passed ?? false;
  const effectiveBlockers = entryBypassActive
    ? failedEntryConditions.filter((condition) => condition.label === 'Single-fill cooldown')
    : failedEntryConditions;
  const diagnosticBlockerCount = Math.max(0, failedEntryConditions.length - effectiveBlockers.length);
  const currentEntryIntents = viewState.intents.filter((intent) => (
    intent.roundId === snapshot.round.id
    && intent.strategy === 'UPDOWN_DUAL_ENTRY'
    && intent.status === 'generated'
  ));
  const previewShares = currentEntryIntents[0]?.shares;
  const previewLabels = currentEntryIntents.map((intent) => outcomeLabel(intent.label)).join(' + ');
  const entryActionDetail = entryCheck?.status === 'eligible'
    ? `${previewLabels || 'UP + DOWN'} BUY LIMIT${previewShares == null ? '' : `, ${formatShares(previewShares)} shares/side`} @ ${entryLimit == null ? 'strategy limit' : entryLimit.toFixed(3)}`
    : effectiveBlockers.slice(0, 3).map(blockerDetail).join(' / ')
      || (entryBypassActive && failedEntryConditions.length ? `${diagnosticBlockerCount} strategy checks bypassed by config` : '')
      || entryCheck?.reason
      || 'waiting for strategy check';
  const decisionState = entryCheck?.status === 'eligible'
    ? { label: 'ENTER READY', detail: entryActionDetail, tone: 'good' as const }
    : entryCooldownActive || cooldownCondition?.passed === false
      ? { label: 'COOLDOWN', detail: cooldownCondition ? blockerDetail(cooldownCondition) : entryCooldownReason, tone: 'warn' as const }
      : isRoundStarted
        ? { label: 'POST-START MONITOR', detail: 'regular entries blocked; single-fill hedge may run in final window', tone: 'neutral' as const }
        : !entryWindowPassed
          ? { label: 'WAITING FOR T-30S', detail: decisionWindowCondition ? blockerDetail(decisionWindowCondition) : `${formatSeconds(secondsToStart)} to start`, tone: 'neutral' as const }
          : { label: 'BLOCKED', detail: entryActionDetail, tone: 'bad' as const };
  const scopedDecisionState = isAllProfiles
    ? {
      label: 'PROFILE OVERVIEW',
      detail: `${enabledProfileCount} enabled profiles, ${liveProfileCount} live. Select one profile for current-round entry, hedge, and orderbook detail.`,
      tone: state.profiles.some((item) => item.entryCooldownUntil && new Date(item.entryCooldownUntil).getTime() > Date.now()) ? 'warn' as const : 'neutral' as const,
    }
    : decisionState;
  const cooldownDetail = entryCooldownActive ? `${entryCooldownRemaining}; ${entryCooldownReason}` : entryCooldownReason;
  const executionLabel = state.runtime.executionMode === 'live' ? 'LIVE' : 'MONITOR';
  const feedLabel = `${viewState.feed.source.toUpperCase()} / CLOB ${viewState.feed.clobConnected ? 'ON' : 'OFF'}`;
  const hedgeCheck = viewState.strategyChecks.find((check) => check.strategy === 'UPDOWN_SINGLE_FILL_HEDGE');
  const profitExitCheck = viewState.strategyChecks.find((check) => check.strategy === 'UPDOWN_SINGLE_FILL_PROFIT_EXIT');
  const tailEntryCheck = viewState.strategyChecks.find((check) => check.strategy === 'UPDOWN_TAIL_ENTRY');
  const tailCondition = (label: string) => tailEntryCheck?.conditions.find((condition) => condition.label === label);
  const tailCheckpointCondition = tailCondition('Tail checkpoint');
  const tailSelectedSummaryRowCondition = tailCondition('Summary selected row');
  const tailSelectedSideCondition = tailCondition('Selected side');
  const tailSummaryPnlCondition = tailCondition('Summary 12h PnL');
  const tailSummaryEvCondition = tailCondition('Summary EV/share');
  const tailSummaryMinVwapCondition = tailCondition('Summary min VWAP');
  const tailVwapCondition = tailCondition('VWAP depth');
  const tailVwapFloorCondition = tailCondition('VWAP floor');
  const tailMidpointGapCondition = tailCondition('Midpoint gap');
  const tailRoundOrderLimitCondition = tailCondition('Round order limit');
  const currentRoundOrders = viewState.orders.filter((order) => order.roundId === snapshot.round.id);
  const tailEntryOrders = viewState.orders
    .filter((order) => order.strategy === 'UPDOWN_TAIL_ENTRY')
    .slice()
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const tailEntryRoundId = tailEntryCheck?.roundId || snapshot.round.id;
  const currentRoundTailOrders = tailEntryOrders.filter((order) => order.roundId === tailEntryRoundId);
  const currentRoundOpenOrders = currentRoundOrders.filter((order) => (
    order.status === 'posted'
    || order.status === 'partially_filled'
    || (state.runtime.executionMode === 'monitor' && order.status === 'local')
  ));
  const currentExposure = currentRoundExposure(viewState.fills, snapshot.round.id);
  const roundSettlement = viewState.settlements.find((settlement) => settlement.roundId === snapshot.round.id);
  const entryPriceDisplay = entryLimit == null ? fixedLimitLabel : entryLimit.toFixed(3);
  const entrySharesDisplay = previewShares == null ? fixedSharesLabel : formatShares(previewShares);
  const dynamicEntryPrice = viewState.profileState.dynamicEntryPrice;
  const tailEntryDetail = tailEntryCheck?.status === 'eligible'
    ? `${tailSelectedSideCondition?.actual || 'selected side'} @ ${tailEntryCheck.limitPrice == null ? 'strategy limit' : tailEntryCheck.limitPrice.toFixed(3)}`
    : tailEntryCheck?.conditions.filter((condition) => !condition.passed).slice(0, 2).map(blockerDetail).join(' / ')
      || tailEntryCheck?.reason
      || 'waiting for BTC 5m tail gate';
  const profileStatusRows = state.profiles.map((item) => {
    const itemEntryCheck = item.strategyChecks.find((check) => check.strategy === 'UPDOWN_DUAL_ENTRY');
    const itemTailEntryCheck = item.strategyChecks.find((check) => check.strategy === 'UPDOWN_TAIL_ENTRY');
    const itemHedgeCheck = item.strategyChecks.find((check) => check.strategy === 'UPDOWN_SINGLE_FILL_HEDGE');
    const itemProfitExitCheck = item.strategyChecks.find((check) => check.strategy === 'UPDOWN_SINGLE_FILL_PROFIT_EXIT');
    const itemCooldownActive = Boolean(item.entryCooldownUntil && new Date(item.entryCooldownUntil).getTime() > Date.now());
    return {
      item,
      entryCheck: itemEntryCheck,
      tailEntryCheck: itemTailEntryCheck,
      hedgeCheck: itemHedgeCheck,
      profitExitCheck: itemProfitExitCheck,
      cooldownActive: itemCooldownActive,
    };
  });
  const touchSimStatus = typeof touchSim?.status === 'object' ? touchSim.status : undefined;
  const touchSimStatusLabel = typeof touchSim?.status === 'string'
    ? touchSim.status
    : touchSimStatus?.websocketConnected
      ? 'recording'
      : touchSim?.ok
        ? 'waiting'
        : 'unavailable';
  const selectedTouchAsset = touchMatrixAssets.includes(simulationAssetTab)
    ? simulationAssetTab
    : touchMatrixAssets[0] || 'btc';
  const touchCompletedBySelectedAsset = touchCompletedByAssetPrice.filter((row) => (row.asset || 'unknown') === selectedTouchAsset);
  const touchRecentRounds = touchSim?.recentRounds ?? [];
  const touchCurrentRounds = touchRecentRounds.filter((round) => {
    if (round.finalized) return false;
    const startMs = new Date(round.startAt).getTime();
    const endMs = new Date(round.endAt).getTime();
    return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= nowMs && nowMs <= endMs;
  });
  const touchCommand = 'npm run research:pm5m-touch -- --assets btc,eth,sol,doge,xrp,hype --min-price 0.29 --max-price 0.49 --lookback-hours 12';
  const touchGeneratedAtMs = touchSim?.generatedAt ? new Date(touchSim.generatedAt).getTime() : 0;
  const touchGeneratedLabel = touchGeneratedAtMs ? formatRelativeAge(touchGeneratedAtMs, nowMs) : 'not generated';
  const touchLookbackHours = touchSim?.config?.lookbackHours;
  const touchLookbackLabel = touchLookbackHours && Number.isFinite(touchLookbackHours) ? `${touchLookbackHours}h` : 'all-time';
  const touchAllTimeRounds = touchSimStatus?.completedAllTimeRounds ?? touchSim?.completedAllTime?.rounds;
  const tailSimStatus = typeof tailSim?.status === 'object' ? tailSim.status : undefined;
  const tailSimStatusLabel = typeof tailSim?.status === 'string'
    ? tailSim.status
    : tailSimStatus?.websocketConnected
      ? 'recording'
      : tailSim?.ok
        ? 'waiting'
        : 'unavailable';
  const tailCheckpointRows = tailSim?.completed?.byCheckpoint ?? tailSim?.completed?.byCheckpointSize ?? [];
  const tailBandRows = tailSim?.completed?.byAskBand ?? [];
  const tailRecentRounds = tailSim?.recentRounds ?? [];
  const tailCommand = 'npm run research:pm5m-tail -- --assets btc --checkpoints 60,45,30,20,15,10,5 --size 5 --lookback-hours 12';
  const tailGeneratedAtMs = tailSim?.generatedAt ? new Date(tailSim.generatedAt).getTime() : 0;
  const tailGeneratedLabel = tailGeneratedAtMs ? formatRelativeAge(tailGeneratedAtMs, nowMs) : 'not generated';
  const tailLookbackHours = tailSim?.config?.lookbackHours;
  const tailLookbackLabel = tailLookbackHours && Number.isFinite(tailLookbackHours) ? `${tailLookbackHours}h` : 'all-time';
  const isResearchTab = activeTab === 'simulation';
  const pageTone = activeTab === 'terminal'
    ? scopedDecisionState.tone
    : activeTab === 'portfolio'
      ? (portfolioPnl + displayedUnrealizedPnl > 0 ? 'good' as const : portfolioPnl + displayedUnrealizedPnl < 0 ? 'bad' as const : 'neutral' as const)
      : activeTab === 'logs'
        ? (alertLogCount > 0 ? 'warn' as const : 'neutral' as const)
        : 'neutral' as const;
  const pageCopy: Record<TabType, { kicker: string; title: string; summary: string }> = {
    terminal: {
      kicker: 'Live Operations',
      title: isAllProfiles ? 'Profile health and routing overview' : `${scopeLabel} execution cockpit`,
      summary: isAllProfiles
        ? 'Use this view to identify which markets are live, cooled down, blocked, or ready before drilling into one profile.'
        : 'This is the primary action view: current round state, entry readiness, BTC 5m tail order state, open exposure, and hedge/profit-exit readiness.',
    },
    portfolio: {
      kicker: 'Account Risk',
      title: 'Collateral, positions, and PnL',
      summary: 'Use this view to separate available collateral from open exposure and realized performance for the selected scope.',
    },
    orderbooks: {
      kicker: 'Market Microstructure',
      title: 'Executable depth and live CLOB quality',
      summary: isAllProfiles
        ? 'Use this view to compare feed health and orderbook readiness across profiles before selecting a market.'
        : 'Use this view to inspect the active round books behind entry, tail, hedge, and exit decisions.',
    },
    activity: {
      kicker: 'Execution Audit',
      title: 'Orders, fills, and settlement outcomes',
      summary: 'Use this view after trades happen: daily PnL, per-round fill quality, failed orders, and submitted CLOB IDs.',
    },
    simulation: {
      kicker: 'Research Calibration',
      title: simulationResearchTab === 'tail' ? 'Tail Entry simulation results' : 'Touch-fill simulation results',
      summary: simulationResearchTab === 'tail'
        ? 'Use this view to choose BTC 5m tail live parameters from the most recent 12h simulation PnL.'
        : 'Use this view to calibrate pre-round entry price levels across 5m assets.',
    },
    strategy: {
      kicker: 'Configured Rules',
      title: 'Runtime strategy contract',
      summary: 'Use this view to read the exact entry/exit behaviors the bot is allowed to execute.',
    },
    logs: {
      kicker: 'Diagnostics',
      title: 'Runtime events and operator signals',
      summary: 'Use this view when something looks wrong: filter to execution, market-data, warnings, or raw worker output.',
    },
  };
  const activityViewCopy = activitySubTab === 'daily'
    ? { title: 'Daily execution rollup', summary: 'Best for answering whether the strategy is making money and whether single-fill risk is contained across a day.' }
    : activitySubTab === 'rounds'
      ? { title: 'Round-level fill quality', summary: 'Best for debugging a market lifecycle: submitted orders, filled shares, unfilled shares, and settlement result.' }
      : { title: 'Raw order ledger', summary: 'Best for checking individual CLOB order IDs, failed FAKs, prices, sizes, and strategy source. Use strategy filters to separate Dual, Tail, and Exit records without leaving the ledger.' };
  const simulationViewCopy = simulationResearchTab === 'touch'
    ? (simulationSubTab === 'price'
      ? { title: 'Price-level outcome rates', summary: 'Compare paired, single, no-fill, and EV/share by target entry price.' }
      : simulationSubTab === 'matrix'
        ? { title: 'Asset x price matrix', summary: 'Check whether a price level works broadly or only on specific 5m assets.' }
        : { title: 'Current round touch strip', summary: 'Watch active recorder observations without mixing them into live bot execution.' })
    : (tailSimulationSubTab === 'checkpoint'
      ? { title: 'Checkpoint x size PnL', summary: 'Primary live BTC 5m tail gate: use the best positive 12h PnL row, otherwise keep live tail stopped.' }
      : tailSimulationSubTab === 'bands'
        ? { title: 'Ask-band performance', summary: 'Check which live entry price bands historically retained enough EV after fill and win rates.' }
        : { title: 'Recent tail sample strip', summary: 'Inspect how recent markets were sampled at each checkpoint and what side/price would have been selected.' });

  return (
    <Shell>
      {/* Top Header Bar */}
      <section className="topbar">
        <div>
          <h1>
            <Cpu size={24} style={{ color: 'var(--color-primary)' }} />
            Poly Up/Down Terminal
          </h1>
        </div>
        
        {/* Navigation Tabs */}
        <nav className="tabBar">
	          <button className={`tabBtn ${activeTab === 'terminal' ? 'active' : ''}`} onClick={() => setActiveTab('terminal')}>
	            <Terminal size={14} /> Terminal
	          </button>
	          <button className={`tabBtn ${activeTab === 'portfolio' ? 'active' : ''}`} onClick={() => setActiveTab('portfolio')}>
	            <WalletCards size={14} /> Portfolio
	          </button>
	          <button className={`tabBtn ${activeTab === 'orderbooks' ? 'active' : ''}`} onClick={() => setActiveTab('orderbooks')}>
	            <BookOpen size={14} /> Order Books
	          </button>
          <button className={`tabBtn ${activeTab === 'activity' ? 'active' : ''}`} onClick={() => setActiveTab('activity')}>
            <History size={14} /> Activity & PnL
          </button>
          <button className={`tabBtn ${activeTab === 'simulation' ? 'active' : ''}`} onClick={() => setActiveTab('simulation')}>
            <BarChart3 size={14} /> Simulation
          </button>
          <button className={`tabBtn ${activeTab === 'strategy' ? 'active' : ''}`} onClick={() => setActiveTab('strategy')}>
            <Cpu size={14} /> Strategy Rules
          </button>
          <button className={`tabBtn ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>
            <Terminal size={14} /> Logs
          </button>
        </nav>

        <div className="actions">
          <button
            type="button"
            className="refreshControl"
            onClick={() => {
              void load();
              void loadTouchSim();
            }}
            disabled={refreshing}
            title="All dashboard panels refresh from /api/state on the same polling cycle."
            aria-label={`Refresh dashboard. ${refreshAriaStatus}. Last refresh ${lastRefreshLabel}.`}
          >
            <span className="refreshControlStatus">
              <RefreshCw size={13} className={(autoRefreshing || refreshing) ? 'spin' : ''} />
              <span>{refreshStatusLabel}</span>
              <strong>{lastRefreshLabel}</strong>
            </span>
            <span className="refreshControlAction">
              Refresh
            </span>
          </button>
        </div>
      </section>

      {!isResearchTab && (
        <>
          <section className="profileSwitcher" aria-label="Market profiles">
            <button type="button" className={`profilePill ${selectedProfileId === 'all' ? 'active' : ''}`} onClick={() => setSelectedProfileId('all')}>
              All
            </button>
            {state.profiles.map((item) => (
              <button
                key={item.profile.id}
                type="button"
                className={`profilePill ${selectedProfileId === item.profile.id ? 'active' : ''}`}
                onClick={() => setSelectedProfileId(item.profile.id)}
              >
                <AssetLabel profileId={item.profile.id} label={item.profile.label} />
                <em>{item.profile.status}</em>
              </button>
            ))}
          </section>

          <section className="scopeSummary" aria-label="Current data scope">
            <div>
              <span className="sectionKicker">Data Scope</span>
              <strong>{scopeLabel}</strong>
            </div>
            <div className="scopeSummaryStats">
              <span>{viewState.orders.length} orders</span>
              <span>{viewState.fills.length} fills</span>
              <span>{viewState.settlements.length} settlements</span>
              <span>{filteredLogs.length} logs</span>
              {isAllProfiles ? <span>{enabledProfileCount} enabled profiles</span> : <span>{viewState.profileState.profile.status}</span>}
            </div>
          </section>

          <section className={`terminalCommandBar ${scopedDecisionState.tone}`} aria-label="Current terminal state">
            <div className="terminalCommandPrimary">
              <div className="terminalCommandIcon">
                {scopedDecisionState.tone === 'good' ? <CheckCircle2 size={20} /> : <AlertTriangle size={20} />}
              </div>
              <div>
                <span className="decisionKicker">{scopeLabel}</span>
                <strong>{scopedDecisionState.label}</strong>
                <p>{scopedDecisionState.detail}</p>
              </div>
            </div>
            <div className="terminalCommandStats">
              <div className="terminalStat">
                <span>{isAllProfiles ? 'Profiles' : 'Round'}</span>
                <strong>{isAllProfiles ? `${enabledProfileCount}/${state.profiles.length}` : snapshot.round.phase.toUpperCase()}</strong>
                <em>{isAllProfiles ? `${liveProfileCount} live / ${state.profiles.length - enabledProfileCount} disabled` : roundPhaseDetail}</em>
              </div>
              <div className="terminalStat">
                <span>Execution</span>
                <strong>{executionLabel}</strong>
                <em>{state.runtime.status.toUpperCase()} / {runtimeBuildLabel(state.runtime)}</em>
              </div>
              <div className="terminalStat">
                <span>{isAllProfiles ? 'Orders' : 'Risk Gate'}</span>
                <strong>{isAllProfiles ? String(viewState.orders.length) : entryCooldownActive ? 'COOLDOWN' : cooldownGateLabel}</strong>
                <em>{isAllProfiles ? `${Math.max(...profileOrderCounts, 0)} max per profile` : cooldownDetail}</em>
              </div>
              <div className="terminalStat">
                <span>Entry Plan</span>
                <strong>FIXED {entryPriceDisplay}</strong>
                <em>{fixedSharesLabel} shares per side</em>
              </div>
              <div className="terminalStat">
                <span>Feeds</span>
                <strong>{isAllProfiles ? `${state.profiles.filter((item) => item.feed.clobConnected).length}/${state.profiles.length} CLOB` : feedLabel}</strong>
                <em>{isAllProfiles ? `${state.profiles.filter((item) => item.feed.binanceConnected).length}/${state.profiles.length} Binance` : `Binance ${viewState.feed.binanceConnected ? 'on' : 'off'}`}</em>
              </div>
              <div className={`terminalStat pnl ${portfolioPnl > 0 ? 'good' : portfolioPnl < 0 ? 'bad' : 'neutral'}`}>
                <span>Portfolio</span>
                <strong>{formatSignedMoney(portfolioPnl)}</strong>
                <em>{portfolio ? `${portfolio.positionCount} positions / ${portfolioStatusLabel(portfolio.status)}` : `${activeOrders} open / ${viewState.settlements.length} settled`}</em>
              </div>
            </div>
          </section>
        </>
      )}

      {/* Main Tabbed Area */}
      <main>
        <PageIntro
          kicker={pageCopy[activeTab].kicker}
          title={pageCopy[activeTab].title}
          summary={pageCopy[activeTab].summary}
          tone={pageTone}
          meta={(
            <>
              <Badge tone={state.runtime.executionMode === 'live' ? 'warn' : 'neutral'}>{executionLabel}</Badge>
              <Badge tone={state.runtime.status === 'running' ? 'good' : 'bad'}>{state.runtime.status}</Badge>
              <Badge tone="neutral">{scopeLabel}</Badge>
            </>
          )}
        >
          {activeTab === 'terminal' && (
            <>
              <DecisionMetric label="Primary state" value={scopedDecisionState.label} detail={scopedDecisionState.detail} tone={scopedDecisionState.tone} />
              <DecisionMetric label="Tail Entry" value={strategyCheckLabel(tailEntryCheck).toUpperCase()} detail={tailEntryDetail} tone={strategyCheckTone(tailEntryCheck)} />
              <DecisionMetric label="Current orders" value={String(currentRoundOpenOrders.length)} detail={`${currentRoundOrders.length} current-round records`} tone={currentRoundOpenOrders.length ? 'warn' : 'neutral'} />
              <DecisionMetric label="Portfolio PnL" value={formatSignedMoney(portfolioPnl)} detail={`${displayedPositions.length} open positions`} tone={portfolioPnl > 0 ? 'good' : portfolioPnl < 0 ? 'bad' : 'neutral'} />
            </>
          )}
          {activeTab === 'portfolio' && (
            <>
              <DecisionMetric label="Collateral" value={portfolio?.collateralBalance == null ? 'n/a' : formatMoney(portfolio.collateralBalance)} detail={portfolioStatusLabel(portfolio?.status || 'disabled')} tone={portfolio?.collateralBalance == null ? 'neutral' : 'good'} />
              <DecisionMetric label="Open value" value={formatMoney(displayedPositionValue)} detail={`${displayedPositions.length} positions`} tone={displayedPositionValue > 0 ? 'good' : 'neutral'} />
              <DecisionMetric label="Unrealized" value={formatSignedMoney(displayedUnrealizedPnl)} detail="marked from current prices" tone={displayedUnrealizedPnl > 0 ? 'good' : displayedUnrealizedPnl < 0 ? 'bad' : 'neutral'} />
              <DecisionMetric label="Total PnL" value={formatSignedMoney(portfolioPnl + displayedUnrealizedPnl)} detail={`ROI ${formatPercentValue(displayedRoiPct)}`} tone={portfolioPnl + displayedUnrealizedPnl > 0 ? 'good' : portfolioPnl + displayedUnrealizedPnl < 0 ? 'bad' : 'neutral'} />
            </>
          )}
          {activeTab === 'orderbooks' && (
            <>
              <DecisionMetric label="CLOB feed" value={isAllProfiles ? `${state.profiles.filter((item) => item.feed.clobConnected).length}/${state.profiles.length}` : (viewState.feed.clobConnected ? 'ON' : 'OFF')} detail={isAllProfiles ? 'profiles connected' : `updated ${viewState.feed.lastOrderbookAt ? formatRelativeAge(new Date(viewState.feed.lastOrderbookAt).getTime(), nowMs) : 'n/a'}`} tone={viewState.feed.clobConnected ? 'good' : 'bad'} />
              <DecisionMetric label="Orderbooks" value={String(isAllProfiles ? state.profiles.reduce((sum, item) => sum + (item.latestSnapshot?.orderbooks.length || 0), 0) : snapshot.orderbooks.length)} detail="live quotes loaded" tone={snapshot.orderbooks.length ? 'good' : 'warn'} />
              <DecisionMetric label="Depth model" value={snapshot.orderbookDepth ? 'READY' : 'EMPTY'} detail={snapshot.orderbookDepth ? `${snapshot.orderbookDepth.levels.length} price levels` : 'waiting for snapshot'} tone={snapshot.orderbookDepth ? 'good' : 'warn'} />
              <DecisionMetric label="Round" value={snapshot.round.phase.toUpperCase()} detail={roundPhaseDetail} tone={isRoundStarted ? 'warn' : 'neutral'} />
            </>
          )}
          {activeTab === 'activity' && (
            <>
              <DecisionMetric label="View" value={activityViewCopy.title} detail={activityViewCopy.summary} tone="neutral" />
              <DecisionMetric label="Orders" value={String(viewState.orders.length)} detail={`${viewState.fills.length} fills`} tone={viewState.orders.length ? 'good' : 'neutral'} />
              <DecisionMetric label="Settlements" value={String(viewState.settlements.length)} detail={formatSignedMoney(portfolioPnl)} tone={portfolioPnl > 0 ? 'good' : portfolioPnl < 0 ? 'bad' : 'neutral'} />
              <DecisionMetric label="Alerts" value={String(alertLogCount)} detail={`${signalLogCount} signal logs`} tone={alertLogCount ? 'warn' : 'good'} />
            </>
          )}
          {activeTab === 'simulation' && (
            <>
              <DecisionMetric label="Recorder" value={simulationResearchTab === 'tail' ? tailSimStatusLabel.toUpperCase() : touchSimStatusLabel.toUpperCase()} detail={simulationResearchTab === 'tail' ? `updated ${tailGeneratedLabel}` : `updated ${touchGeneratedLabel}`} tone={(simulationResearchTab === 'tail' ? tailSim?.ok : touchSim?.ok) ? 'good' : 'warn'} />
              <DecisionMetric label="Current view" value={simulationViewCopy.title} detail={simulationViewCopy.summary} tone="neutral" />
              <DecisionMetric label="Window rows" value={String(simulationResearchTab === 'tail' ? tailSimStatus?.completedRows ?? tailSim?.completed?.rows ?? 0 : touchSimStatus?.completedRounds ?? touchSim?.completed?.rounds ?? 0)} detail={simulationResearchTab === 'tail' ? tailLookbackLabel : touchLookbackLabel} tone="neutral" />
              <DecisionMetric label="Live use" value={simulationResearchTab === 'tail' ? 'TAIL PARAMS' : 'ENTRY PRICE'} detail={simulationResearchTab === 'tail' ? 'checkpoint + min strength price' : 'price routing reference'} tone="warn" />
            </>
          )}
          {activeTab === 'strategy' && (
            <>
              <DecisionMetric label="Loaded rules" value={String(state.rules.length)} detail="runtime strategy contracts" tone={state.rules.length ? 'good' : 'warn'} />
              <DecisionMetric label="Classic entry" value={strategyCheckLabel(entryCheck).toUpperCase()} detail={entryActionDetail} tone={strategyCheckTone(entryCheck)} />
              <DecisionMetric label="Tail Entry" value={strategyCheckLabel(tailEntryCheck).toUpperCase()} detail={tailEntryDetail} tone={strategyCheckTone(tailEntryCheck)} />
              <DecisionMetric label="Execution mode" value={executionLabel} detail={runtimeBuildLabel(state.runtime)} tone={state.runtime.executionMode === 'live' ? 'warn' : 'neutral'} />
            </>
          )}
          {activeTab === 'logs' && (
            <>
              <DecisionMetric label="Filtered logs" value={String(filteredLogs.length)} detail={`${state.runtimeLogs.length} total records`} tone={filteredLogs.length ? 'neutral' : 'warn'} />
              <DecisionMetric label="Alerts" value={String(alertLogCount)} detail="warn + error" tone={alertLogCount ? 'warn' : 'good'} />
              <DecisionMetric label="Signals" value={String(signalLogCount)} detail={hideRoutineLogs ? 'routine hidden' : 'raw view'} tone="neutral" />
              <DecisionMetric label="Filter" value={logLevel.toUpperCase()} detail={`${logSource} / ${logSearch ? 'search active' : 'no search'}`} tone="neutral" />
            </>
          )}
        </PageIntro>

        {activeTab === 'terminal' && (isAllProfiles ? (
          <AllProfilesOverview
            state={state}
            enabledProfileCount={enabledProfileCount}
            liveProfileCount={liveProfileCount}
            executionLabel={executionLabel}
            orderCount={viewState.orders.length}
            fillCount={viewState.fills.length}
            settlementCount={viewState.settlements.length}
            displayedPositionCount={displayedPositions.length}
            portfolioPnl={portfolioPnl}
            profileStatusRows={profileStatusRows}
            onSelectProfile={setSelectedProfileId}
          />
        ) : (
          <div className="opsWorkspace">
            <section className="opsPrimary">
              <div className={`opsHero ${decisionState.tone}`}>
                <div className="opsHeroMain">
                  <span className="decisionKicker">
                    <AssetLabel profileId={viewState.profileState.profile.id} label={`${viewState.profileState.profile.label} Runtime`} />
                  </span>
                  <h2>{decisionState.label}</h2>
                  <p>{decisionState.detail}</p>
                </div>
                <div className="opsHeroMeta">
                  <Badge tone={entryStatusTone}>{entryStatusLabel}</Badge>
                  <Badge tone={state.runtime.executionMode === 'live' ? 'warn' : 'neutral'}>{executionLabel}</Badge>
                </div>
              </div>

              <div className="opsMetricGrid">
                <DecisionMetric
                  label="Entry"
                  value={entryCheck?.status === 'eligible' ? 'READY' : entryCooldownActive ? 'COOLDOWN' : isRoundStarted ? 'CLOSED' : 'WAITING'}
                  detail={`BUY UP + DOWN @ ${entryPriceDisplay}, ${entrySharesDisplay} shares/side`}
                  tone={entryCheck?.status === 'eligible' ? 'good' : entryCooldownActive ? 'warn' : isRoundStarted ? 'neutral' : 'warn'}
                />
                <DecisionMetric
                  label="Open Orders"
                  value={String(currentRoundOpenOrders.length)}
                  detail={`${currentRoundOrders.length} recorded in this round`}
                  tone={currentRoundOpenOrders.length ? 'warn' : 'neutral'}
                />
                <DecisionMetric
                  label="Tail Entry"
                  value={strategyCheckLabel(tailEntryCheck).toUpperCase()}
                  detail={tailEntryDetail}
                  tone={strategyCheckTone(tailEntryCheck)}
                />
                <DecisionMetric
                  label="Filled Exposure"
                  value={currentExposure.label.toUpperCase()}
                  detail={`UP ${formatShares(currentExposure.yes)} / DOWN ${formatShares(currentExposure.no)} / ${currentExposure.fills} fills`}
                  tone={currentExposure.tone}
                />
                <DecisionMetric
                  label="Profit Exit"
                  value={strategyCheckLabel(profitExitCheck).toUpperCase()}
                  detail={profitExitCheck?.reason || 'waiting for a single-fill opportunity'}
                  tone={strategyCheckTone(profitExitCheck)}
                />
                <DecisionMetric
                  label="Hedge"
                  value={strategyCheckLabel(hedgeCheck).toUpperCase()}
                  detail={hedgeCheck?.reason || 'waiting for hedge window'}
                  tone={strategyCheckTone(hedgeCheck)}
                />
                <DecisionMetric
                  label="Cooldown"
                  value={entryCooldownActive ? entryCooldownRemaining : 'CLEAR'}
                  detail={entryCooldownReason}
                  tone={entryCooldownActive ? 'warn' : 'good'}
                />
                <DynamicEntryPricePanel selection={dynamicEntryPrice} configuredPrice={entryLimit ?? entryConfig?.dualLimitPrice} />
              </div>

              <div className="panel opsPanel">
                <h2>
                  Current Round
                  <span className="panelSubTitle">{snapshot.round.id}</span>
                </h2>
                <div className="opsRoundGrid">
                  <div className="opsRoundTimeline">
                    <RoundTimelinePipeline
                      phase={snapshot.round.phase}
                      timelineDetail={timelineDetail}
                      progressPct={progressPct}
                      progressColorClass={progressColorClass}
                    />
                  </div>
                  <div className="opsRoundFacts">
                    <div>
                      <span>{strikeLabel}</span>
                      <strong>{formatMoney(snapshot.round.strike)}</strong>
                    </div>
                    <div>
                      <span>Start</span>
                      <strong>{formatEtTime(snapshot.round.startAt)}</strong>
                    </div>
                    <div>
                      <span>End</span>
                      <strong>{formatEtTime(snapshot.round.endAt)}</strong>
                    </div>
                    <div>
                      <span>Settlement</span>
                      <strong>{roundSettlement ? `${roundSettlement.status} ${formatSignedMoney(roundSettlement.pnl)}` : 'pending'}</strong>
                    </div>
                  </div>
                </div>
              </div>

              <TailEntryPanel
                tailEntryCheck={tailEntryCheck}
                checkpointCondition={tailCheckpointCondition}
                selectedSummaryRowCondition={tailSelectedSummaryRowCondition}
                selectedSideCondition={tailSelectedSideCondition}
                summaryPnlCondition={tailSummaryPnlCondition}
                summaryEvCondition={tailSummaryEvCondition}
                summaryMinVwapCondition={tailSummaryMinVwapCondition}
                vwapCondition={tailVwapCondition}
                vwapFloorCondition={tailVwapFloorCondition}
                midpointGapCondition={tailMidpointGapCondition}
                roundOrderLimitCondition={tailRoundOrderLimitCondition}
                currentRoundTailOrders={currentRoundTailOrders}
              />

              <div className="panel opsPanel">
                <h2>
                  Active Positions
                  <span className="panelSubTitle">{snapshot.positions.length ? `${snapshot.positions.length} positions` : 'none'}</span>
                </h2>
                {snapshot.positions.length ? (
                  <div className="opsPositionGrid">
                    {snapshot.positions.map((position) => {
                      const value = positionValue(position);
                      const pnlValue = positionPnl(position);
                      return (
                        <div key={position.tokenId} className="opsPosition">
                          <div>
                            <strong>{outcomeLabel(position.label)}</strong>
                            <span>{shortenTokenId(position.tokenId)}</span>
                          </div>
                          <div>
                            <span>{formatNumber(position.shares, 2)} @ {position.avgPrice.toFixed(3)}</span>
                            <strong className={pnlValue >= 0 ? 'pass' : 'fail'}>{formatSignedMoney(pnlValue)}</strong>
                          </div>
                          <em>{formatMoney(value)} value</em>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="opsEmptyState">No active positions for the selected profile.</div>
                )}
              </div>
            </section>

            <ProfileRail
              profileStatusRows={profileStatusRows}
              selectedProfileId={selectedProfileId}
              feedLabel={feedLabel}
              feed={viewState.feed}
              runtimeStatus={state.runtime.status}
              alertLogCount={alertLogCount}
              signalLogCount={signalLogCount}
              portfolioPnl={portfolioPnl}
              diagnostics={snapshot.diagnostics}
              onSelectProfile={setSelectedProfileId}
            />
          </div>
        ))}

        {activeTab === 'portfolio' && (
          <PortfolioTab
            portfolio={portfolio}
            portfolioAvatarUrl={portfolioAvatarUrl}
            portfolioInitial={portfolioInitial}
            portfolioProfileName={portfolioProfileName}
            portfolioProfileHandle={portfolioProfileHandle}
            displayedPositions={displayedPositions}
            displayedPositionValue={displayedPositionValue}
            displayedPositionCost={displayedPositionCost}
            displayedUnrealizedPnl={displayedUnrealizedPnl}
            displayedRoiPct={displayedRoiPct}
            portfolioPnl={portfolioPnl}
            isAllProfiles={isAllProfiles}
            scopeLabel={scopeLabel}
            settlementCount={viewState.settlements.length}
          />
        )}

        {activeTab === 'orderbooks' && (
          <OrderbooksTab
            state={state}
            snapshot={snapshot}
            isAllProfiles={isAllProfiles}
            scopeLabel={scopeLabel}
            onSelectProfile={setSelectedProfileId}
          />
        )}

        {activeTab === 'activity' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="panel">
              <div className="sectionHeader">
                <div>
                  <span className="sectionKicker">{scopeLabel}</span>
                  <h2>Execution Review</h2>
                </div>
                <span className="panelSubTitle">{roundSummaries.length} rounds / {viewState.orders.length} orders</span>
              </div>

              <div className="listScopeBar">
                <span>{isAllProfiles ? 'Aggregated across enabled and disabled profiles' : `Filtered to ${scopeLabel}`}</span>
                <strong>{viewState.fills.length} fills</strong>
                <strong>{viewState.settlements.length} settlements</strong>
              </div>

              {stats && (
                <section className={`executionStatsPanel ${stats.singleRate != null && stats.singleRate > stats.targetRate ? 'warn' : 'good'}`} aria-label="Last 24 hours execution statistics">
                  <div className="executionStatsHeader">
                    <div>
                      <span className="sectionKicker">Last 24 hours</span>
                      <h3>Paired vs Single Fill Rate</h3>
                      <p>
                        {formatEtRange(stats.windowStart, STATS_WINDOW_MS)}
                        <span className="mutedInline"> refreshed from live state</span>
                      </p>
                    </div>
                    <div className="singleRateTarget">
                      <Target size={16} />
                      <span>single target</span>
                      <strong>&lt; {(stats.targetRate * 100).toFixed(0)}%</strong>
                    </div>
                  </div>

                  <div className="executionStatsGrid">
                    <DecisionMetric
                      label="Settled rounds"
                      value={String(stats.settlements)}
                      detail={`${stats.orderRounds} order rounds / ${stats.orders} orders`}
                      tone={stats.settlements > 0 ? 'neutral' : 'warn'}
                    />
                    <DecisionMetric
                      label="Paired rate"
                      value={stats.pairedRate == null ? 'n/a' : `${(stats.pairedRate * 100).toFixed(1)}%`}
                      detail={`${stats.paired} paired / ${formatSignedMoney(stats.pairedPnl)}`}
                      tone={stats.paired > 0 ? 'good' : 'neutral'}
                    />
                    <DecisionMetric
                      label="Single rate"
                      value={stats.singleRate == null ? 'n/a' : `${(stats.singleRate * 100).toFixed(1)}%`}
                      detail={stats.singleRateDelta == null ? '< 18% target' : `${stats.singleRateDelta >= 0 ? '+' : ''}${(stats.singleRateDelta * 100).toFixed(1)} pts vs target`}
                      tone={stats.singleRate == null ? 'neutral' : stats.singleRate <= stats.targetRate ? 'good' : 'bad'}
                    />
                    <DecisionMetric
                      label="Single PnL"
                      value={formatSignedMoney(stats.singlePnl)}
                      detail={`${stats.singleWins} won / ${stats.singleLosses} lost`}
                      tone={stats.singlePnl >= 0 ? 'good' : 'bad'}
                    />
                    <DecisionMetric
                      label="Total PnL"
                      value={formatSignedMoney(stats.totalPnl)}
                      detail={`${stats.fills} fills / ${stats.none} no-fill settled`}
                      tone={stats.totalPnl > 0 ? 'good' : stats.totalPnl < 0 ? 'bad' : 'neutral'}
                    />
                  </div>

                  <div className="singleRateMeter" aria-label="Single fill rate threshold meter">
                    <div className="singleRateMeterTrack">
                      <span className="singleRateTargetLine" style={{ left: `${stats.targetRate * 100}%` }} />
                      <span
                        className={`singleRateActual ${stats.singleRate != null && stats.singleRate <= stats.targetRate ? 'good' : 'bad'}`}
                        style={{ width: `${Math.min(100, Math.max(0, (stats.singleRate ?? 0) * 100))}%` }}
                      />
                    </div>
                    <div className="singleRateMeterLabels">
                      <span>0%</span>
                      <strong>target {(stats.targetRate * 100).toFixed(0)}%</strong>
                      <span>{stats.singleRate == null ? 'actual n/a' : `actual ${(stats.singleRate * 100).toFixed(1)}%`}</span>
                    </div>
                  </div>
                </section>
              )}

              <div className="subTabBar">
                <button
                  type="button"
                  className={`subTabBtn ${activitySubTab === 'daily' ? 'active' : ''}`}
                  onClick={() => setActivitySubTab('daily')}
                >
                  Daily
                  <span>{dailySummaries.length}</span>
                </button>
                <button
                  type="button"
                  className={`subTabBtn ${activitySubTab === 'rounds' ? 'active' : ''}`}
                  onClick={() => setActivitySubTab('rounds')}
                >
                  Round Summary
                  <span>{roundSummaries.length}</span>
                </button>
                <button
                  type="button"
                  className={`subTabBtn ${activitySubTab === 'orders' ? 'active' : ''}`}
                  onClick={() => setActivitySubTab('orders')}
                >
                  Orders
                  <span>{viewState.orders.length}</span>
                </button>
              </div>

              <ViewHeader
                kicker="Selected view"
                title={activityViewCopy.title}
                summary={activityViewCopy.summary}
                meta={<span>{activitySubTab}</span>}
              />

              {activitySubTab === 'daily' && (
                dailySummaries.length > 0 ? (
                  <>
                    <div className="dailyArchive">
                      {dailyPagination.pageRows.map((day) => (
                        <section key={day.dateKey} className="dailyGroup">
                          <div className="dailyGroupHeader">
                            <div>
                              <h3>{day.dateLabel}</h3>
                              <p>
                                {day.roundCount} recorded rounds / {day.orderCount} orders
                                <span className="mutedInline"> {day.buyOrderCount} buy / {day.sellOrderCount} sell</span>
                              </p>
                            </div>
                            <div className="dailyStats">
                              <span><strong>{day.pairedRounds}</strong> paired</span>
                              <span><strong>{day.singleRounds}</strong> single</span>
                              <span><strong>{day.unfilledOrders}</strong> unfilled</span>
                              <span><strong>{day.settledRounds}</strong> settled</span>
                              <span className={day.settlementPnl >= 0 ? 'pass' : 'fail'}>
                                {day.settlementPnl >= 0 ? '+' : ''}{formatMoney(day.settlementPnl)}
                              </span>
                            </div>
                          </div>

                          <DataTable
                            headers={isAllProfiles
                              ? ['Profile', 'Time (ET)', 'Age', 'Market', 'Strategy', 'Round Status', 'Orders', 'Submitted Buy Orders', 'Filled Buy Shares', 'Unfilled', 'Settlement PnL']
                              : ['Time (ET)', 'Age', 'Market', 'Strategy', 'Round Status', 'Orders', 'Submitted Buy Orders', 'Filled Buy Shares', 'Unfilled', 'Settlement PnL']}
                            className={`executionTable dailyExecutionTable ${isAllProfiles ? 'withProfile' : ''}`}
                          >
                            {day.rounds.map((round) => {
                              const hasUnfilled = round.unfilledOrders > 0;
                              const fillState = roundFillState(round);
                              const status = roundStatusSummary(round);
                              return (
                                <tr key={round.key}>
                                  {isAllProfiles && <td><Badge tone="neutral"><AssetLabel profileId={round.profileId} label={round.profileLabel} /></Badge></td>}
                                  <td className="mono timeCell">{round.timeLabel}</td>
                                  <td className="ageCell"><span>{formatRelativeAge(round.startTime)}</span></td>
                                  <td>
                                    <div className="marketCell">
                                      {round.imageUrl ? (
                                        <img src={round.imageUrl} alt="" className="marketThumb" />
                                      ) : (
                                        <AssetIcon profileId={round.profileId} size="md" />
                                      )}
                                      <span className="marketTitle">{round.title}</span>
                                    </div>
                                  </td>
                                  <td>
                                    <Badge tone={strategySourceToneForStrategy(round.strategy)}>{strategySourceLabelForStrategy(round.strategy)}</Badge>
                                  </td>
                                  <td>
                                    <Badge tone={status.tone}>{status.label}</Badge>
                                    <span className="mutedBlock">{status.detail}</span>
                                  </td>
                                  <td className="orderCountCell">
                                    <span className="mono">{round.orderCount}</span>
                                    <span className="mutedInline"> {round.buyOrderCount} buy / {round.sellOrderCount} sell</span>
                                  </td>
                                  <td className="mono" style={{ whiteSpace: 'normal' }}>
                                    {formatSubmittedLeg('UP', round.orderedYes, round.orderedYesPrice)}
                                    <br />
                                    {formatSubmittedLeg('DOWN', round.orderedNo, round.orderedNoPrice)}
                                  </td>
                                  <td className="mono">
                                    UP {formatShares(round.filledBuyYes)} / DOWN {formatShares(round.filledBuyNo)}
                                    {' '}
                                    <Badge tone={fillState.tone}>{fillState.label}</Badge>
                                  </td>
                                  <td>
                                    <Badge tone={hasUnfilled ? 'warn' : 'good'}>
                                      {hasUnfilled ? `${round.unfilledOrders} orders / ${formatShares(round.unfilledShares)} shares` : 'none'}
                                    </Badge>
                                  </td>
                                  <td className={`mono ${round.settlementPnl == null ? '' : round.settlementPnl >= 0 ? 'pass' : 'fail'}`}>
                                    {round.settlementPnl == null ? '-' : `${round.settlementPnl >= 0 ? '+' : ''}${formatMoney(round.settlementPnl)}`}
                                    {round.settlementStatus && <span className="mutedInline"> {round.settlementStatus}</span>}
                                  </td>
                                </tr>
                              );
                            })}
                          </DataTable>
                        </section>
                      ))}
                    </div>
                    <PaginationControls
                      page={dailyPagination.page}
                      totalPages={dailyPagination.totalPages}
                      totalRows={dailySummaries.length}
                      pageSize={DAILY_PAGE_SIZE}
                      onPageChange={dailyPagination.setPage}
                    />
                  </>
                ) : (
                  <div className="empty" style={{ minHeight: '150px' }}>
                    <p className="emptyText">No daily execution records found</p>
                  </div>
                )
              )}

              {activitySubTab === 'rounds' && (
                roundSummaries.length > 0 ? (
                  <>
                    <DataTable
                      headers={isAllProfiles
                        ? ['Profile', 'Age', 'Market', 'Strategy', 'Round ID', 'Round Status', 'Orders', 'Submitted Buy Orders', 'Filled Buy Shares', 'Filled Sell Shares', 'Unfilled', 'Settlement PnL']
                        : ['Age', 'Market', 'Strategy', 'Round ID', 'Round Status', 'Orders', 'Submitted Buy Orders', 'Filled Buy Shares', 'Filled Sell Shares', 'Unfilled', 'Settlement PnL']}
                      className={`executionTable roundExecutionTable ${isAllProfiles ? 'withProfile' : ''}`}
                    >
                      {roundPagination.pageRows.map((round) => {
                        const hasUnfilled = round.unfilledOrders > 0;
                        const fillState = roundFillState(round);
                        const status = roundStatusSummary(round);
                        return (
                          <tr key={round.key}>
                            {isAllProfiles && <td><Badge tone="neutral"><AssetLabel profileId={round.profileId} label={round.profileLabel} /></Badge></td>}
                            <td className="ageCell"><span>{formatRelativeAge(round.startTime)}</span></td>
                            <td>
                              <div className="marketCell">
                                {round.imageUrl ? (
                                  <img src={round.imageUrl} alt="" className="marketThumb" />
                                ) : (
                                  <AssetIcon profileId={round.profileId} size="md" />
                                )}
                                <span className="marketTitle">{round.title}</span>
                              </div>
                            </td>
                            <td>
                              <Badge tone={strategySourceToneForStrategy(round.strategy)}>{strategySourceLabelForStrategy(round.strategy)}</Badge>
                            </td>
                            <td className="mono" style={{ fontSize: '11px' }}>{round.roundId}</td>
                            <td>
                              <Badge tone={status.tone}>{status.label}</Badge>
                              <span className="mutedBlock">{status.detail}</span>
                            </td>
                            <td className="orderCountCell">
                              <span className="mono">{round.orderCount}</span>
                              <span className="mutedInline"> {round.buyOrderCount} buy / {round.sellOrderCount} sell</span>
                            </td>
                            <td className="mono" style={{ whiteSpace: 'normal' }}>
                              {formatSubmittedLeg('UP', round.orderedYes, round.orderedYesPrice)}
                              <br />
                              {formatSubmittedLeg('DOWN', round.orderedNo, round.orderedNoPrice)}
                            </td>
                            <td className="mono">
                              UP {formatShares(round.filledBuyYes)} / DOWN {formatShares(round.filledBuyNo)}
                              {' '}
                              <Badge tone={fillState.tone}>{fillState.label}</Badge>
                            </td>
                            <td className="mono">
                              UP {formatShares(round.filledSellYes)} / DOWN {formatShares(round.filledSellNo)}
                            </td>
                            <td>
                              <Badge tone={hasUnfilled ? 'warn' : 'good'}>
                                {hasUnfilled ? `${round.unfilledOrders} orders / ${formatShares(round.unfilledShares)} shares` : 'none'}
                              </Badge>
                            </td>
                            <td className={`mono ${round.settlementPnl == null ? '' : round.settlementPnl >= 0 ? 'pass' : 'fail'}`}>
                              {round.settlementPnl == null ? '-' : `${round.settlementPnl >= 0 ? '+' : ''}${formatMoney(round.settlementPnl)}`}
                              {round.settlementStatus && <span className="mutedInline"> {round.settlementStatus}</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </DataTable>
                    <PaginationControls
                      page={roundPagination.page}
                      totalPages={roundPagination.totalPages}
                      totalRows={roundSummaries.length}
                      pageSize={ROUND_PAGE_SIZE}
                      onPageChange={roundPagination.setPage}
                    />
                  </>
                ) : (
                  <div className="empty" style={{ minHeight: '150px' }}>
                    <p className="emptyText">No round execution records found</p>
                  </div>
                )
              )}

              {activitySubTab === 'orders' && (
                viewState.orders.length > 0 ? (
                  <>
                    <div className="subTabBar strategyFilterBar" aria-label="Order strategy filter">
                      {ORDER_STRATEGY_FILTERS.map((filter) => (
                        <button
                          key={filter}
                          type="button"
                          className={`subTabBtn ${orderStrategyFilter === filter ? 'active' : ''}`}
                          onClick={() => setOrderStrategyFilter(filter)}
                        >
                          {orderStrategyFilterLabel(filter)}
                          <span>{orderStrategyCounts[filter]}</span>
                        </button>
                      ))}
                    </div>
                    {filteredOrders.length > 0 ? (
                      <>
                        <DataTable headers={isAllProfiles
                          ? ['Profile', 'Time (ET)', 'Strategy', 'Market', 'Round ID', 'Outcome', 'Side', 'Price', 'Size', 'Status', 'Reason', 'Polymarket CLOB Order ID']
                          : ['Time (ET)', 'Strategy', 'Market', 'Round ID', 'Outcome', 'Side', 'Price', 'Size', 'Status', 'Reason', 'Polymarket CLOB Order ID']}>
                          {ordersPagination.pageRows.map((order) => (
                            <tr key={order.id}>
                              {isAllProfiles && <td><Badge tone="neutral"><AssetLabel profileId={order.profileId} label={profileLabelFor(state.profiles, order.profileId)} /></Badge></td>}
                              <td className="mono">{formatEtTime(order.createdAt)}</td>
                              <td title={order.strategy || 'UPDOWN_DUAL_ENTRY'}>
                                <Badge tone={strategySourceTone(order)}>{strategySourceLabel(order)}</Badge>
                              </td>
                              <td>
                                <div className="marketCell compact">
                                  <AssetIcon profileId={order.profileId} size="sm" />
                                  <span className="marketTitle">{orderMarketTitle(order)}</span>
                                </div>
                              </td>
                              <td className="mono" style={{ fontSize: '11px' }}>{order.roundId}</td>
                              <td><Badge tone={outcomeTone(order.label)}>{outcomeLabel(order.label)}</Badge></td>
                              <td>
                                <strong style={{ color: order.side === 'BUY' ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                  {order.side}
                                </strong>
                              </td>
                              <td className="mono">${order.price.toFixed(3)}</td>
                              <td className="mono">{order.size.toFixed(1)}</td>
                              <td>
                                <Badge tone={order.status === 'failed' ? 'bad' : order.status === 'filled' ? 'good' : order.status === 'posted' ? 'warn' : 'neutral'}>
                                  {order.status}
                                </Badge>
                              </td>
                              <td className="mono" style={{ fontSize: '11px', maxWidth: '260px', whiteSpace: 'normal' }}>
                                {orderFailureReason(order)}
                              </td>
                              <td className="mono" style={{ fontSize: '11px' }} title={order.clobOrderId || ''}>
                                {order.clobOrderId ? shortenTokenId(order.clobOrderId) : '-'}
                              </td>
                            </tr>
                          ))}
                        </DataTable>
                        <PaginationControls
                          page={ordersPagination.page}
                          totalPages={ordersPagination.totalPages}
                          totalRows={filteredOrders.length}
                          pageSize={ORDER_PAGE_SIZE}
                          onPageChange={ordersPagination.setPage}
                        />
                      </>
                    ) : (
                      <div className="empty" style={{ minHeight: '150px' }}>
                        <p className="emptyText">No {orderStrategyFilterLabel(orderStrategyFilter).toLowerCase()} orders match this scope</p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="empty" style={{ minHeight: '150px' }}>
                    <p className="emptyText">No orders placed by the bot yet</p>
                  </div>
                )
              )}
            </div>

          </div>
        )}

        {activeTab === 'simulation' && (
          <div className="simulationWorkspace">
            <div className="subTabBar simulationSubTabs" aria-label="Research simulator">
              <button
                type="button"
                className={`subTabBtn ${simulationResearchTab === 'touch' ? 'active' : ''}`}
                onClick={() => setSimulationResearchTab('touch')}
              >
                Touch Fill
                <span>{touchSimStatus?.completedRounds ?? touchSim?.completed?.rounds ?? 0}</span>
              </button>
              <button
                type="button"
                className={`subTabBtn ${simulationResearchTab === 'tail' ? 'active' : ''}`}
                onClick={() => setSimulationResearchTab('tail')}
              >
                Tail Entry
                <span>{tailSimStatus?.completedRows ?? tailSim?.completed?.rows ?? 0}</span>
              </button>
            </div>
            {simulationResearchTab === 'touch' && (
            <section className="panel simulationPanel">
              <div className="sectionHeader">
                <div>
                  <span className="sectionKicker">Research Recorder</span>
                  <h2>5m Touch-Fill Simulation</h2>
                </div>
                <Badge tone={touchSim?.ok ? (touchSimStatus?.websocketConnected ? 'good' : 'warn') : 'neutral'}>
                  {touchSimStatusLabel}
                </Badge>
              </div>

              <div className="listScopeBar">
                <span>{touchSim?.model || 'ask-touch-fill: best ask <= target price means simulated fill'}</span>
                <strong>{touchSim?.config?.assets?.join(', ') || 'btc, eth, sol, doge, xrp, hype'}</strong>
                <strong>{touchSim?.config ? `${formatPriceCents(touchSim.config.minPrice)}-${formatPriceCents(touchSim.config.maxPrice)}` : '29c-49c'}</strong>
                <strong>updated {touchGeneratedLabel}</strong>
              </div>

              {touchSimError ? (
                <div className="empty simulationEmpty">
                  <AlertTriangle size={22} className="fail" />
                  <p className="emptyText">{touchSimError}</p>
                </div>
              ) : !touchSim?.ok ? (
                <div className="simulationStartState">
                  <div>
                    <span className="sectionKicker">No summary file</span>
                    <strong>{touchSim?.message || 'Start the independent recorder to populate this tab.'}</strong>
                    <p>The recorder writes ignored files under data-lab and does not import or mutate bot runtime state.</p>
                  </div>
                  <code>{touchCommand}</code>
                </div>
              ) : (
                <>
                  <div className="simulationMetricGrid">
                    <DecisionMetric
                      label="WebSocket"
                      value={touchSimStatus?.websocketConnected ? 'CONNECTED' : 'WAITING'}
                      detail={`${touchSimStatus?.subscribedTokens ?? 0} subscribed token ids`}
                      tone={touchSimStatus?.websocketConnected ? 'good' : 'warn'}
                    />
                    <DecisionMetric
                      label="Active rounds"
                      value={String(touchSimStatus?.activeRounds ?? touchSim.active?.rounds ?? 0)}
                      detail={`${touchSim.active?.rows ?? 0} active price rows`}
                      tone={(touchSimStatus?.activeRounds ?? touchSim.active?.rounds ?? 0) > 0 ? 'good' : 'neutral'}
                    />
                    <DecisionMetric
                      label="Window rounds"
                      value={String(touchSimStatus?.completedRounds ?? touchSim.completed?.rounds ?? 0)}
                      detail={`${touchLookbackLabel} lookback / ${touchCompletedByPrice.length} levels`}
                      tone={(touchSimStatus?.completedRounds ?? touchSim.completed?.rounds ?? 0) > 0 ? 'good' : 'warn'}
                    />
                    <DecisionMetric
                      label="Sample scope"
                      value={`${touchSim.config?.assets.length ?? 0} assets`}
                      detail={`${touchAllTimeRounds ?? 0} all-time rounds / ${touchSim.config?.interval ?? '5m'}`}
                      tone="neutral"
                    />
                  </div>

                  <div className="subTabBar simulationSubTabs" aria-label="Simulation result views">
                    <button
                      type="button"
                      className={`subTabBtn ${simulationSubTab === 'price' ? 'active' : ''}`}
                      onClick={() => setSimulationSubTab('price')}
                    >
                      Price Levels
                      <span>{touchCompletedByPrice.length}</span>
                    </button>
                    <button
                      type="button"
                      className={`subTabBtn ${simulationSubTab === 'matrix' ? 'active' : ''}`}
                      onClick={() => setSimulationSubTab('matrix')}
                    >
                      Asset Matrix
                      <span>{touchMatrixAssets.length}</span>
                    </button>
                    <button
                      type="button"
                      className={`subTabBtn ${simulationSubTab === 'rounds' ? 'active' : ''}`}
                      onClick={() => setSimulationSubTab('rounds')}
                    >
                      Round Strip
                      <span>{touchCurrentRounds.length}</span>
                    </button>
                  </div>

                  <ViewHeader
                    kicker="Selected view"
                    title={simulationViewCopy.title}
                    summary={simulationViewCopy.summary}
                    meta={<span>{simulationSubTab}</span>}
                  />

                  {simulationSubTab === 'price' && (
                  <section className="simulationSection">
                    <div className="sectionHeader compact">
                      <div>
                        <span className="sectionKicker">Completed rounds</span>
                        <h3>Price-Level Outcome Rates</h3>
                      </div>
                      <span className="panelSubTitle">{touchSim.completed?.rows ?? 0} finalized rows / {touchLookbackLabel}</span>
                    </div>
                    {touchCompletedByPrice.length > 0 ? (
                      <DataTable headers={['Price', 'Rounds', 'Paired', 'Single', 'None', 'Break-even single', 'EV/share']}>
                        {touchCompletedByPrice.map((row) => (
                          <tr key={`price-${row.price}`}>
                            <td className="mono">{formatPriceCents(row.price)}</td>
                            <td className="mono">{row.rounds}</td>
                            <td><Badge tone="good">{row.paired} / {formatRate(row.pairedRate)}</Badge></td>
                            <td><Badge tone={row.singleRate != null && row.breakevenSingleRate != null && row.singleRate <= row.breakevenSingleRate ? 'good' : 'warn'}>{row.single} / {formatRate(row.singleRate)}</Badge></td>
                            <td className="mono">{row.none} / {formatRate(row.noneRate)}</td>
                            <td className="mono">{formatRate(row.breakevenSingleRate)}</td>
                            <td className={`mono ${row.estimatedEvPerShare >= 0 ? 'pass' : 'fail'}`}>{formatEv(row.estimatedEvPerShare)}</td>
                          </tr>
                        ))}
                      </DataTable>
                    ) : (
                      <div className="opsEmptyState">Waiting for at least one completed 5m round.</div>
                    )}
                  </section>
                  )}

                  {simulationSubTab === 'matrix' && (
                  <section className="simulationSection">
                    <div className="sectionHeader compact">
                      <div>
                        <span className="sectionKicker">Asset split</span>
                        <h3>Asset x Price Matrix</h3>
                      </div>
                      <span className="panelSubTitle">{touchCompletedBySelectedAsset.length} rows</span>
                    </div>
                    {touchCompletedByAssetPrice.length > 0 ? (
                      <>
                      <div className="assetMatrixTabs" aria-label="Asset matrix asset filter">
                        {touchMatrixAssets.map((asset) => {
                          const count = touchCompletedByAssetPrice.filter((row) => (row.asset || 'unknown') === asset).length;
                          return (
                            <button
                              key={asset}
                              type="button"
                              className={`assetMatrixTab ${selectedTouchAsset === asset ? 'active' : ''}`}
                              onClick={() => setSimulationAssetTab(asset)}
                            >
                              <AssetLabel profileId={`${asset}-5m`} label={asset.toUpperCase()} />
                              <span>{count}</span>
                            </button>
                          );
                        })}
                      </div>
                      <DataTable headers={['Asset', 'Price', 'Rounds', 'Paired rate', 'Single rate', 'Break-even', 'EV/share']}>
                        {touchCompletedBySelectedAsset.map((row) => (
                          <tr key={`${row.asset}-${row.price}`}>
                            <td><AssetLabel profileId={`${row.asset || 'btc'}-5m`} label={(row.asset || 'unknown').toUpperCase()} /></td>
                            <td className="mono">{formatPriceCents(row.price)}</td>
                            <td className="mono">{row.rounds}</td>
                            <td><Badge tone="good">{formatRate(row.pairedRate)}</Badge></td>
                            <td><Badge tone={row.singleRate != null && row.breakevenSingleRate != null && row.singleRate <= row.breakevenSingleRate ? 'good' : 'warn'}>{formatRate(row.singleRate)}</Badge></td>
                            <td className="mono">{formatRate(row.breakevenSingleRate)}</td>
                            <td className={`mono ${row.estimatedEvPerShare >= 0 ? 'pass' : 'fail'}`}>{formatEv(row.estimatedEvPerShare)}</td>
                          </tr>
                        ))}
                      </DataTable>
                      </>
                    ) : (
                      <div className="opsEmptyState">Asset-level rows will appear after completed rounds are finalized.</div>
                    )}
                  </section>
                  )}

                  {simulationSubTab === 'rounds' && (
                    <section className="simulationSection">
                      <div className="sectionHeader compact">
                        <div>
                          <span className="sectionKicker">Recent markets</span>
                          <h3>Round Outcome Strip</h3>
                        </div>
                      </div>
                      {touchCurrentRounds.length > 0 ? (
                        <div className="touchRecentGrid">
                          {touchCurrentRounds.map((round) => (
                          <div key={round.slug} className="touchRoundCard">
                            <div className="touchRoundHeader">
                              <AssetLabel profileId={`${round.asset}-5m`} label={round.asset.toUpperCase()} size="sm" />
                              <Badge tone={round.finalized ? 'neutral' : 'warn'}>{round.finalized ? 'final' : 'active'}</Badge>
                            </div>
                            <strong>{round.title || round.slug}</strong>
                            <span className="mutedBlock">{formatEtTime(round.startAt)} - {formatEtTime(round.endAt)}</span>
                            <div className="touchOutcomeStrip">
                              {round.levels.map((level) => (
                                <span key={`${round.slug}-${level.price}`} className={`touchOutcomePill ${level.outcome}`} title={`YES ${level.yesTouched ? 'touched' : 'missed'} / NO ${level.noTouched ? 'touched' : 'missed'}`}>
                                  <em>{formatPriceCents(level.price)}</em>
                                  <Badge tone={touchOutcomeTone(level.outcome)}>{level.outcome}</Badge>
                                </span>
                              ))}
                            </div>
                          </div>
                          ))}
                        </div>
                      ) : (
                        <div className="opsEmptyState">Current round strips will appear once the recorder publishes active markets.</div>
                      )}
                    </section>
                  )}
                </>
              )}
            </section>
            )}

            {simulationResearchTab === 'tail' && (
            <section className="panel simulationPanel">
              <div className="sectionHeader">
                <div>
                  <span className="sectionKicker">Research Recorder</span>
                  <h2>5m Tail Entry Simulation</h2>
                </div>
                <Badge tone={tailSim?.ok ? (tailSimStatus?.websocketConnected ? 'good' : 'warn') : 'neutral'}>
                  {tailSimStatusLabel}
                </Badge>
              </div>

              <div className="listScopeBar">
                <span>{tailSim?.model || 'tail-entry: buy stronger side by midpoint using ask-book VWAP'}</span>
                <strong>{tailSim?.config?.assets?.join(', ') || 'btc'}</strong>
                <strong>{tailSim?.config?.checkpoints?.map((item) => `${item}s`).join(', ') || '60s, 45s, 30s, 20s, 15s, 10s, 5s'}</strong>
                <strong>updated {tailGeneratedLabel}</strong>
              </div>

              {tailSimError ? (
                <div className="empty simulationEmpty">
                  <AlertTriangle size={22} className="fail" />
                  <p className="emptyText">{tailSimError}</p>
                </div>
              ) : !tailSim?.ok ? (
                <div className="simulationStartState">
                  <div>
                    <span className="sectionKicker">No summary file</span>
                    <strong>{tailSim?.message || 'Start the independent tail-entry recorder to populate this tab.'}</strong>
                    <p>The recorder writes ignored files under data-lab and only observes Gamma plus CLOB orderbooks.</p>
                  </div>
                  <code>{tailCommand}</code>
                </div>
              ) : (
                <>
                  <div className="simulationMetricGrid">
                    <DecisionMetric
                      label="WebSocket"
                      value={tailSimStatus?.websocketConnected ? 'CONNECTED' : 'WAITING'}
                      detail={`${tailSimStatus?.subscribedTokens ?? 0} subscribed token ids`}
                      tone={tailSimStatus?.websocketConnected ? 'good' : 'warn'}
                    />
                    <DecisionMetric
                      label="Active rounds"
                      value={String(tailSimStatus?.activeRounds ?? tailSim.active?.rounds ?? 0)}
                      detail={`${tailSim.active?.samples ?? 0} captured checkpoints`}
                      tone={(tailSimStatus?.activeRounds ?? tailSim.active?.rounds ?? 0) > 0 ? 'good' : 'neutral'}
                    />
                    <DecisionMetric
                      label="Window rows"
                      value={String(tailSimStatus?.completedRows ?? tailSim.completed?.rows ?? 0)}
                      detail={`${tailLookbackLabel} lookback / ${tailCheckpointRows.length} checkpoint rows`}
                      tone={(tailSimStatus?.completedRows ?? tailSim.completed?.rows ?? 0) > 0 ? 'good' : 'warn'}
                    />
                    <DecisionMetric
                      label="All-time rows"
                      value={String(tailSimStatus?.completedAllTimeRows ?? tailSim.completedAllTime?.rows ?? 0)}
                      detail={`${tailSim.config?.size ?? tailSim.config?.sizes?.[0] ?? 5} shares fixed`}
                      tone="neutral"
                    />
                  </div>

                  <div className="subTabBar simulationSubTabs" aria-label="Tail simulation result views">
                    <button
                      type="button"
                      className={`subTabBtn ${tailSimulationSubTab === 'checkpoint' ? 'active' : ''}`}
                      onClick={() => setTailSimulationSubTab('checkpoint')}
                    >
                      Checkpoints
                      <span>{tailCheckpointRows.length}</span>
                    </button>
                    <button
                      type="button"
                      className={`subTabBtn ${tailSimulationSubTab === 'bands' ? 'active' : ''}`}
                      onClick={() => setTailSimulationSubTab('bands')}
                    >
                      Ask Bands
                      <span>{tailBandRows.length}</span>
                    </button>
                    <button
                      type="button"
                      className={`subTabBtn ${tailSimulationSubTab === 'rounds' ? 'active' : ''}`}
                      onClick={() => setTailSimulationSubTab('rounds')}
                    >
                      Round Strip
                      <span>{tailRecentRounds.length}</span>
                    </button>
                  </div>

                  <ViewHeader
                    kicker="Selected view"
                    title={simulationViewCopy.title}
                    summary={simulationViewCopy.summary}
                    meta={<span>{tailSimulationSubTab}</span>}
                  />

                  {tailSimulationSubTab === 'checkpoint' && (
                  <section className="simulationSection">
                    <div className="sectionHeader compact">
                      <div>
                        <span className="sectionKicker">Completed samples</span>
                        <h3>Checkpoint PnL Gate</h3>
                      </div>
                      <span className="panelSubTitle">{tailSim.completed?.rows ?? 0} finalized rows / {tailLookbackLabel}</span>
                    </div>
                    {tailCheckpointRows.length > 0 ? (
                      <DataTable headers={['T-End', 'Rows', 'Fill', 'Win', 'VWAP', 'Spread', 'Overround', 'EV/share', 'PnL']}>
                        {tailCheckpointRows.map((row) => (
                          <tr key={`tail-checkpoint-${row.checkpointSeconds}`}>
                            <td className="mono">{row.checkpointSeconds}s</td>
                            <td className="mono">{row.rows}</td>
                            <td><Badge tone={row.fillRate && row.fillRate >= 0.9 ? 'good' : 'warn'}>{row.fillable} / {formatRate(row.fillRate)}</Badge></td>
                            <td><Badge tone={row.winRate && row.avgVwap != null && row.winRate > row.avgVwap ? 'good' : 'warn'}>{row.wins} / {formatRate(row.winRate)}</Badge></td>
                            <td className="mono">{row.avgVwap == null ? '-' : row.avgVwap.toFixed(3)}</td>
                            <td className="mono">{row.avgSpread == null ? '-' : row.avgSpread.toFixed(3)}</td>
                            <td className="mono">{row.avgOverroundAsk == null ? '-' : row.avgOverroundAsk.toFixed(3)}</td>
                            <td className={`mono ${(row.avgPnlPerShare ?? 0) >= 0 ? 'pass' : 'fail'}`}>{formatEv(row.avgPnlPerShare)}</td>
                            <td className={`mono ${row.totalPnl >= 0 ? 'pass' : 'fail'}`}>{formatSignedMoney(row.totalPnl)}</td>
                          </tr>
                        ))}
                      </DataTable>
                    ) : (
                      <div className="opsEmptyState">Waiting for finalized tail-entry samples.</div>
                    )}
                  </section>
                  )}

                  {tailSimulationSubTab === 'bands' && (
                  <section className="simulationSection">
                    <div className="sectionHeader compact">
                      <div>
                        <span className="sectionKicker">Execution price split</span>
                        <h3>Selected Ask Bands</h3>
                      </div>
                      <span className="panelSubTitle">{tailBandRows.length} rows</span>
                    </div>
                    {tailBandRows.length > 0 ? (
                      <DataTable headers={['T-End', 'Ask band', 'Rows', 'Fill', 'Win', 'VWAP', 'EV/share', 'PnL']}>
                        {tailBandRows.map((row) => (
                          <tr key={`tail-band-${row.checkpointSeconds}-${row.askBand}`}>
                            <td className="mono">{row.checkpointSeconds}s</td>
                            <td><Badge tone="neutral">{row.askBand || '-'}</Badge></td>
                            <td className="mono">{row.rows}</td>
                            <td><Badge tone={row.fillRate && row.fillRate >= 0.9 ? 'good' : 'warn'}>{formatRate(row.fillRate)}</Badge></td>
                            <td><Badge tone={row.winRate && row.avgVwap != null && row.winRate > row.avgVwap ? 'good' : 'warn'}>{formatRate(row.winRate)}</Badge></td>
                            <td className="mono">{row.avgVwap == null ? '-' : row.avgVwap.toFixed(3)}</td>
                            <td className={`mono ${(row.avgPnlPerShare ?? 0) >= 0 ? 'pass' : 'fail'}`}>{formatEv(row.avgPnlPerShare)}</td>
                            <td className={`mono ${row.totalPnl >= 0 ? 'pass' : 'fail'}`}>{formatSignedMoney(row.totalPnl)}</td>
                          </tr>
                        ))}
                      </DataTable>
                    ) : (
                      <div className="opsEmptyState">Ask-band rows will appear after finalized samples are aggregated.</div>
                    )}
                  </section>
                  )}

                  {tailSimulationSubTab === 'rounds' && (
                  <section className="simulationSection">
                    <div className="sectionHeader compact">
                      <div>
                        <span className="sectionKicker">Recent markets</span>
                        <h3>Tail Sample Strip</h3>
                      </div>
                    </div>
                    {tailRecentRounds.length > 0 ? (
                      <div className="touchRecentGrid">
                        {tailRecentRounds.map((round) => (
                          <div key={round.slug} className="touchRoundCard">
                            <div className="touchRoundHeader">
                              <AssetLabel profileId={`${round.asset}-5m`} label={round.asset.toUpperCase()} size="sm" />
                              <Badge tone={round.finalized ? 'neutral' : 'warn'}>{round.finalized ? `winner ${round.winner || '-'}` : 'active'}</Badge>
                            </div>
                            <strong>{round.title || round.slug}</strong>
                            <span className="mutedBlock">{formatEtTime(round.startAt)} - {formatEtTime(round.endAt)}</span>
                            <div className="touchOutcomeStrip">
                              {round.samples.map((sample) => {
                                const firstPlan = sample.sizePlans?.[0];
                                const vwap = sample.vwap ?? firstPlan?.vwap;
                                return (
                                  <span key={`${round.slug}-${sample.checkpointSeconds}`} className={`touchOutcomePill ${sample.status === 'sampled' ? 'paired' : sample.status === 'insufficient_depth' ? 'single' : 'none'}`} title={`YES mid ${sample.yesMidpoint ?? '-'} / NO mid ${sample.noMidpoint ?? '-'}`}>
                                    <em>{sample.checkpointSeconds}s</em>
                                    <Badge tone={sample.status === 'sampled' ? 'good' : sample.status === 'insufficient_depth' ? 'warn' : 'neutral'}>
                                      {sample.selectedSide || 'none'} {vwap == null ? '' : `@ ${vwap.toFixed(3)}`}
                                    </Badge>
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="opsEmptyState">Tail sample strips will appear once the recorder observes active markets.</div>
                    )}
                  </section>
                  )}
                </>
              )}
            </section>
            )}
          </div>
        )}

        {activeTab === 'strategy' && <StrategyRulesTab rules={state.rules} />}

        {activeTab === 'logs' && (
          <LogsTab
            allLogCount={state.runtimeLogs.length}
            filteredLogs={filteredLogs}
            pageRows={logsPagination.pageRows}
            page={logsPagination.page}
            totalPages={logsPagination.totalPages}
            logSearch={logSearch}
            logLevel={logLevel}
            logSource={logSource}
            hideRoutineLogs={hideRoutineLogs}
            alertLogCount={alertLogCount}
            signalLogCount={signalLogCount}
            consoleRef={consoleRef}
            onSearchChange={setLogSearch}
            onLevelChange={setLogLevel}
            onSourceChange={setLogSource}
            onToggleRoutineLogs={() => setHideRoutineLogs((value) => !value)}
            onPageChange={logsPagination.setPage}
          />
        )}
      </main>
    </Shell>
  );
}
