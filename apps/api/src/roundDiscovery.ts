import type { BtcRoundConfig, MarketProfile } from '../../../packages/shared/src';
import type { AppConfig } from './config';

type GammaMarket = Record<string, unknown> & {
  slug?: string;
  question?: string;
  description?: string;
  resolutionSource?: string;
  endDate?: string;
  outcomes?: unknown;
  clobTokenIds?: unknown;
  conditionId?: unknown;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  image?: unknown;
  imageUrl?: unknown;
  icon?: unknown;
};

type DiscoveryResult = {
  round: BtcRoundConfig;
  diagnostics: string[];
};

type CachedMarket = {
  market: GammaMarket | null;
  fetchedAt: number;
};

const DISCOVERY_CACHE_MS = 10_000;

export class RecurringCryptoRoundDiscovery {
  private readonly marketCache = new Map<string, CachedMarket>();

  constructor(private readonly config: AppConfig) {}

  async discover(params: {
    profile?: MarketProfile;
    latestPrice?: number | null;
    persistedStrike?: (roundId: string) => number | undefined;
  } = {}): Promise<DiscoveryResult> {
    const diagnostics: string[] = [];
    const profile = params.profile || this.config.marketProfiles[0];
    const nowSec = Math.floor(Date.now() / 1000);
    const nextRoundStartSec = Math.floor(nowSec / profile.roundDurationSeconds) * profile.roundDurationSeconds + profile.roundDurationSeconds;
    const candidates = upcomingRoundWindow(profile, nextRoundStartSec, 6);
    for (const candidate of candidates) {
      const result = await this.marketFromSlug(candidate.slug);
      if (!isUsableMarket(result.market, profile, candidate.slug)) continue;
      return {
        round: this.marketToRound(profile, result.market, params.latestPrice, params.persistedStrike, candidate.roundStartSec),
        diagnostics,
      };
    }

    diagnostics.push(`No usable ${profile.label} Gamma market found in ${candidates.length} deterministic slug candidates.`);
    return {
      round: fallbackRound(profile, nextRoundStartSec, params.latestPrice ?? undefined),
      diagnostics,
    };
  }

  private async marketFromSlug(slug: string): Promise<CachedMarket> {
    const cached = this.marketCache.get(slug);
    if (cached && Date.now() - cached.fetchedAt < DISCOVERY_CACHE_MS) return cached;

    const url = new URL(`/markets/slug/${encodeURIComponent(slug)}`, this.config.gammaApiUrl.replace(/\/+$/, '') + '/');
    const response = await fetch(url);
    const market = response.ok ? await response.json() as GammaMarket : null;
    const result = { market, fetchedAt: Date.now() };
    this.marketCache.set(slug, result);
    return result;
  }

