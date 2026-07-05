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
  Target
} from 'lucide-react';

import type { BotRuntimeStatus, DashboardState, RuntimeLogRecord, StrategyCheck } from '../../../packages/shared/src';
import { api, DASHBOARD_REFRESH_MS } from './lib/api';
import { formatMoney, formatNumber, formatSeconds } from './lib/format';
import { formatEtTime, outcomeLabel, outcomeTone, shortenTokenId } from './lib/dashboardFormat';

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
  profiles: DashboardState['profiles'];
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
  key: string;
  profileId?: string;
  profileLabel: string;
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
const STATS_WINDOW_MS = 24 * 60 * 60 * 1000;
const SINGLE_FILL_TARGET_RATE = 0.18;
const SINGLE_FILL_EXPOSURE_EPSILON = 0.01;

type ExecutionStats = {
  windowStart: number;
  windowEnd: number;
  orders: number;
  fills: number;
  settlements: number;
  orderRounds: number;
  paired: number;
  single: number;
  none: number;
  pairedRate: number | null;
  singleRate: number | null;
  singleRateDelta: number | null;
  pairedPnl: number;
  singlePnl: number;
  totalPnl: number;
  singleWins: number;
  singleLosses: number;
  singleWinRate: number | null;
  targetRate: number;
};

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
  if (yesShares > SINGLE_FILL_EXPOSURE_EPSILON && noShares > SINGLE_FILL_EXPOSURE_EPSILON) return 'good';
  if (yesShares > SINGLE_FILL_EXPOSURE_EPSILON || noShares > SINGLE_FILL_EXPOSURE_EPSILON) return 'warn';
  return 'neutral';
}

function fillStateLabel(yesShares: number, noShares: number): 'paired' | 'single' | 'none' {
  if (yesShares > SINGLE_FILL_EXPOSURE_EPSILON && noShares > SINGLE_FILL_EXPOSURE_EPSILON) return 'paired';
  if (yesShares > SINGLE_FILL_EXPOSURE_EPSILON || noShares > SINGLE_FILL_EXPOSURE_EPSILON) return 'single';
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
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 1) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(diffMs / 60_000);
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

type AssetKey = 'btc' | 'eth' | 'sol';

function assetKeyForProfile(profileId?: string): AssetKey {
  if (profileId?.startsWith('eth-')) return 'eth';
  if (profileId?.startsWith('sol-')) return 'sol';
  return 'btc';
}

function assetNameForProfile(profileId?: string): string {
  const asset = assetKeyForProfile(profileId);
  if (asset === 'eth') return 'Ethereum';
  if (asset === 'sol') return 'Solana';
  return 'Bitcoin';
}

function AssetIcon({ profileId, size = 'sm' }: { profileId?: string; size?: 'xs' | 'sm' | 'md' }) {
  const asset = assetKeyForProfile(profileId);
  return (
    <span className={`assetIcon assetIcon-${asset} assetIcon-${size}`} title={assetNameForProfile(profileId)} aria-hidden="true">
      <img src={`/token-icons/${asset}.png`} alt="" loading="lazy" />
    </span>
  );
}

function AssetLabel({ profileId, label, size = 'xs' }: { profileId?: string; label: string; size?: 'xs' | 'sm' }) {
  return (
    <span className="assetLabel">
      <AssetIcon profileId={profileId} size={size} />
      <span>{label}</span>
    </span>
  );
}

