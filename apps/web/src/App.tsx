import React from 'react';
import { 
  AlertTriangle, 
  CheckCircle2, 
  RefreshCw, 
  BookOpen,
  History,
  Terminal,
  Cpu,
  Search,
  Info,
  WalletCards,
  PieChart,
  Target,
  BarChart3
} from 'lucide-react';

import type { BotRuntimeStatus, DashboardState, RuntimeLogRecord, StrategyCheck } from '../../../packages/shared/src';
import { api, DASHBOARD_REFRESH_MS } from './lib/api';
import { formatMoney, formatNumber, formatSeconds } from './lib/format';
import { formatEtTime, outcomeLabel, outcomeTone, shortenTokenId } from './lib/dashboardFormat';

import { RoundTimelinePipeline } from './components/RoundTimelinePipeline';
import { OrderbookCapacityPanel, OrderbookExecutionSummary, OrderbookTable } from './components/dashboard/OrderbookPanels';
import { Badge, DataTable, DecisionMetric, PaginationControls, Shell } from './components/dashboard/Ui';
import { DynamicEntryPricePanel } from './app/DynamicEntryPricePanel';
import {
  AssetIcon,
  AssetLabel,
  DAILY_PAGE_SIZE,
  LOG_PAGE_SIZE,
  ORDER_PAGE_SIZE,
  ROUND_PAGE_SIZE,
  STATS_WINDOW_MS,
  type ActivitySubTab,
  type TabType,
  type TouchSimSummary,
  type VisibleState,
  blockerDetail,
  buildDailyExecutionSummaries,
  buildExecutionStats,
  buildRoundExecutionSummaries,
  currentRoundExposure,
  fillStateLabel,
  fillStateTone,
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
  netFilledShares,
  orderFailureReason,
  orderMarketTitle,
  portfolioStatusLabel,
  portfolioStatusTone,
  positionCost,
  positionPnl,
  positionValue,
  profileLabelFor,
  roundStatusSummary,
  runtimeBuildLabel,
  strategyCheckLabel,
  strategyCheckTone,
  strategySourceLabel,
  syncTabToUrl,
  tabFromUrl,
  touchOutcomeTone,
  usePaginatedRows,
} from './app/dashboardHelpers';

type SimulationSubTab = 'price' | 'matrix' | 'rounds';

