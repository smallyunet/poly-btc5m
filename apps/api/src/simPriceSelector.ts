import fs from 'node:fs';
import path from 'node:path';

import type { DynamicEntryPriceSelection, MarketProfile, RoundSnapshot } from '../../../packages/shared/src';
import type { AppConfig } from './config';

type TouchAggregateRow = {
  asset?: string;
  price: number;
  rounds: number;
  pairedRate: number | null;
  singleRate: number | null;
  noneRate: number | null;
  estimatedEvPerShare: number;
};

type TouchSummary = {
  ok?: boolean;
  generatedAt?: string;
  completed?: {
    byAssetPrice?: TouchAggregateRow[];
  };
  completedAllTime?: {
    byAssetPrice?: TouchAggregateRow[];
  };
  config?: {
    lookbackHours?: number | null;
  };
};

const cachedSummaries = new Map<string, { loadedAt: number; summary: TouchSummary }>();
const roundSelections = new Map<string, DynamicEntryPriceSelection>();

export type IntervalAssetSelection = {
  profileId: MarketProfile['id'];
  selected: boolean;
  rank?: number;
  score?: number;
  ev?: number | null;
  singleRate?: number | null;
  singlePenalty?: number;
  reason: string;
};

type AssetCandidate = {
  profile: MarketProfile;
  row: TouchAggregateRow;
  score: number;
  sampleScope: 'lookback' | 'all-time';
};

export function selectProfileEntryPrice(appConfig: AppConfig, profile: MarketProfile, round: RoundSnapshot): DynamicEntryPriceSelection {
  const fallbackPrice = roundPrice(appConfig.pm5mSimPriceFallback || appConfig.dualLimitPrice);
  const selectedAt = new Date().toISOString();
  const simulationEnabled = appConfig.pm5mSimPriceEnabled || appConfig.pm5mAssetSelectorEnabled;
  if (!simulationEnabled) {
    return disabledSelection(profile, fallbackPrice, selectedAt, 'PM_SIM_PRICE_ENABLED=false');
  }

  const lockKey = `${profile.id}:${round.id}`;
  const locked = roundSelections.get(lockKey);
  if (locked) return locked;

  const nextSelectionAt = round.endAt;
  const summaryPath = path.resolve(process.cwd(), summaryPathForProfile(appConfig, profile));
  const summary = readSummary(summaryPath, appConfig.pm5mSimPriceRefreshMs);
  if (!summary.ok) {
    if (appConfig.pm5mSimRequirePositiveEv) {
      return lock(lockKey, disabledSelection(profile, fallbackPrice, selectedAt, `${profile.interval} simulator positive EV gate blocked ${profile.asset}: ${summary.reason}`));
    }
    return lock(lockKey, fallbackSelection(profile, fallbackPrice, selectedAt, nextSelectionAt, summary.reason));
  }

  const generatedAtMs = summary.value.generatedAt ? new Date(summary.value.generatedAt).getTime() : NaN;
  const summaryAgeMs = Number.isFinite(generatedAtMs) ? Date.now() - generatedAtMs : null;
  if (summaryAgeMs == null || summaryAgeMs > appConfig.pm5mSimPriceMaxSummaryAgeMs) {
    if (appConfig.pm5mSimRequirePositiveEv) {
      return lock(lockKey, disabledSelection(
        profile,
        fallbackPrice,
        selectedAt,
        `${profile.interval} simulator positive EV gate blocked ${profile.asset}: simulator summary stale (${summaryAgeMs == null ? 'unknown age' : `${Math.round(summaryAgeMs / 1000)}s`})`,
      ));
    }
    return lock(lockKey, fallbackSelection(
      profile,
      fallbackPrice,
      selectedAt,
      nextSelectionAt,
      `simulator summary stale (${summaryAgeMs == null ? 'unknown age' : `${Math.round(summaryAgeMs / 1000)}s`})`,
      summary.value.generatedAt,
      summaryAgeMs ?? undefined,
    ));
  }

  const lookbackRows = summaryRows(summary.value, 'lookback');
  const best = bestSimulatorRow(appConfig, profile, lookbackRows)
    ?? (!hasSufficientSimulatorRows(appConfig, profile, lookbackRows)
      ? bestSimulatorRow(appConfig, profile, summaryRows(summary.value, 'all-time'), 'all-time')
      : undefined);
  if (!best) {
    if (appConfig.pm5mSimRequirePositiveEv) {
      return lock(lockKey, disabledSelection(
        profile,
        fallbackPrice,
        selectedAt,
        `${profile.interval} simulator positive EV gate blocked ${profile.asset}: no row above ${appConfig.pm5mSimMinEvPerShare.toFixed(4)}/share passed range/min-round filters`,
      ));
    }
    return lock(lockKey, fallbackSelection(
      profile,
      fallbackPrice,
      selectedAt,
      nextSelectionAt,
      `no ${profile.asset} simulator row passed range/min-round filters`,
      summary.value.generatedAt,
      summaryAgeMs,
    ));
  }
  const sampleScope = best.sampleScope === 'all-time' ? 'all-time fallback' : summaryWindowLabel(summary.value);

  return lock(lockKey, {
    profileId: profile.id,
    enabled: true,
    source: 'simulator',
    selectedPrice: roundPrice(best.row.price),
    fallbackPrice,
    reason: `best ${profile.asset} ${profile.interval} simulator score ${assetSelectorScore(best.row, appConfig.pm5mAssetSelectorSinglePenalty).toFixed(4)}/share from ${sampleScope} = EV ${best.row.estimatedEvPerShare.toFixed(4)} - ${appConfig.pm5mAssetSelectorSinglePenalty.toFixed(3)}*single ${(best.row.singleRate ?? 0).toFixed(4)}`,
    selectedAt,
    nextSelectionAt,
    summaryGeneratedAt: summary.value.generatedAt,
    summaryAgeMs,
    rounds: best.row.rounds,
    pairedRate: best.row.pairedRate,
    singleRate: best.row.singleRate,
    noneRate: best.row.noneRate,
    estimatedEvPerShare: best.row.estimatedEvPerShare,
  });
}

