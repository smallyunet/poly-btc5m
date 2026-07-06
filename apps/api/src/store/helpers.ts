import fs from 'node:fs';
import path from 'node:path';

import type { FillRecord, MarketProfileId, OrderRecord, StrategyId, StrategyProfile, TradeIntent } from '../../../../packages/shared/src';
import { BENIGN_HEDGE_REASONS, CLASSIC_ENTRY_STRATEGY, EXPERIMENT_STRATEGY, FINAL_SINGLE_FILL_GRACE_MS, PRICE_CAP_HEDGE_REASONS } from './constants';
import type { ExperimentStopRecord, SingleFillCooldownEvent, SingleFillCooldownPolicy, SingleFillCooldownRecord, SingleFillHedgeOutcome, TelegramNotificationState } from './types';

export function isTradeIntentLike(value: unknown): value is TradeIntent {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<TradeIntent>;
  return typeof item.id === 'string' && typeof item.tokenId === 'string' && (item.side === 'BUY' || item.side === 'SELL');
}

export function netShares(fills: FillRecord[], label: 'YES' | 'NO'): number {
  const labelFills = fills.filter((fill) => fill.label === label);
  const buyShares = sum(labelFills.filter((fill) => fill.side === 'BUY').map((fill) => fill.size));
  const sellShares = sum(labelFills.filter((fill) => fill.side === 'SELL').map((fill) => fill.size));
  return Math.max(0, buyShares - sellShares);
}

export function isOrderRecordLike(value: unknown): value is OrderRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<OrderRecord>;
  return typeof item.id === 'string' && typeof item.intentId === 'string' && typeof item.tokenId === 'string' && (item.side === 'BUY' || item.side === 'SELL');
}

export function isFillRecordLike(value: unknown): value is FillRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<FillRecord>;
  if (typeof item.id !== 'string' || typeof item.roundId !== 'string' || typeof item.tokenId !== 'string') return false;
  const raw = item.raw as { trader_side?: unknown; maker_orders?: unknown } | undefined;
  return !(String(raw?.trader_side || '').toUpperCase() === 'MAKER' && Array.isArray(raw?.maker_orders) && !item.clobOrderId);
}

export function isSingleFillCooldownLike(value: unknown): value is SingleFillCooldownRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SingleFillCooldownRecord>;
  return typeof item.roundId === 'string'
    && typeof item.triggeredAt === 'string'
    && typeof item.expiresAt === 'string'
    && typeof item.yesShares === 'number'
    && typeof item.noShares === 'number';
}

export function isSingleFillHedgeOutcomeLike(value: unknown): value is SingleFillHedgeOutcome {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SingleFillHedgeOutcome>;
  return typeof item.roundId === 'string'
    && typeof item.recordedAt === 'string'
    && typeof item.reason === 'string'
    && (item.status === 'posted' || item.status === 'blocked' || item.status === 'failed' || item.status === 'monitor');
}

export function isSingleFillCooldownEventLike(value: unknown): value is SingleFillCooldownEvent {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SingleFillCooldownEvent>;
  return typeof item.roundId === 'string'
    && typeof item.triggeredAt === 'string'
    && typeof item.category === 'string';
}

export function isExperimentStopLike(value: unknown): value is ExperimentStopRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ExperimentStopRecord>;
  return isMarketProfileId(item.profileId)
    && typeof item.roundId === 'string'
    && typeof item.stoppedAt === 'string'
    && typeof item.reason === 'string'
    && typeof item.yesShares === 'number'
    && typeof item.noShares === 'number';
}

export function isTelegramNotificationStateLike(value: unknown): value is TelegramNotificationState {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<TelegramNotificationState>;
  return Array.isArray(item.notifiedRoundSummaryKeys)
    && item.notifiedRoundSummaryKeys.every((key) => typeof key === 'string')
    && (item.lastIdleSummaryAt == null || typeof item.lastIdleSummaryAt === 'string');
}

export function isMarketProfileId(value: unknown): value is MarketProfileId {
  return typeof value === 'string' && /^(btc|eth|sol)-(5m|15m|1h)$/.test(value);
}

export function profileAsset(profileId: MarketProfileId): 'btc' | 'eth' | 'sol' {
  return profileId.split('-')[0] as 'btc' | 'eth' | 'sol';
}

export function profileIntervals(_asset: 'btc' | 'eth' | 'sol'): Array<'5m' | '15m' | '1h'> {
  return ['5m', '15m', '1h'];
}

export function normalizeCooldownPolicy(value: number | SingleFillCooldownPolicy): SingleFillCooldownPolicy {
  if (typeof value === 'number') {
    return {
      baseMs: value,
      priceCapMs: value,
      executionMs: value,
      repeatWindowMs: 0,
      secondMs: value,
      thirdMs: value,
    };
  }
  return value;
}

export function cooldownCategory(outcome: SingleFillHedgeOutcome | undefined): string {
  if (!outcome) return 'unhedged';
  if (outcome.status === 'posted' || outcome.status === 'monitor') return 'hedge-unfilled';
  if (PRICE_CAP_HEDGE_REASONS.has(outcome.reason)) return 'price-cap';
  if (BENIGN_HEDGE_REASONS.has(outcome.reason)) return 'unhedged';
  return 'execution';
}

