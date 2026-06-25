import 'dotenv/config';
import path from 'node:path';

import { btcMarketConfigSchema, type BtcMarketConfig, type ExecutionMode } from '../../../packages/shared/src';

export type AppConfig = {
  port: number;
  dashboardInternalApiKey?: string;
  executionMode: ExecutionMode;
  clobApiUrl: string;
  gammaApiUrl: string;
  chainId: number;
  ownerPrivateKey?: string;
  depositWallet?: string;
  tickIntervalMs: number;
  runtimeStatePath: string;
  runtimeMaxRecords: number;
  rtdsWsUrl: string;
  clobWsUrl: string;
  dualLimitPrice: number;
  orderSharesPerSide: number;
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
  marketConfig: BtcMarketConfig;
};

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT || 8788),
    dashboardInternalApiKey: process.env.DASHBOARD_INTERNAL_API_KEY,
    executionMode: parseExecutionMode(process.env.EXECUTION_MODE),
    clobApiUrl: process.env.POLYMARKET_CLOB_API_URL || 'https://clob.polymarket.com',
    gammaApiUrl: process.env.POLYMARKET_GAMMA_API_URL || 'https://gamma-api.polymarket.com',
    chainId: Number(process.env.POLYMARKET_CHAIN_ID || 137),
    ownerPrivateKey: process.env.OWNER_PRIVATE_KEY,
    depositWallet: process.env.POLYMARKET_DEPOSIT_WALLET,
    tickIntervalMs: parsePositiveInteger(process.env.BOT_TICK_MS, 2_000),
    runtimeStatePath: process.env.RUNTIME_STATE_PATH || path.resolve(process.cwd(), 'data/runtime-state.json'),
    runtimeMaxRecords: parsePositiveInteger(process.env.RUNTIME_MAX_RECORDS, 1_000),
    rtdsWsUrl: rtdsWsUrl(process.env.POLYMARKET_RTDS_WS_URL),
    clobWsUrl: clobWsUrl(process.env.POLYMARKET_CLOB_WS_URL),
    dualLimitPrice: numberEnv('DUAL_LIMIT_PRICE', 0.45),
    orderSharesPerSide: numberEnv('ORDER_SHARES_PER_SIDE', 10),
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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rtdsWsUrl(value: string | undefined): string {
  const url = value?.trim() || 'wss://ws-live-data.polymarket.com';
  if (!url.startsWith('wss://')) throw new Error('POLYMARKET_RTDS_WS_URL must be a wss:// URL.');
  return url;
}

function clobWsUrl(value: string | undefined): string {
  const url = value?.trim() || 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
  if (!url.startsWith('wss://')) throw new Error('POLYMARKET_CLOB_WS_URL must be a wss:// URL.');
  return url;
}
