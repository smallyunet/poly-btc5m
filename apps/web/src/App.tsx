import React from 'react';
import { 
  Activity, 
  AlertTriangle, 
  CheckCircle2, 
  RefreshCw, 
  Radio, 
  Shield, 
  Timer, 
  TrendingUp,
  BookOpen,
  History,
  Terminal,
  Cpu,
  SlidersHorizontal,
  Search,
  Info,
  Users
} from 'lucide-react';

import type { BotRuntimeStatus, DashboardState, OrderBookQuote, OrderbookDepthSnapshot, RuntimeLogRecord, StrategyCheck } from '../../../packages/shared/src';
import { api, DASHBOARD_REFRESH_MS } from './lib/api';
import { formatMoney, formatNumber, formatSeconds, modeLabel } from './lib/format';

import { ScoreGauge } from './components/ScoreGauge';
import { PriceStrikeGauge } from './components/PriceStrikeGauge';
import { RoundTimelinePipeline } from './components/RoundTimelinePipeline';

type TabType = 'terminal' | 'orderbooks' | 'activity' | 'strategy' | 'logs';
type ActivitySubTab = 'daily' | 'rounds' | 'orders';
type DashboardOrder = DashboardState['orders'][number];
type DashboardFill = DashboardState['fills'][number];
type RoundExecutionSummary = {
  roundId: string;
  title: string;
  imageUrl?: string;
  latestTime: number;
  startTime: number;
  dateKey: string;
  dateLabel: string;
  timeLabel: string;
  orderCount: number;
  buyOrderCount: number;
  sellOrderCount: number;
  failedOrderCount: number;
  firstOrderError?: string;
  orderedYes: number;
  orderedNo: number;
  orderedYesPrice?: number;
  orderedNoPrice?: number;
  filledBuyYes: number;
  filledBuyNo: number;
  filledSellYes: number;
  filledSellNo: number;
  unfilledOrders: number;
  unfilledShares: number;
  settlementPnl?: number;
  settlementStatus?: DashboardState['settlements'][number]['status'];
};
type RoundStatusSummary = {
  label: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  detail: string;
};
type DailyExecutionSummary = {
  dateKey: string;
  dateLabel: string;
  latestTime: number;
  rounds: RoundExecutionSummary[];
  roundCount: number;
  orderCount: number;
  buyOrderCount: number;
  sellOrderCount: number;
  pairedRounds: number;
  singleRounds: number;
  unfilledOrders: number;
  unfilledShares: number;
  settledRounds: number;
  settlementPnl: number;
};

const ROUND_PAGE_SIZE = 20;
const ORDER_PAGE_SIZE = 25;
const DAILY_PAGE_SIZE = 1;
const LOG_PAGE_SIZE = 75;
const TAB_TYPES: TabType[] = ['terminal', 'orderbooks', 'activity', 'strategy', 'logs'];

function isTabType(value: string | null): value is TabType {
  return TAB_TYPES.includes(value as TabType);
}

function tabFromUrl(): TabType {
  if (typeof window === 'undefined') return 'terminal';
  const tab = new URLSearchParams(window.location.search).get('tab');
  return isTabType(tab) ? tab : 'terminal';
}

function syncTabToUrl(tab: TabType): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (url.searchParams.get('tab') === tab) return;
  url.searchParams.set('tab', tab);
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

// Helper to shorten long crypto addresses/token IDs
function shortenTokenId(id: string): string {
  if (!id) return '-';
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}...${id.slice(-8)}`;
}

function outcomeLabel(label: 'YES' | 'NO' | 'UNKNOWN'): string {
  if (label === 'UNKNOWN') return 'UNKNOWN';
  return label === 'YES' ? 'UP' : 'DOWN';
}

function outcomeTone(label: 'YES' | 'NO' | 'UNKNOWN'): 'good' | 'bad' | 'neutral' {
  if (label === 'UNKNOWN') return 'neutral';
  return label === 'YES' ? 'good' : 'bad';
}

function fillStateTone(yesShares: number, noShares: number): 'good' | 'warn' | 'neutral' {
  if (yesShares > 0 && noShares > 0) return 'good';
  if (yesShares > 0 || noShares > 0) return 'warn';
  return 'neutral';
}

function fillStateLabel(yesShares: number, noShares: number): 'paired' | 'single' | 'none' {
  if (yesShares > 0 && noShares > 0) return 'paired';
  if (yesShares > 0 || noShares > 0) return 'single';
  return 'none';
}

function netFilledShares(round: Pick<RoundExecutionSummary, 'filledBuyYes' | 'filledBuyNo' | 'filledSellYes' | 'filledSellNo'>) {
  return {
    yes: Math.max(0, round.filledBuyYes - round.filledSellYes),
    no: Math.max(0, round.filledBuyNo - round.filledSellNo),
  };
}

function roundStatusSummary(round: RoundExecutionSummary): RoundStatusSummary {
  if (round.failedOrderCount > 0) {
    return {
      label: 'failed order',
      tone: 'bad',
      detail: round.firstOrderError || `${round.failedOrderCount} failed orders`,
    };
  }
  if (round.unfilledOrders > 0) {
    return {
      label: 'unfilled',
      tone: 'warn',
      detail: `${round.unfilledOrders} orders / ${formatShares(round.unfilledShares)} shares`,
    };
  }
  const net = netFilledShares(round);
  const fillLabel = fillStateLabel(net.yes, net.no);
  if (fillLabel === 'paired') {
    return { label: 'paired', tone: 'good', detail: `UP ${formatShares(net.yes)} / DOWN ${formatShares(net.no)}` };
  }
  if (fillLabel === 'single') {
    return { label: 'single', tone: 'warn', detail: `UP ${formatShares(net.yes)} / DOWN ${formatShares(net.no)}` };
  }
  if (round.settlementStatus === 'settled') {
    return { label: 'settled', tone: 'neutral', detail: round.settlementPnl == null ? 'settled without local fills' : formatMoney(round.settlementPnl) };
  }
  return { label: 'recorded', tone: 'neutral', detail: `${round.orderCount} orders` };
}

function formatEtTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'n/a';
  return `${date.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })} ET`;
}

function formatRelativeAge(ms: number, nowMs = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'n/a';
  const diffMs = Math.max(0, nowMs - ms);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h ago` : `${days}d ago`;
}

function formatEtClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'n/a';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

function formatEtDateKey(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown-date';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function formatEtDateLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'Unknown date';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(ms));
}

function formatEtRange(startMs: number, durationMs: number): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const endFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  return `${formatter.format(new Date(startMs))}-${endFormatter.format(new Date(startMs + durationMs))}`;
}

function roundStartTime(roundId: string): number {
  const match = roundId.match(/btc-updown-5m-(\d+)$/);
  if (!match) return 0;
  const startMs = Number(match[1]) * 1000;
  return Number.isFinite(startMs) ? startMs : 0;
}

function derivedRoundTitle(roundId: string): string {
  const startMs = roundStartTime(roundId);
  if (!startMs) return roundId;
  return `Bitcoin Up or Down - ${formatEtRange(startMs, 5 * 60_000)}`;
}

