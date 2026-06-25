import type { BtcRoundConfig } from '../../../packages/shared/src';
import type { AppConfig } from './config';

type GammaMarket = Record<string, unknown> & {
  slug?: string;
  question?: string;
  description?: string;
  resolutionSource?: string;
  endDate?: string;
  outcomes?: unknown;
  clobTokenIds?: unknown;
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

const ASSET = 'btc';
const INTERVAL = '5m';
const ROUND_DURATION_SECONDS = 300;
const DISCOVERY_CACHE_MS = 10_000;

export class Btc5mRoundDiscovery {
  private readonly marketCache = new Map<string, CachedMarket>();

  constructor(private readonly config: AppConfig) {}

  async discover(params: {
    latestPrice?: number | null;
    persistedStrike?: (roundId: string) => number | undefined;
  } = {}): Promise<DiscoveryResult> {
    const diagnostics: string[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const nextRoundStartSec = Math.floor(nowSec / ROUND_DURATION_SECONDS) * ROUND_DURATION_SECONDS + ROUND_DURATION_SECONDS;
    const candidates = upcomingRoundWindow(nextRoundStartSec, 6);
    for (const candidate of candidates) {
      const result = await this.marketFromSlug(candidate.slug);
      if (!isUsableMarket(result.market)) continue;
      return {
        round: this.marketToRound(result.market, params.latestPrice, params.persistedStrike),
        diagnostics,
      };
    }

    diagnostics.push(`No usable BTC 5m Gamma market found in ${candidates.length} deterministic slug candidates.`);
    return {
      round: fallbackRound(nextRoundStartSec, this.config, params.latestPrice ?? undefined),
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

  private marketToRound(market: GammaMarket, latestPrice?: number | null, persistedStrike?: (roundId: string) => number | undefined): BtcRoundConfig {
    const slug = String(market.slug || '');
    const roundStartSec = parseRoundStartSec(slug);
    const endAt = normalizeDate(market.endDate) || new Date((roundStartSec + ROUND_DURATION_SECONDS) * 1000).toISOString();
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
      title: String(market.question || `${this.config.marketConfig.title} ${new Date(roundStartSec * 1000).toISOString()}`),
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

function upcomingRoundWindow(anchorRoundStartSec: number, futureCount: number): Array<{ slug: string; roundStartSec: number }> {
  const items: Array<{ slug: string; roundStartSec: number }> = [];
  for (let offset = 0; offset <= futureCount; offset += 1) {
    const roundStartSec = anchorRoundStartSec + offset * ROUND_DURATION_SECONDS;
    items.push({ slug: `${ASSET}-updown-${INTERVAL}-${roundStartSec}`, roundStartSec });
  }
  return items;
}

function isUsableMarket(market: GammaMarket | null): market is GammaMarket {
  if (!market || market.active === false || market.closed === true) return false;
  const slug = String(market.slug || '');
  if (!/^btc-updown-5m-\d+$/.test(slug)) return false;
  const tokenIds = parseStringArray(market.clobTokenIds);
  const outcomes = parseStringArray(market.outcomes).map((item) => item.toLowerCase());
  return tokenIds.length >= 2 && outcomes.includes('up') && outcomes.includes('down');
}

function fallbackRound(nextRoundStartSec: number, config: AppConfig, latestPrice?: number): BtcRoundConfig {
  const slug = `${config.marketConfig.seriesSlug}-${nextRoundStartSec}`;
  return {
    eventSlug: slug,
    title: `${config.marketConfig.title} ${new Date(nextRoundStartSec * 1000).toISOString()}`,
    startAt: new Date(nextRoundStartSec * 1000).toISOString(),
    endAt: new Date((nextRoundStartSec + ROUND_DURATION_SECONDS) * 1000).toISOString(),
    strike: finitePositive(latestPrice) || config.marketConfig.strike || 1,
    yesTokenId: '',
    noTokenId: '',
  };
}

function parseRoundStartSec(slug: string): number {
  const match = slug.match(/btc-updown-5m-(\d+)$/);
  const parsed = Number(match?.[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.floor(Date.now() / 1000 / ROUND_DURATION_SECONDS) * ROUND_DURATION_SECONDS;
  return Math.floor(parsed);
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
