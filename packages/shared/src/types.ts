export type ExecutionMode = 'monitor' | 'live';

export type TradeSide = 'BUY' | 'SELL';

export type RoundPhase = 'observing' | 'decision' | 'posting' | 'monitoring' | 'settling' | 'settled';

export type Regime = 'CHOP' | 'TREND' | 'LOW_ACTIVITY' | 'UNKNOWN';

export type StrategyId = 'BTC5M_DUAL_45' | 'BTC5M_SINGLE_FILL_HEDGE' | 'BTC5M_SINGLE_FILL_PROFIT_EXIT' | 'BTC5M_SINGLE_EXIT';

export type BotRuntimeStatus = {
  status: 'running' | 'degraded';
  executionMode: ExecutionMode;
  startedAt: string;
  lastTickAt?: string;
  nextTickAt?: string;
  tickIntervalMs: number;
  version: string;
  dockerReady: boolean;
  entryCooldownUntil?: string;
  entryCooldownReason?: string;
};

export type BtcRoundConfig = {
  eventSlug: string;
  conditionId?: string;
  title?: string;
  startAt: string;
  endAt: string;
  strike: number;
  yesTokenId: string;
  noTokenId: string;
  sourceUrl?: string;
  imageUrl?: string;
};

export type BtcMarketConfig = {
  seriesSlug: string;
  title: string;
  roundDurationSeconds: number;
  decisionLeadSeconds: number;
  avoidExpirySeconds: number;
  strike?: number;
  yesTokenId?: string;
  noTokenId?: string;
  staticRound?: BtcRoundConfig;
};

export type PriceTick = {
  price: number;
  source: 'binance';
  receivedAt: string;
};

export type OrderBookLevel = {
  price: number;
  size: number;
};

export type OrderBookQuote = {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
  bidDepth: number;
  askDepth: number;
  imbalance: number | null;
  updatedAt: string;
  source: 'mock' | 'ws';
  bids?: OrderBookLevel[];
  asks?: OrderBookLevel[];
};

export type BtcFeatureSnapshot = {
  price: number | null;
  strike: number;
  cross120s: number;
  crossFrequency: number;
  volatility120s: number;
  drift120s: number;
  momentum30s: number;
  range120s: number;
  range300s: number;
  rangeBps120s: number;
  rangeBps300s: number;
  centerPrice120s: number | null;
  centerCross120s: number;
  latestRangePosition120s: number | null;
  upExcursionBps120s: number;
  downExcursionBps120s: number;
  minBiExcursionBps120s: number;
  excursionBalance120s: number;
  centerUpExcursionBps120s: number;
  centerDownExcursionBps120s: number;
  centerMinBiExcursionBps120s: number;
  centerExcursionBalance120s: number;
  driftRatio120s: number;
  momentumRatio30s: number;
  rangePercentile120s: number | null;
  chopScore: number;
  samples120s: number;
  latestCrossAt?: string;
  source: PriceTick['source'] | 'none';
  updatedAt: string;
};

export type RoundSnapshot = {
  id: string;
  phase: RoundPhase;
  eventSlug: string;
  conditionId?: string;
  title?: string;
  startAt: string;
  endAt: string;
  secondsToStart: number;
  secondsToEnd: number;
  strike: number;
  strikeStatus: 'estimated' | 'locked';
  yesTokenId: string;
  noTokenId: string;
  sourceUrl?: string;
  imageUrl?: string;
};

export type PositionSnapshot = {
  tokenId: string;
  label: 'YES' | 'NO' | 'UNKNOWN';
  title?: string;
  shares: number;
  avgPrice: number;
  currentPrice?: number;
  openedAt?: string;
  lastTradeAt?: string;
};

export type ParticipationSideSnapshot = {
  label: 'YES' | 'NO';
  holderCount: number;
  topHolderShares: number;
  largestHolderShares: number;
  largestHolderShareRatio: number | null;
  positionCount: number;
  topPositionPnl: number | null;
  positionPnlSum: number;
  positionCurrentValueSum: number;
};