function toSortTime(value: string | number | undefined): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const normalized = value.trim();
  if (/^\d+(\.\d+)?$/.test(normalized)) {
    const numeric = Number(normalized);
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const time = new Date(normalized).getTime();
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

function runtimeBuildLabel(runtime: BotRuntimeStatus): string {
  const sha = runtime.buildSha && runtime.buildSha !== 'unknown' ? runtime.buildSha.slice(0, 7) : runtime.version;
  return `build ${sha}`;
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

function profileLabelFor(profiles: DashboardState['profiles'], profileId: string | undefined): string {
  if (!profileId) return 'Unknown';
  return profiles.find((item) => item.profile.id === profileId)?.profile.label || profileId;
}

function inferProfileIdFromRound(roundId?: string): string | undefined {
  if (!roundId) return undefined;
  if (roundId.includes('eth-updown-5m')) return 'eth-5m';
  if (roundId.includes('eth-updown-15m')) return 'eth-15m';
  if (roundId.includes('eth-updown-1h') || roundId.includes('ethereum-up-or-down')) return 'eth-1h';
  if (roundId.includes('btc-updown-5m')) return 'btc-5m';
  if (roundId.includes('btc-updown-15m')) return 'btc-15m';
  if (roundId.includes('btc-updown-1h') || roundId.includes('bitcoin-up-or-down')) return 'btc-1h';
  return undefined;
}

function recordProfileId(record: { profileId?: string; roundId?: string; eventSlug?: string }): string | undefined {
  return record.profileId || inferProfileIdFromRound(record.roundId) || inferProfileIdFromRound(record.eventSlug);
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

function strategyCheckTone(check?: StrategyCheck): 'good' | 'warn' | 'bad' | 'neutral' {
  if (!check) return 'neutral';
  if (check.status === 'eligible') return 'good';
  if (check.status === 'blocked') return 'bad';
  return 'neutral';
}

function strategyCheckLabel(check?: StrategyCheck): string {
  if (!check) return 'pending';
  return check.status;
}

function currentRoundExposure(fills: DashboardFill[], roundId: string) {
  const roundFills = fills.filter((fill) => fill.roundId === roundId);
  const yesBuy = sumShares(roundFills.filter((fill) => fill.label === 'YES' && fill.side === 'BUY').map((fill) => fill.size));
  const noBuy = sumShares(roundFills.filter((fill) => fill.label === 'NO' && fill.side === 'BUY').map((fill) => fill.size));
  const yesSell = sumShares(roundFills.filter((fill) => fill.label === 'YES' && fill.side === 'SELL').map((fill) => fill.size));
  const noSell = sumShares(roundFills.filter((fill) => fill.label === 'NO' && fill.side === 'SELL').map((fill) => fill.size));
  const yes = Math.max(0, yesBuy - yesSell);
  const no = Math.max(0, noBuy - noSell);
  return {
    yes,
    no,
    fills: roundFills.length,
    label: fillStateLabel(yes, no),
    tone: fillStateTone(yes, no),
  };
}

function isRoutineHeartbeatLog(log: RuntimeLogRecord): boolean {
  const message = log.message.toLowerCase();
  return log.level === 'info'
    && (message === 'scheduled tick completed.' || message === 'scheduled tick completed');
}

function buildRoundExecutionSummaries(state: Pick<DashboardState, 'orders' | 'fills' | 'settlements' | 'profiles'>): RoundExecutionSummary[] {
  const byRound = new Map<string, {
    profileId?: string;
    orders: DashboardOrder[];
    fills: DashboardFill[];
    settlements: DashboardState['settlements'];
  }>();
  const ensure = (roundId: string, profileId?: string) => {
    const key = `${profileId || 'unknown'}:${roundId}`;
    const existing = byRound.get(key);
    if (existing) return existing;
    const created = { profileId, orders: [], fills: [], settlements: [] };
    byRound.set(key, created);
    return created;
  };

  state.orders.forEach((order) => ensure(order.roundId, order.profileId).orders.push(order));
  state.fills.forEach((fill) => ensure(fill.roundId, fill.profileId).fills.push(fill));
  state.settlements.forEach((settlement) => ensure(settlement.roundId, settlement.profileId).settlements.push(settlement));

  return [...byRound.entries()].map(([key, record]) => {
    const yesBuyOrders = record.orders.filter((order) => order.label === 'YES' && order.side === 'BUY');
    const noBuyOrders = record.orders.filter((order) => order.label === 'NO' && order.side === 'BUY');
    const unfilledByOrder = record.orders.map((order) => Math.max(0, order.size - orderFilledShares(order, record.fills)));
    const metadataSource = record.orders[0] || record.fills[0] || record.settlements[0];
    const roundId = metadataSource?.roundId || key.split(':').slice(1).join(':');
    const profileId = record.profileId || metadataSource?.profileId;
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
      key,
      profileId,
      profileLabel: profileLabelFor(state.profiles, profileId),
      roundId,
      title: metadataSource?.marketTitle || derivedRoundTitle(roundId, profileId),
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

function buildExecutionStats(state: Pick<DashboardState, 'orders' | 'fills' | 'settlements'>, windowEnd: number): ExecutionStats {
  const windowStart = windowEnd - STATS_WINDOW_MS;
  const inWindow = (value: string | number | undefined) => {
    const time = toSortTime(value);
    return time >= windowStart && time <= windowEnd;
  };
  const orders = state.orders.filter((order) => inWindow(order.createdAt));
  const fills = state.fills.filter((fill) => inWindow(fill.matchedAt));
  const settlements = state.settlements.filter((settlement) => inWindow(settlement.resolvedAt));
  const orderRounds = new Set(orders.map((order) => `${recordProfileId(order) || 'unknown'}:${order.roundId}:${order.strategy || 'UPDOWN_DUAL_ENTRY'}`));

  let paired = 0;
  let single = 0;
  let none = 0;
  let pairedPnl = 0;
  let singlePnl = 0;
  let totalPnl = 0;
  let singleWins = 0;
  let singleLosses = 0;

  settlements.forEach((settlement) => {
    const label = fillStateLabel(settlement.yesShares, settlement.noShares);
    totalPnl += settlement.pnl;
    if (label === 'paired') {
      paired += 1;
      pairedPnl += settlement.pnl;
      return;
    }
    if (label === 'single') {
      single += 1;
      singlePnl += settlement.pnl;
      const singleSide = settlement.yesShares > SINGLE_FILL_EXPOSURE_EPSILON ? 'YES' : 'NO';
      if (settlement.winningLabel === singleSide) singleWins += 1;
      else singleLosses += 1;
      return;
    }
    none += 1;
  });

  const settledWithExposure = paired + single + none;
  const singleRate = settledWithExposure > 0 ? single / settledWithExposure : null;
  const pairedRate = settledWithExposure > 0 ? paired / settledWithExposure : null;
  return {
    windowStart,
    windowEnd,
    orders: orders.length,
    fills: fills.length,
    settlements: settlements.length,
    orderRounds: orderRounds.size,
    paired,
    single,
    none,
    pairedRate,
    singleRate,
    singleRateDelta: singleRate == null ? null : singleRate - SINGLE_FILL_TARGET_RATE,
    pairedPnl,
    singlePnl,
    totalPnl,
    singleWins,
    singleLosses,
    singleWinRate: single > 0 ? singleWins / single : null,
    targetRate: SINGLE_FILL_TARGET_RATE,
  };
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
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  
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
          <button
            type="button"
            className="refreshControl"
            onClick={() => load()}
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
