import 'dotenv/config';
import path from 'node:path';

import { btcMarketConfigSchema, type BtcMarketConfig, type ExecutionMode, type MarketInterval, type MarketProfile, type MarketProfileId, type StrategyProfile } from '../../../packages/shared/src';

type SupportedAssetSymbol = 'BTC' | 'ETH' | 'SOL' | 'DOGE' | 'XRP' | 'HYPE';

const DEFAULT_SINGLE_FILL_COOLDOWN = {
  baseMs: 15 * 60_000,
  priceCapMs: 30 * 60_000,
  executionMs: 60 * 60_000,
  repeatWindowMs: 60 * 60_000,
  secondMs: 60 * 60_000,
  thirdMs: 60 * 60_000,
};

export type AppConfig = {
  port: number;
  dashboardInternalApiKey?: string;
  executionMode: ExecutionMode;
  activeStrategyProfile: StrategyProfile;
  clobApiUrl: string;
  gammaApiUrl: string;
  dataApiUrl: string;
  chainId: number;
  ownerPrivateKey?: string;
  depositWallet?: string;
  tickIntervalMs: number;
  runtimeStatePath: string;
  runtimeMaxRecords: number;
  binanceWsUrl: string;
  binancePriceSampleMs: number;
  clobWsUrl: string;
  dualLimitPrice: number;
  dynamicLimitEnabled: boolean;
  minDynamicLimitPrice: number;
  maxDynamicLimitPrice: number;
  maxPairCost: number;
  orderSharesPerSide: number;
  dynamicSharesEnabled: boolean;
  maxOrderSharesPerSide: number;
  minOrderShares: number;
  maxOrderbookAgeSeconds: number;
  minCross120s: number;
  maxAbsDrift120s: number;
  maxAbsMomentum30s: number;
  minChopScore: number;
  minRangeBps120s: number;
  minBiExcursionBps120s: number;
  maxDriftRatio120s: number;
  maxMomentumRatio30s: number;
  maxEntryQueueImbalance: number;
  pm5mSimPriceEnabled: boolean;
  pm5mSimPriceSummaryPath: string;
  pm5mSimPriceRefreshMs: number;
  pm5mSimPriceMin: number;
  pm5mSimPriceMax: number;
  pm5mSimPriceMinRounds: number;
  pm5mSimPriceFallback: number;
  pm5mSimPriceMaxSummaryAgeMs: number;
  pm5mSimRequirePositiveEv: boolean;
  pm5mSimMinEvPerShare: number;
  pm5mAssetSelectorEnabled: boolean;
  pm5mAssetSelectorMaxAssets: number;
  pm5mAssetSelectorSinglePenalty: number;
  minLiveChopScore: number;
  bypassEntryScoreGating: boolean;
  bypassSingleFillCooldown: boolean;
  refreshSingleFillCooldownOnBoot: boolean;
  entryConfirmTicks: number;
  entryMinSecondsToStart: number;
  participationEnabled: boolean;
  participationCacheMs: number;
  participationTopHoldersPerSide: number;
  minParticipationHoldersPerSide: number;
  minParticipationTopHolderSharesPerSide: number;
  minParticipationTopPositionPnl: number;
  minParticipationPositionPnlSum: number;
  maxParticipationHolderConcentration: number;
  singleFillCooldownBaseMs: number;
  singleFillCooldownPriceCapMs: number;
  singleFillCooldownExecutionMs: number;
  singleFillCooldownRepeatWindowMs: number;
  singleFillCooldownSecondMs: number;
  singleFillCooldownThirdMs: number;
  singleFillHedgeEnabled: boolean;
  singleFillEarlyHedgeWindowSeconds: number;
  singleFillEarlyHedgeMaxPairCost: number;
  singleFillEmergencyHedgeWindowSeconds: number;
  singleFillEmergencyHedgeMaxPrice: number;
  singleFillEmergencyHedgeMaxPairCost: number;
  singleFillHedgeWindowSeconds: number;
  singleFillHedgeMinSecondsToEnd: number;
  singleFillHedgeMaxPrice: number;
  singleFillHedgePriceOffset: number;
  singleFillHedgeMaxPairCost: number;
  singleFillProfitExitEnabled: boolean;
  singleFillProfitExitMinRate: number;
  singleFillProfitExitMinPnlUsd: number;
  singleFillProfitExitPriceOffset: number;
  singleFillProfitExitMaxOrderbookAgeMs: number;
  singleFillProfitExitMinSecondsToEnd: number;
  singleFillProfitExitMaxSecondsToEnd: number;
  singleFillLossExitEnabled: boolean;
  singleFillLossExitMaxLossUsd: number;
  singleFillLossExitMinBid: number;
  singleFillLossExitPriceOffset: number;
  singleFillLossExitMaxOrderbookAgeMs: number;
  singleFillLossExitMinSecondsToEnd: number;
  singleFillLossExitMaxSecondsToEnd: number;
  crossProfileSingleFillRiskEnabled: boolean;
  experimentNextRoundUpLimitPrice: number;
  experimentNextRoundDownLimitPrice: number;
  experimentNextRoundSharesPerSide: number;
  experimentStopOnSingle: boolean;
  telegramNotifyEnabled: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramRoundSummaryOnOrderOnly: boolean;
  telegramIdleSummaryIntervalMs: number;
  marketConfig: BtcMarketConfig;
  marketProfiles: MarketProfile[];
};