function toSortTime(value: string): number {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function formatShares(value: number): string {
  return value.toFixed(value % 1 === 0 ? 0 : 2);
}

function formatCooldownRemaining(until: string | undefined): string {
  if (!until) return 'inactive';
  const remainingMs = new Date(until).getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'inactive';
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m left`;
  return minutes > 0 ? `${hours}h ${minutes}m left` : `${hours}h left`;
}

function formatNullableMoney(value: number | null | undefined): string {
  return value == null ? 'unknown' : formatMoney(value);
}

function formatRatioPct(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? 'unknown' : `${formatNumber(value * 100, 1)}%`;
}

function runtimeBuildLabel(runtime: BotRuntimeStatus): string {
  const sha = runtime.buildSha && runtime.buildSha !== 'unknown' ? runtime.buildSha.slice(0, 7) : runtime.version;
  return `build ${sha}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function scoreBreakdown(features: DashboardState['latestSnapshot']['features']) {
  const centerCrosses = features.centerCross120s ?? features.cross120s;
  const centerMinExcursion = features.centerMinBiExcursionBps120s ?? features.minBiExcursionBps120s;
  const centerBalance = features.centerExcursionBalance120s ?? features.excursionBalance120s;
  return [
    { label: 'Center Crosses', value: clamp01(centerCrosses / 4) * 25, max: 25, detail: `${centerCrosses} crosses` },
    { label: 'Range', value: clamp01(features.rangeBps120s / 3) * 10, max: 10, detail: `${formatNumber(features.rangeBps120s, 2)}bps` },
    { label: 'Center Two-sided', value: clamp01(centerMinExcursion / 2) * 25, max: 25, detail: `${formatNumber(centerMinExcursion, 2)}bps` },
    { label: 'Center Balance', value: clamp01(centerBalance) * 15, max: 15, detail: formatNumber(centerBalance, 2) },
    { label: 'Drift', value: clamp01(1 - features.driftRatio120s / 0.7) * 15, max: 15, detail: formatNumber(features.driftRatio120s, 2) },
    { label: 'Momentum', value: clamp01(1 - features.momentumRatio30s / 0.8) * 10, max: 10, detail: formatNumber(features.momentumRatio30s, 2) },
  ];
}

function scoreTier(score: number): { label: string; price: string; size: string; next: string; tone: 'good' | 'warn' | 'neutral' } {
  if (score >= 95) return { label: 'A+ score tier', price: '0.460 cap', size: '1.25x size', next: 'top tier active', tone: 'good' };
  if (score >= 90) return { label: 'A score tier', price: '0.450 cap', size: '1.00x size', next: `${formatNumber(95 - score, 1)} pts to A+`, tone: 'good' };
  if (score >= 80) return { label: 'B score tier', price: '0.440 cap', size: '1.00x size', next: `${formatNumber(90 - score, 1)} pts to A`, tone: 'warn' };
  return { label: 'Base score tier', price: '0.420 cap', size: '0.50x size', next: `${formatNumber(Math.max(0, 80 - score), 1)} pts to B`, tone: score >= 70 ? 'warn' : 'neutral' };
}

function blockerDetail(condition: StrategyCheck['conditions'][number]): string {
  return `${condition.label}: ${condition.actual}`;
}

function sumShares(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function weightedAverageOrderPrice(orders: DashboardOrder[]): number | undefined {
  const totalShares = sumShares(orders.map((order) => order.size));
  if (totalShares <= 0) return undefined;
  return orders.reduce((total, order) => total + order.price * order.size, 0) / totalShares;
}

function formatSubmittedLeg(label: string, shares: number, price?: number): string {
  if (shares <= 0 || price == null) return `${label} -`;
  return `${label} ${formatShares(shares)} @ $${price.toFixed(3)}`;
}

function orderFilledShares(order: DashboardOrder, fills: DashboardFill[]): number {
  if (order.filledSize != null) return order.filledSize;
  if (order.status === 'filled') return order.size;
  if (!order.clobOrderId) return 0;
  return sumShares(fills.filter((fill) => fill.clobOrderId === order.clobOrderId).map((fill) => fill.size));
}

function orderMarketTitle(order: DashboardOrder): string {
  return order.marketTitle || derivedRoundTitle(order.roundId);
}

function strategySourceLabel(order: DashboardOrder): string {
  return order.strategy || 'BTC5M_DUAL_45';
}

function orderFailureReason(order: DashboardOrder): string {
  if (order.error) return order.error;
  if (order.status === 'cancelled') return 'closed after round ended';
  if (order.status === 'failed') return 'failed without stored reason';
  return '-';
}

function isRoutineHeartbeatLog(log: RuntimeLogRecord): boolean {
  const message = log.message.toLowerCase();
  return log.level === 'info'
    && (message === 'scheduled tick completed.' || message === 'scheduled tick completed');
}

function buildRoundExecutionSummaries(state: DashboardState): RoundExecutionSummary[] {
  const byRound = new Map<string, {
    orders: DashboardOrder[];
    fills: DashboardFill[];
    settlements: DashboardState['settlements'];
  }>();
  const ensure = (roundId: string) => {
    const existing = byRound.get(roundId);
    if (existing) return existing;
    const created = { orders: [], fills: [], settlements: [] };
    byRound.set(roundId, created);
    return created;
  };

  state.orders.forEach((order) => ensure(order.roundId).orders.push(order));
  state.fills.forEach((fill) => ensure(fill.roundId).fills.push(fill));
  state.settlements.forEach((settlement) => ensure(settlement.roundId).settlements.push(settlement));

  return [...byRound.entries()].map(([roundId, record]) => {
    const yesBuyOrders = record.orders.filter((order) => order.label === 'YES' && order.side === 'BUY');
    const noBuyOrders = record.orders.filter((order) => order.label === 'NO' && order.side === 'BUY');
    const unfilledByOrder = record.orders.map((order) => Math.max(0, order.size - orderFilledShares(order, record.fills)));
    const metadataSource = record.orders[0] || record.fills[0] || record.settlements[0];
    const settlement = [...record.settlements].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'settled' ? -1 : 1;
      return toSortTime(b.resolvedAt) - toSortTime(a.resolvedAt);
    })[0];
    const latestTime = Math.max(
      ...record.orders.map((order) => toSortTime(order.createdAt)),
      ...record.fills.map((fill) => toSortTime(fill.matchedAt)),
      ...record.settlements.map((settlement) => toSortTime(settlement.resolvedAt)),
      0,
    );
    const startTime = roundStartTime(roundId) || latestTime;

    return {
      roundId,
      title: metadataSource?.marketTitle || derivedRoundTitle(roundId),
      imageUrl: metadataSource?.imageUrl,
      latestTime,
      startTime,
      dateKey: formatEtDateKey(startTime),
      dateLabel: formatEtDateLabel(startTime),
      timeLabel: formatEtClock(startTime),
      orderCount: record.orders.length,
      buyOrderCount: record.orders.filter((order) => order.side === 'BUY').length,
      sellOrderCount: record.orders.filter((order) => order.side === 'SELL').length,
      failedOrderCount: record.orders.filter((order) => order.status === 'failed').length,
      firstOrderError: record.orders.find((order) => order.error)?.error,
      orderedYes: sumShares(yesBuyOrders.map((order) => order.size)),
      orderedNo: sumShares(noBuyOrders.map((order) => order.size)),
      orderedYesPrice: weightedAverageOrderPrice(yesBuyOrders),
      orderedNoPrice: weightedAverageOrderPrice(noBuyOrders),
      filledBuyYes: sumShares(record.fills.filter((fill) => fill.label === 'YES' && fill.side === 'BUY').map((fill) => fill.size)),
      filledBuyNo: sumShares(record.fills.filter((fill) => fill.label === 'NO' && fill.side === 'BUY').map((fill) => fill.size)),
      filledSellYes: sumShares(record.fills.filter((fill) => fill.label === 'YES' && fill.side === 'SELL').map((fill) => fill.size)),
      filledSellNo: sumShares(record.fills.filter((fill) => fill.label === 'NO' && fill.side === 'SELL').map((fill) => fill.size)),
      unfilledOrders: unfilledByOrder.filter((shares) => shares > 0.01).length,
      unfilledShares: sumShares(unfilledByOrder),
      settlementPnl: settlement?.pnl,
      settlementStatus: settlement?.status,
    };
  }).sort((a, b) => b.latestTime - a.latestTime);
}

function buildDailyExecutionSummaries(rounds: RoundExecutionSummary[]): DailyExecutionSummary[] {
  const byDate = new Map<string, RoundExecutionSummary[]>();
  rounds.forEach((round) => {
    const existing = byDate.get(round.dateKey);
    if (existing) existing.push(round);
    else byDate.set(round.dateKey, [round]);
  });

  return [...byDate.entries()].map(([dateKey, dayRounds]) => {
    const sortedRounds = [...dayRounds].sort((a, b) => b.startTime - a.startTime);
    const settlementPnl = sortedRounds.reduce((total, round) => total + (round.settlementPnl ?? 0), 0);
    return {
      dateKey,
      dateLabel: sortedRounds[0]?.dateLabel || dateKey,
      latestTime: Math.max(...sortedRounds.map((round) => round.latestTime), 0),
      rounds: sortedRounds,
      roundCount: sortedRounds.length,
      orderCount: sortedRounds.reduce((total, round) => total + round.orderCount, 0),
      buyOrderCount: sortedRounds.reduce((total, round) => total + round.buyOrderCount, 0),
      sellOrderCount: sortedRounds.reduce((total, round) => total + round.sellOrderCount, 0),
      pairedRounds: sortedRounds.filter((round) => {
        const net = netFilledShares(round);
        return fillStateLabel(net.yes, net.no) === 'paired';
      }).length,
      singleRounds: sortedRounds.filter((round) => {
        const net = netFilledShares(round);
        return fillStateLabel(net.yes, net.no) === 'single';
      }).length,
      unfilledOrders: sortedRounds.reduce((total, round) => total + round.unfilledOrders, 0),
      unfilledShares: sortedRounds.reduce((total, round) => total + round.unfilledShares, 0),
      settledRounds: sortedRounds.filter((round) => round.settlementStatus === 'settled').length,
      settlementPnl,
    };
  }).sort((a, b) => b.latestTime - a.latestTime);
}

function usePaginatedRows<T>(rows: T[], pageSize: number) {
  const [page, setPage] = React.useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages);

  React.useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  return {
    page: safePage,
    totalPages,
    pageRows: rows.slice((safePage - 1) * pageSize, safePage * pageSize),
    setPage,
  };
}