export function App() {
  const [state, setState] = React.useState<DashboardState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [autoRefreshing, setAutoRefreshing] = React.useState(false);
  const [lastRefreshAt, setLastRefreshAt] = React.useState<string | null>(null);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const [touchSim, setTouchSim] = React.useState<TouchSimSummary | null>(null);
  const [touchSimError, setTouchSimError] = React.useState<string | null>(null);
  
  // Navigation Tab State
  const [activeTab, setActiveTab] = React.useState<TabType>(() => tabFromUrl());
  const [activitySubTab, setActivitySubTab] = React.useState<ActivitySubTab>('daily');
  const [simulationSubTab, setSimulationSubTab] = React.useState<SimulationSubTab>('price');
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

  React.useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), DASHBOARD_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  React.useEffect(() => {
    void loadTouchSim();
    const timer = setInterval(() => void loadTouchSim(), DASHBOARD_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadTouchSim]);

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
  const touchCompletedByPrice = touchSim?.completed?.byPrice ?? [];
  const touchCompletedByAssetPrice = touchSim?.completed?.byAssetPrice ?? [];
  const touchMatrixAssets = React.useMemo(() => (
    [...new Set(touchCompletedByAssetPrice.map((row) => row.asset || 'unknown'))].sort()
  ), [touchCompletedByAssetPrice]);

  const dailyPagination = usePaginatedRows(dailySummaries, DAILY_PAGE_SIZE);
  const roundPagination = usePaginatedRows(roundSummaries, ROUND_PAGE_SIZE);
  const ordersPagination = usePaginatedRows(visibleState?.orders ?? [], ORDER_PAGE_SIZE);
  const logsPagination = usePaginatedRows(filteredLogs, LOG_PAGE_SIZE);

  React.useEffect(() => {
    dailyPagination.setPage(1);
    roundPagination.setPage(1);
  }, [roundSummaries.length]);

  React.useEffect(() => {
    ordersPagination.setPage(1);
  }, [visibleState?.orders.length, selectedProfileId]);

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
  const currentRoundOrders = viewState.orders.filter((order) => order.roundId === snapshot.round.id);
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
  const assetRouteLabel = (selection: typeof dynamicEntryPrice): string => {
    if (!selection?.assetSelectorEnabled) return 'off';
    const rank = selection.assetSelectorRank ? `#${selection.assetSelectorRank}` : '-';
    return selection.assetSelectorSelected ? rank : `skip ${rank}`;
  };
  const profileStatusRows = state.profiles.map((item) => {
    const itemEntryCheck = item.strategyChecks.find((check) => check.strategy === 'UPDOWN_DUAL_ENTRY');
    const itemHedgeCheck = item.strategyChecks.find((check) => check.strategy === 'UPDOWN_SINGLE_FILL_HEDGE');
    const itemProfitExitCheck = item.strategyChecks.find((check) => check.strategy === 'UPDOWN_SINGLE_FILL_PROFIT_EXIT');
    const itemCooldownActive = Boolean(item.entryCooldownUntil && new Date(item.entryCooldownUntil).getTime() > Date.now());
    return {
      item,
      entryCheck: itemEntryCheck,
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
  const touchCommand = 'npm run research:pm5m-touch -- --assets btc,eth,sol,doge,xrp,hype --min-price 0.29 --max-price 0.49';
  const touchGeneratedAtMs = touchSim?.generatedAt ? new Date(touchSim.generatedAt).getTime() : 0;
  const touchGeneratedLabel = touchGeneratedAtMs ? formatRelativeAge(touchGeneratedAtMs, nowMs) : 'not generated';
  const isResearchTab = activeTab === 'simulation';

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
        {activeTab === 'terminal' && (isAllProfiles ? (
          <div className="scopeWorkspace">
            <section className="panel scopePanel">
              <div className="sectionHeader">
                <div>
                  <span className="sectionKicker">All Profiles</span>
                  <h2>Runtime Overview</h2>
                </div>
                <Badge tone={state.runtime.executionMode === 'live' ? 'warn' : 'neutral'}>{executionLabel}</Badge>
              </div>
              <div className="scopeMetricGrid">
                <DecisionMetric label="Enabled" value={`${enabledProfileCount}/${state.profiles.length}`} detail={`${liveProfileCount} live profiles`} tone={liveProfileCount > 0 ? 'warn' : 'neutral'} />
                <DecisionMetric label="Orders" value={String(viewState.orders.length)} detail={`${viewState.fills.length} fills / ${viewState.settlements.length} settlements`} tone={viewState.orders.length > 0 ? 'good' : 'neutral'} />
                <DecisionMetric label="Open Positions" value={String(displayedPositions.length)} detail="latest profile snapshots" tone={displayedPositions.length > 0 ? 'warn' : 'neutral'} />
                <DecisionMetric label="Settled PnL" value={formatSignedMoney(portfolioPnl)} detail="filtered settlements" tone={portfolioPnl > 0 ? 'good' : portfolioPnl < 0 ? 'bad' : 'neutral'} />
              </div>
            </section>

            <section className="profileGridPanel" aria-label="Profile runtime matrix">
              {profileStatusRows.map(({ item, entryCheck: itemEntryCheck, hedgeCheck: itemHedgeCheck, profitExitCheck: itemProfitExitCheck, cooldownActive: itemCooldownActive }) => (
                <button key={item.profile.id} type="button" className="profileRuntimeCard" onClick={() => setSelectedProfileId(item.profile.id)}>
                  <div className="profileRuntimeHeader">
                    <div>
                      <strong><AssetLabel profileId={item.profile.id} label={item.profile.label} size="sm" /></strong>
                      <span>{item.profile.status} · {item.latestSnapshot?.round.phase || 'pending'}</span>
                    </div>
                    <Badge tone={item.profile.status === 'live' ? 'warn' : item.profile.status === 'monitor' ? 'neutral' : 'bad'}>{item.profile.status}</Badge>
                  </div>
                  <div className="profileRuntimeStats">
                    <div><span>Entry</span><strong>{strategyCheckLabel(itemEntryCheck)}</strong></div>
                    <div><span>Price</span><strong>{item.dynamicEntryPrice ? formatPriceCents(item.dynamicEntryPrice.selectedPrice) : itemEntryCheck?.limitPrice != null ? formatPriceCents(itemEntryCheck.limitPrice) : '-'}</strong></div>
                    <div><span>Route</span><strong>{assetRouteLabel(item.dynamicEntryPrice)}</strong></div>
                    <div><span>Exit</span><strong>{strategyCheckLabel(itemProfitExitCheck)}</strong></div>
                    <div><span>Hedge</span><strong>{strategyCheckLabel(itemHedgeCheck)}</strong></div>
                    <div><span>Cooldown</span><strong>{itemCooldownActive ? formatCooldownRemaining(item.entryCooldownUntil) : 'clear'}</strong></div>
                  </div>
                  <div className="profileRuntimeFooter">
                    <span>{item.stats.orders} orders</span>
                    <span>{item.stats.fills} fills</span>
                    <strong className={item.stats.settledPnl >= 0 ? 'pass' : 'fail'}>{formatSignedMoney(item.stats.settledPnl)}</strong>
                  </div>
                </button>
              ))}
            </section>
          </div>
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

            <aside className="opsRail">
              <div className="panel opsPanel">
                <h2>Profiles</h2>
                <div className="opsProfileList">
                  {profileStatusRows.map(({ item, entryCheck: itemEntryCheck, hedgeCheck: itemHedgeCheck, profitExitCheck: itemProfitExitCheck, cooldownActive: itemCooldownActive }) => (
                    <button key={item.profile.id} type="button" className={`opsProfileRow ${selectedProfileId === item.profile.id ? 'active' : ''}`} onClick={() => setSelectedProfileId(item.profile.id)}>
                      <div>
                        <strong><AssetLabel profileId={item.profile.id} label={item.profile.label} size="sm" /></strong>
                        <span>{item.latestSnapshot?.round.phase || 'pending'} · {item.profile.status}</span>
                      </div>
                      <div className="opsProfileBadges">
                        <Badge tone={strategyCheckTone(itemEntryCheck)}>entry {strategyCheckLabel(itemEntryCheck)}</Badge>
                        <Badge tone={strategyCheckTone(itemProfitExitCheck)}>exit {strategyCheckLabel(itemProfitExitCheck)}</Badge>
                        <Badge tone={strategyCheckTone(itemHedgeCheck)}>hedge {strategyCheckLabel(itemHedgeCheck)}</Badge>
                        {itemCooldownActive && <Badge tone="warn">{formatCooldownRemaining(item.entryCooldownUntil)}</Badge>}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="panel opsPanel">
                <h2>System</h2>
                <div className="opsSystemList">
                  <div><span>Feed</span><strong>{feedLabel}</strong></div>
                  <div><span>Binance</span><strong>{viewState.feed.binanceConnected ? 'connected' : 'offline'}</strong></div>
                  <div><span>Runtime</span><strong>{state.runtime.status}</strong></div>
                  <div><span>Alerts</span><strong>{alertLogCount}</strong></div>
                  <div><span>Signals</span><strong>{signalLogCount}</strong></div>
                  <div><span>Portfolio PnL</span><strong>{formatSignedMoney(portfolioPnl)}</strong></div>
                </div>
              </div>

              {snapshot.diagnostics.length > 0 && (
                <details className="panel opsPanel opsDiagnostics">
                  <summary>
                    <span>Diagnostics</span>
                    <strong>{snapshot.diagnostics.length}</strong>
                  </summary>
                  <div className="opsDiagnosticList">
                    {snapshot.diagnostics.map((diag, index) => (
                      <span key={`${diag}-${index}`}>{diag}</span>
                    ))}
                  </div>
                </details>
              )}
            </aside>
          </div>
        ))}

	
	        {activeTab === 'portfolio' && (
	          <div className="portfolioWorkspace">
	            <section className="panel">
	              <h2>
	                Account Portfolio
	                <span className="panelSubTitle">{portfolio?.updatedAt ? `updated ${formatEtTime(portfolio.updatedAt)}` : 'waiting for snapshot'}</span>
	              </h2>

	              {portfolio ? (
	                <>
	                  <div className="portfolioHero">
	                    <div className="portfolioIdentity">
                        <div className="portfolioAvatar" aria-hidden="true">
                          {portfolioAvatarUrl ? (
                            <img src={portfolioAvatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                          ) : (
                            <span>{portfolioInitial}</span>
                          )}
                        </div>
                        <div className="portfolioIdentityText">
	                        <span className="decisionKicker">Configured Account</span>
	                        <strong title={portfolioProfileName || portfolio.accountAddress || ''}>{portfolioProfileName || (portfolio.accountAddress ? shortenTokenId(portfolio.accountAddress) : 'not configured')}</strong>
                          {portfolioProfileHandle && <em>{portfolioProfileHandle}</em>}
	                        <p title={portfolio.accountAddress || ''}>{portfolio.accountAddress ? shortenTokenId(portfolio.accountAddress) : 'not configured'} · {portfolio.hasOwnerPrivateKey ? 'CLOB balance reads enabled' : 'OWNER_PRIVATE_KEY missing; positions only'}</p>
                        </div>
	                    </div>
	                    <Badge tone={portfolioStatusTone(portfolio.status)}>{portfolioStatusLabel(portfolio.status)}</Badge>
	                  </div>

	                  <div className="portfolioMetricGrid">
		                    <DecisionMetric label="Collateral Balance" value={portfolio.collateralBalance == null ? 'n/a' : formatMoney(portfolio.collateralBalance)} detail="CLOB collateral" tone={portfolio.collateralBalance == null ? 'neutral' : 'good'} />
		                    <DecisionMetric label="Position Value" value={formatMoney(displayedPositionValue)} detail={`${displayedPositions.length} scoped positions`} tone={displayedPositionValue > 0 ? 'good' : 'neutral'} />
		                    <DecisionMetric label="Open Cost" value={formatMoney(displayedPositionCost)} detail="scoped entry basis" tone="neutral" />
		                    <DecisionMetric label="Unrealized PnL" value={formatSignedMoney(displayedUnrealizedPnl)} detail="scoped positions" tone={displayedUnrealizedPnl > 0 ? 'good' : displayedUnrealizedPnl < 0 ? 'bad' : 'neutral'} />
		                    <DecisionMetric label="Settled PnL" value={formatSignedMoney(portfolio.settledPnl)} detail={`${viewState.settlements.length} records`} tone={portfolio.settledPnl > 0 ? 'good' : portfolio.settledPnl < 0 ? 'bad' : 'neutral'} />
		                    <DecisionMetric label="Total PnL" value={formatSignedMoney(portfolioPnl + displayedUnrealizedPnl)} detail="scoped settled + unrealized" tone={(portfolioPnl + displayedUnrealizedPnl) > 0 ? 'good' : (portfolioPnl + displayedUnrealizedPnl) < 0 ? 'bad' : 'neutral'} />
		                    <DecisionMetric label="ROI" value={formatPercentValue(displayedRoiPct)} detail="scoped PnL / open cost" tone={displayedRoiPct == null ? 'neutral' : displayedRoiPct > 0 ? 'good' : displayedRoiPct < 0 ? 'bad' : 'neutral'} />
	                  </div>

	                  {portfolio.diagnostics.length > 0 && (
	                    <div className="portfolioDiagnostics">
	                      {portfolio.diagnostics.map((item) => (
	                        <span key={item}>{item}</span>
	                      ))}
	                    </div>
	                  )}
	                </>
	              ) : (
	                <div className="empty" style={{ minHeight: '120px' }}>
	                  <Info size={20} style={{ color: 'var(--text-muted)' }} />
	                  <p className="emptyText">No portfolio snapshot has been captured yet</p>
	                </div>
	              )}
	            </section>

		            <section className="panel">
		              <h2>
		                Active Positions
		                <span className="panelSubTitle">{displayedPositions.length ? `${displayedPositions.length} positions in ${scopeLabel}` : 'no scoped positions'}</span>
		              </h2>
	              {displayedPositions.length > 0 ? (
	                <DataTable headers={isAllProfiles ? ['Profile', 'Market', 'Outcome', 'Shares', 'Avg', 'Value', 'PnL', 'ROI'] : ['Market', 'Outcome', 'Shares', 'Avg', 'Value', 'PnL', 'ROI']}>
	                  {displayedPositions.map((position) => {
	                    const value = positionValue(position);
	                    const cost = positionCost(position);
	                    const pnlValue = positionPnl(position);
	                    const roi = cost > 0 ? (pnlValue / cost) * 100 : null;
	                    return (
	                      <tr key={`${position.profileId}:${position.tokenId}`}>
	                        {isAllProfiles && <td><Badge tone="neutral"><AssetLabel profileId={position.profileId} label={position.profileLabel} /></Badge></td>}
	                        <td>
	                          <div className="marketCell compact">
	                            <AssetIcon profileId={position.profileId} size="sm" />
	                            <div>
	                              <span className="marketTitle">{position.title || 'Polymarket position'}</span>
	                              <span className="mutedBlock mono">{shortenTokenId(position.tokenId)}</span>
	                            </div>
	                          </div>
	                        </td>
	                        <td><Badge tone={outcomeTone(position.label)}>{outcomeLabel(position.label)}</Badge></td>
	                        <td className="mono">{formatNumber(position.shares, 2)}</td>
	                        <td className="mono">${position.avgPrice.toFixed(3)}</td>
	                        <td className="mono">{formatMoney(value)}</td>
	                        <td className={`mono ${pnlValue >= 0 ? 'pass' : 'fail'}`}>{formatSignedMoney(pnlValue)}</td>
	                        <td className={`mono ${roi == null ? '' : roi >= 0 ? 'pass' : 'fail'}`}>{formatPercentValue(roi)}</td>
	                      </tr>
	                    );
	                  })}
	                </DataTable>
	              ) : (
	                <div className="empty" style={{ minHeight: '140px' }}>
	                  <PieChart size={22} style={{ color: 'var(--text-muted)' }} />
	                  <p className="emptyText">{portfolio?.status === 'disabled' ? 'Configure POLYMARKET_DEPOSIT_WALLET to load account positions' : 'No active positions found for this account'}</p>
	                </div>
	              )}
	            </section>
	          </div>
	        )}

	        {activeTab === 'orderbooks' && (
	          <div className="panel">
	            <div className="sectionHeader">
	              <div>
	                <span className="sectionKicker">{scopeLabel}</span>
	                <h2>Polymarket CLOB Order Books</h2>
	              </div>
	            </div>
            {isAllProfiles ? (
              <div className="profileGridPanel compact">
                {state.profiles.map((item) => (
                  <button key={item.profile.id} type="button" className="profileRuntimeCard" onClick={() => setSelectedProfileId(item.profile.id)}>
                    <div className="profileRuntimeHeader">
                      <div>
                        <strong><AssetLabel profileId={item.profile.id} label={item.profile.label} size="sm" /></strong>
                        <span>{item.latestSnapshot?.round.id || 'waiting for round'}</span>
                      </div>
                      <Badge tone={item.feed.clobConnected ? 'good' : 'bad'}>CLOB {item.feed.clobConnected ? 'on' : 'off'}</Badge>
                    </div>
                    <div className="profileRuntimeStats">
                      <div><span>Round</span><strong>{item.latestSnapshot?.round.phase || 'pending'}</strong></div>
                      <div><span>Orderbooks</span><strong>{item.latestSnapshot?.orderbooks.length || 0}</strong></div>
                      <div><span>Depth</span><strong>{item.latestSnapshot?.orderbookDepth ? 'loaded' : 'empty'}</strong></div>
                      <div><span>Updated</span><strong>{item.feed.lastOrderbookAt ? formatEtTime(item.feed.lastOrderbookAt) : 'n/a'}</strong></div>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <>
                <OrderbookExecutionSummary quotes={snapshot.orderbooks} yesTokenId={snapshot.round.yesTokenId} noTokenId={snapshot.round.noTokenId} />
                <OrderbookCapacityPanel depth={snapshot.orderbookDepth} />
                <OrderbookTable quotes={snapshot.orderbooks} yesTokenId={snapshot.round.yesTokenId} noTokenId={snapshot.round.noTokenId} />
              </>
            )}
          </div>
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
                              ? ['Profile', 'Time (ET)', 'Age', 'Market', 'Round Status', 'Orders', 'Submitted Buy Orders', 'Filled Buy Shares', 'Unfilled', 'Settlement PnL']
                              : ['Time (ET)', 'Age', 'Market', 'Round Status', 'Orders', 'Submitted Buy Orders', 'Filled Buy Shares', 'Unfilled', 'Settlement PnL']}
                            className={`executionTable dailyExecutionTable ${isAllProfiles ? 'withProfile' : ''}`}
                          >
                            {day.rounds.map((round) => {
                              const hasUnfilled = round.unfilledOrders > 0;
                              const net = netFilledShares(round);
                              const fillLabel = fillStateLabel(net.yes, net.no);
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
                                    <Badge tone={fillStateTone(net.yes, net.no)}>{fillLabel}</Badge>
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
                        ? ['Profile', 'Age', 'Market', 'Round ID', 'Round Status', 'Orders', 'Submitted Buy Orders', 'Filled Buy Shares', 'Filled Sell Shares', 'Unfilled', 'Settlement PnL']
                        : ['Age', 'Market', 'Round ID', 'Round Status', 'Orders', 'Submitted Buy Orders', 'Filled Buy Shares', 'Filled Sell Shares', 'Unfilled', 'Settlement PnL']}
                      className={`executionTable roundExecutionTable ${isAllProfiles ? 'withProfile' : ''}`}
                    >
                      {roundPagination.pageRows.map((round) => {
                        const hasUnfilled = round.unfilledOrders > 0;
                        const net = netFilledShares(round);
                        const fillLabel = fillStateLabel(net.yes, net.no);
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
                              <Badge tone={fillStateTone(net.yes, net.no)}>{fillLabel}</Badge>
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
                    <DataTable headers={isAllProfiles
                      ? ['Profile', 'Time (ET)', 'Strategy', 'Market', 'Round ID', 'Outcome', 'Side', 'Price', 'Size', 'Status', 'Reason', 'Polymarket CLOB Order ID']
                      : ['Time (ET)', 'Strategy', 'Market', 'Round ID', 'Outcome', 'Side', 'Price', 'Size', 'Status', 'Reason', 'Polymarket CLOB Order ID']}>
                      {ordersPagination.pageRows.map((order) => (
                        <tr key={order.id}>
                          {isAllProfiles && <td><Badge tone="neutral"><AssetLabel profileId={order.profileId} label={profileLabelFor(state.profiles, order.profileId)} /></Badge></td>}
                          <td className="mono">{formatEtTime(order.createdAt)}</td>
                          <td className="mono" style={{ fontSize: '11px' }}>{strategySourceLabel(order)}</td>
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
                      totalRows={viewState.orders.length}
                      pageSize={ORDER_PAGE_SIZE}
                      onPageChange={ordersPagination.setPage}
                    />
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
                      label="Completed rounds"
                      value={String(touchSimStatus?.completedRounds ?? touchSim.completed?.rounds ?? 0)}
                      detail={`${touchCompletedByPrice.length} price levels`}
                      tone={(touchSimStatus?.completedRounds ?? touchSim.completed?.rounds ?? 0) > 0 ? 'good' : 'warn'}
                    />
                    <DecisionMetric
                      label="Sample scope"
                      value={`${touchSim.config?.assets.length ?? 0} assets`}
                      detail={`${touchSim.config?.priceLevels.length ?? 0} levels / ${touchSim.config?.interval ?? '5m'}`}
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

                  {simulationSubTab === 'price' && (
                  <section className="simulationSection">
                    <div className="sectionHeader compact">
                      <div>
                        <span className="sectionKicker">Completed rounds</span>
                        <h3>Price-Level Outcome Rates</h3>
                      </div>
                      <span className="panelSubTitle">{touchSim.completed?.rows ?? 0} finalized rows</span>
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
          </div>
        )}

        {activeTab === 'strategy' && (
          <div className="panel">
            <h2>Trading Strategy & Configured Rules</h2>
            <div className="rulesGrid">
              {state.rules && state.rules.length > 0 ? (
                state.rules.map((rule) => (
                  <div key={rule.id} className="ruleCard">
                    <div className="ruleHeader">
                      <span className="ruleTitle">{rule.title} ({rule.id})</span>
                      <span className="ruleAllocation">{rule.allocationPct}% ALLOCATION</span>
                    </div>
                    <p className="ruleSummary">{rule.summary}</p>
                    <div className="ruleLists">
                      <div className="ruleSection">
                        <h4>Entry triggers</h4>
                        <ul>
                          {rule.entryRules.map((entry, idx) => (
                            <li key={idx}>{entry}</li>
                          ))}
                        </ul>
                      </div>
                      <div className="ruleSection">
                        <h4>Exit parameters</h4>
                        <ul>
                          {rule.exitRules.map((exit, idx) => (
                            <li key={idx}>{exit}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty" style={{ width: '100%' }}>
                  <p className="emptyText">No strategy rules loaded in bot configuration</p>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="panel">
            <h2>Runtime Logs & System Output</h2>
            <div className="logsViewContainer">
              
              {/* Logs filter controls */}
              <div className="logsControlBar">
                <div className="searchWrapper">
                  <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
                  <input 
                    type="text" 
                    className="logSearchInput" 
                    style={{ paddingLeft: '34px' }}
                    placeholder="Search logs by message or source..." 
                    value={logSearch} 
                    onChange={(e) => setLogSearch(e.target.value)}
                  />
                </div>
                
                <select 
                  className="logFilterSelect" 
                  value={logLevel} 
                  onChange={(e) => setLogLevel(e.target.value)}
                >
                  <option value="all">All Levels</option>
                  <option value="info">Info</option>
                  <option value="warn">Warning</option>
                  <option value="error">Error</option>
                </select>

                <select 
                  className="logFilterSelect" 
                  value={logSource} 
                  onChange={(e) => setLogSource(e.target.value)}
                >
                  <option value="all">All Sources</option>
                  <option value="worker">Worker</option>
                  <option value="api">API</option>
                  <option value="execution">Execution</option>
                  <option value="market-data">Market Data</option>
                  <option value="operator">Operator</option>
                </select>

                <button
                  type="button"
                  className={`logModeButton ${hideRoutineLogs ? 'active' : ''}`}
                  onClick={() => setHideRoutineLogs((value) => !value)}
                >
                  {hideRoutineLogs ? 'Signal View' : 'Raw View'}
                </button>

                {/* Counter */}
                <div className="logCounters">
                  <span>{filteredLogs.length} of {state.runtimeLogs.length} logs</span>
                  <strong>{alertLogCount} alerts</strong>
                  <span>{signalLogCount} signal</span>
                </div>
              </div>

              {/* Console log box */}
              <div className="consoleWindow" ref={consoleRef}>
                {filteredLogs.length > 0 ? (
                  logsPagination.pageRows.map((log) => (
                    <div key={log.id} className={`consoleLogLine ${log.level}`}>
                      <span className="logTime">{formatEtTime(log.createdAt)}</span>
                      <span className="logSource">[{log.source}]</span>
                      <span className={`logLevelTag ${log.level}`}>{log.level}</span>
                      <span className="logMessage">{log.message}</span>
                    </div>
                  ))
                ) : (
                  <div className="empty" style={{ minHeight: '200px' }}>
                    <p className="emptyText">No log records matches your filters</p>
                  </div>
                )}
              </div>
              <PaginationControls
                page={logsPagination.page}
                totalPages={logsPagination.totalPages}
                totalRows={filteredLogs.length}
                pageSize={LOG_PAGE_SIZE}
                onPageChange={logsPagination.setPage}
              />
            </div>
          </div>
        )}
      </main>
    </Shell>
  );
}