  private marketToRound(profile: MarketProfile, market: GammaMarket, latestPrice?: number | null, persistedStrike?: (roundId: string) => number | undefined, candidateRoundStartSec?: number): BtcRoundConfig {
    const slug = String(market.slug || '');
    const roundStartSec = parseRoundStartSec(slug, profile, candidateRoundStartSec);
    const endAt = normalizeDate(market.endDate) || new Date((roundStartSec + profile.roundDurationSeconds) * 1000).toISOString();
    const startAt = new Date(roundStartSec * 1000).toISOString();
    const tokenIds = parseStringArray(market.clobTokenIds);
    const outcomes = parseStringArray(market.outcomes).map((item) => item.toLowerCase());
    const upIndex = outcomes.indexOf('up');
    const downIndex = outcomes.indexOf('down');
    const yesTokenId = tokenIds[upIndex >= 0 ? upIndex : 0] || '';
    const noTokenId = tokenIds[downIndex >= 0 ? downIndex : 1] || '';
    const strike = persistedStrike?.(slug) || finitePositive(latestPrice) || this.config.marketConfig.strike || 1;

    return {
      eventSlug: slug,
      conditionId: stringValue(market.conditionId),
      title: String(market.question || `${profile.title} ${new Date(roundStartSec * 1000).toISOString()}`),
      startAt,
      endAt,
      strike,
      yesTokenId,
      noTokenId,
      sourceUrl: `https://polymarket.com/event/${slug}`,
      imageUrl: imageUrlFrom(market),
    };
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function upcomingRoundWindow(profile: MarketProfile, anchorRoundStartSec: number, futureCount: number): Array<{ slug: string; roundStartSec: number }> {
  const items: Array<{ slug: string; roundStartSec: number }> = [];
  const seen = new Set<string>();
  for (let offset = 0; offset <= futureCount; offset += 1) {
    const roundStartSec = anchorRoundStartSec + offset * profile.roundDurationSeconds;
    for (const slug of roundSlugCandidates(profile, roundStartSec)) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      items.push({ slug, roundStartSec });
    }
  }
  return items;
}

function roundSlugCandidates(profile: MarketProfile, roundStartSec: number): string[] {
  const slugs = [`${profile.seriesSlug}-${roundStartSec}`];
  const hourlySlug = hourlyHumanSlug(profile, roundStartSec);
  if (hourlySlug) slugs.push(hourlySlug);
  return slugs;
}

function hourlyHumanSlug(profile: MarketProfile, roundStartSec: number): string | null {
  if (profile.interval !== '1h') return null;
  const assetName = {
    btc: 'bitcoin',
    eth: 'ethereum',
    sol: 'solana',
    doge: 'dogecoin',
    xrp: 'xrp',
    hype: 'hyperliquid',
  }[profile.asset];
  const marketStartMs = (roundStartSec - profile.roundDurationSeconds) * 1000;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    hour12: true,
  }).formatToParts(new Date(marketStartMs));
  const part = (type: string) => parts.find((item) => item.type === type)?.value || '';
  const month = part('month').toLowerCase();
  const day = part('day');
  const year = part('year');
  const hour = part('hour').toLowerCase();
  const dayPeriod = part('dayPeriod').toLowerCase();
  if (!month || !day || !year || !hour || !dayPeriod) return null;
  return `${assetName}-up-or-down-${month}-${day}-${year}-${hour}${dayPeriod}-et`;
}

function isUsableMarket(market: GammaMarket | null, profile: MarketProfile, expectedSlug?: string): market is GammaMarket {
  if (!market || market.active === false || market.closed === true) return false;
  const slug = String(market.slug || '');
  const expected = expectedSlug ? slug === expectedSlug : false;
  const deterministic = new RegExp(`^${escapeRegExp(profile.seriesSlug)}-\\d+$`).test(slug);
  if (!expected && !deterministic) return false;
  const tokenIds = parseStringArray(market.clobTokenIds);
  const outcomes = parseStringArray(market.outcomes).map((item) => item.toLowerCase());
  return tokenIds.length >= 2 && outcomes.includes('up') && outcomes.includes('down');
}

function fallbackRound(profile: MarketProfile, nextRoundStartSec: number, latestPrice?: number): BtcRoundConfig {
  const slug = `${profile.seriesSlug}-${nextRoundStartSec}`;
  return {
    eventSlug: slug,
    title: `${profile.title} ${new Date(nextRoundStartSec * 1000).toISOString()}`,
    startAt: new Date(nextRoundStartSec * 1000).toISOString(),
    endAt: new Date((nextRoundStartSec + profile.roundDurationSeconds) * 1000).toISOString(),
    strike: finitePositive(latestPrice) || 1,
    yesTokenId: '',
    noTokenId: '',
  };
}

function parseRoundStartSec(slug: string, profile: MarketProfile, fallback?: number): number {
  const match = slug.match(new RegExp(`${escapeRegExp(profile.seriesSlug)}-(\\d+)$`));
  const parsed = Number(match?.[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    if (Number.isFinite(fallback) && Number(fallback) > 0) return Math.floor(Number(fallback));
    return Math.floor(Date.now() / 1000 / profile.roundDurationSeconds) * profile.roundDurationSeconds;
  }
  return Math.floor(parsed);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item ?? '').trim()).filter(Boolean);
  } catch {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function finitePositive(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function imageUrlFrom(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['imageUrl', 'image', 'icon']) {
    const raw = record[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return undefined;
}
