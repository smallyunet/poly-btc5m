import fs from 'node:fs';
import path from 'node:path';

import type { OrderBookLevel, OrderBookQuote, OrderRecord, StateSnapshot, StrategyCheck, StrategyCondition, StrategyId, TradeIntent } from '../../../packages/shared/src';
import type { PolymarketAdapter } from '../../../packages/polymarket/src';
import type { AppConfig } from './config';
import type { InMemoryStore } from './store';

const TAIL_ENTRY_STRATEGY: StrategyId = 'UPDOWN_TAIL_ENTRY';
const MIN_MARKETABLE_BUY_NOTIONAL_USD = 1;
const FAILED_ORDER_COOLDOWN_MS = 5 * 60_000;
const EPSILON = 0.000001;

export type TailEntryEvaluation =
  | { ok: true; intent: TradeIntent; check: StrategyCheck; checkpointSeconds: number; vwap: number; bestAsk: number; midpointGap: number }
  | { ok: false; rejected?: TradeIntent; check: StrategyCheck };

type TailSummaryRow = {
  checkpointSeconds?: number;
  size?: number;
  rows?: number;
  fillable?: number;
  fillRate?: number | null;
  avgPnlPerShare?: number | null;
  avgVwap?: number | null;
};

type TailSummary = {
  ok?: boolean;
  generatedAt?: string;
  completed?: {
    byCheckpointSize?: TailSummaryRow[];
  };
};

type QuoteSnapshot = {
  quote: OrderBookQuote;
  ageMs: number;
};

