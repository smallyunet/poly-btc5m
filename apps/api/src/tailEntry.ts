import fs from 'node:fs';
import path from 'node:path';

import type { OrderBookLevel, OrderBookQuote, OrderRecord, StateSnapshot, StrategyCheck, StrategyCondition, StrategyId, TradeIntent } from '../../../packages/shared/src';
import type { PolymarketAdapter } from '../../../packages/polymarket/src';
import type { AppConfig } from './config';
import type { InMemoryStore } from './store';

const TAIL_ENTRY_STRATEGY: StrategyId = 'UPDOWN_TAIL_ENTRY';
const MIN_MARKETABLE_BUY_NOTIONAL_USD = 1;
const FAILED_ORDER_COOLDOWN_MS = 5 * 60_000;
const FAK_NO_MATCH_RETRY_LIMIT = 2;
const FAK_NO_MATCH_RETRY_DELAY_MS = 750;
const EPSILON = 0.000001;
const CLOB_MIN_LIMIT_PRICE = 0.01;
const CLOB_MAX_LIMIT_PRICE = 0.99;

export type TailEntryEvaluation =
  | { ok: true; intent: TradeIntent; check: StrategyCheck; checkpointSeconds: number; vwap: number; bestAsk: number; midpointGap: number }
  | { ok: false; rejected?: TradeIntent; check: StrategyCheck };

type TailSummaryRow = {
  checkpointSeconds?: number;
  size?: number;
  askBand?: string;
  rows?: number;
  fillable?: number;
  fillRate?: number | null;
  winRate?: number | null;
  avgPnlPerShare?: number | null;
  totalPnl?: number | null;
  avgVwap?: number | null;
};

