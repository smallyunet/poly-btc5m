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
  PieChart
} from 'lucide-react';

import type { BotRuntimeStatus, DashboardState, RuntimeLogRecord, StrategyCheck } from '../../../packages/shared/src';
import { api, DASHBOARD_REFRESH_MS } from './lib/api';
import { formatMoney, formatNumber, formatSeconds } from './lib/format';
import { formatEtTime, outcomeLabel, outcomeTone, shortenTokenId } from './lib/dashboardFormat';

import { ScoreGauge } from './components/ScoreGauge';
import { PriceStrikeGauge } from './components/PriceStrikeGauge';
import { RoundTimelinePipeline } from './components/RoundTimelinePipeline';
import { OrderbookCapacityPanel, OrderbookExecutionSummary, OrderbookTable } from './components/dashboard/OrderbookPanels';
import { Badge, DataTable, DecisionMetric, PaginationControls, Shell } from './components/dashboard/Ui';

type TabType = 'terminal' | 'portfolio' | 'orderbooks' | 'activity' | 'strategy' | 'logs';
type ActivitySubTab = 'daily' | 'rounds' | 'orders';
type DashboardOrder = DashboardState['orders'][number];
type DashboardFill = DashboardState['fills'][number];
type DashboardProfileState = DashboardState['profiles'][number];
type DashboardSnapshot = NonNullable<DashboardProfileState['latestSnapshot']>;
type VisibleState = {
  runtime: DashboardState['runtime'];
  profileState: DashboardProfileState;
  feed: DashboardProfileState['feed'];
  snapshot: DashboardSnapshot;
  strategyChecks: DashboardProfileState['strategyChecks'];
  intents: DashboardState['intents'];
  orders: DashboardState['orders'];
  fills: DashboardState['fills'];
  settlements: DashboardState['settlements'];
  runtimeLogs: DashboardState['runtimeLogs'];
  rules: DashboardState['rules'];
};
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
const TAB_TYPES: TabType[] = ['terminal', 'portfolio', 'orderbooks', 'activity', 'strategy', 'logs'];

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

function portfolioStatusTone(status?: NonNullable<DashboardSnapshot['portfolio']>['status']): 'good' | 'warn' | 'bad' | 'neutral' {
  if (status === 'enabled') return 'good';
  if (status === 'partial') return 'warn';
  if (status === 'unavailable') return 'bad';
  return 'neutral';
}

function portfolioStatusLabel(status?: NonNullable<DashboardSnapshot['portfolio']>['status']): string {
  if (status === 'enabled') return 'ready';
  if (status === 'partial') return 'partial';
  if (status === 'unavailable') return 'unavailable';
  return 'disabled';
}