export function evaluateTailEntry(snapshot: StateSnapshot, appConfig: AppConfig, store: InMemoryStore): TailEntryEvaluation {
  const blockers: string[] = [];
  const conditions: StrategyCondition[] = [];
  const enabled = appConfig.pm5mTailEntryEnabled && snapshot.profileId === 'btc-5m' && snapshot.interval === '5m' && snapshot.asset === 'btc';
  const checkpoint = matchingCheckpoint(snapshot.round.secondsToEnd, appConfig);
  const summary = readTailSummary(appConfig);
  const row = checkpoint == null || !summary.value ? null : summaryRow(summary.value, checkpoint, appConfig.pm5mTailEntrySize);
  const yes = quoteSnapshot(snapshot, snapshot.round.yesTokenId, appConfig);
  const no = quoteSnapshot(snapshot, snapshot.round.noTokenId, appConfig);
  const selectedLabel = selectStrongSide(yes, no);
  const selected = selectedLabel === 'YES' ? yes : selectedLabel === 'NO' ? no : null;
  const plan = selected ? buyVwap(selected.quote.asks || [], appConfig.pm5mTailEntrySize) : null;
  const overroundAsk = yes?.quote.bestAsk != null && no?.quote.bestAsk != null ? roundMoney(yes.quote.bestAsk + no.quote.bestAsk) : null;
  const midpointGap = yes?.quote.midpoint != null && no?.quote.midpoint != null ? roundMoney(Math.abs(yes.quote.midpoint - no.quote.midpoint)) : null;
  const existingOrders = store.roundOrders(snapshot.profileId, snapshot.round.id, TAIL_ENTRY_STRATEGY)
    .filter((order) => order.status !== 'failed');

  if (!enabled) blockers.push('TAIL_ENTRY_DISABLED');
  if (snapshot.round.secondsToStart > 0) blockers.push('ROUND_NOT_STARTED');
  if (snapshot.round.secondsToEnd <= snapshot.round.secondsToStart) blockers.push('INVALID_ROUND_TIMING');
  if (checkpoint == null) blockers.push('NOT_IN_TAIL_CHECKPOINT_WINDOW');
  if (!summary.ok) blockers.push(summary.reason);
  if (checkpoint != null && summary.ok && !row) blockers.push('TAIL_SUMMARY_ROW_MISSING');
  if (row && (row.rows ?? 0) < appConfig.pm5mTailEntryMinRounds) blockers.push('TAIL_SUMMARY_SAMPLE_TOO_SMALL');
  if (row && (row.avgPnlPerShare ?? Number.NEGATIVE_INFINITY) < appConfig.pm5mTailEntryMinEvPerShare) blockers.push('TAIL_SUMMARY_EV_TOO_LOW');
  if (row && (row.fillRate ?? 0) < appConfig.pm5mTailEntryMinFillRate) blockers.push('TAIL_SUMMARY_FILL_RATE_TOO_LOW');
  if (!yes || !no) blockers.push('ORDERBOOK_MISSING');
  if (selectedLabel == null || !selected) blockers.push('TAIL_SIDE_NOT_SELECTABLE');
  if (plan && !plan.fillable) blockers.push('TAIL_DEPTH_INSUFFICIENT');
  if (plan?.vwap != null && plan.vwap > appConfig.pm5mTailEntryMaxVwap + EPSILON) blockers.push('TAIL_VWAP_TOO_HIGH');
  if (selected?.quote.spread != null && selected.quote.spread > appConfig.pm5mTailEntryMaxSpread + EPSILON) blockers.push('TAIL_SPREAD_TOO_WIDE');
  if (overroundAsk != null && overroundAsk > appConfig.pm5mTailEntryMaxOverround + EPSILON) blockers.push('TAIL_OVERROUND_TOO_HIGH');
  if ((midpointGap ?? 0) + EPSILON < appConfig.pm5mTailEntryMinMidpointGap) blockers.push('TAIL_MIDPOINT_GAP_TOO_SMALL');
  if (plan?.vwap != null && selected?.quote.bestAsk != null && plan.vwap - selected.quote.bestAsk > appConfig.pm5mTailEntryMaxSlippage + EPSILON) blockers.push('TAIL_SLIPPAGE_TOO_HIGH');
  if (existingOrders.length >= appConfig.pm5mTailEntryMaxOrdersPerRound) blockers.push('TAIL_ROUND_ORDER_LIMIT_REACHED');

  conditions.push(
    condition('Tail entry enabled', enabled, enabled ? 'btc-5m live path enabled' : 'disabled or non-btc-5m profile'),
    condition('Tail checkpoint', checkpoint != null, checkpoint == null ? `${snapshot.round.secondsToEnd.toFixed(1)}s to end` : `${checkpoint}s checkpoint / ${snapshot.round.secondsToEnd.toFixed(1)}s to end`),
    condition('Summary freshness', summary.ok, summary.label),
    condition('Summary sample size', Boolean(row && (row.rows ?? 0) >= appConfig.pm5mTailEntryMinRounds), row ? `${row.rows ?? 0} / min ${appConfig.pm5mTailEntryMinRounds}` : 'missing'),
    condition('Summary EV/share', Boolean(row && (row.avgPnlPerShare ?? Number.NEGATIVE_INFINITY) >= appConfig.pm5mTailEntryMinEvPerShare), row?.avgPnlPerShare == null ? 'missing' : `${row.avgPnlPerShare.toFixed(4)} / min ${appConfig.pm5mTailEntryMinEvPerShare.toFixed(4)}`),
    condition('Summary fill rate', Boolean(row && (row.fillRate ?? 0) >= appConfig.pm5mTailEntryMinFillRate), row?.fillRate == null ? 'missing' : `${formatPct(row.fillRate)} / min ${formatPct(appConfig.pm5mTailEntryMinFillRate)}`),
    condition('YES quote fresh', Boolean(yes), yes ? `${yes.ageMs}ms old` : 'missing/stale'),
    condition('NO quote fresh', Boolean(no), no ? `${no.ageMs}ms old` : 'missing/stale'),
    condition('Selected side', selectedLabel != null, selectedLabel ?? 'none'),
    condition('Midpoint gap', (midpointGap ?? 0) + EPSILON >= appConfig.pm5mTailEntryMinMidpointGap, midpointGap == null ? 'missing' : `${midpointGap.toFixed(3)} / min ${appConfig.pm5mTailEntryMinMidpointGap.toFixed(3)}`),
    condition('VWAP depth', Boolean(plan?.fillable), plan?.vwap == null ? `${plan?.filledShares ?? 0}/${appConfig.pm5mTailEntrySize}` : `${plan.filledShares}/${appConfig.pm5mTailEntrySize} @ ${plan.vwap.toFixed(3)}`),
    condition('VWAP cap', plan?.vwap != null && plan.vwap <= appConfig.pm5mTailEntryMaxVwap + EPSILON, plan?.vwap == null ? 'missing' : `${plan.vwap.toFixed(3)} / max ${appConfig.pm5mTailEntryMaxVwap.toFixed(3)}`),
    condition('Spread cap', selected?.quote.spread != null && selected.quote.spread <= appConfig.pm5mTailEntryMaxSpread + EPSILON, selected?.quote.spread == null ? 'missing' : `${selected.quote.spread.toFixed(3)} / max ${appConfig.pm5mTailEntryMaxSpread.toFixed(3)}`),
    condition('Overround cap', overroundAsk != null && overroundAsk <= appConfig.pm5mTailEntryMaxOverround + EPSILON, overroundAsk == null ? 'missing' : `${overroundAsk.toFixed(3)} / max ${appConfig.pm5mTailEntryMaxOverround.toFixed(3)}`),
    condition('Round order limit', existingOrders.length < appConfig.pm5mTailEntryMaxOrdersPerRound, `${existingOrders.length} / max ${appConfig.pm5mTailEntryMaxOrdersPerRound}`),
  );

  const check: StrategyCheck = {
    profileId: snapshot.profileId,
    asset: snapshot.asset,
    interval: snapshot.interval,
    strategy: TAIL_ENTRY_STRATEGY,
    title: '5m Tail Entry',
    status: blockers.length ? 'blocked' : 'eligible',
    summary: 'Buy the stronger BTC 5m side near expiry when the tail-entry simulator and current orderbook both pass configured gates.',
    reason: blockers.length ? blockers.join(', ') : `Tail entry eligible: buy ${selectedLabel} ${appConfig.pm5mTailEntrySize.toFixed(2)} @ ${plan!.vwap!.toFixed(3)} VWAP.`,
    blockers,
    amountUsd: plan?.cost,
    limitPrice: plan?.vwap == null ? undefined : cappedPrice(plan.vwap + appConfig.pm5mTailEntryPriceOffset),
    conditions,
  };

  if (blockers.length || !selected || !selectedLabel || !plan?.fillable || plan.vwap == null || checkpoint == null) {
    return { ok: false, check };
  }

  const intent: TradeIntent = {
    id: `tail-entry-intent-${Date.now()}-${selectedLabel}-${Math.random().toString(16).slice(2, 8)}`,
    profileId: snapshot.profileId,
    asset: snapshot.asset,
    interval: snapshot.interval,
    strategy: TAIL_ENTRY_STRATEGY,
    roundId: snapshot.round.id,
    tokenId: selected.quote.tokenId,
    label: selectedLabel,
    side: 'BUY',
    orderType: 'LIMIT',
    limitPrice: cappedPrice(plan.vwap + appConfig.pm5mTailEntryPriceOffset),
    shares: appConfig.pm5mTailEntrySize,
    reason: `BTC 5m tail entry at ${checkpoint}s: selected ${selectedLabel}, simulator EV ${(row?.avgPnlPerShare ?? 0).toFixed(4)}/share, live VWAP ${plan.vwap.toFixed(3)}.`,
    status: 'generated',
    ttlSeconds: Math.max(1, Math.ceil(snapshot.round.secondsToEnd)),
    createdAt: snapshot.capturedAt,
  };
  return { ok: true, intent, check, checkpointSeconds: checkpoint, vwap: plan.vwap, bestAsk: selected.quote.bestAsk ?? plan.vwap, midpointGap: midpointGap ?? 0 };
}