export function loadConfig(): AppConfig {
  const orderSharesPerSide = numberEnv('ORDER_SHARES_PER_SIDE', 5);
  const marketProfiles = loadMarketProfiles(orderSharesPerSide);
  return {
    port: Number(process.env.PORT || 8788),
    dashboardInternalApiKey: process.env.DASHBOARD_INTERNAL_API_KEY,
    executionMode: parseExecutionMode(process.env.EXECUTION_MODE),
    activeStrategyProfile: parseStrategyProfile(process.env.ACTIVE_STRATEGY_PROFILE),
    clobApiUrl: process.env.POLYMARKET_CLOB_API_URL || 'https://clob.polymarket.com',
    gammaApiUrl: process.env.POLYMARKET_GAMMA_API_URL || 'https://gamma-api.polymarket.com',
    dataApiUrl: process.env.POLYMARKET_DATA_API_URL || 'https://data-api.polymarket.com',
    chainId: Number(process.env.POLYMARKET_CHAIN_ID || 137),
    ownerPrivateKey: process.env.OWNER_PRIVATE_KEY,
    depositWallet: process.env.POLYMARKET_DEPOSIT_WALLET,
    tickIntervalMs: parsePositiveInteger(process.env.BOT_TICK_MS, 2_000),
    runtimeStatePath: process.env.RUNTIME_STATE_PATH || path.resolve(process.cwd(), 'data/runtime-state.json'),
    runtimeMaxRecords: parsePositiveInteger(process.env.RUNTIME_MAX_RECORDS, 1_000),
    binanceWsUrl: binanceWsUrl(process.env.BINANCE_WS_URL || process.env.BINANCE_BTC_WS_URL, marketProfiles),
    binancePriceSampleMs: parsePositiveInteger(process.env.BINANCE_PRICE_SAMPLE_MS, 1_000),
    clobWsUrl: clobWsUrl(process.env.POLYMARKET_CLOB_WS_URL),
    dualLimitPrice: numberEnv('DUAL_LIMIT_PRICE', 0.45),
    dynamicLimitEnabled: booleanEnv('DYNAMIC_LIMIT_ENABLED', false),
    minDynamicLimitPrice: numberEnv('MIN_DYNAMIC_LIMIT_PRICE', 0.42),
    maxDynamicLimitPrice: numberEnv('MAX_DYNAMIC_LIMIT_PRICE', 0.46),
    maxPairCost: numberEnv('MAX_PAIR_COST', 0.92),
    orderSharesPerSide,
    dynamicSharesEnabled: booleanEnv('DYNAMIC_SHARES_ENABLED', false),
    maxOrderSharesPerSide: numberEnv('MAX_ORDER_SHARES_PER_SIDE', orderSharesPerSide * 1.25),
    minOrderShares: numberEnv('MIN_ORDER_SHARES', 5),
    maxOrderbookAgeSeconds: numberEnv('MAX_ORDERBOOK_AGE_SECONDS', 5),
    minCross120s: numberEnv('MIN_CROSS_120S', 2),
    maxAbsDrift120s: numberEnv('MAX_ABS_DRIFT_120S', 40),
    maxAbsMomentum30s: numberEnv('MAX_ABS_MOMENTUM_30S', 28),
    minChopScore: numberEnv('MIN_CHOP_SCORE', 70),
    minRangeBps120s: numberEnv('MIN_RANGE_BPS_120S', 3),
    minBiExcursionBps120s: numberEnv('MIN_BI_EXCURSION_BPS_120S', 1),
    maxDriftRatio120s: numberEnv('MAX_DRIFT_RATIO_120S', 0.45),
    maxMomentumRatio30s: numberEnv('MAX_MOMENTUM_RATIO_30S', 0.55),
    maxEntryQueueImbalance: numberEnv('MAX_ENTRY_QUEUE_IMBALANCE', 5),
    pm5mSimPriceEnabled: booleanEnv('PM5M_SIM_PRICE_ENABLED', booleanEnv('BTC_5M_SIM_PRICE_ENABLED', false)),
    pm5mSimPriceSummaryPath: process.env.PM5M_SIM_PRICE_SUMMARY_PATH || process.env.BTC_5M_SIM_PRICE_SUMMARY_PATH || process.env.PM5M_TOUCH_SUMMARY_PATH || 'data-lab/pm-5m-touch/summary.json',
    pm5mSimPriceRefreshMs: parsePositiveInteger(process.env.PM5M_SIM_PRICE_REFRESH_MS || process.env.BTC_5M_SIM_PRICE_REFRESH_MS, 30_000),
    pm5mSimPriceMin: numberEnv('PM5M_SIM_PRICE_MIN', numberEnv('BTC_5M_SIM_PRICE_MIN', 0.29)),
    pm5mSimPriceMax: numberEnv('PM5M_SIM_PRICE_MAX', numberEnv('BTC_5M_SIM_PRICE_MAX', 0.49)),
    pm5mSimPriceMinRounds: parsePositiveInteger(process.env.PM5M_SIM_PRICE_MIN_ROUNDS || process.env.BTC_5M_SIM_PRICE_MIN_ROUNDS, 100),
    pm5mSimPriceFallback: numberEnv('PM5M_SIM_PRICE_FALLBACK', numberEnv('BTC_5M_SIM_PRICE_FALLBACK', numberEnv('DUAL_LIMIT_PRICE', 0.45))),
    pm5mSimPriceMaxSummaryAgeMs: parsePositiveInteger(process.env.PM5M_SIM_PRICE_MAX_SUMMARY_AGE_MS || process.env.BTC_5M_SIM_PRICE_MAX_SUMMARY_AGE_MS, 10 * 60_000),
    pm5mSimRequirePositiveEv: booleanEnv('PM5M_SIM_REQUIRE_POSITIVE_EV', false),
    pm5mSimMinEvPerShare: numberEnv('PM5M_SIM_MIN_EV_PER_SHARE', 0),
    pm5mAssetSelectorEnabled: booleanEnv('PM5M_ASSET_SELECTOR_ENABLED', false),
    pm5mAssetSelectorMaxAssets: parsePositiveInteger(process.env.PM5M_ASSET_SELECTOR_MAX_ASSETS, 1),
    pm5mAssetSelectorSinglePenalty: numberEnv('PM5M_ASSET_SELECTOR_SINGLE_PENALTY', 0.05),
    minLiveChopScore: numberEnv('MIN_LIVE_CHOP_SCORE', 70),
    bypassEntryScoreGating: booleanEnv('BYPASS_ENTRY_SCORE_GATING', true),
    bypassSingleFillCooldown: booleanEnv('BYPASS_SINGLE_FILL_COOLDOWN', false),
    refreshSingleFillCooldownOnBoot: booleanEnv('REFRESH_SINGLE_FILL_COOLDOWN_ON_BOOT', false),
    entryConfirmTicks: parsePositiveInteger(process.env.ENTRY_CONFIRM_TICKS, 3),
    entryMinSecondsToStart: parsePositiveInteger(process.env.ENTRY_MIN_SECONDS_TO_START, 15),
    participationEnabled: booleanEnv('PARTICIPATION_ENABLED', true),
    participationCacheMs: parsePositiveInteger(process.env.PARTICIPATION_CACHE_MS, 30_000),
    participationTopHoldersPerSide: parsePositiveInteger(process.env.PARTICIPATION_TOP_HOLDERS_PER_SIDE, 8),
    minParticipationHoldersPerSide: parsePositiveInteger(process.env.MIN_PARTICIPATION_HOLDERS_PER_SIDE, 3),
    minParticipationTopHolderSharesPerSide: numberEnv('MIN_PARTICIPATION_TOP_HOLDER_SHARES_PER_SIDE', 300),
    minParticipationTopPositionPnl: numberEnv('MIN_PARTICIPATION_TOP_POSITION_PNL', 40),
    minParticipationPositionPnlSum: numberEnv('MIN_PARTICIPATION_POSITION_PNL_SUM', 100),
    maxParticipationHolderConcentration: numberEnv('MAX_PARTICIPATION_HOLDER_CONCENTRATION', 0.75),
    singleFillCooldownBaseMs: parsePositiveInteger(process.env.SINGLE_FILL_COOLDOWN_BASE_MS, DEFAULT_SINGLE_FILL_COOLDOWN.baseMs),
    singleFillCooldownPriceCapMs: parsePositiveInteger(process.env.SINGLE_FILL_COOLDOWN_PRICE_CAP_MS, DEFAULT_SINGLE_FILL_COOLDOWN.priceCapMs),
    singleFillCooldownExecutionMs: parsePositiveInteger(process.env.SINGLE_FILL_COOLDOWN_EXECUTION_MS, DEFAULT_SINGLE_FILL_COOLDOWN.executionMs),
    singleFillCooldownRepeatWindowMs: parsePositiveInteger(process.env.SINGLE_FILL_COOLDOWN_REPEAT_WINDOW_MS, DEFAULT_SINGLE_FILL_COOLDOWN.repeatWindowMs),
    singleFillCooldownSecondMs: parsePositiveInteger(process.env.SINGLE_FILL_COOLDOWN_SECOND_MS, DEFAULT_SINGLE_FILL_COOLDOWN.secondMs),
    singleFillCooldownThirdMs: parsePositiveInteger(process.env.SINGLE_FILL_COOLDOWN_THIRD_MS, DEFAULT_SINGLE_FILL_COOLDOWN.thirdMs),
    singleFillHedgeEnabled: booleanEnv('SINGLE_FILL_HEDGE_ENABLED', true),
    singleFillEarlyHedgeWindowSeconds: parsePositiveInteger(process.env.SINGLE_FILL_EARLY_HEDGE_WINDOW_SECONDS, 60),
    singleFillEarlyHedgeMaxPairCost: numberEnv('SINGLE_FILL_EARLY_HEDGE_MAX_PAIR_COST', 1.02),
    singleFillEmergencyHedgeWindowSeconds: parsePositiveInteger(process.env.SINGLE_FILL_EMERGENCY_HEDGE_WINDOW_SECONDS, 15),
    singleFillEmergencyHedgeMaxPrice: numberEnv('SINGLE_FILL_EMERGENCY_HEDGE_MAX_PRICE', 0.75),
    singleFillEmergencyHedgeMaxPairCost: numberEnv('SINGLE_FILL_EMERGENCY_HEDGE_MAX_PAIR_COST', 1.2),
    singleFillHedgeWindowSeconds: parsePositiveInteger(process.env.SINGLE_FILL_HEDGE_WINDOW_SECONDS, 30),
    singleFillHedgeMinSecondsToEnd: parsePositiveInteger(process.env.SINGLE_FILL_HEDGE_MIN_SECONDS_TO_END, 5),
    singleFillHedgeMaxPrice: numberEnv('SINGLE_FILL_HEDGE_MAX_PRICE', 0.65),
    singleFillHedgePriceOffset: numberEnv('SINGLE_FILL_HEDGE_PRICE_OFFSET', 0.01),
    singleFillHedgeMaxPairCost: numberEnv('SINGLE_FILL_HEDGE_MAX_PAIR_COST', 1.1),
    singleFillProfitExitEnabled: booleanEnv('SINGLE_FILL_PROFIT_EXIT_ENABLED', true),
    singleFillProfitExitMinRate: numberEnv('SINGLE_FILL_PROFIT_EXIT_MIN_RATE', 0.05),
    singleFillProfitExitMinPnlUsd: numberEnv('SINGLE_FILL_PROFIT_EXIT_MIN_PNL_USD', 0.3),
    singleFillProfitExitPriceOffset: numberEnv('SINGLE_FILL_PROFIT_EXIT_PRICE_OFFSET', 0.01),
    singleFillProfitExitMaxOrderbookAgeMs: parsePositiveInteger(process.env.SINGLE_FILL_PROFIT_EXIT_MAX_ORDERBOOK_AGE_MS, 1_000),
    singleFillProfitExitMinSecondsToEnd: parsePositiveInteger(process.env.SINGLE_FILL_PROFIT_EXIT_MIN_SECONDS_TO_END, 20),
    singleFillProfitExitMaxSecondsToEnd: parsePositiveInteger(process.env.SINGLE_FILL_PROFIT_EXIT_MAX_SECONDS_TO_END, 240),
    singleFillLossExitEnabled: booleanEnv('SINGLE_FILL_LOSS_EXIT_ENABLED', false),
    singleFillLossExitMaxLossUsd: numberEnv('SINGLE_FILL_LOSS_EXIT_MAX_LOSS_USD', 0.75),
    singleFillLossExitMinBid: numberEnv('SINGLE_FILL_LOSS_EXIT_MIN_BID', 0.3),
    singleFillLossExitPriceOffset: numberEnv('SINGLE_FILL_LOSS_EXIT_PRICE_OFFSET', 0.01),
    singleFillLossExitMaxOrderbookAgeMs: parsePositiveInteger(process.env.SINGLE_FILL_LOSS_EXIT_MAX_ORDERBOOK_AGE_MS, 1_000),
    singleFillLossExitMinSecondsToEnd: parsePositiveInteger(process.env.SINGLE_FILL_LOSS_EXIT_MIN_SECONDS_TO_END, 20),
    singleFillLossExitMaxSecondsToEnd: parsePositiveInteger(process.env.SINGLE_FILL_LOSS_EXIT_MAX_SECONDS_TO_END, 180),
    crossProfileSingleFillRiskEnabled: booleanEnv('CROSS_PROFILE_SINGLE_FILL_RISK_ENABLED', true),
    experimentNextRoundUpLimitPrice: numberEnv('EXPERIMENT_NEXT_ROUND_UP_LIMIT_PRICE', 0.5),
    experimentNextRoundDownLimitPrice: numberEnv('EXPERIMENT_NEXT_ROUND_DOWN_LIMIT_PRICE', 0.49),
    experimentNextRoundSharesPerSide: numberEnv('EXPERIMENT_NEXT_ROUND_SHARES_PER_SIDE', orderSharesPerSide),
    experimentStopOnSingle: booleanEnv('EXPERIMENT_STOP_ON_SINGLE', true),
    telegramNotifyEnabled: booleanEnv('TELEGRAM_NOTIFY_ENABLED', true),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_USER_ID,
    telegramRoundSummaryOnOrderOnly: booleanEnv('TELEGRAM_ROUND_SUMMARY_ON_ORDER_ONLY', true),
    telegramIdleSummaryIntervalMs: parsePositiveInteger(process.env.TELEGRAM_IDLE_SUMMARY_INTERVAL_MS, 4 * 60 * 60_000),
    marketConfig: loadMarketConfig(),
    marketProfiles,
  };
}

