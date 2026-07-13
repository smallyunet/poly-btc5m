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
const TAIL_EXECUTION_CHECKPOINT_GRACE_SECONDS = 5;
const EPSILON = 0.000001;
const CLOB_MIN_LIMIT_PRICE = 0.01;
const CLOB_MAX_LIMIT_PRICE = 0.99;

export type TailEntryEvaluation =
  | { ok: true; intent: TradeIntent; check: StrategyCheck; checkpointSeconds: number; vwap: number; bestAsk: number; midpointGap: number; askBand: string }
  | { ok: false; rejected?: TradeIntent; check: StrategyCheck };

type TailSummaryRow = {
  asset?: string;
  checkpointSeconds?: number;
  size?: number;
  askBand?: string;
  rows?: number;
  fillable?: number;
  fillRate?: number | null;
  winRate?: number | null;
  wins?: number | null;
  avgPnlPerShare?: number | null;
  totalPnl?: number | null;
  avgVwap?: number | null;
};

type TailSummary = {
  ok?: boolean;
  generatedAt?: string;
  config?: {
    assets?: string[];
  };
  completed?: {
    byCheckpoint?: TailSummaryRow[];
    byCheckpointSize?: TailSummaryRow[];
    byAssetCheckpoint?: TailSummaryRow[];
    byAskBand?: TailSummaryRow[];
    byAssetAskBand?: TailSummaryRow[];
  };
};

type TailSummarySelection = {
  checkpointRow: TailSummaryRow;
  bandRow: TailSummaryRow;
};

type QuoteSnapshot = {
  quote: OrderBookQuote;
  ageMs: number;
};

