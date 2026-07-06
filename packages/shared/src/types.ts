export type ExecutionMode = 'monitor' | 'live';

export type TradeSide = 'BUY' | 'SELL';

export type RoundPhase = 'observing' | 'decision' | 'posting' | 'monitoring' | 'settling' | 'settled';

export type Regime = 'CHOP' | 'TREND' | 'LOW_ACTIVITY' | 'UNKNOWN';

export type StrategyProfile = 'classic' | 'experiment_next_round';

export type MarketAsset = 'btc' | 'eth' | 'sol' | 'doge' | 'xrp' | 'hype';

export type MarketInterval = '5m' | '15m' | '1h';

export type MarketProfileId = `${MarketAsset}-${MarketInterval}`;

export type MarketProfileStatus = 'disabled' | 'monitor' | 'live';

export type MarketProfile = {
  id: MarketProfileId;
  asset: MarketAsset;
  assetSymbol: 'BTC' | 'ETH' | 'SOL' | 'DOGE' | 'XRP' | 'HYPE';
  interval: MarketInterval;
  label: string;
  status: MarketProfileStatus;
  seriesSlug: string;
  title: string;
  roundDurationSeconds: number;
  decisionLeadSeconds: number;
  avoidExpirySeconds: number;
  priceFeedSymbol: string;
  entry: {
    enabled: boolean;
    limitPrice: number;
    sharesPerSide: number;
    minSecondsToStart: number;
    confirmTicks: number;
  };
  profitExit: {
    enabled: boolean;
    minProfitRate: number;
    minPnlUsd: number;
    priceOffset: number;
    maxOrderbookAgeMs: number;
    minSecondsToEnd: number;
    maxSecondsToEnd: number;
  };
  hedge: {
    enabled: boolean;
    earlyWindowSeconds: number;
    earlyMaxPairCost: number;
    emergencyWindowSeconds: number;
    emergencyMaxPrice: number;
    emergencyMaxPairCost: number;
    finalWindowSeconds: number;
    minSecondsToEnd: number;
    maxPrice: number;
    priceOffset: number;
    maxPairCost: number;
  };
  cooldown: {
    baseMs: number;
    priceCapMs: number;
    executionMs: number;
    repeatWindowMs: number;
    secondMs: number;
    thirdMs: number;
  };
};

export type StrategyId =
  | 'UPDOWN_DUAL_ENTRY'
  | 'UPDOWN_NEXT_ROUND_50_49_STOP_ON_SINGLE'
  | 'UPDOWN_SINGLE_FILL_HEDGE'
  | 'UPDOWN_SINGLE_FILL_PROFIT_EXIT'
  | 'UPDOWN_SINGLE_FILL_LOSS_EXIT'
  | 'UPDOWN_SINGLE_EXIT';

export type BotRuntimeStatus = {
  status: 'running' | 'degraded';
  executionMode: ExecutionMode;
  startedAt: string;
  lastTickAt?: string;
  nextTickAt?: string;
  tickIntervalMs: number;
  version: string;
  buildSha?: string;
  buildTime?: string;
  dockerReady: boolean;
  activeStrategyProfile: StrategyProfile;
  entryConfig?: EntryRuntimeConfig;
  experimentStoppedAt?: string;
  experimentStoppedReason?: string;
  experimentStoppedRoundId?: string;
};