type TailSummary = {
  ok?: boolean;
  generatedAt?: string;
  completed?: {
    byCheckpointSize?: TailSummaryRow[];
    byAskBand?: TailSummaryRow[];
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
  const summary = readTailSummary(appConfig);
  const selectedSummaryRow = summary.value ? selectSummaryRow(summary.value, appConfig) : null;
  const checkpoint = selectedSummaryRow?.checkpointSeconds == null ? null : matchingCheckpoint(snapshot.round.secondsToEnd, selectedSummaryRow.checkpointSeconds, appConfig);
  const row = selectedSummaryRow;
  const liveVwapFloor = selectedSummaryRow && summary.value ? summaryMinVwapFloor(summary.value, selectedSummaryRow, appConfig) : appConfig.pm5mTailEntryMinVwap;
  const yes = quoteSnapshot(snapshot, snapshot.round.yesTokenId, appConfig);
  const no = quoteSnapshot(snapshot, snapshot.round.noTokenId, appConfig);
  const selectedLabel = selectStrongSide(yes, no);
  const selected = selectedLabel === 'YES' ? yes : selectedLabel === 'NO' ? no : null;
  const liveSize = selectedSummaryRow?.size ?? appConfig.pm5mTailEntrySize;
  const plan = selected ? buyVwap(selected.quote.asks || [], liveSize) : null;
  const overroundAsk = yes?.quote.bestAsk != null && no?.quote.bestAsk != null ? roundMoney(yes.quote.bestAsk + no.quote.bestAsk) : null;
  const midpointGap = yes?.quote.midpoint != null && no?.quote.midpoint != null ? roundMoney(Math.abs(yes.quote.midpoint - no.quote.midpoint)) : null;
  const existingOrders = store.roundOrders(snapshot.profileId, snapshot.round.id, TAIL_ENTRY_STRATEGY)
    .filter((order) => order.status !== 'failed');

  if (!enabled) blockers.push('TAIL_ENTRY_DISABLED');
  if (snapshot.round.secondsToStart > 0) blockers.push('ROUND_NOT_STARTED');
  if (snapshot.round.secondsToEnd <= snapshot.round.secondsToStart) blockers.push('INVALID_ROUND_TIMING');
  if (summary.ok && !selectedSummaryRow) blockers.push('TAIL_SUMMARY_ROW_MISSING');
  if (checkpoint == null) blockers.push('NOT_IN_TAIL_CHECKPOINT_WINDOW');
  if (!summary.ok) blockers.push(summary.reason);
  if (row && (row.rows ?? 0) < appConfig.pm5mTailEntryMinRounds) blockers.push('TAIL_SUMMARY_SAMPLE_TOO_SMALL');
  if (summary.ok && !row) blockers.push('TAIL_SUMMARY_12H_PNL_NOT_POSITIVE');
  if (row && (row.totalPnl ?? Number.NEGATIVE_INFINITY) <= 0) blockers.push('TAIL_SUMMARY_12H_PNL_NOT_POSITIVE');
  if (!yes || !no) blockers.push('ORDERBOOK_MISSING');
  if (selectedLabel == null || !selected) blockers.push('TAIL_SIDE_NOT_SELECTABLE');
  if (plan && !plan.fillable) blockers.push('TAIL_DEPTH_INSUFFICIENT');
  if (plan?.vwap != null && plan.vwap + EPSILON < liveVwapFloor) blockers.push('TAIL_VWAP_TOO_LOW');
  if (selected?.quote.spread != null && selected.quote.spread > appConfig.pm5mTailEntryMaxSpread + EPSILON) blockers.push('TAIL_SPREAD_TOO_WIDE');
  if (overroundAsk != null && overroundAsk > appConfig.pm5mTailEntryMaxOverround + EPSILON) blockers.push('TAIL_OVERROUND_TOO_HIGH');
  if ((midpointGap ?? 0) + EPSILON < appConfig.pm5mTailEntryMinMidpointGap) blockers.push('TAIL_MIDPOINT_GAP_TOO_SMALL');
  if (plan?.vwap != null && selected?.quote.bestAsk != null && plan.vwap - selected.quote.bestAsk > appConfig.pm5mTailEntryMaxSlippage + EPSILON) blockers.push('TAIL_SLIPPAGE_TOO_HIGH');
  if (existingOrders.length >= appConfig.pm5mTailEntryMaxOrdersPerRound) blockers.push('TAIL_ROUND_ORDER_LIMIT_REACHED');

  conditions.push(
    condition('Tail entry enabled', enabled, enabled ? 'btc-5m live path enabled' : 'disabled or non-btc-5m profile'),
    condition('Tail checkpoint', checkpoint != null, selectedSummaryRow?.checkpointSeconds == null ? 'no summary-selected checkpoint' : checkpoint == null ? `${selectedSummaryRow.checkpointSeconds}s selected / ${snapshot.round.secondsToEnd.toFixed(1)}s to end` : `${checkpoint}s checkpoint / ${snapshot.round.secondsToEnd.toFixed(1)}s to end`),
    condition('Summary freshness', summary.ok, summary.label),
    condition('Summary selected row', Boolean(selectedSummaryRow), selectedSummaryRow ? `${selectedSummaryRow.checkpointSeconds}s / ${selectedSummaryRow.size} shares / PnL ${formatMoney(selectedSummaryRow.totalPnl)}` : 'missing positive 12h PnL row'),
    condition('Summary sample size', Boolean(row && (row.rows ?? 0) >= appConfig.pm5mTailEntryMinRounds), row ? `${row.rows ?? 0} / min ${appConfig.pm5mTailEntryMinRounds}` : 'missing'),
    condition('Summary 12h PnL', Boolean(row && (row.totalPnl ?? Number.NEGATIVE_INFINITY) > 0), row?.totalPnl == null ? 'missing' : `${formatMoney(row.totalPnl)} / must be > 0`),
    condition('Summary EV/share', row?.avgPnlPerShare != null, row?.avgPnlPerShare == null ? 'missing' : `${row.avgPnlPerShare.toFixed(4)} reference`),
    condition('Summary fill rate', row?.fillRate != null, row?.fillRate == null ? 'missing' : `${formatPct(row.fillRate)} reference only`),
    condition('Summary min VWAP', liveVwapFloor != null, `${liveVwapFloor.toFixed(3)} min strength floor`),
    condition('YES quote fresh', Boolean(yes), yes ? `${yes.ageMs}ms old` : 'missing/stale'),
    condition('NO quote fresh', Boolean(no), no ? `${no.ageMs}ms old` : 'missing/stale'),
    condition('Selected side', selectedLabel != null, selectedLabel ?? 'none'),
    condition('Midpoint gap', (midpointGap ?? 0) + EPSILON >= appConfig.pm5mTailEntryMinMidpointGap, midpointGap == null ? 'missing' : `${midpointGap.toFixed(3)} / min ${appConfig.pm5mTailEntryMinMidpointGap.toFixed(3)}`),
    condition('VWAP depth', Boolean(plan?.fillable), plan?.vwap == null ? `${plan?.filledShares ?? 0}/${liveSize}` : `${plan.filledShares}/${liveSize} @ ${plan.vwap.toFixed(3)}`),
    condition('VWAP floor', plan?.vwap != null && plan.vwap + EPSILON >= liveVwapFloor, plan?.vwap == null ? 'missing' : `${plan.vwap.toFixed(3)} / min ${liveVwapFloor.toFixed(3)}`),
    condition('Spread cap', selected?.quote.spread != null && selected.quote.spread <= appConfig.pm5mTailEntryMaxSpread + EPSILON, selected?.quote.spread == null ? 'missing' : `${selected.quote.spread.toFixed(3)} / max ${appConfig.pm5mTailEntryMaxSpread.toFixed(3)}`),
    condition('Overround cap', overroundAsk != null && overroundAsk <= appConfig.pm5mTailEntryMaxOverround + EPSILON, overroundAsk == null ? 'missing' : `${overroundAsk.toFixed(3)} / max ${appConfig.pm5mTailEntryMaxOverround.toFixed(3)}`),
    condition('Round order limit', existingOrders.length < appConfig.pm5mTailEntryMaxOrdersPerRound, `${existingOrders.length} / max ${appConfig.pm5mTailEntryMaxOrdersPerRound}`),
  );

  const check: StrategyCheck = {
    profileId: snapshot.profileId,
    asset: snapshot.asset,
    interval: snapshot.interval,
    strategy: TAIL_ENTRY_STRATEGY,
    roundId: snapshot.round.id,
    title: '5m Tail Entry',
    status: blockers.length ? 'blocked' : 'eligible',
    summary: 'Buy the stronger BTC 5m side near expiry only when the 12h tail simulator has positive PnL and current orderbook gates pass.',
    reason: blockers.length ? blockers.join(', ') : `Tail entry eligible: buy ${selectedLabel} ${liveSize.toFixed(2)} @ ${plan!.vwap!.toFixed(3)} VWAP from best 12h PnL row.`,
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
    shares: liveSize,
    reason: `BTC 5m tail entry at ${checkpoint}s: selected ${selectedLabel}, simulator 12h PnL ${formatMoney(row?.totalPnl)} at ${liveSize} shares, live VWAP ${plan.vwap.toFixed(3)} >= min ${liveVwapFloor.toFixed(3)}.`,
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
    const { posted, intent: postedIntent, attempts, retryReasons } = await postTailEntryWithFakNoMatchRetry(params, intent);
    params.store.recordOrder({
      ...localOrder(params.snapshot, postedIntent, executionKey, posted.ok ? 'posted' : 'failed'),
      clobOrderId: posted.orderId,
      price: posted.price,
      size: posted.size,
      error: posted.error,
      rawResponse: retryReasons.length ? { response: posted.raw, retryReasons, attempts } : posted.raw,
    });
    params.store.updateIntent(postedIntent.id, { status: posted.ok ? 'executed' : 'failed', rejectionReason: posted.ok ? undefined : posted.error || 'CLOB_POST_FAILED' });
    params.store.recordRuntimeLog({
      level: posted.ok ? 'warn' : 'error',
      source: 'execution',
      message: posted.ok ? `Tail entry posted for ${postedIntent.label} at ${posted.price.toFixed(3)}${attempts > 1 ? ` after ${attempts} FAK attempts` : ''}.` : `Tail entry failed for ${postedIntent.label}: ${posted.error || 'CLOB_POST_FAILED'}.`,
      details: { intentId: postedIntent.id, roundId: postedIntent.roundId, tokenId: postedIntent.tokenId, price: posted.price, size: posted.size, attempts, retryReasons },
    });
    return posted.ok ? [] : [`Tail entry failed for ${postedIntent.label}: ${posted.error || 'CLOB_POST_FAILED'}.`];
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
  if (hasRecentBlockingFailedTailOrder(params.store, intent, executionKey)) return reject('LOCAL_RECENT_FAILED_ORDER');
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

async function postTailEntryWithFakNoMatchRetry(
  params: {
    appConfig: AppConfig;
    adapter: PolymarketAdapter;
    store: InMemoryStore;
    snapshot: StateSnapshot;
    evaluation: TailEntryEvaluation;
  },
  initialIntent: TradeIntent,
): Promise<{ posted: Awaited<ReturnType<PolymarketAdapter['executeLimitIntent']>>; intent: TradeIntent; attempts: number; retryReasons: string[] }> {
  let intent = initialIntent;
  const retryReasons: string[] = [];
  for (let attempt = 1; attempt <= FAK_NO_MATCH_RETRY_LIMIT + 1; attempt += 1) {
    const posted = await params.adapter.executeLimitIntent(intent, { execute: true, orderType: 'FAK' });
    if (posted.ok || !isFakNoMatchError(posted.error) || attempt > FAK_NO_MATCH_RETRY_LIMIT) {
      return { posted, intent, attempts: attempt, retryReasons };
    }

    retryReasons.push(posted.error || 'FAK_NO_MATCH');
    await delay(FAK_NO_MATCH_RETRY_DELAY_MS);
    const nextEvaluation = evaluateTailEntry(params.snapshot, params.appConfig, params.store);
    if (!nextEvaluation.ok) {
      return {
        posted: {
          ok: false,
          price: intent.limitPrice,
          size: roundDownShares(intent.shares),
          error: `FAK_RETRY_REPLAN_BLOCKED: ${nextEvaluation.check.reason}`,
          raw: { retryReasons },
        },
        intent,
        attempts: attempt,
        retryReasons,
      };
    }
    intent = { ...nextEvaluation.intent, id: initialIntent.id };
  }
  throw new Error('unreachable');
}

function hasRecentBlockingFailedTailOrder(store: InMemoryStore, intent: TradeIntent, executionKey: string): boolean {
  const cutoffMs = Date.now() - FAILED_ORDER_COOLDOWN_MS;
  return store.roundOrders(intent.profileId, intent.roundId, TAIL_ENTRY_STRATEGY).some((order) => {
    if (order.executionKey !== executionKey || order.status !== 'failed') return false;
    if (isFakNoMatchError(order.error)) return false;
    const createdMs = new Date(order.createdAt).getTime();
    return Number.isFinite(createdMs) && createdMs >= cutoffMs;
  });
}

function matchingCheckpoint(secondsToEnd: number, checkpoint: number, appConfig: AppConfig): number | null {
  const windowSeconds = Math.max(2, Math.min(5, appConfig.pm5mTailEntryQuoteMaxAgeMs / 1000 + 1));
  return secondsToEnd <= checkpoint && secondsToEnd > checkpoint - windowSeconds ? checkpoint : null;
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

function selectSummaryRow(summary: TailSummary, appConfig: AppConfig): TailSummaryRow | null {
  const allowedCheckpoints = new Set(appConfig.pm5mTailEntryCheckpoints);
  const rows = summary.completed?.byCheckpointSize || [];
  return rows
    .filter((row) => row.size != null && Number.isFinite(row.size) && row.size > 0)
    .filter((row) => !allowedCheckpoints.size || (row.checkpointSeconds != null && allowedCheckpoints.has(row.checkpointSeconds)))
    .filter((row) => (row.rows ?? 0) >= appConfig.pm5mTailEntryMinRounds)
    .filter((row) => (row.totalPnl ?? Number.NEGATIVE_INFINITY) > 0)
    .sort((left, right) => (
      (right.totalPnl ?? Number.NEGATIVE_INFINITY) - (left.totalPnl ?? Number.NEGATIVE_INFINITY)
      || (right.avgPnlPerShare ?? Number.NEGATIVE_INFINITY) - (left.avgPnlPerShare ?? Number.NEGATIVE_INFINITY)
      || (right.fillRate ?? 0) - (left.fillRate ?? 0)
      || (right.checkpointSeconds ?? 0) - (left.checkpointSeconds ?? 0)
    ))[0] ?? null;
}

function summaryMinVwapFloor(summary: TailSummary, selectedRow: TailSummaryRow, appConfig: AppConfig): number {
  const bandRows = (summary.completed?.byAskBand || [])
    .filter((row) => row.checkpointSeconds === selectedRow.checkpointSeconds && row.size === selectedRow.size)
    .filter((row) => (row.rows ?? 0) >= appConfig.pm5mTailEntryMinBandRows)
    .filter((row) => (row.totalPnl ?? Number.NEGATIVE_INFINITY) > 0)
    .map((row) => ({ row, floor: askBandFloor(row.askBand) }))
    .filter((item): item is { row: TailSummaryRow; floor: number } => item.floor != null)
    .sort((left, right) => left.floor - right.floor);
  return bandRows[0]?.floor ?? appConfig.pm5mTailEntryMinVwap;
}

function askBandFloor(askBand: string | undefined): number | null {
  if (!askBand) return null;
  if (askBand === '<55c') return 0;
  if (askBand === '55-65c') return 0.55;
  if (askBand === '65-75c') return 0.65;
  if (askBand === '75-85c') return 0.75;
  if (askBand === '85c+') return 0.85;
  return null;
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
  return Math.max(CLOB_MIN_LIMIT_PRICE, Math.min(CLOB_MAX_LIMIT_PRICE, roundMoney(price)));
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

function formatMoney(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? 'n/a' : `$${value.toFixed(2)}`;
}

function isFakNoMatchError(error: string | undefined): boolean {
  const normalized = (error || '').toLowerCase();
  return normalized.includes('no orders found to match') && normalized.includes('fak');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