export async function executeTailEntry(params: {
  appConfig: AppConfig;
  adapter: PolymarketAdapter;
  store: InMemoryStore;
  snapshot: StateSnapshot;
  evaluation: TailEntryEvaluation;
}): Promise<string[]> {
  if (!params.evaluation.ok) return [];
  const intent = params.evaluation.intent;
  params.store.recordIntents([intent]);
  const runtime = params.store.getRuntime();
  const executionKey = executionKeyFor(intent);
  const gate = await tailExecutionGate(params, executionKey, intent);
  if (!gate.ok) {
    params.store.updateIntent(intent.id, { status: gate.recordFailure ? 'failed' : 'rejected', rejectionReason: gate.reason });
    if (gate.recordFailure) params.store.recordOrder(failedOrder(params.snapshot, intent, executionKey, gate.reason));
    params.store.recordRuntimeLog({ level: gate.recordFailure ? 'error' : 'warn', source: 'execution', message: `Tail entry blocked for ${intent.label}: ${gate.reason}.`, details: { intentId: intent.id, roundId: intent.roundId, tokenId: intent.tokenId } });
    return [`Tail entry blocked for ${intent.label}: ${gate.reason}.`];
  }

  if (runtime.executionMode !== 'live') {
    params.store.recordOrder(localOrder(params.snapshot, intent, executionKey, 'local'));
    params.store.updateIntent(intent.id, { status: 'executed' });
    return [`Monitor mode recorded tail entry for ${intent.label} @ ${intent.limitPrice.toFixed(3)}.`];
  }

  try {
    const posted = await params.adapter.executeLimitIntent(intent, { execute: true, orderType: 'FAK' });
    params.store.recordOrder({
      ...localOrder(params.snapshot, intent, executionKey, posted.ok ? 'posted' : 'failed'),
      clobOrderId: posted.orderId,
      price: posted.price,
      size: posted.size,
      error: posted.error,
      rawResponse: posted.raw,
    });
    params.store.updateIntent(intent.id, { status: posted.ok ? 'executed' : 'failed', rejectionReason: posted.ok ? undefined : posted.error || 'CLOB_POST_FAILED' });
    params.store.recordRuntimeLog({
      level: posted.ok ? 'warn' : 'error',
      source: 'execution',
      message: posted.ok ? `Tail entry posted for ${intent.label} at ${posted.price.toFixed(3)}.` : `Tail entry failed for ${intent.label}: ${posted.error || 'CLOB_POST_FAILED'}.`,
      details: { intentId: intent.id, roundId: intent.roundId, tokenId: intent.tokenId, price: posted.price, size: posted.size },
    });
    return posted.ok ? [] : [`Tail entry failed for ${intent.label}: ${posted.error || 'CLOB_POST_FAILED'}.`];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.store.recordOrder(failedOrder(params.snapshot, intent, executionKey, message));
    params.store.updateIntent(intent.id, { status: 'failed', rejectionReason: message });
    params.store.recordRuntimeLog({ level: 'error', source: 'execution', message: `Tail entry failed for ${intent.label}: ${message}.` });
    return [`Tail entry failed for ${intent.label}: ${message}.`];
  }
}