function loadMarketConfig(): BtcMarketConfig {
  return btcMarketConfigSchema.parse({
    seriesSlug: process.env.MARKET_SERIES_SLUG || 'btc-updown-5m',
    title: process.env.MARKET_TITLE || 'Polymarket Up/Down',
    roundDurationSeconds: 300,
    decisionLeadSeconds: 30,
    avoidExpirySeconds: 30,
  });
}

function loadMarketProfiles(orderSharesPerSide: number): MarketProfile[] {
  const baseLimitPrice = numberEnv('DUAL_LIMIT_PRICE', 0.45);
  const baseMinSecondsToStart = parsePositiveInteger(process.env.ENTRY_MIN_SECONDS_TO_START, 15);
  const baseConfirmTicks = parsePositiveInteger(process.env.ENTRY_CONFIRM_TICKS, 3);
  const btcStatuses: Record<MarketInterval, MarketProfile['status']> = {
    '5m': parseProfileStatus(process.env.BTC_5M_PROFILE_STATUS, process.env.EXECUTION_MODE === 'live' ? 'live' : 'monitor'),
    '15m': parseProfileStatus(process.env.BTC_15M_PROFILE_STATUS, 'monitor'),
    '1h': parseProfileStatus(process.env.BTC_1H_PROFILE_STATUS, 'monitor'),
  };
  const altStatuses: Record<Exclude<SupportedAssetSymbol, 'BTC'>, Record<MarketInterval, MarketProfile['status']>> = {
    ETH: {
      '5m': parseProfileStatus(process.env.ETH_5M_PROFILE_STATUS, 'disabled'),
      '15m': parseProfileStatus(process.env.ETH_15M_PROFILE_STATUS, 'disabled'),
      '1h': parseProfileStatus(process.env.ETH_1H_PROFILE_STATUS, 'disabled'),
    },
    SOL: {
      '5m': parseProfileStatus(process.env.SOL_5M_PROFILE_STATUS, 'disabled'),
      '15m': parseProfileStatus(process.env.SOL_15M_PROFILE_STATUS, 'disabled'),
      '1h': parseProfileStatus(process.env.SOL_1H_PROFILE_STATUS, 'disabled'),
    },
    DOGE: {
      '5m': parseProfileStatus(process.env.DOGE_5M_PROFILE_STATUS, 'disabled'),
      '15m': parseProfileStatus(process.env.DOGE_15M_PROFILE_STATUS, 'disabled'),
      '1h': parseProfileStatus(process.env.DOGE_1H_PROFILE_STATUS, 'disabled'),
    },
    XRP: {
      '5m': parseProfileStatus(process.env.XRP_5M_PROFILE_STATUS, 'disabled'),
      '15m': parseProfileStatus(process.env.XRP_15M_PROFILE_STATUS, 'disabled'),
      '1h': parseProfileStatus(process.env.XRP_1H_PROFILE_STATUS, 'disabled'),
    },
    HYPE: {
      '5m': parseProfileStatus(process.env.HYPE_5M_PROFILE_STATUS, 'disabled'),
      '15m': parseProfileStatus(process.env.HYPE_15M_PROFILE_STATUS, 'disabled'),
      '1h': parseProfileStatus(process.env.HYPE_1H_PROFILE_STATUS, 'disabled'),
    },
  };
  const profiles: MarketProfile[] = [
    makeProfile({ id: 'btc-5m', assetSymbol: 'BTC', interval: '5m', status: btcStatuses['5m'], durationSeconds: 300, decisionLeadSeconds: 30, orderSharesPerSide, limitPrice: baseLimitPrice, minSecondsToStart: baseMinSecondsToStart, confirmTicks: baseConfirmTicks, hedgeWindows: [60, 30, 15], priceFeedSymbol: 'btcusdt' }),
    makeProfile({ id: 'btc-15m', assetSymbol: 'BTC', interval: '15m', status: btcStatuses['15m'], durationSeconds: 900, decisionLeadSeconds: 90, orderSharesPerSide, limitPrice: baseLimitPrice, minSecondsToStart: baseMinSecondsToStart, confirmTicks: baseConfirmTicks, hedgeWindows: [180, 90, 30], priceFeedSymbol: 'btcusdt' }),
    makeProfile({ id: 'btc-1h', assetSymbol: 'BTC', interval: '1h', status: btcStatuses['1h'], durationSeconds: 3600, decisionLeadSeconds: 180, orderSharesPerSide, limitPrice: baseLimitPrice, minSecondsToStart: baseMinSecondsToStart, confirmTicks: baseConfirmTicks, hedgeWindows: [600, 300, 60], priceFeedSymbol: 'btcusdt' }),
  ];

  for (const assetSymbol of ['ETH', 'SOL', 'DOGE', 'XRP', 'HYPE'] as const) {
    for (const interval of ['5m', '15m', '1h'] as const) {
      const durationSeconds = interval === '5m' ? 300 : interval === '15m' ? 900 : 3600;
      const decisionLeadSeconds = interval === '5m' ? 30 : interval === '15m' ? 90 : 180;
      const hedgeWindows: [number, number, number] = interval === '5m' ? [60, 30, 15] : interval === '15m' ? [180, 90, 30] : [600, 300, 60];
      profiles.push(makeProfile({
        id: `${assetSymbol.toLowerCase()}-${interval}` as MarketProfileId,
        assetSymbol,
        interval,
        status: altStatuses[assetSymbol][interval],
        durationSeconds,
        decisionLeadSeconds,
        orderSharesPerSide,
        limitPrice: baseLimitPrice,
        minSecondsToStart: baseMinSecondsToStart,
        confirmTicks: baseConfirmTicks,
        hedgeWindows,
        priceFeedSymbol: `${assetSymbol.toLowerCase()}usdt`,
      }));
    }
  }
  return profiles;
}

