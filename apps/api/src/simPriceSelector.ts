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
};

let cachedSummary: { path: string; loadedAt: number; summary: TouchSummary } | null = null;
const roundSelections = new Map<string, DynamicEntryPriceSelection>();

export type FiveMinuteAssetSelection = {
  profileId: MarketProfile['id'];
  selected: boolean;
  rank?: number;
  score?: number;
  reason: string;
};

type AssetCandidate = {
  profile: MarketProfile;
  row: TouchAggregateRow;
  score: number;
  relaxed: boolean;
};

export function selectFiveMinuteEntryPrice(appConfig: AppConfig, profile: MarketProfile, round: RoundSnapshot): DynamicEntryPriceSelection {
  const fallbackPrice = roundPrice(appConfig.pm5mSimPriceFallback || appConfig.dualLimitPrice);
  const selectedAt = new Date().toISOString();
  if (profile.interval !== '5m') {
    return disabledSelection(profile, fallbackPrice, selectedAt, 'simulator price selection only applies to 5m profiles');
  }
  if (!appConfig.pm5mSimPriceEnabled && !appConfig.pm5mAssetSelectorEnabled) {
    return disabledSelection(profile, fallbackPrice, selectedAt, 'PM5M_SIM_PRICE_ENABLED=false');
  }

  const lockKey = `${profile.id}:${round.id}`;
  const locked = roundSelections.get(lockKey);
  if (locked) return locked;

  const nextSelectionAt = round.endAt;
  const summaryPath = path.resolve(process.cwd(), appConfig.pm5mSimPriceSummaryPath);
  const summary = readSummary(summaryPath, appConfig.pm5mSimPriceRefreshMs);
  if (!summary.ok) {
    return lock(lockKey, fallbackSelection(profile, fallbackPrice, selectedAt, nextSelectionAt, summary.reason));
  }

  const generatedAtMs = summary.value.generatedAt ? new Date(summary.value.generatedAt).getTime() : NaN;
  const summaryAgeMs = Number.isFinite(generatedAtMs) ? Date.now() - generatedAtMs : null;
  if (summaryAgeMs == null || summaryAgeMs > appConfig.pm5mSimPriceMaxSummaryAgeMs) {
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

  const candidates = (summary.value.completed?.byAssetPrice || [])
    .filter((row) => row.asset === profile.asset)
    .filter((row) => row.price >= appConfig.pm5mSimPriceMin - 0.000001 && row.price <= appConfig.pm5mSimPriceMax + 0.000001)
    .filter((row) => row.rounds >= appConfig.pm5mSimPriceMinRounds)
    .sort((a, b) => (
      b.estimatedEvPerShare - a.estimatedEvPerShare
      || (a.singleRate ?? Number.POSITIVE_INFINITY) - (b.singleRate ?? Number.POSITIVE_INFINITY)
      || (a.noneRate ?? Number.POSITIVE_INFINITY) - (b.noneRate ?? Number.POSITIVE_INFINITY)
      || b.price - a.price
    ));

  const best = candidates[0];
  if (!best) {
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

  return lock(lockKey, {
    profileId: profile.id,
    enabled: true,
    source: 'simulator',
    selectedPrice: roundPrice(best.price),
    fallbackPrice,
    reason: `best ${profile.asset} simulator EV ${best.estimatedEvPerShare.toFixed(4)}/share`,
    selectedAt,
    nextSelectionAt,
    summaryGeneratedAt: summary.value.generatedAt,
    summaryAgeMs,
    rounds: best.rounds,
    pairedRate: best.pairedRate,
    singleRate: best.singleRate,
    noneRate: best.noneRate,
    estimatedEvPerShare: best.estimatedEvPerShare,
  });
}

export function rankFiveMinuteAssetCandidates(appConfig: AppConfig, profiles: MarketProfile[]): Map<MarketProfile['id'], FiveMinuteAssetSelection> {
  const decisions = new Map<MarketProfile['id'], FiveMinuteAssetSelection>();
  if (!appConfig.pm5mAssetSelectorEnabled) return decisions;

  const fiveMinuteProfiles = profiles.filter((profile) => profile.interval === '5m');
  if (!fiveMinuteProfiles.length) return decisions;

  const selectedAt = new Date().toISOString();
  const summaryPath = path.resolve(process.cwd(), appConfig.pm5mSimPriceSummaryPath);
  const summary = readSummary(summaryPath, appConfig.pm5mSimPriceRefreshMs);
  if (!summary.ok) {
    for (const profile of fiveMinuteProfiles) {
      decisions.set(profile.id, {
        profileId: profile.id,
        selected: false,
        reason: `5m asset selector blocked live entry: ${summary.reason}`,
      });
    }
    return decisions;
  }

  const generatedAtMs = summary.value.generatedAt ? new Date(summary.value.generatedAt).getTime() : NaN;
  const summaryAgeMs = Number.isFinite(generatedAtMs) ? Date.now() - generatedAtMs : null;
  if (summaryAgeMs == null || summaryAgeMs > appConfig.pm5mSimPriceMaxSummaryAgeMs) {
    const reason = `5m asset selector blocked live entry: simulator summary stale (${summaryAgeMs == null ? 'unknown age' : `${Math.round(summaryAgeMs / 1000)}s`})`;
    for (const profile of fiveMinuteProfiles) decisions.set(profile.id, { profileId: profile.id, selected: false, reason });
    return decisions;
  }

  const rows = summary.value.completed?.byAssetPrice || [];
  const candidates = fiveMinuteProfiles
    .map((profile): AssetCandidate | null => {
      const row = bestSimulatorRow(appConfig, profile, rows);
      return row ? { profile, row, score: row.estimatedEvPerShare, relaxed: false } : null;
    })
    .filter((candidate): candidate is AssetCandidate => Boolean(candidate))
    .sort(sortAssetCandidates);

  const maxSelected = Math.max(1, appConfig.pm5mAssetSelectorMaxAssets);
  const selectedIds = new Set(candidates.slice(0, maxSelected).map((candidate) => candidate.profile.id));
  const rankById = new Map(candidates.map((candidate, index) => [candidate.profile.id, { rank: index + 1, candidate }]));

  for (const profile of fiveMinuteProfiles) {
    const ranked = rankById.get(profile.id);
    if (!ranked) {
      decisions.set(profile.id, {
        profileId: profile.id,
        selected: false,
        reason: `5m asset selector rejected ${profile.asset}: no simulator row passed range/min-round filters at ${selectedAt}`,
      });
      continue;
    }
    const selected = selectedIds.has(profile.id);
    decisions.set(profile.id, {
      profileId: profile.id,
      selected,
      rank: ranked.rank,
      score: ranked.candidate.score,
      reason: selected
        ? `5m asset selector selected rank #${ranked.rank}${ranked.candidate.relaxed ? ' by relative fallback' : ''} (${profile.asset} EV ${ranked.candidate.score.toFixed(4)}/share)`
        : `5m asset selector rejected rank #${ranked.rank}${ranked.candidate.relaxed ? ' by relative fallback' : ''}; outside top ${maxSelected}`,
    });
  }

  return decisions;
}

function bestSimulatorRow(appConfig: AppConfig, profile: MarketProfile, rows: TouchAggregateRow[]): TouchAggregateRow | undefined {
  return rows
    .filter((row) => row.asset === profile.asset)
    .filter((row) => row.price >= appConfig.pm5mSimPriceMin - 0.000001 && row.price <= appConfig.pm5mSimPriceMax + 0.000001)
    .filter((row) => row.rounds >= appConfig.pm5mSimPriceMinRounds)
    .sort((a, b) => (
      b.estimatedEvPerShare - a.estimatedEvPerShare
      || (a.singleRate ?? Number.POSITIVE_INFINITY) - (b.singleRate ?? Number.POSITIVE_INFINITY)
      || (a.noneRate ?? Number.POSITIVE_INFINITY) - (b.noneRate ?? Number.POSITIVE_INFINITY)
      || b.price - a.price
    ))[0];
}

function sortAssetCandidates(a: AssetCandidate, b: AssetCandidate): number {
  return b.score - a.score
    || (a.row.singleRate ?? Number.POSITIVE_INFINITY) - (b.row.singleRate ?? Number.POSITIVE_INFINITY)
    || (a.row.noneRate ?? Number.POSITIVE_INFINITY) - (b.row.noneRate ?? Number.POSITIVE_INFINITY)
    || b.row.price - a.row.price
    || a.profile.id.localeCompare(b.profile.id);
}

function readSummary(summaryPath: string, refreshMs: number): { ok: true; value: TouchSummary } | { ok: false; reason: string; value: TouchSummary } {
  try {
    if (cachedSummary && cachedSummary.path === summaryPath && Date.now() - cachedSummary.loadedAt <= refreshMs) {
      return { ok: true, value: cachedSummary.summary };
    }
    if (!fs.existsSync(summaryPath)) return { ok: false, reason: `simulator summary missing at ${summaryPath}`, value: {} };
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as TouchSummary;
    cachedSummary = { path: summaryPath, loadedAt: Date.now(), summary };
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
