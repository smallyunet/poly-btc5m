import type { BtcRoundConfig, PositionSnapshot, RoundPhase, RoundSnapshot, SettlementRecord, StateSnapshot } from '../../../packages/shared/src';
import { classifyRegime, evaluateEntry, evaluateExit, type StrategyRiskConfig } from '../../../packages/strategy/src';
import { PolymarketAdapter } from '../../../packages/polymarket/src';
import type { AppConfig } from './config';
import { executeLiveIntents } from './execution';
import type { MarketDataService } from './marketData';
import type { InMemoryStore } from './store';

export async function runBotTick(appConfig: AppConfig, store: InMemoryStore, data: MarketDataService, adapter: PolymarketAdapter): Promise<StateSnapshot> {
  const diagnostics: string[] = [];
  const round = currentRound(appConfig);
  const orderbooks = await data.refreshOrderbooks(round);
  const features = data.features(round);
  const roundSnapshot = roundToSnapshot(appConfig, round);
  const tokenLabels = new Map<string, 'YES' | 'NO'>([
    [round.yesTokenId, 'YES'],
    [round.noTokenId, 'NO'],
  ]);
  const positions = await loadPositions(adapter, tokenLabels, diagnostics);
  const baseSnapshot: StateSnapshot = {
    id: `snapshot-${Date.now()}`,
    capturedAt: new Date().toISOString(),
    round: roundSnapshot,
    features,
    regime: 'UNKNOWN',
    orderbooks,
    positions,
    diagnostics,
  };
  const risk = riskConfig(appConfig, store.getRuntime().executionMode !== 'live');
  const snapshot: StateSnapshot = { ...baseSnapshot, regime: classifyRegime(baseSnapshot, risk) };
  const entry = evaluateEntry(snapshot, risk);
  const exit = evaluateExit(snapshot, positions, risk);
  const intents = [...exit.intents, ...entry.intents];
  store.recordIntents([...intents, ...exit.rejected, ...entry.rejected]);
  const executionDiagnostics = await executeLiveIntents({ appConfig, adapter, store, snapshot, intents, risk });
  await reconcileFills(adapter, store, roundSnapshot, tokenLabels, diagnostics);
  maybeRecordEstimatedSettlement(store, snapshot);
  const finalSnapshot = { ...snapshot, diagnostics: [...diagnostics, ...entry.diagnostics, ...exit.diagnostics, ...executionDiagnostics] };
  store.recordSnapshot(finalSnapshot, data.status());
  store.recordStrategyChecks([...entry.checks, ...exit.checks]);
  return finalSnapshot;
}

export function currentRound(appConfig: AppConfig): BtcRoundConfig {
  if (appConfig.marketConfig.staticRound) return appConfig.marketConfig.staticRound;
  const durationMs = appConfig.marketConfig.roundDurationSeconds * 1000;
  const now = Date.now();
  const start = Math.floor(now / durationMs) * durationMs;
  const strike = appConfig.staticBtcPrice || 100_000;
  return {
    eventSlug: `${appConfig.marketConfig.seriesSlug}-${start}`,
    title: `${appConfig.marketConfig.title} ${new Date(start).toISOString()}`,
    startAt: new Date(start).toISOString(),
    endAt: new Date(start + durationMs).toISOString(),
    strike,
    yesTokenId: '',
    noTokenId: '',
  };
}

function roundToSnapshot(appConfig: AppConfig, round: BtcRoundConfig): RoundSnapshot {
  const now = Date.now();
  const start = new Date(round.startAt).getTime();
  const end = new Date(round.endAt).getTime();
  return {
    id: round.eventSlug,
    phase: roundPhase(now, start, end, appConfig.marketConfig.decisionLeadSeconds, appConfig.marketConfig.avoidExpirySeconds),
    eventSlug: round.eventSlug,
    title: round.title,
    startAt: round.startAt,
    endAt: round.endAt,
    secondsToStart: (start - now) / 1000,
    secondsToEnd: (end - now) / 1000,
    strike: round.strike,
    yesTokenId: round.yesTokenId,
    noTokenId: round.noTokenId,
    sourceUrl: round.sourceUrl,
    imageUrl: round.imageUrl,
  };
}

function roundPhase(now: number, start: number, end: number, decisionLeadSeconds: number, avoidExpirySeconds: number): RoundPhase {
  if (now < start - decisionLeadSeconds * 1000) return 'observing';
  if (now < start) return 'decision';
  if (now < start + 10_000) return 'posting';
  if (now < end - avoidExpirySeconds * 1000) return 'monitoring';
  if (now < end) return 'settling';
  return 'settled';
}

async function loadPositions(adapter: PolymarketAdapter, tokenLabels: Map<string, 'YES' | 'NO'>, diagnostics: string[]): Promise<PositionSnapshot[]> {
  try {
    return await adapter.getCurrentPositions(tokenLabels);
  } catch (error) {
    diagnostics.push(`Position load failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function reconcileFills(adapter: PolymarketAdapter, store: InMemoryStore, round: RoundSnapshot, tokenLabels: Map<string, 'YES' | 'NO'>, diagnostics: string[]): Promise<void> {
  if (!tokenLabels.size) return;
  try {
    const fills = await adapter.getRecentFills({ roundId: round.id, eventSlug: round.eventSlug, tokenLabels });
    store.recordFills(fills);
  } catch (error) {
    if (store.getRuntime().executionMode === 'live') diagnostics.push(`Fill reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function maybeRecordEstimatedSettlement(store: InMemoryStore, snapshot: StateSnapshot): void {
  if (snapshot.round.phase !== 'settled') return;
  const fills = store.roundFills(snapshot.round.id);
  if (!fills.length) return;
  const yesShares = sum(fills.filter((fill) => fill.label === 'YES' && fill.side === 'BUY').map((fill) => fill.size));
  const noShares = sum(fills.filter((fill) => fill.label === 'NO' && fill.side === 'BUY').map((fill) => fill.size));
  const totalCost = sum(fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.price * fill.size));
  const winningLabel = snapshot.features.price == null ? undefined : snapshot.features.price >= snapshot.round.strike ? 'YES' : 'NO';
  const payout = winningLabel === 'YES' ? yesShares : winningLabel === 'NO' ? noShares : 0;
  const settlement: SettlementRecord = {
    id: `settlement-${snapshot.round.id}`,
    roundId: snapshot.round.id,
    eventSlug: snapshot.round.eventSlug,
    resolvedAt: snapshot.capturedAt,
    winningLabel,
    yesShares,
    noShares,
    totalCost,
    payout,
    pnl: payout - totalCost,
    status: 'estimated',
  };
  store.recordSettlement(settlement);
}

function riskConfig(appConfig: AppConfig, dryRun: boolean): StrategyRiskConfig {
  return {
    dryRun,
    dualLimitPrice: appConfig.dualLimitPrice,
    orderSharesPerSide: appConfig.orderSharesPerSide,
    minOrderShares: appConfig.minOrderShares,
    maxOrderbookAgeSeconds: appConfig.maxOrderbookAgeSeconds,
    minCross120s: appConfig.minCross120s,
    minVolatility120s: appConfig.minVolatility120s,
    maxAbsDrift120s: appConfig.maxAbsDrift120s,
    maxAbsMomentum30s: appConfig.maxAbsMomentum30s,
    singleFillGraceSeconds: appConfig.singleFillGraceSeconds,
    entryOrderTtlSeconds: appConfig.marketConfig.decisionLeadSeconds,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