export function App() {
  const [state, setState] = React.useState<DashboardState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [autoRefreshing, setAutoRefreshing] = React.useState(false);
  const [lastRefreshAt, setLastRefreshAt] = React.useState<string | null>(null);
  
  // Navigation Tab State
  const [activeTab, setActiveTab] = React.useState<TabType>(() => tabFromUrl());
  const [activitySubTab, setActivitySubTab] = React.useState<ActivitySubTab>('daily');

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

  React.useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), DASHBOARD_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  React.useEffect(() => {
    syncTabToUrl(activeTab);
  }, [activeTab]);

  React.useEffect(() => {
    const handlePopState = () => setActiveTab(tabFromUrl());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Filter logs in real-time
  const filteredLogs = React.useMemo(() => {
    if (!state?.runtimeLogs) return [];
    return state.runtimeLogs.filter((log) => {
      const matchesSearch = logSearch
        ? log.message.toLowerCase().includes(logSearch.toLowerCase()) || 
          log.source.toLowerCase().includes(logSearch.toLowerCase())
        : true;
      const matchesLevel = logLevel === 'all' ? true : log.level === logLevel;
      const matchesSource = logSource === 'all' ? true : log.source === logSource;
      const matchesSignalMode = hideRoutineLogs ? !isRoutineHeartbeatLog(log) : true;
      return matchesSearch && matchesLevel && matchesSource && matchesSignalMode;
    });
  }, [state?.runtimeLogs, logSearch, logLevel, logSource, hideRoutineLogs]);

  const roundSummaries = React.useMemo(() => state ? buildRoundExecutionSummaries(state) : [], [state]);
  const dailySummaries = React.useMemo(() => buildDailyExecutionSummaries(roundSummaries), [roundSummaries]);

  const dailyPagination = usePaginatedRows(dailySummaries, DAILY_PAGE_SIZE);
  const roundPagination = usePaginatedRows(roundSummaries, ROUND_PAGE_SIZE);
  const ordersPagination = usePaginatedRows(state?.orders ?? [], ORDER_PAGE_SIZE);
  const logsPagination = usePaginatedRows(filteredLogs, LOG_PAGE_SIZE);

  React.useEffect(() => {
    dailyPagination.setPage(1);
    roundPagination.setPage(1);
  }, [roundSummaries.length]);

  React.useEffect(() => {
    ordersPagination.setPage(1);
  }, [state?.orders.length]);

  React.useEffect(() => {
    logsPagination.setPage(1);
  }, [logSearch, logLevel, logSource, hideRoutineLogs]);

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
          <p className="emptyText">Initializing BTC 5m Trading Terminal...</p>
        </div>
      </Shell>
    );
  }

  const snapshot = state.latestSnapshot;
  const entryCheck = state.strategyChecks.find((check) => check.strategy === 'BTC5M_DUAL_45');
  const entryEligibleLabel = entryCheck?.status === 'eligible' ? 'entry eligible' : 'entry blocked';
  const entryConditions = entryCheck?.conditions || [];
  const conditionByLabel = (label: string) => entryConditions.find((condition) => condition.label === label);
  const failedEntryConditions = entryConditions.filter((condition) => !condition.passed);
  const btcDecisionConditions = [
    'CHOP score threshold',
    'center cross_120s threshold',
    'range_120s sufficient',
    'center two-sided excursion',
    'drift ratio capped',
    'momentum ratio capped',
  ].map(conditionByLabel).filter((condition): condition is StrategyCheck['conditions'][number] => Boolean(condition));
  const orderbookDecisionConditions = [
    'YES book tradable',
    'NO book tradable',
  ].map(conditionByLabel).filter((condition): condition is StrategyCheck['conditions'][number] => Boolean(condition));
  const btcDecisionPassed = btcDecisionConditions.length > 0 && btcDecisionConditions.every((condition) => condition.passed);
  const orderbookDecisionPassed = orderbookDecisionConditions.length > 0 && orderbookDecisionConditions.every((condition) => condition.passed);
  const participationConditions = [
    'Participation data',
    'Holder count depth',
    'Top holder shares',
    'Holder concentration',
  ].map(conditionByLabel).filter((condition): condition is StrategyCheck['conditions'][number] => Boolean(condition));
  const participationDecisionPassed = participationConditions.length > 0 && participationConditions.every((condition) => condition.passed);
  const activeOrders = state.orders.filter((order) => (
    order.status === 'posted'
    || order.status === 'partially_filled'
    || (state.runtime.executionMode === 'monitor' && order.status === 'local')
  )).length;
  const pnl = state.settlements.reduce((sum, item) => sum + item.pnl, 0);
  const signalLogCount = state.runtimeLogs.filter((log) => !isRoutineHeartbeatLog(log)).length;
  const alertLogCount = state.runtimeLogs.filter((log) => log.level === 'warn' || log.level === 'error').length;

  // Time progress bar calculation
  const secondsToEnd = snapshot.round.secondsToEnd;
  const secondsToStart = snapshot.round.secondsToStart;
  const totalRoundDuration = 300; // 5 minutes
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

  // BTC volatility gauge inputs
  const btcPrice = snapshot.features.price;

  // Round phase detail text logic (prevents negative countdowns once started)
  const roundPhaseDetail = isRoundStarted
    ? `${formatSeconds(secondsToEnd)} remaining`
    : `${formatSeconds(secondsToStart)} to start`;
  const timelineDetail = isRoundStarted ? `${formatSeconds(secondsToEnd)} remaining` : `${formatSeconds(secondsToStart)} to start`;
  const strikeLabel = snapshot.round.strikeStatus === 'locked' ? 'Opening Strike' : 'Estimated Open';
  const entryStatusTone = entryCheck?.status === 'eligible' ? 'good' : entryCheck?.status === 'blocked' ? 'bad' : 'neutral';
  const entryStatusLabel = entryCheck?.status || 'not-loaded';
  const topBlockers = failedEntryConditions.slice(0, 4).map((condition) => condition.label).join(', ') || 'none';
  const entryLimit = entryCheck?.limitPrice;
  const entryPairCost = entryLimit == null ? null : entryLimit * 2;
  const entryPairEdge = entryPairCost == null ? null : 1 - entryPairCost;
  const entryConfig = state.runtime.entryConfig;
  const entryBypassActive = Boolean(entryConfig?.bypassEntryScoreGating);
  const fixedLimitActive = Boolean(entryConfig && !entryConfig.dynamicLimitEnabled);
  const fixedSharesActive = Boolean(entryConfig && !entryConfig.dynamicSharesEnabled);
  const fixedLimitLabel = entryConfig ? entryConfig.dualLimitPrice.toFixed(3) : '-';
  const fixedSharesLabel = entryConfig ? formatShares(entryConfig.orderSharesPerSide) : '-';
  const pricePolicyLabel = entryConfig
    ? fixedLimitActive ? `FIXED ${fixedLimitLabel}` : 'SCORE PRICE'
    : 'UNKNOWN';
  const sizePolicyLabel = entryConfig
    ? fixedSharesActive ? `FIXED ${fixedSharesLabel}` : 'SCORE SIZE'
    : 'UNKNOWN';
  const entryConfigValue = entryBypassActive ? 'BYPASS ALL' : 'RULE GATED';
  const entryConfigDetail = entryConfig
    ? `${pricePolicyLabel} / ${sizePolicyLabel} / ${entryConfig.bypassSingleFillCooldown ? 'cooldown bypass' : 'cooldown gate'}`
    : 'runtime entry config unavailable';
  const entryCooldownActive = Boolean(state.runtime.entryCooldownUntil && new Date(state.runtime.entryCooldownUntil).getTime() > Date.now());
  const entryCooldownRemaining = formatCooldownRemaining(state.runtime.entryCooldownUntil);
  const entryCooldownReason = state.runtime.entryCooldownReason || 'no single-fill lockout';
  const participation = snapshot.participation;
  const participationStatus = participation?.status || 'missing';
  const participationTone = participationStatus === 'enabled'
    ? (participationDecisionPassed ? 'good' : 'warn')
    : participationStatus === 'unavailable' ? 'warn' : 'neutral';
  const participationMaxPnl = participation?.maxPositionPnl;
  const participationSummary = participationStatus === 'enabled' && participation
    ? `sample top PnL ${formatNullableMoney(participationMaxPnl)} / sample sum ${formatMoney(participation.totalPositionPnl)}`
    : `${participationStatus}; not blocking`;
  const decisionWindowCondition = conditionByLabel('Decision window');
  const cooldownCondition = conditionByLabel('Single-fill cooldown');
  const entryWindowPassed = decisionWindowCondition?.passed ?? false;
  const scoreInfo = scoreTier(snapshot.features.chopScore);
  const scoreParts = scoreBreakdown(snapshot.features);
  const scoreMetricValue = entryBypassActive ? 'BYPASSED' : formatNumber(snapshot.features.chopScore, 1);
  const scoreMetricDetail = entryBypassActive
    ? `current score ${formatNumber(snapshot.features.chopScore, 1)} is diagnostic only`
    : `${scoreInfo.label}; ${scoreInfo.next}`;
  const priceSizeValue = entryConfig
    ? `${pricePolicyLabel} / ${sizePolicyLabel}`
    : `${scoreInfo.price} / ${scoreInfo.size}`;
  const priceSizeDetail = entryConfig
    ? fixedLimitActive || fixedSharesActive
      ? `env policy active; score tier ${scoreInfo.price} / ${scoreInfo.size} is diagnostic`
      : `score policy active; ${scoreInfo.next}`
    : entryLimit == null ? 'waiting for strategy cap' : `active limit ${entryLimit.toFixed(3)}, ${scoreInfo.next}`;
  const priceSizeTone = entryBypassActive || fixedLimitActive || fixedSharesActive ? 'neutral' : scoreInfo.tone;
  const currentEntryIntents = state.intents.filter((intent) => (
    intent.roundId === snapshot.round.id
    && intent.strategy === 'BTC5M_DUAL_45'
    && intent.status === 'generated'
  ));
  const previewShares = currentEntryIntents[0]?.shares;
  const previewLabels = currentEntryIntents.map((intent) => outcomeLabel(intent.label)).join(' + ');
  const entryActionDetail = entryCheck?.status === 'eligible'
    ? `${previewLabels || 'UP + DOWN'} BUY LIMIT${previewShares == null ? '' : `, ${formatShares(previewShares)} shares/side`} @ ${entryLimit == null ? 'strategy limit' : entryLimit.toFixed(3)}`
    : failedEntryConditions.slice(0, 3).map(blockerDetail).join(' / ') || entryCheck?.reason || 'waiting for strategy check';
  const decisionState = entryCheck?.status === 'eligible'
    ? { label: 'ENTER READY', detail: entryActionDetail, tone: 'good' as const }
    : entryCooldownActive || cooldownCondition?.passed === false
      ? { label: 'COOLDOWN', detail: cooldownCondition ? blockerDetail(cooldownCondition) : entryCooldownReason, tone: 'warn' as const }
      : isRoundStarted
        ? { label: 'POST-START MONITOR', detail: 'regular entries blocked; single-fill hedge may run in final window', tone: 'neutral' as const }
        : !entryWindowPassed
          ? { label: 'WAITING FOR T-30S', detail: decisionWindowCondition ? blockerDetail(decisionWindowCondition) : `${formatSeconds(secondsToStart)} to start`, tone: 'neutral' as const }
          : { label: 'BLOCKED', detail: entryActionDetail, tone: 'bad' as const };
  const buyPolicyStatus = entryCheck?.status === 'eligible'
    ? 'CAN ENTER'
    : isRoundStarted
      ? 'REGULAR BUY OFF'
      : entryWindowPassed
        ? 'DECISION WINDOW'
        : 'WAITING';
  const buyPolicyTone = entryCheck?.status === 'eligible' ? 'good' : entryWindowPassed && !isRoundStarted ? 'warn' : isRoundStarted ? 'bad' : 'neutral';
  const participationGateValue = participationStatus === 'enabled'
    ? (participationDecisionPassed ? 'PASS' : 'WEAK')
    : 'NOT BLOCKING';
  const participationGateTone = participationStatus === 'enabled'
    ? (participationDecisionPassed ? 'good' : 'warn')
    : 'neutral';

  return (
    <Shell>
      {/* Top Header Bar */}
      <section className="topbar">
        <div>
          <h1>
            <Cpu size={24} style={{ color: 'var(--color-primary)' }} />
            Poly BTC 5m Terminal
          </h1>
        </div>
        
        {/* Navigation Tabs */}
        <nav className="tabBar">
          <button className={`tabBtn ${activeTab === 'terminal' ? 'active' : ''}`} onClick={() => setActiveTab('terminal')}>
            <Terminal size={14} /> Terminal
          </button>
          <button className={`tabBtn ${activeTab === 'orderbooks' ? 'active' : ''}`} onClick={() => setActiveTab('orderbooks')}>
            <BookOpen size={14} /> Order Books
          </button>
          <button className={`tabBtn ${activeTab === 'activity' ? 'active' : ''}`} onClick={() => setActiveTab('activity')}>
            <History size={14} /> Activity & PnL
          </button>
          <button className={`tabBtn ${activeTab === 'strategy' ? 'active' : ''}`} onClick={() => setActiveTab('strategy')}>
            <Cpu size={14} /> Strategy Rules
          </button>
          <button className={`tabBtn ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>
            <Terminal size={14} /> Logs
          </button>
        </nav>

        <div className="actions">
          <div className="refreshStatus" title="All dashboard panels refresh from /api/state on the same polling cycle.">
            <RefreshCw size={13} className={autoRefreshing ? 'spin' : ''} />
            <span>{autoRefreshing ? 'Updating' : `Auto ${Math.round(DASHBOARD_REFRESH_MS / 1000)}s`}</span>
            <strong>{lastRefreshAt ? formatEtTime(lastRefreshAt) : 'pending'}</strong>
          </div>
          <button type="button" onClick={() => load()} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
            {refreshing ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
      </section>

      {/* Top Status Cards / Digest */}
      <section className="digest">
        <div className="digestGroup action">
          <span className="digestGroupLabel">Action</span>
          <Digest
            icon={<Timer size={16} />}
            label="Round Phase"
            value={snapshot.round.phase.toUpperCase()}
            detail={roundPhaseDetail}
            tone={snapshot.round.phase === 'decision' || snapshot.round.phase === 'posting' ? 'warn' : 'neutral'}
            priority="primary"
          />
          <Digest
            icon={<TrendingUp size={16} />}
            label="Market Regime"
            value={snapshot.regime}
            detail={`Score ${formatNumber(snapshot.features.chopScore, 1)} / ${entryEligibleLabel}`}
            tone={snapshot.regime === 'CHOP' ? 'good' : snapshot.regime === 'TREND' ? 'bad' : 'neutral'}
            priority="primary"
          />
          <Digest
            icon={<Timer size={16} />}
            label="Entry Cooldown"
            value={entryCooldownActive ? 'ACTIVE' : 'INACTIVE'}
            detail={entryCooldownActive ? `${entryCooldownRemaining} / ${entryCooldownReason}` : entryCooldownReason}
            tone={entryCooldownActive ? 'warn' : 'neutral'}
            priority="primary"
          />
          <Digest
            icon={<Shield size={16} />}
            label="Active Trades"
            value={`${activeOrders} Orders`}
            detail={`${state.fills.length} fills / ${state.orders.length} total`}
            tone={activeOrders ? 'warn' : 'neutral'}
            priority="primary"
          />
        </div>
        <div className="digestGroup system">
          <span className="digestGroupLabel">System</span>
          <Digest
            icon={<Activity size={16} />}
            label="Runtime"
            value={state.runtime.status.toUpperCase()}
            detail={`${modeLabel(state.runtime.executionMode)} / ${runtimeBuildLabel(state.runtime)}`}
            tone={state.runtime.executionMode === 'live' ? 'warn' : 'neutral'}
          />
          <Digest
            icon={<Cpu size={16} />}
            label="Strategy Profile"
            value={state.runtime.activeStrategyProfile}
            detail={state.runtime.experimentStoppedAt ? `${state.runtime.experimentStoppedReason || 'stopped'} / ${state.runtime.experimentStoppedRoundId || 'unknown round'}` : 'running selected profile'}
            tone={state.runtime.activeStrategyProfile === 'experiment_next_round' ? 'warn' : 'neutral'}
          />
          <Digest
            icon={<SlidersHorizontal size={16} />}
            label="Entry Config"
            value={entryConfigValue}
            detail={entryConfigDetail}
            tone={entryBypassActive ? 'warn' : fixedLimitActive || fixedSharesActive ? 'neutral' : 'good'}
          />
          <Digest
            icon={<Radio size={16} />}
            label="Feeds Connection"
            value={state.feed.source.toUpperCase()}
            detail={`BINANCE: ${state.feed.binanceConnected ? 'ON' : 'OFF'} / CLOB: ${state.feed.clobConnected ? 'ON' : 'OFF'}`}
            tone={state.feed.source === 'live' && state.feed.binanceConnected ? 'good' : 'warn'}
          />
        </div>
        <div className="digestGroup result">
          <span className="digestGroupLabel">Results</span>
          <Digest
            icon={<CheckCircle2 size={16} />}
            label="Net Realized PnL"
            value={formatMoney(pnl)}
            detail={`${state.settlements.length} settled rounds`}
            tone={pnl > 0 ? 'good' : pnl < 0 ? 'bad' : 'neutral'}
          />
          <Digest
            icon={<Users size={16} />}
            label="Participation"
            value={participationStatus.toUpperCase()}
            detail={participationSummary}
            tone={participationTone}
          />
        </div>
      </section>

      {/* Main Tabbed Area */}
      <main>
        {activeTab === 'terminal' && (
          <div className="grid">
            {/* Left Column (Main widgets) */}
            <div className="span-8" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div className="decisionPanel">
                <div className="decisionHeader">
                  <div>
                    <span className="decisionKicker">Next Round Pre-Start Decision</span>
                    <strong>{entryCheck?.title || 'BTC 5m Dynamic Dual Pre-Round'}</strong>
                  </div>
                  <Badge tone={entryStatusTone}>{entryStatusLabel}</Badge>
                </div>
                <div className={`decisionSummary ${decisionState.tone}`}>
                  <div>
                    <span className="decisionKicker">Current Action</span>
                    <strong>{decisionState.label}</strong>
                    <p>{decisionState.detail}</p>
                    {failedEntryConditions.length > 0 && (
                      <div className="blockerChips">
                        {failedEntryConditions.slice(0, 3).map((condition) => (
                          <span key={condition.label}>{condition.label}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="decisionSummaryMeta">
                    <span>{entryCheck?.reason || 'Strategy check has not loaded yet'}</span>
                    <strong>{state.runtime.executionMode === 'live' ? 'LIVE EXECUTION' : 'MONITOR ONLY'}</strong>
                  </div>
                </div>
                <div className="decisionGrid">
                  <DecisionMetric
                    label="BUY Policy"
                    value={buyPolicyStatus}
                    detail={decisionWindowCondition?.actual || (isRoundStarted ? 'entries closed after start' : `${formatSeconds(secondsToStart)} before start`)}
                    tone={buyPolicyTone}
                  />
                  <DecisionMetric
                    label="BTC Dynamic Score"
                    value={scoreMetricValue}
                    detail={scoreMetricDetail}
                    tone={entryBypassActive ? 'neutral' : btcDecisionPassed ? 'good' : 'bad'}
                  />
                  <DecisionMetric
                    label="Entry Price / Size"
                    value={priceSizeValue}
                    detail={priceSizeDetail}
                    tone={priceSizeTone}
                  />
                  <DecisionMetric
                    label="Entry Bypass"
                    value={entryConfigValue}
                    detail={entryBypassActive ? 'strategy blockers and entry quote gate are bypassed; cooldown still gates' : `live score floor ${entryConfig?.minLiveChopScore ?? 80}; confirmation ${entryConfig?.entryConfirmTicks ?? 3} ticks`}
                    tone={entryBypassActive ? 'warn' : 'neutral'}
                  />
                  <DecisionMetric
                    label="Entry Limit"
                    value={entryLimit == null ? '-' : entryLimit.toFixed(3)}
                    detail={entryPairCost == null || entryPairEdge == null ? 'waiting for strategy check' : `pair cost ${entryPairCost.toFixed(3)} / edge ${entryPairEdge.toFixed(3)}`}
                    tone={entryLimit == null ? 'neutral' : entryPairEdge != null && entryPairEdge >= 0.08 ? 'good' : 'warn'}
                  />
                  <DecisionMetric
                    label="Orderbook Role"
                    value={orderbookDecisionPassed ? 'TRADABLE' : 'NOT TRADABLE'}
                    detail="live/fresh token books with buy ask only"
                    tone={orderbookDecisionPassed ? 'good' : 'bad'}
                  />
                  <DecisionMetric
                    label="Participation Gate"
                    value={participationGateValue}
                    detail={participationSummary}
                    tone={participationGateTone}
                  />
                  <DecisionMetric
                    label="Post-Start Actions"
                    value="REGULAR OFF"
                    detail="no add/sell/rebalance; capped single-fill hedge can run late"
                    tone="neutral"
                  />
                  <DecisionMetric
                    label="Current Blockers"
                    value={failedEntryConditions.length ? String(failedEntryConditions.length) : '0'}
                    detail={topBlockers}
                    tone={failedEntryConditions.length ? 'warn' : 'good'}
                  />
                </div>
                <details className="collapsiblePanel">
                  <summary>
                    <span>Score Composition</span>
                    <strong>{formatNumber(snapshot.features.chopScore, 1)} / 70</strong>
                  </summary>
                  <div className="scorePanelBody">
                    <div className="scoreGaugeColumn">
                      <ScoreGauge score={snapshot.features.chopScore} threshold={70} />
                    </div>
                    <div className="scoreBreakdownColumn">
                      <div className="scoreBreakdown">
                        {scoreParts.map((part) => (
                          <div key={part.label} className="scorePart">
                            <div className="scorePartTop">
                              <span>{part.label}</span>
                              <strong>{formatNumber(part.value, 1)} / {part.max}</strong>
                            </div>
                            <div className="scoreTrack">
                              <div className="scoreFill" style={{ width: `${Math.max(2, Math.min(100, (part.value / part.max) * 100))}%` }}></div>
                            </div>
                            <em>{part.detail}</em>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </details>
              </div>
              
              {/* BTC Volatility Visualizer */}
              {btcPrice != null && (
                <div className="panel">
                  <h2>BTC 120s Volatility</h2>
                  <PriceStrikeGauge
                    btcPrice={btcPrice}
                    centerPrice={snapshot.features.centerPrice120s}
                    rangeBps120s={snapshot.features.rangeBps120s}
                    volatility120s={snapshot.features.volatility120s}
                    centerMinBiExcursionBps120s={snapshot.features.centerMinBiExcursionBps120s ?? snapshot.features.minBiExcursionBps120s}
                    centerExcursionBalance120s={snapshot.features.centerExcursionBalance120s ?? snapshot.features.excursionBalance120s}
                    latestRangePosition120s={snapshot.features.latestRangePosition120s}
                  />
                </div>
              )}

              {/* Active Positions Panel */}
              <div className="panel">
                <h2>Active Portfolio Positions</h2>
                <div className="positionsList">
                  {snapshot.positions && snapshot.positions.length > 0 ? (
                    snapshot.positions.map((pos) => {
                      const quote = snapshot.orderbooks.find((q) => q.tokenId === pos.tokenId);
                      // Estimate current market price from orderbook midpoint or best bid/ask
                      const currentPrice = pos.currentPrice ?? quote?.midpoint ?? (
                        (quote?.bestBid != null && quote?.bestAsk != null) 
                          ? (quote.bestBid + quote.bestAsk) / 2 
                          : pos.avgPrice
                      );
                      const unrealizedPnL = (currentPrice - pos.avgPrice) * pos.shares;
                      const value = currentPrice * pos.shares;
                      const cost = pos.shares * pos.avgPrice;
                      
                      return (
                        <div key={pos.tokenId} className={`positionCard ${pos.label}`}>
                          <div className="posToken">
                            <div className="posTokenName">{pos.title || `${outcomeLabel(pos.label)} Token`}</div>
                            <div className="posTokenSide">{outcomeLabel(pos.label)} Shares</div>
                          </div>
                          <div className="posStats">
                            <span>Shares / Avg Entry</span>
                            <strong>{formatNumber(pos.shares, 1)} @ {pos.avgPrice.toFixed(3)}</strong>
                          </div>
                          <div className="posStats">
                            <span>Market Value / Cost</span>
                            <strong>{formatMoney(value)} / {formatMoney(cost)}</strong>
                          </div>
                          <div className="posPnL">
                            <span>Unrealized PnL</span>
                            <strong className={`posPnLAmount ${unrealizedPnL >= 0 ? 'profit' : 'loss'}`}>
                              {unrealizedPnL >= 0 ? '+' : ''}{formatMoney(unrealizedPnL)}
                            </strong>
                          </div>
                        </div>
                      );
                    })
                  ) : snapshot.positionReadStatus === 'disabled' ? (
                    <div className="empty" style={{ minHeight: '100px', background: 'rgba(0, 0, 0, 0.008)', border: '1px dashed var(--border-color)', borderRadius: '10px' }}>
                      <Info size={20} style={{ color: 'var(--text-muted)' }} />
                      <p className="emptyText">Position reads disabled until a deposit wallet is configured</p>
                    </div>
                  ) : (
                    <div className="empty" style={{ minHeight: '100px', background: 'rgba(0, 0, 0, 0.008)', border: '1px dashed var(--border-color)', borderRadius: '10px' }}>
                      <Info size={20} style={{ color: 'var(--text-muted)' }} />
                      <p className="emptyText">No active token positions held in this round</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Strategy Checks */}
              <details className="panel collapsiblePanel checksPanel">
                <summary>
                  <span>Strategy Eligibility & Entry Checks</span>
                  <strong>{failedEntryConditions.length ? `${failedEntryConditions.length} blockers` : 'clear'}</strong>
                </summary>
                <div className="checks">
                  {state.strategyChecks.map((check) => (
                    <article key={check.strategy} className={`checkCard ${check.status}`}>
                      <div className="checkCardHeader">
                        <h3>{check.title}</h3>
                        <Badge tone={check.status === 'eligible' ? 'good' : check.status === 'blocked' ? 'bad' : 'neutral'}>
                          {check.status}
                        </Badge>
                      </div>
                      <p className="checkReason">{check.reason}</p>
                      <div className="checkConditions">
                        {check.conditions.map((condition) => (
                          <div key={condition.label} className="checkConditionRow">
                            <span className="checkConditionLabel">{condition.label}</span>
                            <span className={`checkConditionValue ${condition.passed ? 'pass' : 'fail'}`}>
                              {condition.actual}
                            </span>
                          </div>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              </details>
            </div>

            {/* Right Column (Side status metrics) */}
            <div className="span-4" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              
              {/* Round Progress Countdown */}
              <div className="panel">
                <h2>Round Timeline</h2>
                <RoundTimelinePipeline
                  phase={snapshot.round.phase}
                  timelineDetail={timelineDetail}
                  progressPct={progressPct}
                  progressColorClass={progressColorClass}
                />
              </div>

              {/* Round Details */}
              <div className="panel">
                <h2>Round Specifications</h2>
                <div className="metrics">
                  <div className="metricRow">
                    <span className="metricLabel">Round ID</span>
                    <span className="metricValue">{snapshot.round.id}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Snapshot ID</span>
                    <span className="metricValue" style={{ fontSize: '11px' }}>{snapshot.id}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Event Slug</span>
                    <span className="metricValue" style={{ fontSize: '11px' }}>{snapshot.round.eventSlug}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">{strikeLabel}</span>
                    <span className="metricValue">${formatNumber(snapshot.round.strike, 2)}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Start Time</span>
                    <span className="metricValue">{formatEtTime(snapshot.round.startAt)}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">End Time</span>
                    <span className="metricValue">{formatEtTime(snapshot.round.endAt)}</span>
                  </div>
                </div>
              </div>

              <div className="panel">
                <h2>Market Participation</h2>
                <div className="metrics">
                  <div className="metricRow">
                    <span className="metricLabel">Data Status</span>
                    <span className="metricValue"><Badge tone={participationTone}>{participationStatus}</Badge></span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Sample Top PnL</span>
                    <span className="metricValue">{formatNullableMoney(participation?.maxPositionPnl)}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Sample PnL Sum</span>
                    <span className="metricValue">{participation ? formatMoney(participation.totalPositionPnl) : 'unknown'}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Top Holder Shares</span>
                    <span className="metricValue">{participation ? formatNumber(participation.totalTopHolderShares, 1) : 'unknown'}</span>
                  </div>
                  {participation?.sides.map((side) => (
                    <React.Fragment key={side.label}>
                      <div className="metricRow">
                        <span className="metricLabel">{outcomeLabel(side.label)} Holders</span>
                        <span className="metricValue">{side.holderCount} / top {participation.topHoldersPerSide}</span>
                      </div>
                      <div className="metricRow">
                        <span className="metricLabel">{outcomeLabel(side.label)} Top Shares</span>
                        <span className="metricValue">{formatNumber(side.topHolderShares, 1)}</span>
                      </div>
                      <div className="metricRow">
                        <span className="metricLabel">{outcomeLabel(side.label)} Concentration</span>
                        <span className="metricValue">{formatRatioPct(side.largestHolderShareRatio)}</span>
                      </div>
                      <div className="metricRow">
                        <span className="metricLabel">{outcomeLabel(side.label)} Sample PnL</span>
                        <span className="metricValue">{formatMoney(side.positionPnlSum)} / top {formatNullableMoney(side.topPositionPnl)}</span>
                      </div>
                    </React.Fragment>
                  ))}
                </div>
              </div>

              {/* Analytics Features */}
              <div className="panel">
                <h2>Path Features (120s)</h2>
                <div className="metrics">
                  <div className="metricRow">
                    <span className="metricLabel">Data Feed Source</span>
                    <span className="metricValue"><Badge tone="good">{snapshot.features.source}</Badge></span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Price Samples</span>
                    <span className="metricValue">{snapshot.features.samples120s}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Strike Crosses</span>
                    <span className="metricValue">{snapshot.features.cross120s}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Center Price</span>
                    <span className="metricValue">{snapshot.features.centerPrice120s == null ? 'unknown' : formatMoney(snapshot.features.centerPrice120s)}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Center Crosses</span>
                    <span className="metricValue">{snapshot.features.centerCross120s ?? snapshot.features.cross120s}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">CHOP Score</span>
                    <span className="metricValue">{formatNumber(snapshot.features.chopScore, 1)}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Range (120s)</span>
                    <span className="metricValue">{formatNumber(snapshot.features.range120s, 2)} / {formatNumber(snapshot.features.rangeBps120s, 2)}bps</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Range (300s)</span>
                    <span className="metricValue">{formatNumber(snapshot.features.range300s, 2)} / {formatNumber(snapshot.features.rangeBps300s, 2)}bps</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Two-Sided Excursion</span>
                    <span className="metricValue">{formatNumber(snapshot.features.minBiExcursionBps120s, 2)}bps</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Center Two-Sided</span>
                    <span className="metricValue">{formatNumber(snapshot.features.centerMinBiExcursionBps120s ?? snapshot.features.minBiExcursionBps120s, 2)}bps</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Latest Range Position</span>
                    <span className="metricValue">{formatRatioPct(snapshot.features.latestRangePosition120s)}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Excursion Balance</span>
                    <span className="metricValue">{formatNumber(snapshot.features.excursionBalance120s, 2)}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Volatility (120s)</span>
                    <span className="metricValue">{formatNumber(snapshot.features.volatility120s, 2)}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Drift (120s)</span>
                    <span className="metricValue">{formatNumber(snapshot.features.drift120s, 2)}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Momentum (30s)</span>
                    <span className="metricValue">{formatNumber(snapshot.features.momentum30s, 2)}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Drift / Momentum Ratio</span>
                    <span className="metricValue">{formatNumber(snapshot.features.driftRatio120s, 2)} / {formatNumber(snapshot.features.momentumRatio30s, 2)}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Range Percentile</span>
                    <span className="metricValue">{snapshot.features.rangePercentile120s == null ? '-' : formatNumber(snapshot.features.rangePercentile120s * 100, 1) + '%'}</span>
                  </div>
                </div>
              </div>

              {/* System Diagnostics */}
              {snapshot.diagnostics && snapshot.diagnostics.length > 0 && (
                <div className="panel">
                  <h2>Diagnostics</h2>
                  <div className="metrics" style={{ gap: '8px' }}>
                    {snapshot.diagnostics.map((diag, i) => (
                      <div key={i} className="metricRow" style={{ borderBottom: 'none', padding: '2px 0' }}>
                        <span className="metricValue" style={{ color: 'var(--color-warning)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
                          • {diag}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'orderbooks' && (
          <div className="panel">
            <h2>Polymarket CLOB Order Books</h2>
            <OrderbookExecutionSummary quotes={snapshot.orderbooks} yesTokenId={snapshot.round.yesTokenId} noTokenId={snapshot.round.noTokenId} />
            <OrderbookCapacityPanel depth={snapshot.orderbookDepth} />
            <OrderbookTable quotes={snapshot.orderbooks} yesTokenId={snapshot.round.yesTokenId} noTokenId={snapshot.round.noTokenId} />
          </div>
        )}

        {activeTab === 'activity' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="panel">
              <h2>
                Execution Review
                <span className="panelSubTitle">
                  {roundSummaries.length} rounds / {state.orders.length} orders
                </span>
              </h2>

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
                  <span>{state.orders.length}</span>
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
                            headers={['Time (ET)', 'Age', 'Market', 'Round Status', 'Orders', 'Submitted Buy Orders', 'Filled Buy Shares', 'Unfilled', 'Settlement PnL']}
                            className="executionTable dailyExecutionTable"
                          >
                            {day.rounds.map((round) => {
                              const hasUnfilled = round.unfilledOrders > 0;
                              const net = netFilledShares(round);
                              const fillLabel = fillStateLabel(net.yes, net.no);
                              const status = roundStatusSummary(round);
                              return (
                                <tr key={round.roundId}>
                                  <td className="mono timeCell">{round.timeLabel}</td>
                                  <td className="ageCell"><span>{formatRelativeAge(round.startTime)}</span></td>
                                  <td>
                                    <div className="marketCell">
                                      {round.imageUrl ? (
                                        <img src={round.imageUrl} alt="" className="marketThumb" />
                                      ) : (
                                        <span className="marketThumb marketThumbFallback">₿</span>
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
                      headers={['Age', 'Market', 'Round ID', 'Round Status', 'Orders', 'Submitted Buy Orders', 'Filled Buy Shares', 'Filled Sell Shares', 'Unfilled', 'Settlement PnL']}
                      className="executionTable roundExecutionTable"
                    >
                      {roundPagination.pageRows.map((round) => {
                        const hasUnfilled = round.unfilledOrders > 0;
                        const net = netFilledShares(round);
                        const fillLabel = fillStateLabel(net.yes, net.no);
                        const status = roundStatusSummary(round);
                        return (
                          <tr key={round.roundId}>
                            <td className="ageCell"><span>{formatRelativeAge(round.startTime)}</span></td>
                            <td>
                              <div className="marketCell">
                                {round.imageUrl ? (
                                  <img src={round.imageUrl} alt="" className="marketThumb" />
                                ) : (
                                  <span className="marketThumb marketThumbFallback">₿</span>
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
                state.orders.length > 0 ? (
                  <>
                    <DataTable headers={['Time (ET)', 'Strategy', 'Market', 'Round ID', 'Outcome', 'Side', 'Price', 'Size', 'Status', 'Reason', 'Polymarket CLOB Order ID']}>
                      {ordersPagination.pageRows.map((order) => (
                        <tr key={order.id}>
                          <td className="mono">{formatEtTime(order.createdAt)}</td>
                          <td className="mono" style={{ fontSize: '11px' }}>{strategySourceLabel(order)}</td>
                          <td>
                            <span className="marketTitle">{orderMarketTitle(order)}</span>
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
                      totalRows={state.orders.length}
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

// Layout helper components
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="appShell">{children}</div>;
}

function Digest({ 
  icon, 
  label, 
  value, 
  detail, 
  tone,
  priority = 'secondary',
}: { 
  icon: React.ReactNode; 
  label: string; 
  value: string; 
  detail: string; 
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  priority?: 'primary' | 'secondary';
}) {
  return (
    <div className={`digestCard ${tone} ${priority}`}>
      <div className="digestHeader">
        {icon}
        <span>{label}</span>
        {(tone === 'good' || tone === 'warn' || tone === 'bad') && (
          <span className={`liveDot ${tone}`} style={{ marginLeft: 'auto' }}></span>
        )}
      </div>
      <strong className="digestValue">{value}</strong>
      <em className="digestDetail">{detail}</em>
    </div>
  );
}

function DecisionMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  return (
    <div className={`decisionMetric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{detail}</em>
    </div>
  );
}

