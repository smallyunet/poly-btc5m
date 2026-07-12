import type { ExecutionMode, FillRecord, MarketProfileId, OrderRecord, SettlementRecord, TradeIntent } from '../../../../packages/shared/src';

export type OpenOrderLike = {
  id: string;
  tokenId: string;
};

export type SingleFillHedgeCandidate = {
  profileId: MarketProfileId;
  roundId: string;
  eventSlug: string;
  marketTitle?: string;
  imageUrl?: string;
  startAt: string;
  endAt: string;
  secondsToEnd: number;
  yesTokenId: string;
  noTokenId: string;
};

export type SingleFillProfitExitCandidate = SingleFillHedgeCandidate;

export type PendingSingleFillRiskRecord = {
  profileId: MarketProfileId;
  sourceProfileId: MarketProfileId;
  roundId: string;
  expiresAt: string;
  yesShares: number;
  noShares: number;
};

export type SingleFillHedgeOutcome = {
  profileId: MarketProfileId;
  roundId: string;
  status: 'posted' | 'blocked' | 'failed' | 'monitor';
  reason: string;
  recordedAt: string;
};

export type SingleFillCooldownPolicy = {
  baseMs: number;
  priceCapMs: number;
  executionMs: number;
  repeatWindowMs: number;
  secondMs: number;
  thirdMs: number;
};

export type StoreOptions = {
  persistencePath?: string | false;
  maxRecords?: number;
};

export type PersistedRuntimeState = {
  version: 2;
  savedAt: string;
  intents: TradeIntent[];
  orders: OrderRecord[];
  fills: FillRecord[];
  settlements: SettlementRecord[];
  telegramNotifications?: TelegramNotificationState;
  roundStrikes?: Record<string, number>;
  singleFillCooldowns: Record<string, SingleFillCooldownRecord>;
  singleFillCooldownRoundIds?: string[];
  pendingSingleFillReviewRoundIds?: string[];
  singleFillHedgeOutcomes?: Record<string, SingleFillHedgeOutcome>;
  singleFillCooldownEvents?: SingleFillCooldownEvent[];
  experimentStop?: ExperimentStopRecord | null;
  tailCooldowns?: Record<string, TailCooldownRecord>;
  tailCooldownEvents?: TailCooldownEvent[];
};

export type TailCooldownRecord = {
  profileId: MarketProfileId;
  roundId: string;
  triggeredAt: string;
  expiresAt: string;
  recentLossCount: number;
  pnl: number;
};

export type TailCooldownEvent = {
  profileId: MarketProfileId;
  roundId: string;
  triggeredAt: string;
};

export type SingleFillCooldownRecord = {
  profileId: MarketProfileId;
  roundId: string;
  sourceProfileId?: MarketProfileId;
  sourceRoundId?: string;
  triggeredAt: string;
  finalizedAt?: string;
  expiresAt: string;
  yesShares: number;
  noShares: number;
  category?: string;
  hedgeReason?: string;
  recentSingleFillCount?: number;
};

export type SingleFillCooldownEvent = {
  profileId: MarketProfileId;
  sourceProfileId?: MarketProfileId;
  roundId: string;
  sourceRoundId?: string;
  triggeredAt: string;
  category: string;
};

export type ExperimentStopRecord = {
  profileId: MarketProfileId;
  roundId: string;
  stoppedAt: string;
  reason: string;
  yesShares: number;
  noShares: number;
};

export type TelegramNotificationState = {
  notifiedRoundSummaryKeys: string[];
  lastIdleSummaryAt?: string;
};

export type StoreRuntimeMode = ExecutionMode;