export type MarketParticipationSnapshot = {
  status: 'enabled' | 'disabled' | 'missing-condition' | 'unavailable';
  updatedAt: string;
  topHoldersPerSide: number;
  maxPositionPnl: number | null;
  totalTopHolderShares: number;
  totalPositionPnl: number;
  sides: ParticipationSideSnapshot[];
  diagnostics: string[];
};

export type StateSnapshot = {
  id: string;
  capturedAt: string;
  round: RoundSnapshot;
  features: BtcFeatureSnapshot;
  regime: Regime;
  orderbooks: OrderBookQuote[];
  positions: PositionSnapshot[];
  positionReadStatus: 'enabled' | 'disabled';
  participation?: MarketParticipationSnapshot;
  diagnostics: string[];
};

export type TradeIntent = {
  id: string;
  strategy: StrategyId;
  roundId: string;
  tokenId: string;
  label: 'YES' | 'NO';
  side: TradeSide;
  orderType: 'LIMIT';
  limitPrice: number;
  shares: number;
  reason: string;
  status: 'generated' | 'rejected' | 'executed' | 'failed';
  ttlSeconds: number;
  createdAt: string;
  rejectionReason?: string;
};

export type StrategyCondition = {
  label: string;
  passed: boolean;
  actual: string;
};

export type StrategyCheck = {
  strategy: StrategyId;
  title: string;
  status: 'eligible' | 'blocked' | 'not-applicable';
  summary: string;
  reason: string;
  blockers: string[];
  conditions: StrategyCondition[];
  amountUsd?: number;
  limitPrice?: number;
};

export type StrategyRule = {
  id: StrategyId;
  title: string;
  allocationPct: number;
  summary: string;
  entryRules: string[];
  exitRules: string[];
};

export type OrderRecord = {
  id: string;
  intentId: string;
  executionKey?: string;
  clobOrderId?: string;
  roundId: string;
  eventSlug: string;
  marketTitle?: string;
  imageUrl?: string;
  tokenId: string;
  label: 'YES' | 'NO';
  side: TradeSide;
  price: number;
  size: number;
  status: 'local' | 'posted' | 'partially_filled' | 'filled' | 'cancelled' | 'failed';
  createdAt: string;
  updatedAt?: string;
  filledSize?: number;
  avgFillPrice?: number;
  error?: string;
  rawResponse?: unknown;
};

export type FillRecord = {
  id: string;
  roundId: string;
  eventSlug?: string;
  marketTitle?: string;
  imageUrl?: string;
  clobOrderId?: string;
  tokenId: string;
  label: 'YES' | 'NO';
  side: TradeSide;
  price: number;
  size: number;
  matchedAt: string;
  raw?: unknown;
};

export type SettlementRecord = {
  id: string;
  roundId: string;
  eventSlug: string;
  marketTitle?: string;
  imageUrl?: string;
  resolvedAt: string;
  winningLabel?: 'YES' | 'NO';
  yesShares: number;
  noShares: number;
  totalCost: number;
  payout: number;
  pnl: number;
  status: 'estimated' | 'settled';
};

export type RuntimeLogRecord = {
  id: string;
  level: 'info' | 'warn' | 'error';
  source: 'worker' | 'api' | 'execution' | 'market-data' | 'operator';
  message: string;
  createdAt: string;
  details?: unknown;
};

export type DataFeedStatus = {
  binanceConnected: boolean;
  clobConnected: boolean;
  lastPriceAt?: string;
  lastOrderbookAt?: string;
  priceSamples: number;
  source: 'live' | 'unavailable';
};

export type DashboardState = {
  runtime: BotRuntimeStatus;
  feed: DataFeedStatus;
  latestSnapshot: StateSnapshot;
  intents: TradeIntent[];
  orders: OrderRecord[];
  fills: FillRecord[];
  settlements: SettlementRecord[];
  runtimeLogs: RuntimeLogRecord[];
  rules: StrategyRule[];
  strategyChecks: StrategyCheck[];
};