export function evaluateTailEntry(
  snapshot: StateSnapshot,
  appConfig: AppConfig,
  store: InMemoryStore,
  options: { checkpointGraceSeconds?: number } = {},
): TailEntryEvaluation {
  const blockers: string[] = [];
  const conditions: StrategyCondition[] = [];
  const enabled = appConfig.pm5mTailEntryEnabled && snapshot.profileId === `${snapshot.asset}-${snapshot.interval}`;
  const summary = readTailSummary(appConfig, snapshot.interval);
  const minRounds = tailEntryMinRounds(appConfig, snapshot.interval);
  const minBandFills = tailEntryMinBandFills(appConfig, snapshot.interval);
  const selectedParameters = summary.value ? selectSummaryParameters(summary.value, snapshot.asset, snapshot.interval, appConfig) : null;
  const selectedSummaryRow = selectedParameters?.checkpointRow ?? null;
  const selectedBandRow = selectedParameters?.bandRow ?? null;
  const checkpoint = selectedSummaryRow?.checkpointSeconds == null ? null : matchingCheckpoint(
    snapshot.round.secondsToEnd,
    selectedSummaryRow.checkpointSeconds,
    appConfig,
    options.checkpointGraceSeconds ?? 0,
  );
  const row = selectedSummaryRow;
  const liveVwapFloor = Math.max(askBandFloor(selectedBandRow?.askBand) ?? appConfig.pm5mTailEntryMinVwap, appConfig.pm5mTailEntryMinVwap);
  const yes = quoteSnapshot(snapshot, snapshot.round.yesTokenId, appConfig);
  const no = quoteSnapshot(snapshot, snapshot.round.noTokenId, appConfig);
  const selectedLabel = selectStrongSide(yes, no);
  const selected = selectedLabel === 'YES' ? yes : selectedLabel === 'NO' ? no : null;
  const liveSize = appConfig.pm5mTailEntrySize;
  const plan = selected ? buyVwap(selected.quote.asks || [], liveSize) : null;
  const liveAskBand = plan?.vwap == null ? null : askBandForVwap(plan.vwap);
  const bandRow = selectedSummaryRow && summary.value && liveAskBand
    ? selectBandRow(summary.value, snapshot.asset, selectedSummaryRow.checkpointSeconds, liveAskBand)
    : null;
  const liveBandSelected = Boolean(liveAskBand && selectedBandRow?.askBand === liveAskBand);
  const tailLimitPrice = plan?.vwap == null
    ? undefined
    : Math.min(cappedPrice(plan.vwap + appConfig.pm5mTailEntryPriceOffset), appConfig.pm5mTailEntryMaxVwap);
  const overroundAsk = yes?.quote.bestAsk != null && no?.quote.bestAsk != null ? roundMoney(yes.quote.bestAsk + no.quote.bestAsk) : null;
  const midpointGap = yes?.quote.midpoint != null && no?.quote.midpoint != null ? roundMoney(Math.abs(yes.quote.midpoint - no.quote.midpoint)) : null;
  const existingOrders = store.roundOrders(snapshot.profileId, snapshot.round.id, TAIL_ENTRY_STRATEGY)
    .filter((order) => order.status !== 'failed');
  const dualRoundOrders = store.roundOrders(snapshot.profileId, snapshot.round.id, 'UPDOWN_DUAL_ENTRY')
    .filter((order) => order.status !== 'failed');
  const tailCooldown = store.getActiveTailCooldown(snapshot.profileId);

  if (!enabled) blockers.push('TAIL_ENTRY_DISABLED');
  if (snapshot.round.secondsToStart > 0) blockers.push('ROUND_NOT_STARTED');
  if (snapshot.round.secondsToEnd <= snapshot.round.secondsToStart) blockers.push('INVALID_ROUND_TIMING');
  if (summary.ok && !selectedParameters) blockers.push('TAIL_SIMULATION_PAIR_MISSING');
  if (checkpoint == null) blockers.push('NOT_IN_TAIL_CHECKPOINT_WINDOW');
  if (!summary.ok) blockers.push(summary.reason);
  if (row && (row.rows ?? 0) < minRounds) blockers.push('TAIL_SUMMARY_SAMPLE_TOO_SMALL');
  if (selectedBandRow && !liveBandSelected) blockers.push('TAIL_ASK_BAND_NOT_SELECTED');
  if (selectedSummaryRow && !bandRow) blockers.push('TAIL_ASK_BAND_HISTORY_MISSING');
  if (bandRow && (bandRow.fillable ?? 0) < minBandFills) blockers.push('TAIL_ASK_BAND_SAMPLE_TOO_SMALL');
  if (bandRow && (bandRow.totalPnl ?? Number.NEGATIVE_INFINITY) <= 0) blockers.push('TAIL_ASK_BAND_PNL_NOT_POSITIVE');
  if (bandRow && (bandRow.avgPnlPerShare ?? Number.NEGATIVE_INFINITY) < appConfig.pm5mTailEntryMinEvPerShare) blockers.push('TAIL_ASK_BAND_EV_TOO_LOW');
  const bandWinLowerBound = bandRow ? winProbabilityLowerBound(bandRow) : null;
  const bandWinProbabilityPass = bandWinLowerBound != null && plan?.vwap != null && bandWinLowerBound + EPSILON >= plan.vwap + appConfig.pm5mTailEntryWinProbabilityMargin;
  if (appConfig.pm5mTailEntryRequireWinProbabilityMargin && !bandWinProbabilityPass) blockers.push('TAIL_WIN_PROBABILITY_MARGIN_TOO_LOW');
  if (dualRoundOrders.length) blockers.push('TAIL_DUAL_ROUND_CONFLICT');
  if (tailCooldown) blockers.push('TAIL_COOLDOWN');
  if (!yes || !no) blockers.push('ORDERBOOK_MISSING');
  if (selectedLabel == null || !selected) blockers.push('TAIL_SIDE_NOT_SELECTABLE');
  if (plan && !plan.fillable) blockers.push('TAIL_DEPTH_INSUFFICIENT');
  if (plan?.vwap != null && plan.vwap + EPSILON < liveVwapFloor) blockers.push('TAIL_VWAP_TOO_LOW');
  if (plan?.vwap != null && plan.vwap > appConfig.pm5mTailEntryMaxVwap + EPSILON) blockers.push('TAIL_VWAP_TOO_HIGH');
  if (selected?.quote.spread != null && selected.quote.spread > appConfig.pm5mTailEntryMaxSpread + EPSILON) blockers.push('TAIL_SPREAD_TOO_WIDE');
  if (overroundAsk != null && overroundAsk > appConfig.pm5mTailEntryMaxOverround + EPSILON) blockers.push('TAIL_OVERROUND_TOO_HIGH');
  if ((midpointGap ?? 0) + EPSILON < appConfig.pm5mTailEntryMinMidpointGap) blockers.push('TAIL_MIDPOINT_GAP_TOO_SMALL');
  if (plan?.vwap != null && selected?.quote.bestAsk != null && plan.vwap - selected.quote.bestAsk > appConfig.pm5mTailEntryMaxSlippage + EPSILON) blockers.push('TAIL_SLIPPAGE_TOO_HIGH');
  if (existingOrders.length >= appConfig.pm5mTailEntryMaxOrdersPerRound) blockers.push('TAIL_ROUND_ORDER_LIMIT_REACHED');

  conditions.push(
    condition('Tail entry enabled', enabled, enabled ? `${snapshot.asset}-${snapshot.interval} tail path enabled` : 'disabled or mismatched profile'),
    condition('Tail checkpoint', checkpoint != null, selectedSummaryRow?.checkpointSeconds == null ? 'no summary-selected checkpoint' : checkpoint == null ? `${selectedSummaryRow.checkpointSeconds}s selected / ${snapshot.round.secondsToEnd.toFixed(1)}s to end` : `${checkpoint}s checkpoint / ${snapshot.round.secondsToEnd.toFixed(1)}s to end`),
    condition('Checkpoint selection', Boolean(selectedSummaryRow), selectedSummaryRow?.checkpointSeconds == null ? 'no eligible simulation pair' : appConfig.pm5mTailEntryAutoSelectCheckpoint ? `${selectedSummaryRow.checkpointSeconds}s auto-selected from fresh simulation` : `${selectedSummaryRow.checkpointSeconds}s selected from configured allowlist`),
    condition('Summary freshness', summary.ok, summary.label),
    condition('Selected simulation pair', Boolean(selectedParameters), selectedParameters ? `${selectedSummaryRow!.checkpointSeconds}s / ${selectedBandRow!.askBand} / per-share EV ${formatPerShare(selectedBandRow!.avgPnlPerShare)} / PnL ${formatMoney(selectedBandRow!.totalPnl)}` : 'no checkpoint and ask-band pair clears simulation gates'),
    condition('Live ask band selected', liveBandSelected, liveAskBand == null ? 'missing' : `${liveAskBand} live / ${selectedBandRow?.askBand ?? 'none'} selected`),
    condition('Summary sample size', Boolean(row && (row.rows ?? 0) >= minRounds), row ? `${row.rows ?? 0} / min ${minRounds}` : 'missing'),
    condition('Checkpoint window PnL', row?.totalPnl != null, row?.totalPnl == null ? 'missing' : `${formatMoney(row.totalPnl)} reference`),
    condition('Summary EV/share', row?.avgPnlPerShare != null, row?.avgPnlPerShare == null ? 'missing' : `${row.avgPnlPerShare.toFixed(4)} reference`),
    condition('Checkpoint EV/share', row?.avgPnlPerShare != null, row?.avgPnlPerShare == null ? 'missing' : `${row.avgPnlPerShare.toFixed(4)} reference`),
    condition('Current ask band', Boolean(bandRow), liveAskBand == null ? 'missing' : `${liveAskBand} / ${bandRow?.rows ?? 0} rows / EV ${formatPerShare(bandRow?.avgPnlPerShare)}`),
    condition('Ask-band fillable sample', Boolean(bandRow && (bandRow.fillable ?? 0) >= minBandFills), `${bandRow?.fillable ?? 0} fillable / min ${minBandFills} (${bandRow?.rows ?? 0} observed)`),
    condition('Ask-band EV/share', Boolean(bandRow && (bandRow.avgPnlPerShare ?? Number.NEGATIVE_INFINITY) >= appConfig.pm5mTailEntryMinEvPerShare), bandRow?.avgPnlPerShare == null ? 'missing' : `${bandRow.avgPnlPerShare.toFixed(4)} / min ${appConfig.pm5mTailEntryMinEvPerShare.toFixed(4)}`),
    condition('Conservative win probability', !appConfig.pm5mTailEntryRequireWinProbabilityMargin || bandWinProbabilityPass, bandWinLowerBound == null || plan?.vwap == null ? appConfig.pm5mTailEntryRequireWinProbabilityMargin ? 'missing / hard gate enabled' : 'missing / reference only' : `${formatPct(bandWinLowerBound)} lower bound / needs ${formatPct(plan.vwap + appConfig.pm5mTailEntryWinProbabilityMargin)} / ${appConfig.pm5mTailEntryRequireWinProbabilityMargin ? 'hard gate enabled' : 'reference only'}`),
    condition('No Dual allocation this round', dualRoundOrders.length === 0, `${dualRoundOrders.length} tracked Dual orders`),
    condition('Tail cooldown', !tailCooldown, tailCooldown ? `until ${tailCooldown.expiresAt} after ${tailCooldown.roundId}` : 'clear'),
    condition('Summary fill rate', row?.fillRate != null, row?.fillRate == null ? 'missing' : `${formatPct(row.fillRate)} reference only`),
    condition('Summary min VWAP', liveVwapFloor != null, `${liveVwapFloor.toFixed(3)} min strength floor`),
    condition('YES quote fresh', Boolean(yes), yes ? `${yes.ageMs}ms old` : 'missing/stale'),
    condition('NO quote fresh', Boolean(no), no ? `${no.ageMs}ms old` : 'missing/stale'),
    condition('Selected side', selectedLabel != null, selectedLabel ?? 'none'),
    condition('Midpoint gap', (midpointGap ?? 0) + EPSILON >= appConfig.pm5mTailEntryMinMidpointGap, midpointGap == null ? 'missing' : `${midpointGap.toFixed(3)} / min ${appConfig.pm5mTailEntryMinMidpointGap.toFixed(3)}`),
    condition('VWAP depth', Boolean(plan?.fillable), plan?.vwap == null ? `${plan?.filledShares ?? 0}/${liveSize}` : `${plan.filledShares}/${liveSize} @ ${plan.vwap.toFixed(3)}`),
    condition('VWAP floor', plan?.vwap != null && plan.vwap + EPSILON >= liveVwapFloor, plan?.vwap == null ? 'missing' : `${plan.vwap.toFixed(3)} / min ${liveVwapFloor.toFixed(3)}`),
    condition('VWAP ceiling', plan?.vwap != null && plan.vwap <= appConfig.pm5mTailEntryMaxVwap + EPSILON, plan?.vwap == null ? 'missing' : `${plan.vwap.toFixed(3)} / max ${appConfig.pm5mTailEntryMaxVwap.toFixed(3)}`),
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
    title: `${snapshot.interval} Tail Entry`,
    status: blockers.length ? 'blocked' : 'eligible',
    summary: `Buy the stronger ${snapshot.asset.toUpperCase()} ${snapshot.interval} side near expiry only when that profile's tail simulator has positive PnL and current orderbook gates pass.`,
    reason: blockers.length ? blockers.join(', ') : `Tail entry eligible: buy ${selectedLabel} ${liveSize.toFixed(2)} @ ${plan!.vwap!.toFixed(3)} VWAP from best simulation checkpoint and ask-band pair.`,
    blockers,
    amountUsd: plan?.cost,
    limitPrice: tailLimitPrice,
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
    limitPrice: tailLimitPrice!,
    shares: liveSize,
    maxSpendUsd: roundMoney(liveSize * tailLimitPrice!),
    reason: `${snapshot.asset.toUpperCase()} ${snapshot.interval} tail entry at ${checkpoint}s: selected ${selectedLabel}, simulator per-share EV ${formatPerShare(row?.avgPnlPerShare)} with PnL ${formatMoney(row?.totalPnl)}, ${liveSize} reference shares / max spend ${formatMoney(liveSize * tailLimitPrice!)}, live VWAP ${plan.vwap.toFixed(3)} >= min ${liveVwapFloor.toFixed(3)}.`,
    status: 'generated',
    ttlSeconds: Math.max(1, Math.ceil(snapshot.round.secondsToEnd)),
    createdAt: snapshot.capturedAt,
  };
  return { ok: true, intent, check, checkpointSeconds: checkpoint, vwap: plan.vwap, bestAsk: selected.quote.bestAsk ?? plan.vwap, midpointGap: midpointGap ?? 0, askBand: liveAskBand! };
}

