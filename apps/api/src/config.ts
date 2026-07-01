import 'dotenv/config';
import path from 'node:path';

import { btcMarketConfigSchema, type BtcMarketConfig, type ExecutionMode, type StrategyProfile } from '../../../packages/shared/src';

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
  minLiveChopScore: number;
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
  singleFillCooldownMs: number;
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
  singleFillProfitExitMinPrice: number;
  singleFillProfitExitMinPnlUsd: number;
  singleFillProfitExitPriceOffset: number;
  singleFillProfitExitMaxOrderbookAgeMs: number;
  singleFillProfitExitMinSecondsToEnd: number;
  singleFillProfitExitMaxSecondsToEnd: number;
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
};

export function loadConfig(): AppConfig {
  const orderSharesPerSide = numberEnv('ORDER_SHARES_PER_SIDE', 10);
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
    binanceWsUrl: binanceWsUrl(process.env.BINANCE_BTC_WS_URL),
    binancePriceSampleMs: parsePositiveInteger(process.env.BINANCE_PRICE_SAMPLE_MS, 1_000),
    clobWsUrl: clobWsUrl(process.env.POLYMARKET_CLOB_WS_URL),
    dualLimitPrice: numberEnv('DUAL_LIMIT_PRICE', 0.45),
    dynamicLimitEnabled: booleanEnv('DYNAMIC_LIMIT_ENABLED', true),
    minDynamicLimitPrice: numberEnv('MIN_DYNAMIC_LIMIT_PRICE', 0.42),
    maxDynamicLimitPrice: numberEnv('MAX_DYNAMIC_LIMIT_PRICE', 0.46),
    maxPairCost: numberEnv('MAX_PAIR_COST', 0.92),
    orderSharesPerSide,
    dynamicSharesEnabled: booleanEnv('DYNAMIC_SHARES_ENABLED', true),
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
    minLiveChopScore: numberEnv('MIN_LIVE_CHOP_SCORE', 80),
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
    singleFillCooldownMs: parsePositiveInteger(process.env.SINGLE_FILL_COOLDOWN_MS, 4 * 60 * 60_000),
    singleFillCooldownBaseMs: parsePositiveInteger(process.env.SINGLE_FILL_COOLDOWN_BASE_MS, 30 * 60_000),
    singleFillCooldownPriceCapMs: parsePositiveInteger(process.env.SINGLE_FILL_COOLDOWN_PRICE_CAP_MS, 60 * 60_000),
    singleFillCooldownExecutionMs: parsePositiveInteger(process.env.SINGLE_FILL_COOLDOWN_EXECUTION_MS, 2 * 60 * 60_000),
    singleFillCooldownRepeatWindowMs: parsePositiveInteger(process.env.SINGLE_FILL_COOLDOWN_REPEAT_WINDOW_MS, 2 * 60 * 60_000),
    singleFillCooldownSecondMs: parsePositiveInteger(process.env.SINGLE_FILL_COOLDOWN_SECOND_MS, 2 * 60 * 60_000),
    singleFillCooldownThirdMs: parsePositiveInteger(process.env.SINGLE_FILL_COOLDOWN_THIRD_MS, 4 * 60 * 60_000),
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
    singleFillProfitExitMinPrice: numberEnv('SINGLE_FILL_PROFIT_EXIT_MIN_PRICE', 0.5),
    singleFillProfitExitMinPnlUsd: numberEnv('SINGLE_FILL_PROFIT_EXIT_MIN_PNL_USD', 0.3),
    singleFillProfitExitPriceOffset: numberEnv('SINGLE_FILL_PROFIT_EXIT_PRICE_OFFSET', 0.01),
    singleFillProfitExitMaxOrderbookAgeMs: parsePositiveInteger(process.env.SINGLE_FILL_PROFIT_EXIT_MAX_ORDERBOOK_AGE_MS, 1_000),
    singleFillProfitExitMinSecondsToEnd: parsePositiveInteger(process.env.SINGLE_FILL_PROFIT_EXIT_MIN_SECONDS_TO_END, 20),
    singleFillProfitExitMaxSecondsToEnd: parsePositiveInteger(process.env.SINGLE_FILL_PROFIT_EXIT_MAX_SECONDS_TO_END, 240),
    experimentNextRoundUpLimitPrice: numberEnv('EXPERIMENT_NEXT_ROUND_UP_LIMIT_PRICE', 0.5),
    experimentNextRoundDownLimitPrice: numberEnv('EXPERIMENT_NEXT_ROUND_DOWN_LIMIT_PRICE', 0.49),
    experimentNextRoundSharesPerSide: numberEnv('EXPERIMENT_NEXT_ROUND_SHARES_PER_SIDE', orderSharesPerSide),
    experimentStopOnSingle: booleanEnv('EXPERIMENT_STOP_ON_SINGLE', true),
    telegramNotifyEnabled: booleanEnv('TELEGRAM_NOTIFY_ENABLED', false),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_USER_ID,
    telegramRoundSummaryOnOrderOnly: booleanEnv('TELEGRAM_ROUND_SUMMARY_ON_ORDER_ONLY', true),
    telegramIdleSummaryIntervalMs: parsePositiveInteger(process.env.TELEGRAM_IDLE_SUMMARY_INTERVAL_MS, 4 * 60 * 60_000),
    marketConfig: loadMarketConfig(),
  };
}

function loadMarketConfig(): BtcMarketConfig {
  return btcMarketConfigSchema.parse({
    seriesSlug: process.env.MARKET_SERIES_SLUG || 'btc-updown-5m',
    title: process.env.MARKET_TITLE || 'Polymarket BTC 5m',
    roundDurationSeconds: 300,
    decisionLeadSeconds: 30,
    avoidExpirySeconds: 30,
  });
}

function parseExecutionMode(value: string | undefined): ExecutionMode {
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

function binanceWsUrl(value: string | undefined): string {
  const url = value?.trim() || 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade';
  if (!url.startsWith('wss://')) throw new Error('BINANCE_BTC_WS_URL must be a wss:// URL.');
  return url;
}

function clobWsUrl(value: string | undefined): string {
  const url = value?.trim() || 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
  if (!url.startsWith('wss://')) throw new Error('POLYMARKET_CLOB_WS_URL must be a wss:// URL.');
  return url;
}