function OrderbookExecutionSummary({ quotes, yesTokenId, noTokenId }: { quotes: OrderBookQuote[]; yesTokenId: string; noTokenId: string }) {
  const yesQuote = quotes.find((quote) => quote.tokenId === yesTokenId);
  const noQuote = quotes.find((quote) => quote.tokenId === noTokenId);
  const pairAskCost = yesQuote?.bestAsk != null && noQuote?.bestAsk != null ? yesQuote.bestAsk + noQuote.bestAsk : null;
  const pairEdge = pairAskCost == null ? null : 1 - pairAskCost;
  const spreadState = quotes.length === 0 ? 'UNKNOWN' : quotes.every((quote) => quote.spread != null && quote.spread <= 0.02) ? 'TIGHT' : 'WIDE';
  const yesDepth = yesQuote ? yesQuote.askDepth + yesQuote.bidDepth : 0;
  const noDepth = noQuote ? noQuote.askDepth + noQuote.bidDepth : 0;
  const depthRatio = yesDepth > 0 && noDepth > 0 ? Math.max(yesDepth, noDepth) / Math.min(yesDepth, noDepth) : null;
  const imbalanceLabel = depthRatio == null ? 'UNKNOWN' : depthRatio >= 2 ? 'IMBALANCED' : 'BALANCED';
  const newestQuoteAt = quotes.length ? Math.max(...quotes.map((quote) => toSortTime(quote.updatedAt)), 0) : 0;

  return (
    <div className="orderbookSummary">
      <DecisionMetric
        label="Pair Ask Cost"
        value={pairAskCost == null ? '-' : pairAskCost.toFixed(3)}
        detail={pairEdge == null ? 'waiting for both books' : `edge ${pairEdge.toFixed(3)}`}
        tone={pairEdge == null ? 'neutral' : pairEdge >= 0.08 ? 'good' : 'warn'}
      />
      <DecisionMetric
        label="Executable Pair"
        value={pairAskCost == null ? 'MISSING' : pairAskCost <= 0.9 ? 'AVAILABLE' : 'EXPENSIVE'}
        detail={`UP ${yesQuote?.bestAsk == null ? '-' : yesQuote.bestAsk.toFixed(3)} / DOWN ${noQuote?.bestAsk == null ? '-' : noQuote.bestAsk.toFixed(3)}`}
        tone={pairAskCost == null ? 'bad' : pairAskCost <= 0.9 ? 'good' : 'warn'}
      />
      <DecisionMetric
        label="Spread State"
        value={spreadState}
        detail={quotes.length ? quotes.map((quote) => quote.spread == null ? '-' : quote.spread.toFixed(3)).join(' / ') : 'no quotes'}
        tone={spreadState === 'TIGHT' ? 'good' : spreadState === 'WIDE' ? 'warn' : 'neutral'}
      />
      <DecisionMetric
        label="Liquidity Balance"
        value={imbalanceLabel}
        detail={depthRatio == null ? 'depth unavailable' : `${depthRatio.toFixed(2)}x depth ratio`}
        tone={imbalanceLabel === 'BALANCED' ? 'good' : imbalanceLabel === 'IMBALANCED' ? 'warn' : 'neutral'}
      />
      <DecisionMetric
        label="Book Freshness"
        value={quotes.length === 0 ? 'UNKNOWN' : quotes.every((quote) => quote.source === 'ws') ? 'LIVE WS' : 'MIXED'}
        detail={newestQuoteAt ? formatEtTime(new Date(newestQuoteAt).toISOString()) : 'not updated'}
        tone={quotes.length > 0 && quotes.every((quote) => quote.source === 'ws') ? 'good' : 'neutral'}
      />
    </div>
  );
}