export type EntryRuntimeConfig = {
  dynamicLimitEnabled: boolean;
  dualLimitPrice: number;
  dynamicSharesEnabled: boolean;
  orderSharesPerSide: number;
  maxOrderSharesPerSide: number;
  minOrderShares: number;
  minLiveChopScore: number;
  bypassEntryScoreGating: boolean;
  bypassSingleFillCooldown: boolean;
  entryConfirmTicks: number;
  entryMinSecondsToStart: number;
  maxPairCost: number;
  maxOrderbookAgeSeconds: number;
  maxEntryQueueImbalance: number;
  participationEnabled: boolean;
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

export type OrderbookDepthLevel = {
  limitPrice: number;
  pairedImmediateShares: number;
  pairedImmediateCostUsd: number;
  maxPairNotionalUsd: number;
  minBidQueueShares: number;
  minBidAtLimitShares: number;
  queueRatio: number | null;
};

export type OrderbookCapacityTier = {
  label: 'safe' | 'conservative' | 'aggressive' | 'stretched';
  maxSharesPerSide: number;
  maxPairAmountUsd: number;
  queueSharePct: number;
  exactLevelSharePct: number;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
};

export type OrderbookDepthSnapshot = {
  status: 'ready' | 'insufficient';
  updatedAt: string;
  roundId: string;
  activeLimitPrice: number;
  baseSharesPerSide: number;
  levels: OrderbookDepthLevel[];
  tiers: OrderbookCapacityTier[];
  diagnostics: string[];
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
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  openedAt?: string;
  lastTradeAt?: string;
};

export type PortfolioSnapshot = {
  status: 'enabled' | 'disabled' | 'partial' | 'unavailable';
  updatedAt: string;
  accountAddress?: string;
  profile?: {
    name?: string;
    pseudonym?: string;
    bio?: string;
    profileImage?: string;
    profileImageOptimized?: string;
  };
  hasOwnerPrivateKey: boolean;
  hasDepositWallet: boolean;
  collateralBalance?: number;
  collateralAllowance?: number | null;
  positions: PositionSnapshot[];
  positionCount: number;
  positionValue: number;
  positionCost: number;
  unrealizedPnl: number;
  settledPnl: number;
  totalPnl: number;
  roiPct: number | null;
  diagnostics: string[];
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
  profileId: MarketProfileId;
  asset: MarketAsset;
  interval: MarketInterval;
  capturedAt: string;
  round: RoundSnapshot;
  features: BtcFeatureSnapshot;
  regime: Regime;
  orderbooks: OrderBookQuote[];
  orderbookDepth?: OrderbookDepthSnapshot;
  positions: PositionSnapshot[];
  positionReadStatus: 'enabled' | 'disabled';
  portfolio?: PortfolioSnapshot;
  participation?: MarketParticipationSnapshot;
  diagnostics: string[];
};

export type TradeIntent = {
  id: string;
  profileId: MarketProfileId;
  asset: MarketAsset;
  interval: MarketInterval;
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
  profileId: MarketProfileId;
  asset: MarketAsset;
  interval: MarketInterval;
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
  profileId: MarketProfileId;
  asset: MarketAsset;
  interval: MarketInterval;
  intentId: string;
  strategy?: StrategyId;
  strategyProfile?: StrategyProfile;
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
  profileId: MarketProfileId;
  asset: MarketAsset;
  interval: MarketInterval;
  strategy?: StrategyId;
  strategyProfile?: StrategyProfile;
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
  profileId: MarketProfileId;
  asset: MarketAsset;
  interval: MarketInterval;
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
  profileId?: MarketProfileId;
  asset?: MarketAsset;
  interval?: MarketInterval;
  level: 'info' | 'warn' | 'error';
  source: 'worker' | 'api' | 'execution' | 'market-data' | 'operator' | 'telegram';
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
  profiles: ProfileDashboardState[];
  intents: TradeIntent[];
  orders: OrderRecord[];
  fills: FillRecord[];
  settlements: SettlementRecord[];
  runtimeLogs: RuntimeLogRecord[];
  rules: StrategyRule[];
};

export type ProfileDashboardState = {
  profile: MarketProfile;
  feed: DataFeedStatus;
  latestSnapshot?: StateSnapshot;
  strategyChecks: StrategyCheck[];
  entryCooldownUntil?: string;
  entryCooldownReason?: string;
  dynamicEntryPrice?: DynamicEntryPriceSelection;
  stats: {
    orders: number;
    fills: number;
    settlements: number;
    settledPnl: number;
  };
};

export type DynamicEntryPriceSelection = {
  profileId: MarketProfileId;
  enabled: boolean;
  source: 'simulator' | 'fallback' | 'disabled';
  selectedPrice: number;
  fallbackPrice: number;
  reason: string;
  selectedAt: string;
  nextSelectionAt?: string;
  summaryGeneratedAt?: string;
  summaryAgeMs?: number;
  assetSelectorEnabled?: boolean;
  assetSelectorSelected?: boolean;
  assetSelectorRank?: number;
  assetSelectorScore?: number;
  assetSelectorEv?: number | null;
  assetSelectorSinglePenalty?: number;
  rounds?: number;
  pairedRate?: number | null;
  singleRate?: number | null;
  noneRate?: number | null;
  estimatedEvPerShare?: number | null;
};