export function revalidateTailEntry(snapshot: StateSnapshot, appConfig: AppConfig, store: InMemoryStore): TailEntryEvaluation {
  return evaluateTailEntry(snapshot, appConfig, store, { checkpointGraceSeconds: TAIL_EXECUTION_CHECKPOINT_GRACE_SECONDS });
}

export async function executeTailEntry(params: {
  appConfig: AppConfig;
  adapter: PolymarketAdapter;
  store: InMemoryStore;
  snapshot: StateSnapshot;
  evaluation: TailEntryEvaluation;
  revalidate?: () => TailEntryEvaluation;
}): Promise<string[]> {
  if (!params.evaluation.ok) return [];
  const evaluation = params.evaluation;
  const intent = evaluation.intent;
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

  const revalidated = params.revalidate?.();
  if (revalidated) {
    const reason = tailRevalidationFailure(evaluation, revalidated, params.appConfig.pm5mTailEntryMaxSlippage);
    if (reason) {
      params.store.updateIntent(intent.id, { status: 'rejected', rejectionReason: reason });
      params.store.recordRuntimeLog({ level: 'warn', source: 'execution', message: `Tail entry blocked before submit: ${reason}.`, details: { intentId: intent.id, roundId: intent.roundId } });
      return [`Tail entry blocked before submit: ${reason}.`];
    }
  }

  try {
    const { posted, intent: postedIntent, attempts, retryReasons } = await postTailEntryWithFakNoMatchRetry({ ...params, evaluation }, intent);
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
  if (params.snapshot.profileId !== `${params.snapshot.asset}-${params.snapshot.interval}`) return reject('TAIL_ENTRY_PROFILE_NOT_ALLOWED');
  if (params.snapshot.round.secondsToStart > 0) return reject('ROUND_NOT_STARTED');
  if (params.snapshot.round.secondsToEnd <= 0) return reject('ROUND_EXPIRED');
  if (intent.limitPrice > params.appConfig.pm5mTailEntryMaxVwap + EPSILON) return reject('TAIL_LIMIT_PRICE_ABOVE_MAX');
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
    evaluation: Extract<TailEntryEvaluation, { ok: true }>;
    revalidate?: () => TailEntryEvaluation;
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
    const nextEvaluation = params.revalidate?.() ?? evaluateTailEntry(params.snapshot, params.appConfig, params.store);
    const replanFailure = tailRevalidationFailure(params.evaluation, nextEvaluation, params.appConfig.pm5mTailEntryMaxSlippage);
    if (replanFailure) {
      return {
        posted: {
          ok: false,
          price: intent.limitPrice,
          size: roundDownShares(intent.shares),
          error: `FAK_RETRY_REPLAN_BLOCKED: ${replanFailure}`,
          raw: { retryReasons },
        },
        intent,
        attempts: attempt,
        retryReasons,
      };
    }
    if (!nextEvaluation.ok) throw new Error('Tail revalidation unexpectedly failed without a blocker');
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

function tailRevalidationFailure(initial: Extract<TailEntryEvaluation, { ok: true }>, next: TailEntryEvaluation, maxSlippage: number): string | null {
  if (!next.ok) return `TAIL_REVALIDATION_BLOCKED: ${next.check.reason}`;
  if (next.intent.roundId !== initial.intent.roundId) return 'TAIL_REVALIDATION_ROUND_CHANGED';
  if (next.intent.label !== initial.intent.label) return 'TAIL_REVALIDATION_SIDE_CHANGED';
  if (next.askBand !== initial.askBand) return 'TAIL_REVALIDATION_BAND_CHANGED';
  if (Math.abs(next.vwap - initial.vwap) > maxSlippage + EPSILON) return 'TAIL_REVALIDATION_VWAP_MOVED';
  return null;
}

function matchingCheckpoint(secondsToEnd: number, checkpoint: number, appConfig: AppConfig, graceSeconds = 0): number | null {
  const windowSeconds = Math.max(2, Math.min(5, appConfig.pm5mTailEntryQuoteMaxAgeMs / 1000 + 1));
  return secondsToEnd <= checkpoint && secondsToEnd > checkpoint - windowSeconds - graceSeconds ? checkpoint : null;
}

function readTailSummary(appConfig: AppConfig, interval: StateSnapshot['interval']): { ok: true; value: TailSummary; label: string } | { ok: false; reason: string; label: string; value?: undefined } {
  const configuredPath = interval === '15m' ? appConfig.pm15mTailEntrySummaryPath : interval === '1h' ? appConfig.pm1hTailEntrySummaryPath : appConfig.pm5mTailEntrySummaryPath;
  const summaryPath = path.resolve(process.cwd(), configuredPath);
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

function selectSummaryParameters(summary: TailSummary, asset: string, interval: StateSnapshot['interval'], appConfig: AppConfig): TailSummarySelection | null {
  const allowedCheckpoints = appConfig.pm5mTailEntryAutoSelectCheckpoint
    ? null
    : new Set(appConfig.pm5mTailEntryCheckpoints);
  const hasAssetBreakdown = Array.isArray(summary.completed?.byAssetCheckpoint);
  const checkpointRows = hasAssetBreakdown
    ? summary.completed!.byAssetCheckpoint!.filter((row) => row.asset === asset)
    : asset === 'btc' ? summary.completed?.byCheckpoint || summary.completed?.byCheckpointSize || [] : [];
  const eligibleCheckpoints = checkpointRows
    .filter((row) => allowedCheckpoints == null || !allowedCheckpoints.size || (row.checkpointSeconds != null && allowedCheckpoints.has(row.checkpointSeconds)))
    .filter((row) => (row.rows ?? 0) >= tailEntryMinRounds(appConfig, interval));
  const checkpointsBySeconds = new Map(eligibleCheckpoints.map((row) => [row.checkpointSeconds, row]));
  const hasAssetBandBreakdown = Array.isArray(summary.completed?.byAssetAskBand);
  const bandRows = (hasAssetBandBreakdown
    ? summary.completed!.byAssetAskBand!.filter((row) => row.asset === asset)
    : asset === 'btc' ? summary.completed?.byAskBand || [] : [])
    .filter((row) => checkpointsBySeconds.has(row.checkpointSeconds))
    .filter((row) => (row.fillable ?? 0) >= tailEntryMinBandFills(appConfig, interval))
    .filter((row) => (row.totalPnl ?? Number.NEGATIVE_INFINITY) > 0)
    .filter((row) => (row.avgPnlPerShare ?? Number.NEGATIVE_INFINITY) >= appConfig.pm5mTailEntryMinEvPerShare)
    .filter((row) => askBandCanExecute(row.askBand, appConfig.pm5mTailEntryMinVwap, appConfig.pm5mTailEntryMaxVwap))
    .sort((left, right) => (
      (right.avgPnlPerShare ?? Number.NEGATIVE_INFINITY) - (left.avgPnlPerShare ?? Number.NEGATIVE_INFINITY)
      || (right.totalPnl ?? Number.NEGATIVE_INFINITY) - (left.totalPnl ?? Number.NEGATIVE_INFINITY)
      || (right.fillRate ?? 0) - (left.fillRate ?? 0)
      || (right.checkpointSeconds ?? 0) - (left.checkpointSeconds ?? 0)
      || (askBandFloor(right.askBand) ?? 0) - (askBandFloor(left.askBand) ?? 0)
    ));
  const bandRow = bandRows[0];
  const checkpointRow = bandRow ? checkpointsBySeconds.get(bandRow.checkpointSeconds) : null;
  return bandRow && checkpointRow ? { checkpointRow, bandRow } : null;
}

function tailEntryMinRounds(appConfig: AppConfig, interval: StateSnapshot['interval']): number {
  if (interval === '15m') return appConfig.pm15mTailEntryMinRounds;
  if (interval === '1h') return appConfig.pm1hTailEntryMinRounds;
  return appConfig.pm5mTailEntryMinRounds;
}

function tailEntryMinBandFills(appConfig: AppConfig, interval: StateSnapshot['interval']): number {
  if (interval === '15m') return appConfig.pm15mTailEntryMinBandFills;
  if (interval === '1h') return appConfig.pm1hTailEntryMinBandFills;
  return appConfig.pm5mTailEntryMinBandFills;
}

function selectBandRow(summary: TailSummary, asset: string, checkpointSeconds: number | undefined, askBand: string): TailSummaryRow | null {
  const rows = Array.isArray(summary.completed?.byAssetAskBand)
    ? summary.completed!.byAssetAskBand!.filter((row) => row.asset === asset)
    : asset === 'btc' ? summary.completed?.byAskBand || [] : [];
  return rows.find((row) => row.checkpointSeconds === checkpointSeconds && row.askBand === askBand) ?? null;
}

function askBandForVwap(vwap: number): string {
  if (vwap < 0.55) return '<55c';
  if (vwap < 0.65) return '55-65c';
  if (vwap < 0.75) return '65-75c';
  if (vwap < 0.85) return '75-85c';
  return '85c+';
}

function winProbabilityLowerBound(row: TailSummaryRow): number | null {
  const n = row.fillable ?? 0;
  if (n <= 0) return null;
  const estimatedWins = row.wins ?? ((row.winRate ?? 0) * n);
  const p = Math.min(1, Math.max(0, estimatedWins / n));
  const z = 1.96;
  const denominator = 1 + z * z / n;
  const center = p + z * z / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return (center - spread) / denominator;
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

function askBandCanExecute(askBand: string | undefined, minVwap: number, maxVwap: number): boolean {
  const floor = askBandFloor(askBand);
  if (floor == null) return false;
  const ceiling = askBand === '<55c' ? 0.55
    : askBand === '55-65c' ? 0.65
      : askBand === '65-75c' ? 0.75
        : askBand === '75-85c' ? 0.85
          : 1.01;
  return floor <= maxVwap + EPSILON && ceiling > minVwap + EPSILON;
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

function formatPerShare(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? 'n/a' : value.toFixed(4);
}

function isFakNoMatchError(error: string | undefined): boolean {
  const normalized = (error || '').toLowerCase();
  return normalized.includes('no orders found to match') && normalized.includes('fak');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