async function tailExecutionGate(params: { appConfig: AppConfig; adapter: PolymarketAdapter; store: InMemoryStore; snapshot: StateSnapshot }, executionKey: string, intent: TradeIntent): Promise<{ ok: true } | { ok: false; reason: string; recordFailure: boolean }> {
  const reject = (reason: string, recordFailure = false) => ({ ok: false as const, reason, recordFailure });
  if (params.snapshot.profileId !== 'btc-5m') return reject('TAIL_ENTRY_PROFILE_NOT_ALLOWED');
  if (params.snapshot.round.secondsToStart > 0) return reject('ROUND_NOT_STARTED');
  if (params.snapshot.round.secondsToEnd <= 0) return reject('ROUND_EXPIRED');
  if (!params.appConfig.ownerPrivateKey?.trim() && params.store.getRuntime().executionMode === 'live') return reject('OWNER_PRIVATE_KEY_MISSING', true);
  if (!params.appConfig.depositWallet?.trim() && params.store.getRuntime().executionMode === 'live') return reject('POLYMARKET_DEPOSIT_WALLET_MISSING', true);
  if (params.store.hasNonFailedOrder(executionKey)) return reject('LOCAL_TAIL_ORDER_EXISTS');
  if (params.store.hasRecentFailedOrder(executionKey, FAILED_ORDER_COOLDOWN_MS)) return reject('LOCAL_RECENT_FAILED_ORDER');
  const notional = roundDownShares(intent.shares) * intent.limitPrice;
  if (notional < MIN_MARKETABLE_BUY_NOTIONAL_USD) return reject('ORDER_NOTIONAL_BELOW_MIN');

  if (params.store.getRuntime().executionMode !== 'live') return { ok: true };

  try {
    const [{ balance, allowance }, openOrders] = await Promise.all([
      params.adapter.getCollateralBalanceAllowance(),
      params.adapter.getOpenOrders({ tokenId: intent.tokenId }),
    ]);
    if (openOrders.some((order) => order.tokenId === intent.tokenId)) return reject('PM_OPEN_ORDER_EXISTS');
    const collateralLimit = allowance == null ? balance : Math.min(balance, allowance);
    if (collateralLimit + 0.000001 < notional) return reject('INSUFFICIENT_AVAILABLE_COLLATERAL');
    return { ok: true };
  } catch (error) {
    return reject(`TAIL_ENTRY_GATE_FAILED: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

function matchingCheckpoint(secondsToEnd: number, appConfig: AppConfig): number | null {
  const windowSeconds = Math.max(2, Math.min(5, appConfig.pm5mTailEntryQuoteMaxAgeMs / 1000 + 1));
  return appConfig.pm5mTailEntryCheckpoints.find((checkpoint) => secondsToEnd <= checkpoint && secondsToEnd > checkpoint - windowSeconds) ?? null;
}

function readTailSummary(appConfig: AppConfig): { ok: true; value: TailSummary; label: string } | { ok: false; reason: string; label: string; value?: undefined } {
  const summaryPath = path.resolve(process.cwd(), appConfig.pm5mTailEntrySummaryPath);
  try {
    if (!fs.existsSync(summaryPath)) return { ok: false, reason: 'TAIL_SUMMARY_MISSING', label: `missing at ${summaryPath}` };
    const value = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as TailSummary;
    if (value.ok === false) return { ok: false, reason: 'TAIL_SUMMARY_UNAVAILABLE', label: 'summary reports unavailable' };
    const ageMs = value.generatedAt ? Date.now() - new Date(value.generatedAt).getTime() : NaN;
    if (!Number.isFinite(ageMs) || ageMs > appConfig.pm5mTailEntryMaxSummaryAgeMs) {
      return { ok: false, reason: 'TAIL_SUMMARY_STALE', label: Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s old` : 'unknown age' };
    }
    return { ok: true, value, label: `${Math.round(ageMs / 1000)}s old` };
  } catch (error) {
    return { ok: false, reason: 'TAIL_SUMMARY_READ_FAILED', label: error instanceof Error ? error.message : String(error) };
  }
}