function OrderbookCapacityPanel({ depth }: { depth?: OrderbookDepthSnapshot }) {
  if (!depth) {
    return (
      <div className="orderbookCapacityBlock">
        <p className="emptyText">No orderbook depth capacity snapshot yet</p>
      </div>
    );
  }
  const activeLevel = nearestDepthLevel(depth);

  return (
    <div className="orderbookCapacityBlock">
      <div className="capacityHeader">
        <div>
          <h3>Strategy Capacity</h3>
          <p>
            Active limit {formatCapacityPrice(depth.activeLimitPrice)} / current size {formatCapacityShares(depth.baseSharesPerSide)} shares per side / {formatEtTime(depth.updatedAt)}
          </p>
        </div>
        <Badge tone={depth.status === 'ready' ? 'good' : 'warn'}>{depth.status.toUpperCase()}</Badge>
      </div>

      {depth.diagnostics.length > 0 && (
        <div className="capacityDiagnostics">
          {depth.diagnostics.map((item) => <span key={item}>{item}</span>)}
        </div>
      )}

      <div className="capacityTierGrid">
        {depth.tiers.map((tier) => (
          <DecisionMetric
            key={tier.label}
            label={tier.label}
            value={`${formatCapacityShares(tier.maxSharesPerSide)} sh`}
            detail={`~${formatMoney(tier.maxPairAmountUsd)} pair / ${formatNumber(tier.exactLevelSharePct * 100, 0)}% level cap`}
            tone={tier.tone}
          />
        ))}
      </div>

      <div className="capacityFocus">
        <DecisionMetric
          label="Active Maker Queue"
          value={formatCapacityShares(activeLevel?.minBidQueueShares ?? 0)}
          detail={`min shares at-or-above ${formatCapacityPrice(depth.activeLimitPrice)}`}
          tone={(activeLevel?.minBidQueueShares ?? 0) >= depth.baseSharesPerSide * 10 ? 'good' : 'warn'}
        />
        <DecisionMetric
          label="Same-Level Queue"
          value={formatCapacityShares(activeLevel?.minBidAtLimitShares ?? 0)}
          detail="thin side at exact active limit"
          tone={(activeLevel?.minBidAtLimitShares ?? 0) >= depth.baseSharesPerSide * 5 ? 'good' : 'warn'}
        />
        <DecisionMetric
          label="Immediate Fill"
          value={formatCapacityShares(activeLevel?.pairedImmediateShares ?? 0)}
          detail={`marketable shares at ${formatCapacityPrice(depth.activeLimitPrice)}`}
          tone={(activeLevel?.pairedImmediateShares ?? 0) > 0 ? 'warn' : 'neutral'}
        />
      </div>

      <DataTable headers={['Limit', 'Immediate Pair', 'Immediate Cost', 'Maker Queue', 'Same-Level Queue', 'Queue Ratio']}>
        {depth.levels.map((level) => (
          <tr key={level.limitPrice} className={Math.abs(level.limitPrice - depth.activeLimitPrice) < 0.000001 ? 'activeDepthRow' : undefined}>
            <td className="mono">{formatCapacityPrice(level.limitPrice)}</td>
            <td className="mono">{formatCapacityShares(level.pairedImmediateShares)} sh</td>
            <td className="mono">{formatMoney(level.pairedImmediateCostUsd)}</td>
            <td className="mono">{formatCapacityShares(level.minBidQueueShares)} sh</td>
            <td className="mono">{formatCapacityShares(level.minBidAtLimitShares)} sh</td>
            <td className="mono">{level.queueRatio == null ? '-' : `${formatNumber(level.queueRatio, 2)}x`}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

function nearestDepthLevel(depth: OrderbookDepthSnapshot) {
  return depth.levels.find((level) => Math.abs(level.limitPrice - depth.activeLimitPrice) < 0.000001)
    || depth.levels.reduce((closest, level) => (
      Math.abs(level.limitPrice - depth.activeLimitPrice) < Math.abs(closest.limitPrice - depth.activeLimitPrice) ? level : closest
    ), depth.levels[0]);
}

function formatCapacityPrice(value: number): string {
  return `${Math.round(value * 100)}c`;
}

function formatCapacityShares(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 1000) return `${formatNumber(value / 1000, 1)}k`;
  return formatNumber(value, value >= 100 ? 0 : 1);
}

function OrderbookTable({ quotes, yesTokenId, noTokenId }: { quotes: OrderBookQuote[]; yesTokenId: string; noTokenId: string }) {
  // Scale depths relative to max depths found in the quotes list
  const maxBidDepth = Math.max(...quotes.map((q) => q.bidDepth), 1);
  const maxAskDepth = Math.max(...quotes.map((q) => q.askDepth), 1);

  return (
    <DataTable headers={['Outcome', 'Token ID', 'Data Source', 'Best Bid', 'Best Ask', 'Midpoint', 'Spread', 'Bid Liquidity (Depth)', 'Ask Liquidity (Depth)', 'Last Updated (ET)']}>
      {quotes.map((quote) => {
        const bidPct = (quote.bidDepth / maxBidDepth) * 80; // max 80% width
        const askPct = (quote.askDepth / maxAskDepth) * 80;
        const label = quote.tokenId === yesTokenId ? 'YES' : quote.tokenId === noTokenId ? 'NO' : null;
        
        return (
          <tr key={quote.tokenId}>
            <td>{label ? <Badge tone={outcomeTone(label)}>{outcomeLabel(label)}</Badge> : '-'}</td>
            <td className="mono" style={{ fontSize: '11px' }} title={quote.tokenId}>{shortenTokenId(quote.tokenId)}</td>
            <td><Badge tone={quote.source === 'ws' ? 'good' : 'neutral'}>{quote.source.toUpperCase()}</Badge></td>
            <td className="mono" style={{ color: 'var(--color-success)', fontWeight: 600 }}>
              {quote.bestBid == null ? '-' : quote.bestBid.toFixed(3)}
            </td>
            <td className="mono" style={{ color: 'var(--color-danger)', fontWeight: 600 }}>
              {quote.bestAsk == null ? '-' : quote.bestAsk.toFixed(3)}
            </td>
            <td className="mono">{quote.midpoint == null ? '-' : quote.midpoint.toFixed(3)}</td>
            <td className="mono">{quote.spread == null ? '-' : quote.spread.toFixed(3)}</td>
            
            {/* Liquidities with background bar gauges */}
            <td className="depthCell">
              <div className="depthFill bid" style={{ width: `${bidPct}%` }}></div>
              <span style={{ position: 'relative', zIndex: 1 }}>{quote.bidDepth.toFixed(2)}</span>
            </td>
            <td className="depthCell">
              <div className="depthFill ask" style={{ width: `${askPct}%` }}></div>
              <span style={{ position: 'relative', zIndex: 1 }}>{quote.askDepth.toFixed(2)}</span>
            </td>
            
            <td className="mono">{formatEtTime(quote.updatedAt)}</td>
          </tr>
        );
      })}
    </DataTable>
  );
}

function DataTable({ headers, children, className = '' }: { headers: string[]; children: React.ReactNode; className?: string }) {
  return (
    <div className="tableWrap">
      <table className={className}>
        <thead>
          <tr>
            {headers.map((header) => <th key={header}>{header}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function PaginationControls({
  page,
  totalPages,
  totalRows,
  pageSize,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  totalRows: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  if (totalRows <= pageSize) return null;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(totalRows, page * pageSize);
  return (
    <div className="paginationBar">
      <span className="paginationSummary">
        Showing {start}-{end} of {totalRows}
      </span>
      <div className="paginationControls">
        <button type="button" onClick={() => onPageChange(1)} disabled={page === 1}>First</button>
        <button type="button" onClick={() => onPageChange(page - 1)} disabled={page === 1}>Previous</button>
        <span className="paginationPage">Page {page} / {totalPages}</span>
        <button type="button" onClick={() => onPageChange(page + 1)} disabled={page === totalPages}>Next</button>
        <button type="button" onClick={() => onPageChange(totalPages)} disabled={page === totalPages}>Last</button>
      </div>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'neutral'; children: React.ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
