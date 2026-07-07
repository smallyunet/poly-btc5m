import React from 'react';

import type { BotRuntimeStatus, DashboardState, RuntimeLogRecord, StrategyCheck, StrategyId } from '../../../../packages/shared/src';
import { formatMoney } from '../lib/format';
import type { Tone } from '../lib/dashboardFormat';
import { formatEtTime, outcomeLabel } from '../lib/dashboardFormat';

export type TabType = 'terminal' | 'portfolio' | 'orderbooks' | 'activity' | 'simulation' | 'strategy' | 'logs';
export type ActivitySubTab = 'daily' | 'rounds' | 'orders';
export type OrderStrategyFilter = 'all' | 'dual' | 'tail' | 'exit' | 'experiment';
export type DashboardOrder = DashboardState['orders'][number];
export type DashboardFill = DashboardState['fills'][number];
export type DashboardProfileState = DashboardState['profiles'][number];
export type DashboardSnapshot = NonNullable<DashboardProfileState['latestSnapshot']>;
export type VisibleState = {
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
export type RoundExecutionSummary = {
  key: string;
  profileId?: string;
  profileLabel: string;
  roundId: string;
  strategy: StrategyId;
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
export type RoundStatusSummary = {
  label: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  detail: string;
};
export type DailyExecutionSummary = {
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

export const ROUND_PAGE_SIZE = 20;
export const ORDER_PAGE_SIZE = 25;
export const DAILY_PAGE_SIZE = 1;
export const LOG_PAGE_SIZE = 75;
export const TAB_TYPES: TabType[] = ['terminal', 'portfolio', 'orderbooks', 'activity', 'simulation', 'strategy', 'logs'];
export const STATS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ORDER_STRATEGY_FILTERS: OrderStrategyFilter[] = ['all', 'dual', 'tail', 'exit', 'experiment'];
const SINGLE_FILL_TARGET_RATE = 0.18;
const SINGLE_FILL_EXPOSURE_EPSILON = 0.01;

export type ExecutionStats = {
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

export type TouchSimAggregateRow = {
  asset?: string;
  price: number;
  rounds: number;
  paired: number;
  single: number;
  none: number;
  pairedRate: number | null;
  singleRate: number | null;
  noneRate: number | null;
  breakevenSingleRate: number | null;
  estimatedEvPerShare: number;
};

export type TouchSimSummary = {
  ok: boolean;
  message?: string;
  model?: string;
  generatedAt?: string;
  summaryPath?: string;
  config?: {
    assets: string[];
    interval: string;
    minPrice: number;
    maxPrice: number;
    step: number;
    priceLevels: number[];
    lookbackHours?: number | null;
    lookbackStartAt?: string | null;
  };
  status?: {
    websocketConnected?: boolean;
    subscribedTokens?: number;
    activeRounds?: number;
    completedRounds?: number;
    completedAllTimeRounds?: number;
  } | string;
  active?: {
    rounds: number;
    rows: number;
    byPrice: TouchSimAggregateRow[];
    byAssetPrice: TouchSimAggregateRow[];
  };
  completed?: {
    rounds: number;
    rows: number;
    byPrice: TouchSimAggregateRow[];
    byAssetPrice: TouchSimAggregateRow[];
  };
  completedAllTime?: {
    rounds: number;
    rows: number;
    byPrice: TouchSimAggregateRow[];
    byAssetPrice: TouchSimAggregateRow[];
  };
  recentRounds?: Array<{
    asset: string;
    slug: string;
    title: string;
    startAt: string;
    endAt: string;
    finalized: boolean;
    levels: Array<{ price: number; outcome: 'paired' | 'single' | 'none'; yesTouched: boolean; noTouched: boolean }>;
  }>;
};

export type TouchOutcome = 'paired' | 'single' | 'none';

export type TailSimAggregateRow = {
  checkpointSeconds: number;
  size: number;
  askBand?: string;
  rows: number;
  fillable: number;
  wins: number;
  fillRate: number | null;
  winRate: number | null;
  avgVwap: number | null;
  avgSpread: number | null;
  avgOverroundAsk: number | null;
  avgPnlPerShare: number | null;
  totalPnl: number;
};

export type TailSimSummary = {
  ok?: boolean;
  model?: string;
  generatedAt?: string;
  message?: string;
  config?: {
    assets: string[];
    interval: string;
    checkpoints: number[];
    sizes: number[];
    topLevels: number;
    quoteMaxAgeMs: number;
    lookbackHours?: number | null;
    lookbackStartAt?: string | null;
  };
  status?: {
    websocketConnected?: boolean;
    subscribedTokens?: number;
    activeRounds?: number;
    sampledRounds?: number;
    completedRows?: number;
    completedAllTimeRows?: number;
    historicalRows?: number;
  } | string;
  active?: {
    rounds: number;
    samples: number;
    latestSampleAt: string | null;
  };
  completed?: {
    rows: number;
    byCheckpointSize: TailSimAggregateRow[];
    byAskBand: TailSimAggregateRow[];
  };
  completedAllTime?: {
    rows: number;
    byCheckpointSize: TailSimAggregateRow[];
    byAskBand: TailSimAggregateRow[];
  };
  recentRounds?: Array<{
    asset: string;
    slug: string;
    title: string;
    startAt: string;
    endAt: string;
    finalized: boolean;
    winner: 'YES' | 'NO' | null;
    samples: Array<{
      recordedAt: string;
      checkpointSeconds: number;
      status: string;
      selectedSide: 'YES' | 'NO' | null;
      yesMidpoint: number | null;
      noMidpoint: number | null;
      selectedBestAsk: number | null;
      overroundAsk: number | null;
      sizePlans: Array<{
        size: number;
        fillable: boolean;
        vwap: number | null;
        cost: number | null;
        filledShares: number;
        slippage: number | null;
      }>;
    }>;
  }>;
};

export function isTabType(value: string | null): value is TabType {
  return TAB_TYPES.includes(value as TabType);
}

export function tabFromUrl(): TabType {
  if (typeof window === 'undefined') return 'terminal';
  const tab = new URLSearchParams(window.location.search).get('tab');
  return isTabType(tab) ? tab : 'terminal';
}

export function syncTabToUrl(tab: TabType): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (url.searchParams.get('tab') === tab) return;
  url.searchParams.set('tab', tab);
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

export function fillStateTone(yesShares: number, noShares: number): 'good' | 'warn' | 'neutral' {
  if (yesShares > SINGLE_FILL_EXPOSURE_EPSILON && noShares > SINGLE_FILL_EXPOSURE_EPSILON) return 'good';
  if (yesShares > SINGLE_FILL_EXPOSURE_EPSILON || noShares > SINGLE_FILL_EXPOSURE_EPSILON) return 'warn';
  return 'neutral';
}

export function fillStateLabel(yesShares: number, noShares: number): 'paired' | 'single' | 'none' {
  if (yesShares > SINGLE_FILL_EXPOSURE_EPSILON && noShares > SINGLE_FILL_EXPOSURE_EPSILON) return 'paired';
  if (yesShares > SINGLE_FILL_EXPOSURE_EPSILON || noShares > SINGLE_FILL_EXPOSURE_EPSILON) return 'single';
  return 'none';
}

export function netFilledShares(round: Pick<RoundExecutionSummary, 'filledBuyYes' | 'filledBuyNo' | 'filledSellYes' | 'filledSellNo'>) {
  return {
    yes: Math.max(0, round.filledBuyYes - round.filledSellYes),
    no: Math.max(0, round.filledBuyNo - round.filledSellNo),
  };
}

export function portfolioStatusTone(status?: NonNullable<DashboardSnapshot['portfolio']>['status']): 'good' | 'warn' | 'bad' | 'neutral' {
  if (status === 'enabled') return 'good';
  if (status === 'partial') return 'warn';
  if (status === 'unavailable') return 'bad';
  return 'neutral';
}

export function portfolioStatusLabel(status?: NonNullable<DashboardSnapshot['portfolio']>['status']): string {
  if (status === 'enabled') return 'ready';
  if (status === 'partial') return 'partial';
  if (status === 'unavailable') return 'unavailable';
  return 'disabled';
}

export function formatSignedMoney(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatMoney(value)}`;
}

export function formatPercentValue(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function formatRate(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function formatPriceCents(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? 'n/a' : `${Math.round(value * 100)}c`;
}

export function formatEv(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

export function touchOutcomeTone(outcome: TouchOutcome): 'good' | 'warn' | 'neutral' {
  if (outcome === 'paired') return 'good';
  if (outcome === 'single') return 'warn';
  return 'neutral';
}

export function positionValue(position: DashboardSnapshot['positions'][number]): number {
  if (position.currentValue != null) return position.currentValue;
  return position.shares * (position.currentPrice ?? position.avgPrice);
}

export function positionCost(position: DashboardSnapshot['positions'][number]): number {
  return position.shares * position.avgPrice;
}

export function positionPnl(position: DashboardSnapshot['positions'][number]): number {
  if (position.cashPnl != null) return position.cashPnl;
  return positionValue(position) - positionCost(position);
}

export function roundStatusSummary(round: RoundExecutionSummary): RoundStatusSummary {
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

export function formatRelativeAge(ms: number, nowMs = Date.now()): string {
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

export function formatEtClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'n/a';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

export function formatEtDateKey(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown-date';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

export function formatEtDateLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'Unknown date';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(ms));
}

export function formatEtRange(startMs: number, durationMs: number): string {
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

export function roundStartTime(roundId: string): number {
  const match = roundId.match(/[a-z]+-updown-(?:5m|15m|1h)-(\d+)$/);
  if (!match) return 0;
  const startMs = Number(match[1]) * 1000;
  return Number.isFinite(startMs) ? startMs : 0;
}

export function roundDurationMsForProfile(profileId: string | undefined): number {
  if (profileId?.endsWith('-15m')) return 15 * 60_000;
  if (profileId?.endsWith('-1h')) return 60 * 60_000;
  return 5 * 60_000;
}

export function derivedRoundTitle(roundId: string, profileId?: string): string {
  const startMs = roundStartTime(roundId);
  if (!startMs) return roundId;
  const asset = assetNameForProfile(profileId);
  return `${asset} Up or Down - ${formatEtRange(startMs, roundDurationMsForProfile(profileId))}`;
}

export type AssetKey = 'btc' | 'eth' | 'sol' | 'doge' | 'xrp' | 'hype';

export function assetKeyForProfile(profileId?: string): AssetKey {
  if (profileId?.startsWith('eth-')) return 'eth';
  if (profileId?.startsWith('sol-')) return 'sol';
  if (profileId?.startsWith('doge-')) return 'doge';
  if (profileId?.startsWith('xrp-')) return 'xrp';
  if (profileId?.startsWith('hype-')) return 'hype';
  return 'btc';
}

export function assetNameForProfile(profileId?: string): string {
  const asset = assetKeyForProfile(profileId);
  if (asset === 'eth') return 'Ethereum';
  if (asset === 'sol') return 'Solana';
  if (asset === 'doge') return 'Dogecoin';
  if (asset === 'xrp') return 'XRP';
  if (asset === 'hype') return 'Hyperliquid';
  return 'Bitcoin';
}

export function AssetIcon({ profileId, size = 'sm' }: { profileId?: string; size?: 'xs' | 'sm' | 'md' }) {
  const asset = assetKeyForProfile(profileId);
  return (
    <span className={`assetIcon assetIcon-${asset} assetIcon-${size}`} title={assetNameForProfile(profileId)} aria-hidden="true">
      <img src={`/token-icons/${asset}.png`} alt="" loading="lazy" />
    </span>
  );
}

export function AssetLabel({ profileId, label, size = 'xs' }: { profileId?: string; label: string; size?: 'xs' | 'sm' }) {
  return (
    <span className="assetLabel">
      <AssetIcon profileId={profileId} size={size} />
      <span>{label}</span>
    </span>
  );
}

export function toSortTime(value: string | number | undefined): number {
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

export function formatShares(value: number): string {
  return value.toFixed(value % 1 === 0 ? 0 : 2);
}

export function formatCooldownRemaining(until: string | undefined): string {
  if (!until) return 'inactive';
  const remainingMs = new Date(until).getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'inactive';
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m left`;
  return minutes > 0 ? `${hours}h ${minutes}m left` : `${hours}h left`;
}

export function runtimeBuildLabel(runtime: BotRuntimeStatus): string {
  const sha = runtime.buildSha && runtime.buildSha !== 'unknown' ? runtime.buildSha.slice(0, 7) : runtime.version;
  return `build ${sha}`;
}

export function blockerDetail(condition: StrategyCheck['conditions'][number]): string {
  return `${condition.label}: ${condition.actual}`;
}

export function sumShares(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundMoneyValue(value: number): number {
  return Math.round(value * 100) / 100;
}

export function weightedAverageOrderPrice(orders: DashboardOrder[]): number | undefined {
  const totalShares = sumShares(orders.map((order) => order.size));
  if (totalShares <= 0) return undefined;
  return orders.reduce((total, order) => total + order.price * order.size, 0) / totalShares;
}

export function formatSubmittedLeg(label: string, shares: number, price?: number): string {
  if (shares <= 0 || price == null) return `${label} -`;
  return `${label} ${formatShares(shares)} @ $${price.toFixed(3)}`;
}

export function orderFilledShares(order: DashboardOrder, fills: DashboardFill[]): number {
  if (order.filledSize != null) return order.filledSize;
  if (order.status === 'filled') return order.size;
  if (!order.clobOrderId) return 0;
  return sumShares(fills.filter((fill) => fill.clobOrderId === order.clobOrderId).map((fill) => fill.size));
}

export function orderMarketTitle(order: DashboardOrder): string {
  return order.marketTitle || derivedRoundTitle(order.roundId, order.profileId);
}

export function profileLabelFor(profiles: DashboardState['profiles'], profileId: string | undefined): string {
  if (!profileId) return 'Unknown';
  return profiles.find((item) => item.profile.id === profileId)?.profile.label || profileId;
}

export function inferProfileIdFromRound(roundId?: string): string | undefined {
  if (!roundId) return undefined;
  const assets = [
    ['btc', 'bitcoin'],
    ['eth', 'ethereum'],
    ['sol', 'solana'],
    ['doge', 'dogecoin'],
    ['xrp', 'xrp'],
    ['hype', 'hyperliquid'],
  ] as const;
  for (const [asset, humanSlug] of assets) {
    if (roundId.includes(`${asset}-updown-5m`)) return `${asset}-5m`;
    if (roundId.includes(`${asset}-updown-15m`)) return `${asset}-15m`;
    if (roundId.includes(`${asset}-updown-1h`) || roundId.includes(`${humanSlug}-up-or-down`)) return `${asset}-1h`;
  }
  return undefined;
}

export function recordProfileId(record: { profileId?: string; roundId?: string; eventSlug?: string }): string | undefined {
  return record.profileId || inferProfileIdFromRound(record.roundId) || inferProfileIdFromRound(record.eventSlug);
}

export function strategySourceLabel(order: DashboardOrder): string {
  const strategy = orderStrategyId(order);
  switch (strategy) {
    case 'UPDOWN_TAIL_ENTRY':
      return 'TAIL ENTRY';
    case 'UPDOWN_DUAL_ENTRY':
      return 'DUAL ENTRY';
    case 'UPDOWN_SINGLE_FILL_HEDGE':
      return 'HEDGE';
    case 'UPDOWN_SINGLE_FILL_PROFIT_EXIT':
      return 'PROFIT EXIT';
    case 'UPDOWN_SINGLE_FILL_LOSS_EXIT':
      return 'LOSS EXIT';
    case 'UPDOWN_NEXT_ROUND_50_49_STOP_ON_SINGLE':
      return 'EXPERIMENT';
    default:
      return strategy;
  }
}

export function strategySourceTone(order: DashboardOrder): Tone {
  const strategy = orderStrategyId(order);
  if (strategy === 'UPDOWN_TAIL_ENTRY') return 'warn';
  if (strategy === 'UPDOWN_DUAL_ENTRY') return 'good';
  if (strategy.includes('LOSS_EXIT') || strategy.includes('HEDGE')) return 'bad';
  if (strategy.includes('PROFIT_EXIT')) return 'good';
  return 'neutral';
}

export function orderStrategyId(record: { strategy?: StrategyId }): StrategyId {
  return record.strategy || 'UPDOWN_DUAL_ENTRY';
}

export function orderStrategyFilterFor(record: { strategy?: StrategyId }): Exclude<OrderStrategyFilter, 'all'> {
  const strategy = orderStrategyId(record);
  if (strategy === 'UPDOWN_TAIL_ENTRY') return 'tail';
  if (strategy === 'UPDOWN_DUAL_ENTRY') return 'dual';
  if (strategy === 'UPDOWN_NEXT_ROUND_50_49_STOP_ON_SINGLE') return 'experiment';
  return 'exit';
}

export function orderStrategyFilterLabel(filter: OrderStrategyFilter): string {
  switch (filter) {
    case 'all':
      return 'All';
    case 'dual':
      return 'Dual';
    case 'tail':
      return 'Tail';
    case 'exit':
      return 'Exit';
    case 'experiment':
      return 'Experiment';
    default:
      return filter;
  }
}

export function orderMatchesStrategyFilter(order: DashboardOrder, filter: OrderStrategyFilter): boolean {
  return filter === 'all' || orderStrategyFilterFor(order) === filter;
}

export function strategySourceLabelForStrategy(strategy: StrategyId): string {
  return strategySourceLabel({ strategy } as DashboardOrder);
}

export function strategySourceToneForStrategy(strategy: StrategyId): Tone {
  return strategySourceTone({ strategy } as DashboardOrder);
}

function strategySettlementPnl(fills: DashboardFill[], winningLabel?: 'YES' | 'NO'): number | undefined {
  if (!fills.length || !winningLabel) return undefined;
  const buyCost = sumShares(fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.price * fill.size));
  const sellProceeds = sumShares(fills.filter((fill) => fill.side === 'SELL').map((fill) => fill.price * fill.size));
  const totalCost = buyCost - sellProceeds;
  const payout = fills
    .filter((fill) => fill.label === winningLabel)
    .reduce((total, fill) => total + (fill.side === 'BUY' ? fill.size : -fill.size), 0);
  return roundMoneyValue(payout - totalCost);
}

export function assetRouteLabel(selection: DashboardProfileState['dynamicEntryPrice']): string {
  if (!selection?.assetSelectorEnabled) return 'off';
  const rank = selection.assetSelectorRank ? `#${selection.assetSelectorRank}` : '-';
  return selection.assetSelectorSelected ? rank : `skip ${rank}`;
}

export function assetSelectorScoreLabel(selection: DashboardProfileState['dynamicEntryPrice']): string {
  return selection?.assetSelectorEnabled ? formatEv(selection.assetSelectorScore) : 'off';
}

export function orderFailureReason(order: DashboardOrder): string {
  if (order.error) return order.error;
  if (order.status === 'cancelled') return 'closed after round ended';
  if (order.status === 'failed') return 'failed without stored reason';
  return '-';
}

export function strategyCheckTone(check?: StrategyCheck): 'good' | 'warn' | 'bad' | 'neutral' {
  if (!check) return 'neutral';
  if (check.status === 'eligible') return 'good';
  if (check.status === 'blocked') return 'bad';
  return 'neutral';
}

export function strategyCheckLabel(check?: StrategyCheck): string {
  if (!check) return 'pending';
  return check.status;
}

export function currentRoundExposure(fills: DashboardFill[], roundId: string) {
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

export function isRoutineHeartbeatLog(log: RuntimeLogRecord): boolean {
  const message = log.message.toLowerCase();
  return log.level === 'info'
    && (message === 'scheduled tick completed.' || message === 'scheduled tick completed');
}

export function buildRoundExecutionSummaries(state: Pick<DashboardState, 'orders' | 'fills' | 'settlements' | 'profiles'>): RoundExecutionSummary[] {
  const byRound = new Map<string, {
    profileId?: string;
    strategy: StrategyId;
    orders: DashboardOrder[];
    fills: DashboardFill[];
    settlements: DashboardState['settlements'];
  }>();
  const ensure = (roundId: string, profileId: string | undefined, strategy: StrategyId) => {
    const key = `${profileId || 'unknown'}:${roundId}:${strategy}`;
    const existing = byRound.get(key);
    if (existing) return existing;
    const created = { profileId, strategy, orders: [], fills: [], settlements: [] };
    byRound.set(key, created);
    return created;
  };

  state.orders.forEach((order) => ensure(order.roundId, order.profileId, orderStrategyId(order)).orders.push(order));
  state.fills.forEach((fill) => ensure(fill.roundId, fill.profileId, orderStrategyId(fill)).fills.push(fill));
  state.settlements.forEach((settlement) => {
    const matchingStrategies = new Set<StrategyId>();
    state.orders.forEach((order) => {
      if (order.roundId === settlement.roundId && order.profileId === settlement.profileId) matchingStrategies.add(orderStrategyId(order));
    });
    state.fills.forEach((fill) => {
      if (fill.roundId === settlement.roundId && fill.profileId === settlement.profileId) matchingStrategies.add(orderStrategyId(fill));
    });
    if (matchingStrategies.size === 0) matchingStrategies.add('UPDOWN_DUAL_ENTRY');
    matchingStrategies.forEach((strategy) => ensure(settlement.roundId, settlement.profileId, strategy).settlements.push(settlement));
  });

  return [...byRound.entries()].map(([key, record]) => {
    const yesBuyOrders = record.orders.filter((order) => order.label === 'YES' && order.side === 'BUY');
    const noBuyOrders = record.orders.filter((order) => order.label === 'NO' && order.side === 'BUY');
    const unfilledByOrder = record.orders.map((order) => Math.max(0, order.size - orderFilledShares(order, record.fills)));
    const metadataSource = record.orders[0] || record.fills[0] || record.settlements[0];
    const roundId = metadataSource?.roundId || key.split(':').slice(1, -1).join(':');
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
      strategy: record.strategy,
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
      settlementPnl: strategySettlementPnl(record.fills, settlement?.winningLabel),
      settlementStatus: settlement?.status,
    };
  }).sort((a, b) => b.latestTime - a.latestTime);
}

export function buildDailyExecutionSummaries(rounds: RoundExecutionSummary[]): DailyExecutionSummary[] {
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

export function buildExecutionStats(state: Pick<DashboardState, 'orders' | 'fills' | 'settlements'>, windowEnd: number): ExecutionStats {
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

export function usePaginatedRows<T>(rows: T[], pageSize: number) {
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