function summaryRow(summary: TailSummary, checkpointSeconds: number, size: number): TailSummaryRow | null {
  return summary.completed?.byCheckpointSize?.find((row) => row.checkpointSeconds === checkpointSeconds && row.size === size) ?? null;
}

function quoteSnapshot(snapshot: StateSnapshot, tokenId: string, appConfig: AppConfig): QuoteSnapshot | null {
  const quote = snapshot.orderbooks.find((item) => item.tokenId === tokenId);
  if (!quote || quote.source === 'mock') return null;
  const ageMs = Date.now() - new Date(quote.updatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > appConfig.pm5mTailEntryQuoteMaxAgeMs) return null;
  if (quote.bestAsk == null || quote.bestBid == null || quote.midpoint == null) return null;
  return { quote, ageMs: Math.round(ageMs) };
}

function selectStrongSide(yes: QuoteSnapshot | null, no: QuoteSnapshot | null): 'YES' | 'NO' | null {
  if (!yes || !no) return null;
  if (yes.quote.midpoint! > no.quote.midpoint!) return 'YES';
  if (no.quote.midpoint! > yes.quote.midpoint!) return 'NO';
  return yes.quote.bestAsk! >= no.quote.bestAsk! ? 'YES' : 'NO';
}

function buyVwap(asks: OrderBookLevel[], targetSize: number): { fillable: boolean; filledShares: number; cost: number; vwap: number | null } {
  let remaining = targetSize;
  let cost = 0;
  for (const level of asks) {
    if (remaining <= 0) break;
    const shares = Math.min(remaining, level.size);
    cost += shares * level.price;
    remaining -= shares;
  }
  const filledShares = roundMoney(targetSize - remaining);
  return {
    fillable: remaining <= 0.000001,
    filledShares,
    cost: roundMoney(cost),
    vwap: filledShares > 0 ? roundMoney(cost / filledShares) : null,
  };
}

function condition(label: string, passed: boolean, actual: string): StrategyCondition {
  return { label, passed, actual };
}

function executionKeyFor(intent: TradeIntent): string {
  return [intent.profileId, intent.roundId, intent.strategy, intent.tokenId, intent.side].filter(Boolean).join(':');
}

function localOrder(snapshot: StateSnapshot, intent: TradeIntent, executionKey: string, status: OrderRecord['status']): OrderRecord {
  return {
    id: `tail-order-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    profileId: intent.profileId,
    asset: intent.asset,
    interval: intent.interval,
    intentId: intent.id,
    strategy: intent.strategy,
    strategyProfile: 'classic',
    executionKey,
    roundId: intent.roundId,
    eventSlug: snapshot.round.eventSlug,
    marketTitle: snapshot.round.title,
    imageUrl: snapshot.round.imageUrl,
    tokenId: intent.tokenId,
    label: intent.label,
    side: intent.side,
    price: intent.limitPrice,
    size: roundDownShares(intent.shares),
    status,
    createdAt: new Date().toISOString(),
    rawResponse: status === 'local' ? { monitor: true } : undefined,
  };
}

function failedOrder(snapshot: StateSnapshot, intent: TradeIntent, executionKey: string, error: string): OrderRecord {
  return {
    ...localOrder(snapshot, intent, executionKey, 'failed'),
    error,
    rawResponse: { error },
  };
}

function cappedPrice(price: number): number {
  return Math.max(0.001, Math.min(0.999, roundMoney(price)));
}

function roundDownShares(shares: number): number {
  return Math.floor(shares * 100) / 100;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