export function rankIntervalAssetCandidates(appConfig: AppConfig, profiles: MarketProfile[]): Map<MarketProfile['id'], IntervalAssetSelection> {
  const decisions = new Map<MarketProfile['id'], IntervalAssetSelection>();
  if (!appConfig.pm5mAssetSelectorEnabled) return decisions;

  for (const interval of ['5m', '15m', '1h'] as const) {
    const intervalProfiles = profiles.filter((profile) => profile.interval === interval);
    if (!intervalProfiles.length) continue;
    rankOneInterval(appConfig, intervalProfiles, decisions);
  }

  return decisions;
}

function rankOneInterval(appConfig: AppConfig, intervalProfiles: MarketProfile[], decisions: Map<MarketProfile['id'], IntervalAssetSelection>): void {
  const interval = intervalProfiles[0]!.interval;
  const selectedAt = new Date().toISOString();
  const summaryPath = path.resolve(process.cwd(), summaryPathForProfile(appConfig, intervalProfiles[0]!));
  const summary = readSummary(summaryPath, appConfig.pm5mSimPriceRefreshMs);
  if (!summary.ok) {
    for (const profile of intervalProfiles) {
      decisions.set(profile.id, {
        profileId: profile.id,
        selected: false,
        reason: `${interval} asset selector blocked live entry: ${summary.reason}`,
      });
    }
    return;
  }

  const generatedAtMs = summary.value.generatedAt ? new Date(summary.value.generatedAt).getTime() : NaN;
  const summaryAgeMs = Number.isFinite(generatedAtMs) ? Date.now() - generatedAtMs : null;
  if (summaryAgeMs == null || summaryAgeMs > appConfig.pm5mSimPriceMaxSummaryAgeMs) {
    const reason = `${interval} asset selector blocked live entry: simulator summary stale (${summaryAgeMs == null ? 'unknown age' : `${Math.round(summaryAgeMs / 1000)}s`})`;
    for (const profile of intervalProfiles) decisions.set(profile.id, { profileId: profile.id, selected: false, reason });
    return;
  }

  const candidates = intervalProfiles
    .map((profile): AssetCandidate | null => {
      const lookbackRows = summaryRows(summary.value, 'lookback');
      const best = bestSimulatorRow(appConfig, profile, lookbackRows)
        ?? (!hasSufficientSimulatorRows(appConfig, profile, lookbackRows)
          ? bestSimulatorRow(appConfig, profile, summaryRows(summary.value, 'all-time'), 'all-time')
          : undefined);
      return best ? { profile, row: best.row, score: assetSelectorScore(best.row, appConfig.pm5mAssetSelectorSinglePenalty), sampleScope: best.sampleScope } : null;
    })
    .filter((candidate): candidate is AssetCandidate => Boolean(candidate))
    .sort(sortAssetCandidates);

  const maxSelected = Math.max(1, appConfig.pm5mAssetSelectorMaxAssets);
  const selectedIds = new Set(candidates.slice(0, maxSelected).map((candidate) => candidate.profile.id));
  const rankById = new Map(candidates.map((candidate, index) => [candidate.profile.id, { rank: index + 1, candidate }]));

  for (const profile of intervalProfiles) {
    const ranked = rankById.get(profile.id);
    if (!ranked) {
      decisions.set(profile.id, {
        profileId: profile.id,
        selected: false,
        reason: `${interval} asset selector rejected ${profile.asset}: no simulator row passed range/min-round filters at ${selectedAt}`,
      });
      continue;
    }
    const selected = selectedIds.has(profile.id);
    decisions.set(profile.id, {
      profileId: profile.id,
      selected,
      rank: ranked.rank,
      score: ranked.candidate.score,
      ev: ranked.candidate.row.estimatedEvPerShare,
      singleRate: ranked.candidate.row.singleRate,
      singlePenalty: appConfig.pm5mAssetSelectorSinglePenalty,
      reason: selected
        ? `${interval} asset selector selected rank #${ranked.rank} (${profile.asset} ${ranked.candidate.sampleScope} score ${ranked.candidate.score.toFixed(4)}/share = EV ${ranked.candidate.row.estimatedEvPerShare.toFixed(4)} - ${appConfig.pm5mAssetSelectorSinglePenalty.toFixed(3)}*single ${(ranked.candidate.row.singleRate ?? 0).toFixed(4)})`
        : `${interval} asset selector rejected rank #${ranked.rank}; outside top ${maxSelected}`,
    });
  }
}