function makeProfile(params: {
  id: MarketProfileId;
  assetSymbol: SupportedAssetSymbol;
  interval: MarketInterval;
  status: MarketProfile['status'];
  durationSeconds: number;
  decisionLeadSeconds: number;
  orderSharesPerSide: number;
  limitPrice: number;
  minSecondsToStart: number;
  confirmTicks: number;
  hedgeWindows: [early: number, final: number, emergency: number];
  priceFeedSymbol: string;
}): MarketProfile {
  const asset = params.assetSymbol.toLowerCase() as MarketProfile['asset'];
  return {
    id: params.id,
    asset,
    assetSymbol: params.assetSymbol,
    interval: params.interval,
    label: `${params.assetSymbol} ${params.interval}`,
    status: params.status,
    seriesSlug: `${asset}-updown-${params.interval}`,
    title: `Polymarket ${params.assetSymbol} ${params.interval}`,
    roundDurationSeconds: params.durationSeconds,
    decisionLeadSeconds: params.decisionLeadSeconds,
    avoidExpirySeconds: params.interval === '1h' ? 120 : 30,
    priceFeedSymbol: params.priceFeedSymbol,
    entry: {
      enabled: true,
      limitPrice: params.limitPrice,
      sharesPerSide: params.orderSharesPerSide,
      minSecondsToStart: params.minSecondsToStart,
      confirmTicks: params.confirmTicks,
    },
    profitExit: {
      enabled: booleanEnv('SINGLE_FILL_PROFIT_EXIT_ENABLED', true),
      minProfitRate: numberEnv('SINGLE_FILL_PROFIT_EXIT_MIN_RATE', 0.05),
      minPnlUsd: numberEnv('SINGLE_FILL_PROFIT_EXIT_MIN_PNL_USD', 0.3),
      priceOffset: numberEnv('SINGLE_FILL_PROFIT_EXIT_PRICE_OFFSET', 0.01),
      maxOrderbookAgeMs: parsePositiveInteger(process.env.SINGLE_FILL_PROFIT_EXIT_MAX_ORDERBOOK_AGE_MS, 1_000),
      minSecondsToEnd: params.interval === '1h' ? 60 : parsePositiveInteger(process.env.SINGLE_FILL_PROFIT_EXIT_MIN_SECONDS_TO_END, 20),
      maxSecondsToEnd: params.interval === '1h' ? 2700 : parsePositiveInteger(process.env.SINGLE_FILL_PROFIT_EXIT_MAX_SECONDS_TO_END, 240),
    },
    hedge: {
      enabled: booleanEnv('SINGLE_FILL_HEDGE_ENABLED', true),
      earlyWindowSeconds: params.hedgeWindows[0],
      earlyMaxPairCost: numberEnv('SINGLE_FILL_EARLY_HEDGE_MAX_PAIR_COST', 1.02),
      emergencyWindowSeconds: params.hedgeWindows[2],
      emergencyMaxPrice: numberEnv('SINGLE_FILL_EMERGENCY_HEDGE_MAX_PRICE', 0.75),
      emergencyMaxPairCost: numberEnv('SINGLE_FILL_EMERGENCY_HEDGE_MAX_PAIR_COST', 1.2),
      finalWindowSeconds: params.hedgeWindows[1],
      minSecondsToEnd: params.interval === '1h' ? 15 : parsePositiveInteger(process.env.SINGLE_FILL_HEDGE_MIN_SECONDS_TO_END, 5),
      maxPrice: numberEnv('SINGLE_FILL_HEDGE_MAX_PRICE', 0.65),
      priceOffset: numberEnv('SINGLE_FILL_HEDGE_PRICE_OFFSET', 0.01),
      maxPairCost: numberEnv('SINGLE_FILL_HEDGE_MAX_PAIR_COST', 1.1),
    },
    cooldown: {
      baseMs: profileCooldownMs(params, 'BASE', DEFAULT_SINGLE_FILL_COOLDOWN.baseMs),
      priceCapMs: profileCooldownMs(params, 'PRICE_CAP', DEFAULT_SINGLE_FILL_COOLDOWN.priceCapMs),
      executionMs: profileCooldownMs(params, 'EXECUTION', DEFAULT_SINGLE_FILL_COOLDOWN.executionMs),
      repeatWindowMs: profileCooldownMs(params, 'REPEAT_WINDOW', DEFAULT_SINGLE_FILL_COOLDOWN.repeatWindowMs),
      secondMs: profileCooldownMs(params, 'SECOND', DEFAULT_SINGLE_FILL_COOLDOWN.secondMs),
      thirdMs: profileCooldownMs(params, 'THIRD', DEFAULT_SINGLE_FILL_COOLDOWN.thirdMs),
    },
  };
}