export function isSameCooldownEvent(event: SingleFillCooldownEvent, record: Pick<SingleFillCooldownRecord, 'profileId' | 'sourceProfileId' | 'roundId' | 'sourceRoundId' | 'triggeredAt'>): boolean {
  return event.profileId === record.profileId
    && (event.sourceProfileId || event.profileId) === (record.sourceProfileId || record.profileId)
    && (event.sourceRoundId || event.roundId) === (record.sourceRoundId || record.roundId)
    && event.triggeredAt === record.triggeredAt;
}

export function entrySignalScope(signalKey: string): string {
  const separator = signalKey.indexOf(':');
  return separator > 0 ? signalKey.slice(0, separator) : 'default';
}

export function maxCooldown(records: SingleFillCooldownRecord[]): SingleFillCooldownRecord {
  if (!records.length) throw new Error('maxCooldown requires at least one cooldown record');
  return records.reduce((max, record) => (toTime(record.expiresAt) > toTime(max.expiresAt) ? record : max));
}

export function matchingOrderFills(order: OrderRecord, fills: FillRecord[]): FillRecord[] {
  const exact = order.clobOrderId
    ? fills.filter((fill) => fill.clobOrderId === order.clobOrderId && fillStrategy(fill) === orderStrategy(order) && (!order.profileId || fill.profileId === order.profileId))
    : [];
  if (exact.length) return exact;
  return fills.filter((fill) => (
    fill.roundId === order.roundId
    && (!order.profileId || fill.profileId === order.profileId)
    && fill.tokenId === order.tokenId
    && fill.side === order.side
    && fillStrategy(fill) === orderStrategy(order)
  ));
}

export function orderStrategy(order: Pick<OrderRecord, 'strategy'>): StrategyId {
  return order.strategy || CLASSIC_ENTRY_STRATEGY;
}

export function fillStrategy(fill: Pick<FillRecord, 'strategy'>): StrategyId {
  return fill.strategy || CLASSIC_ENTRY_STRATEGY;
}

export function strategyProfileForStrategy(strategy: StrategyId): StrategyProfile {
  return strategy === EXPERIMENT_STRATEGY ? 'experiment_next_round' : 'classic';
}

export function runtimeVersion(): string {
  const configured = optionalEnv('APP_VERSION');
  if (configured) return configured;
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function isRoundEnded(roundId: string, nowMs: number, graceMs: number, durationSeconds = 300): boolean {
  const startMs = roundStartMs(roundId);
  if (startMs == null) return false;
  return nowMs >= startMs + durationSeconds * 1000 + graceMs;
}

export function finalSingleFillReviewMs(roundId: string, profileId?: MarketProfileId): number | null {
  const startMs = roundStartMs(roundId);
  return startMs == null ? null : startMs + profileDurationMs(profileId) + FINAL_SINGLE_FILL_GRACE_MS;
}

export function roundStartMs(roundId: string): number | null {
  const match = roundId.match(/[a-z]+-updown-(?:5m|15m|1h)-(\d+)$/);
  const parsed = Number(match?.[1]);
  if (Number.isFinite(parsed) && parsed > 0) return parsed * 1000;
  return humanHourlyRoundStartMs(roundId);
}

export function humanHourlyRoundStartMs(roundId: string): number | null {
  const match = roundId.match(/^(?:bitcoin|ethereum|solana)-up-or-down-([a-z]+)-(\d{1,2})-(\d{4})-(\d{1,2})(am|pm)-et$/);
  if (!match) return null;
  const [, monthName, dayRaw, yearRaw, hourRaw, period] = match;
  const month = MONTH_INDEX[monthName];
  const day = Number(dayRaw);
  const year = Number(yearRaw);
  const hour12 = Number(hourRaw);
  if (month == null || !Number.isInteger(day) || !Number.isInteger(year) || !Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  const hour = period === 'pm' ? (hour12 % 12) + 12 : hour12 % 12;
  return zonedTimeToUtcMs(year, month, day, hour, 'America/New_York');
}

export function zonedTimeToUtcMs(year: number, month: number, day: number, hour: number, timeZone: string): number {
  let utcMs = Date.UTC(year, month, day, hour, 0, 0);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    utcMs = Date.UTC(year, month, day, hour, 0, 0) - timeZoneOffsetMs(timeZone, new Date(utcMs));
  }
  return utcMs;
}

export function timeZoneOffsetMs(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second')) - date.getTime();
}

export function profileDurationSeconds(profileId?: MarketProfileId): number {
  if (profileId?.endsWith('-15m')) return 900;
  if (profileId?.endsWith('-1h')) return 3600;
  return 300;
}

export function profileDurationMs(profileId?: MarketProfileId): number {
  return profileDurationSeconds(profileId) * 1000;
}

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

export function profileRoundKey(profileId: MarketProfileId | undefined, roundId: string): string {
  return profileId ? `${profileId}:${roundId}` : roundId;
}

export function parseProfileRoundKey(value: string): { profileId?: MarketProfileId; roundId: string } {
  const [maybeProfileId, ...rest] = value.split(':');
  if (rest.length && /^(btc|eth|sol)-(5m|15m|1h)$/.test(maybeProfileId)) {
    return { profileId: maybeProfileId as MarketProfileId, roundId: rest.join(':') };
  }
  return { roundId: value };
}

export function toTime(value: string): number {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