function summaryRows(summary: TouchSummary, sampleScope: 'lookback' | 'all-time'): TouchAggregateRow[] {
  if (sampleScope === 'all-time') return summary.completedAllTime?.byAssetPrice || [];
  return summary.completed?.byAssetPrice || [];
}

function bestSimulatorRow(appConfig: AppConfig, profile: MarketProfile, rows: TouchAggregateRow[], sampleScope: 'lookback' | 'all-time' = 'lookback'): { row: TouchAggregateRow; sampleScope: 'lookback' | 'all-time' } | undefined {
  const minRounds = minRoundsForProfile(appConfig, profile);
  const row = rows
    .filter((row) => row.asset === profile.asset)
    .filter((row) => row.price >= appConfig.pm5mSimPriceMin - 0.000001 && row.price <= appConfig.pm5mSimPriceMax + 0.000001)
    .filter((row) => row.rounds >= minRounds)
    .filter((row) => !appConfig.pm5mSimRequirePositiveEv || row.estimatedEvPerShare > appConfig.pm5mSimMinEvPerShare)
    .sort((a, b) => sortSimulatorRows(appConfig, a, b))[0];
  return row ? { row, sampleScope } : undefined;
}

function hasSufficientSimulatorRows(appConfig: AppConfig, profile: MarketProfile, rows: TouchAggregateRow[]): boolean {
  const minRounds = minRoundsForProfile(appConfig, profile);
  return rows.some((row) => (
    row.asset === profile.asset
    && row.price >= appConfig.pm5mSimPriceMin - 0.000001
    && row.price <= appConfig.pm5mSimPriceMax + 0.000001
    && row.rounds >= minRounds
  ));
}

function summaryPathForProfile(appConfig: AppConfig, profile: MarketProfile): string {
  if (profile.interval === '15m') return appConfig.pm15mSimPriceSummaryPath;
  if (profile.interval === '1h') return appConfig.pm1hSimPriceSummaryPath;
  return appConfig.pm5mSimPriceSummaryPath;
}