function profileCooldownMs(params: { assetSymbol: SupportedAssetSymbol; interval: MarketInterval }, key: string, fiveMinuteDefaultMs: number): number {
  const intervalKey = params.interval.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const assetIntervalKey = `${params.assetSymbol}_${intervalKey}_SINGLE_FILL_COOLDOWN_${key}_MS`;
  const intervalOnlyKey = `${intervalKey}_SINGLE_FILL_COOLDOWN_${key}_MS`;
  const globalKey = `SINGLE_FILL_COOLDOWN_${key}_MS`;
  return parsePositiveInteger(process.env[assetIntervalKey] || process.env[intervalOnlyKey] || process.env[globalKey], fiveMinuteDefaultMs);
}

function parseProfileStatus(value: string | undefined, fallback: MarketProfile['status']): MarketProfile['status'] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'disable') return 'disabled';
  if (normalized === 'live' || normalized === 'monitor' || normalized === 'disabled') return normalized;
  return fallback;
}

function parseExecutionMode(value: string | undefined): ExecutionMode {
  if (!value?.trim()) return 'live';
  return value === 'live' ? 'live' : 'monitor';
}

function parseStrategyProfile(value: string | undefined): StrategyProfile {
  const normalized = value?.trim();
  if (!normalized || normalized === 'classic') return 'classic';
  if (normalized === 'experiment_next_round') return 'experiment_next_round';
  throw new Error(`ACTIVE_STRATEGY_PROFILE must be "classic" or "experiment_next_round", got "${value}".`);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function binanceWsUrl(value: string | undefined, profiles: MarketProfile[]): string {
  const url = value?.trim() || 'wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/ethusdt@aggTrade/solusdt@aggTrade/dogeusdt@aggTrade/xrpusdt@aggTrade/hypeusdt@aggTrade';
  if (!url.startsWith('wss://')) throw new Error('BINANCE_WS_URL must be a wss:// URL.');
  if (!url.includes('/stream?streams=') && !url.includes('/ws/')) return url;
  const [base, streamList = ''] = url.includes('/stream?streams=')
    ? url.split('/stream?streams=')
    : url.split('/ws/');
  const streams = new Set(streamList.split('/').map((item) => item.trim()).filter(Boolean));
  for (const profile of profiles) {
    if (profile.status === 'disabled') continue;
    streams.add(`${profile.priceFeedSymbol.toLowerCase()}@aggTrade`);
  }
  return `${base}/stream?streams=${[...streams].join('/')}`;
}

function clobWsUrl(value: string | undefined): string {
  const url = value?.trim() || 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
  if (!url.startsWith('wss://')) throw new Error('POLYMARKET_CLOB_WS_URL must be a wss:// URL.');
  return url;
}