function formatSignedMoney(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatMoney(value)}`;
}

function formatPercentValue(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function positionValue(position: DashboardSnapshot['positions'][number]): number {
  if (position.currentValue != null) return position.currentValue;
  return position.shares * (position.currentPrice ?? position.avgPrice);
}

function positionCost(position: DashboardSnapshot['positions'][number]): number {
  return position.shares * position.avgPrice;
}

function positionPnl(position: DashboardSnapshot['positions'][number]): number {
  if (position.cashPnl != null) return position.cashPnl;
  return positionValue(position) - positionCost(position);
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
  const match = roundId.match(/[a-z]+-updown-(?:5m|15m|1h)-(\d+)$/);
  if (!match) return 0;
  const startMs = Number(match[1]) * 1000;
  return Number.isFinite(startMs) ? startMs : 0;
}

function roundDurationMsForProfile(profileId: string | undefined): number {
  if (profileId?.endsWith('-15m')) return 15 * 60_000;
  if (profileId?.endsWith('-1h')) return 60 * 60_000;
  return 5 * 60_000;
}

function derivedRoundTitle(roundId: string, profileId?: string): string {
  const startMs = roundStartTime(roundId);
  if (!startMs) return roundId;
  const asset = profileId?.startsWith('eth-') ? 'Ethereum' : profileId?.startsWith('sol-') ? 'Solana' : 'Bitcoin';
  return `${asset} Up or Down - ${formatEtRange(startMs, roundDurationMsForProfile(profileId))}`;
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

function scoreBreakdown(features: DashboardSnapshot['features']) {
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
  return order.marketTitle || derivedRoundTitle(order.roundId, order.profileId);
}

function strategySourceLabel(order: DashboardOrder): string {
  return order.strategy || 'UPDOWN_DUAL_ENTRY';
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

function buildRoundExecutionSummaries(state: Pick<DashboardState, 'orders' | 'fills' | 'settlements'>): RoundExecutionSummary[] {
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
      title: metadataSource?.marketTitle || derivedRoundTitle(roundId, metadataSource?.profileId),
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

  const roundSummaries = React.useMemo(() => visibleState ? buildRoundExecutionSummaries(visibleState) : [], [visibleState]);
  const dailySummaries = React.useMemo(() => buildDailyExecutionSummaries(roundSummaries), [roundSummaries]);

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
  const snapshot = viewState.snapshot;
  const portfolio = snapshot.portfolio;
  const entryCheck = viewState.strategyChecks.find((check) => check.strategy === 'UPDOWN_DUAL_ENTRY');
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
  const activeOrders = viewState.orders.filter((order) => (
    order.status === 'posted'
    || order.status === 'partially_filled'
    || (state.runtime.executionMode === 'monitor' && order.status === 'local')
  )).length;
  const pnl = viewState.settlements.reduce((sum, item) => sum + item.pnl, 0);
  const portfolioPnl = portfolio?.totalPnl ?? pnl;
  const signalLogCount = state.runtimeLogs.filter((log) => !isRoutineHeartbeatLog(log)).length;
  const alertLogCount = state.runtimeLogs.filter((log) => log.level === 'warn' || log.level === 'error').length;
  const selectedProfile = selectedProfileId === 'all'
    ? null
    : state.profiles.find((item) => item.profile.id === selectedProfileId)?.profile || null;

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
  const entryCooldownActive = Boolean(viewState.profileState.entryCooldownUntil && new Date(viewState.profileState.entryCooldownUntil).getTime() > Date.now());
  const entryCooldownRemaining = formatCooldownRemaining(viewState.profileState.entryCooldownUntil);
  const entryCooldownReason = viewState.profileState.entryCooldownReason || 'no single-fill lockout';
  const cooldownGateLabel = entryConfig?.bypassSingleFillCooldown ? 'BYPASSED' : 'ENFORCED';
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
  const effectiveBlockers = entryBypassActive
    ? failedEntryConditions.filter((condition) => condition.label === 'Single-fill cooldown')
    : failedEntryConditions;
  const diagnosticBlockerCount = Math.max(0, failedEntryConditions.length - effectiveBlockers.length);
  const topBlockers = effectiveBlockers.slice(0, 4).map((condition) => condition.label).join(', ') || 'none';
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
  const cooldownDetail = entryCooldownActive ? `${entryCooldownRemaining}; ${entryCooldownReason}` : entryCooldownReason;
  const executionLabel = state.runtime.executionMode === 'live' ? 'LIVE' : 'MONITOR';
  const feedLabel = `${viewState.feed.source.toUpperCase()} / CLOB ${viewState.feed.clobConnected ? 'ON' : 'OFF'}`;

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
            <span>{item.profile.label}</span>
            <em>{item.profile.status}</em>
          </button>
        ))}
      </section>

      {selectedProfileId === 'all' && (
        <section className="profileMatrix" aria-label="Profile status matrix">
          {state.profiles.map((item) => {
            const profileEntryCheck = item.strategyChecks.find((check) => check.strategy === 'UPDOWN_DUAL_ENTRY');
            const cooldownActive = Boolean(item.entryCooldownUntil && new Date(item.entryCooldownUntil).getTime() > Date.now());
            return (
              <button key={item.profile.id} type="button" className="profileCard" onClick={() => setSelectedProfileId(item.profile.id)}>
                <div className="profileCardHeader">
                  <strong>{item.profile.label}</strong>
                  <Badge tone={item.profile.status === 'live' ? 'warn' : 'neutral'}>{item.profile.status}</Badge>
                </div>
                <div className="profileCardMetric">
                  <span>Round</span>
                  <em>{item.latestSnapshot?.round.phase || 'pending'}</em>
                </div>
                <div className="profileCardMetric">
                  <span>Entry</span>
                  <em>{profileEntryCheck?.status || 'pending'}</em>
                </div>
                <div className="profileCardMetric">
                  <span>Cooldown</span>
                  <em>{cooldownActive ? formatCooldownRemaining(item.entryCooldownUntil) : 'clear'}</em>
                </div>
                <div className="profileCardMetric">
                  <span>PnL</span>
                  <em>{formatSignedMoney(item.stats.settledPnl)}</em>
                </div>
              </button>
            );
          })}
        </section>
      )}

      <section className={`terminalCommandBar ${decisionState.tone}`} aria-label="Current terminal state">
        <div className="terminalCommandPrimary">
          <div className="terminalCommandIcon">
            {decisionState.tone === 'good' ? <CheckCircle2 size={20} /> : <AlertTriangle size={20} />}
          </div>
          <div>
            <span className="decisionKicker">Current Action</span>
            <strong>{decisionState.label}</strong>
            <p>{decisionState.detail}</p>
          </div>
        </div>
        <div className="terminalCommandStats">
          <div className="terminalStat">
            <span>Round</span>
            <strong>{snapshot.round.phase.toUpperCase()}</strong>
            <em>{roundPhaseDetail}</em>
          </div>
          <div className="terminalStat">
            <span>Execution</span>
            <strong>{executionLabel}</strong>
            <em>{state.runtime.status.toUpperCase()} / {runtimeBuildLabel(state.runtime)}</em>
          </div>
          <div className="terminalStat">
            <span>Risk Gate</span>
            <strong>{entryCooldownActive ? 'COOLDOWN' : cooldownGateLabel}</strong>
            <em>{cooldownDetail}</em>
          </div>
          <div className="terminalStat">
            <span>Price / Size</span>
            <strong>{pricePolicyLabel} / {sizePolicyLabel}</strong>
            <em>{fixedSharesActive ? `${fixedSharesLabel} shares per side` : scoreInfo.next}</em>
          </div>
          <div className="terminalStat">
            <span>Feeds</span>
            <strong>{feedLabel}</strong>
            <em>Binance {viewState.feed.binanceConnected ? 'on' : 'off'}</em>
          </div>
	          <div className={`terminalStat pnl ${portfolioPnl > 0 ? 'good' : portfolioPnl < 0 ? 'bad' : 'neutral'}`}>
	            <span>Portfolio</span>
	            <strong>{formatSignedMoney(portfolioPnl)}</strong>
	            <em>{portfolio ? `${portfolio.positionCount} positions / ${portfolioStatusLabel(portfolio.status)}` : `${activeOrders} open / ${viewState.settlements.length} settled`}</em>
	          </div>
        </div>
      </section>

      {/* Main Tabbed Area */}
      <main>
        {activeTab === 'terminal' && (
          <div className="terminalWorkspace">
            <section className="terminalPrimaryColumn">
              <div className="decisionPanel decisionPanelPrimary">
                <div className="decisionHeader">
                  <div>
                    <span className="decisionKicker">Primary Decision Surface</span>
                    <strong>{entryCheck?.title || 'Up/Down Dual Entry'}</strong>
                  </div>
                  <Badge tone={entryStatusTone}>{entryStatusLabel}</Badge>
                </div>
                <div className={`decisionSummary ${decisionState.tone}`}>
                  <div>
                    <span className="decisionKicker">Current Action</span>
                    <strong>{decisionState.label}</strong>
                    <p>{decisionState.detail}</p>
                    {effectiveBlockers.length > 0 && (
                      <div className={`blockerChips ${entryBypassActive ? 'muted' : ''}`}>
                        {effectiveBlockers.slice(0, 3).map((condition) => (
                          <span key={condition.label}>{condition.label}</span>
                        ))}
                      </div>
                    )}
                    {entryBypassActive && diagnosticBlockerCount > 0 && (
                      <div className="bypassNote">{diagnosticBlockerCount} strategy checks are hidden because score gating is bypassed.</div>
                    )}
                  </div>
                  <div className="decisionSummaryMeta">
                    <span>{entryCheck?.reason || 'Strategy check has not loaded yet'}</span>
                    <div className="decisionSummaryFlags">
                      <Badge tone={state.runtime.executionMode === 'live' ? 'warn' : 'neutral'}>
                        {state.runtime.executionMode === 'live' ? 'live execution' : 'monitor only'}
                      </Badge>
                      <Badge tone={entryBypassActive ? 'warn' : 'good'}>
                        score {entryBypassActive ? 'bypassed' : 'enforced'}
                      </Badge>
                      <Badge tone={entryConfig?.bypassSingleFillCooldown ? 'warn' : 'good'}>
                        cooldown {entryConfig?.bypassSingleFillCooldown ? 'bypassed' : 'enforced'}
                      </Badge>
                    </div>
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
                    label="Cooldown Gate"
                    value={entryCooldownActive ? 'ACTIVE' : cooldownGateLabel}
                    detail={entryCooldownActive ? cooldownDetail : entryConfig?.bypassSingleFillCooldown ? 'single-fill cooldown is ignored by config' : 'single-fill cooldown still gates entry'}
                    tone={entryCooldownActive ? 'warn' : entryConfig?.bypassSingleFillCooldown ? 'warn' : 'good'}
                  />
                  <DecisionMetric
                    label="Entry Price / Size"
                    value={priceSizeValue}
                    detail={priceSizeDetail}
                    tone={priceSizeTone}
                  />
                  <DecisionMetric
                    label="Entry Limit"
                    value={entryLimit == null ? '-' : entryLimit.toFixed(3)}
                    detail={entryPairCost == null || entryPairEdge == null ? 'waiting for strategy check' : `pair cost ${entryPairCost.toFixed(3)} / edge ${entryPairEdge.toFixed(3)}`}
                    tone={entryLimit == null ? 'neutral' : entryPairEdge != null && entryPairEdge >= 0.08 ? 'good' : 'warn'}
                  />
                  {!entryBypassActive && (
                    <>
                      <DecisionMetric
                        label="BTC Dynamic Score"
                        value={scoreMetricValue}
                        detail={scoreMetricDetail}
                        tone={btcDecisionPassed ? 'good' : 'bad'}
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
                    </>
                  )}
                  {entryBypassActive && (
                    <DecisionMetric
                      label="Bypass Scope"
                      value={entryConfigValue}
                      detail="score, strategy blockers, and entry quote gates are diagnostic; cooldown remains active"
                      tone="warn"
                    />
                  )}
                  <DecisionMetric
                    label="Post-Start Actions"
                    value="REGULAR OFF"
                    detail="no add/sell/rebalance; capped single-fill hedge can run late"
                    tone="neutral"
                  />
                  {!entryBypassActive && (
                    <DecisionMetric
                      label="Current Blockers"
                      value={effectiveBlockers.length ? String(effectiveBlockers.length) : '0'}
                      detail={topBlockers}
                      tone={effectiveBlockers.length ? 'warn' : 'good'}
                    />
                  )}
                </div>
                <details className={`collapsiblePanel ${entryBypassActive ? 'diagnosticOnly' : ''}`}>
                  <summary>
                    <span>Score Composition</span>
                    <strong>{entryBypassActive ? `bypassed · ${formatNumber(snapshot.features.chopScore, 1)}` : `${formatNumber(snapshot.features.chopScore, 1)} / 70`}</strong>
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
                <div className="panel marketSignalPanel">
                  <h2>
                    BTC 120s Market Signal
                    <span className="panelSubTitle">range {formatNumber(snapshot.features.rangeBps120s, 2)}bps / balance {formatNumber(snapshot.features.excursionBalance120s, 2)}</span>
                  </h2>
                  <div className="marketSignalSummary">
                    <div>
                      <span>BTC Price</span>
                      <strong>{formatMoney(btcPrice)}</strong>
                    </div>
                    <div>
                      <span>Center</span>
                      <strong>{snapshot.features.centerPrice120s == null ? 'unknown' : formatMoney(snapshot.features.centerPrice120s)}</strong>
                    </div>
                    <div>
                      <span>CHOP</span>
                      <strong>{formatNumber(snapshot.features.chopScore, 1)}</strong>
                    </div>
                    <div>
                      <span>Samples</span>
                      <strong>{snapshot.features.samples120s}</strong>
                    </div>
                  </div>
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
                  {viewState.strategyChecks.map((check) => (
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
            </section>

            {/* Right Column (Side status metrics) */}
            <aside className="terminalContextRail">
              
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

              <div className="panel compactContextPanel">
                <h2>Round</h2>
                <div className="metrics">
                  <div className="metricRow">
                    <span className="metricLabel">Round ID</span>
                    <span className="metricValue">{snapshot.round.id}</span>
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

              <div className="panel compactContextPanel">
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
                    <div key={side.label} className="sideSnapshot">
                      <span>{outcomeLabel(side.label)}</span>
                      <strong>{formatNumber(side.topHolderShares, 1)} shares</strong>
                      <em>{formatRatioPct(side.largestHolderShareRatio)} concentration / {formatMoney(side.positionPnlSum)} sample PnL</em>
                    </div>
                  ))}
                </div>
              </div>

              {/* Analytics Features */}
              <details className="panel collapsiblePanel compactContextPanel">
                <summary>
                  <span>Path Features (120s)</span>
                  <strong>{formatNumber(snapshot.features.chopScore, 1)} chop</strong>
                </summary>
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
              </details>

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
            </aside>
          </div>
	        )}
	
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
	                      <span className="decisionKicker">Configured Account</span>
	                      <strong title={portfolio.accountAddress || ''}>{portfolio.accountAddress ? shortenTokenId(portfolio.accountAddress) : 'not configured'}</strong>
	                      <p>{portfolio.hasOwnerPrivateKey ? 'CLOB balance reads enabled' : 'OWNER_PRIVATE_KEY missing; positions only'}</p>
	                    </div>
	                    <Badge tone={portfolioStatusTone(portfolio.status)}>{portfolioStatusLabel(portfolio.status)}</Badge>
	                  </div>

	                  <div className="portfolioMetricGrid">
		                    <DecisionMetric label="Collateral Balance" value={portfolio.collateralBalance == null ? 'n/a' : formatMoney(portfolio.collateralBalance)} detail="CLOB collateral" tone={portfolio.collateralBalance == null ? 'neutral' : 'good'} />
		                    <DecisionMetric label="Allowance" value={portfolio.collateralAllowance == null ? 'n/a' : formatMoney(portfolio.collateralAllowance)} detail="CLOB allowance" tone={portfolio.collateralAllowance == null ? 'neutral' : 'good'} />
		                    <DecisionMetric label="Position Value" value={formatMoney(portfolio.positionValue)} detail={`${portfolio.positionCount} positions`} tone={portfolio.positionValue > 0 ? 'good' : 'neutral'} />
		                    <DecisionMetric label="Open Cost" value={formatMoney(portfolio.positionCost)} detail="avg entry basis" tone="neutral" />
		                    <DecisionMetric label="Unrealized PnL" value={formatSignedMoney(portfolio.unrealizedPnl)} detail="active positions" tone={portfolio.unrealizedPnl > 0 ? 'good' : portfolio.unrealizedPnl < 0 ? 'bad' : 'neutral'} />
		                    <DecisionMetric label="Settled PnL" value={formatSignedMoney(portfolio.settledPnl)} detail={`${viewState.settlements.length} records`} tone={portfolio.settledPnl > 0 ? 'good' : portfolio.settledPnl < 0 ? 'bad' : 'neutral'} />
		                    <DecisionMetric label="Total PnL" value={formatSignedMoney(portfolio.totalPnl)} detail="settled + unrealized" tone={portfolio.totalPnl > 0 ? 'good' : portfolio.totalPnl < 0 ? 'bad' : 'neutral'} />
		                    <DecisionMetric label="ROI" value={formatPercentValue(portfolio.roiPct)} detail="PnL / open cost" tone={portfolio.roiPct == null ? 'neutral' : portfolio.roiPct > 0 ? 'good' : portfolio.roiPct < 0 ? 'bad' : 'neutral'} />
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
	                <span className="panelSubTitle">{portfolio ? `${portfolio.positionCount} open positions` : 'no account data'}</span>
	              </h2>
	              {portfolio && portfolio.positions.length > 0 ? (
	                <DataTable headers={['Market', 'Outcome', 'Shares', 'Avg', 'Value', 'PnL', 'ROI']}>
	                  {portfolio.positions.map((position) => {
	                    const value = positionValue(position);
	                    const cost = positionCost(position);
	                    const pnlValue = positionPnl(position);
	                    const roi = cost > 0 ? (pnlValue / cost) * 100 : null;
	                    return (
	                      <tr key={position.tokenId}>
	                        <td>
	                          <span className="marketTitle">{position.title || 'Polymarket position'}</span>
	                          <span className="mutedBlock mono">{shortenTokenId(position.tokenId)}</span>
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
                  {roundSummaries.length} rounds / {viewState.orders.length} orders
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
                viewState.orders.length > 0 ? (
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