function minRoundsForProfile(appConfig: AppConfig, profile: MarketProfile): number {
  if (profile.interval === '15m') return appConfig.pm15mSimPriceMinRounds;
  if (profile.interval === '1h') return appConfig.pm1hSimPriceMinRounds;
  return appConfig.pm5mSimPriceMinRounds;
}

function summaryWindowLabel(summary: TouchSummary): string {
  const hours = summary.config?.lookbackHours;
  return hours && Number.isFinite(hours) ? `${hours}h lookback` : 'lookback';
}

function sortSimulatorRows(appConfig: AppConfig, a: TouchAggregateRow, b: TouchAggregateRow): number {
  return assetSelectorScore(b, appConfig.pm5mAssetSelectorSinglePenalty) - assetSelectorScore(a, appConfig.pm5mAssetSelectorSinglePenalty)
    || b.estimatedEvPerShare - a.estimatedEvPerShare
    || (a.singleRate ?? Number.POSITIVE_INFINITY) - (b.singleRate ?? Number.POSITIVE_INFINITY)
    || (a.noneRate ?? Number.POSITIVE_INFINITY) - (b.noneRate ?? Number.POSITIVE_INFINITY)
    || b.price - a.price;
}

function sortAssetCandidates(a: AssetCandidate, b: AssetCandidate): number {
  return b.score - a.score
    || b.row.estimatedEvPerShare - a.row.estimatedEvPerShare
    || (a.row.singleRate ?? Number.POSITIVE_INFINITY) - (b.row.singleRate ?? Number.POSITIVE_INFINITY)
    || (a.row.noneRate ?? Number.POSITIVE_INFINITY) - (b.row.noneRate ?? Number.POSITIVE_INFINITY)
    || b.row.price - a.row.price
    || a.profile.id.localeCompare(b.profile.id);
}

function assetSelectorScore(row: TouchAggregateRow, singlePenalty: number): number {
  const singleRate = row.singleRate ?? 0;
  return row.estimatedEvPerShare - singlePenalty * singleRate;
}

function readSummary(summaryPath: string, refreshMs: number): { ok: true; value: TouchSummary } | { ok: false; reason: string; value: TouchSummary } {
  try {
    const cachedSummary = cachedSummaries.get(summaryPath);
    if (cachedSummary && Date.now() - cachedSummary.loadedAt <= refreshMs) {
      return { ok: true, value: cachedSummary.summary };
    }
    if (!fs.existsSync(summaryPath)) return { ok: false, reason: `simulator summary missing at ${summaryPath}`, value: {} };
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as TouchSummary;
    cachedSummaries.set(summaryPath, { loadedAt: Date.now(), summary });
    if (summary.ok === false) return { ok: false, reason: 'simulator summary reports unavailable', value: summary };
    return { ok: true, value: summary };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), value: {} };
  }
}

function lock(key: string, selection: DynamicEntryPriceSelection): DynamicEntryPriceSelection {
  roundSelections.set(key, selection);
  if (roundSelections.size > 20) {
    const staleKeys = [...roundSelections.keys()].slice(0, roundSelections.size - 20);
    for (const staleKey of staleKeys) roundSelections.delete(staleKey);
  }
  return selection;
}

function disabledSelection(profile: MarketProfile, fallbackPrice: number, selectedAt: string, reason: string): DynamicEntryPriceSelection {
  return {
    profileId: profile.id,
    enabled: false,
    source: 'disabled',
    selectedPrice: fallbackPrice,
    fallbackPrice,
    reason,
    selectedAt,
  };
}

function fallbackSelection(profile: MarketProfile, fallbackPrice: number, selectedAt: string, nextSelectionAt: string, reason: string, summaryGeneratedAt?: string, summaryAgeMs?: number): DynamicEntryPriceSelection {
  return {
    profileId: profile.id,
    enabled: true,
    source: 'fallback',
    selectedPrice: fallbackPrice,
    fallbackPrice,
    reason,
    selectedAt,
    nextSelectionAt,
    summaryGeneratedAt,
    summaryAgeMs,
  };
}

function roundPrice(value: number): number {
  return Math.round(value * 100) / 100;
}
