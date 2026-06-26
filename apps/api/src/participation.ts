import type { BtcRoundConfig, MarketParticipationSnapshot, ParticipationSideSnapshot } from '../../../packages/shared/src';
import type { AppConfig } from './config';

type HolderResponse = Array<{
  token?: string;
  holders?: HolderRecord[];
}>;

type HolderRecord = {
  proxyWallet?: string;
  asset?: string;
  amount?: number | string;
  outcomeIndex?: number;
};

type PositionResponse = Array<{
  asset?: string;
  outcome?: string;
  cashPnl?: number | string;
  currentValue?: number | string;
  size?: number | string;
}>;

type CachedParticipation = {
  snapshot: MarketParticipationSnapshot;
  fetchedAt: number;
};

const REQUEST_TIMEOUT_MS = 4_000;

export class ParticipationService {
  private readonly cache = new Map<string, CachedParticipation>();

  constructor(private readonly config: AppConfig) {}

  async refresh(round: BtcRoundConfig): Promise<MarketParticipationSnapshot> {
    const now = Date.now();
    const cached = this.cache.get(round.eventSlug);
    if (cached && now - cached.fetchedAt < this.config.participationCacheMs) return cached.snapshot;

    const snapshot = await this.fetchParticipation(round);
    this.cache.set(round.eventSlug, { snapshot, fetchedAt: now });
    return snapshot;
  }

  private async fetchParticipation(round: BtcRoundConfig): Promise<MarketParticipationSnapshot> {
    const updatedAt = new Date().toISOString();
    if (!this.config.participationEnabled) {
      return emptySnapshot('disabled', updatedAt, this.config.participationTopHoldersPerSide, ['Participation gate disabled.']);
    }
    if (!round.conditionId?.trim()) {
      return emptySnapshot('missing-condition', updatedAt, this.config.participationTopHoldersPerSide, ['Gamma market did not include conditionId.']);
    }

    const diagnostics: string[] = [];
    try {
      const holderGroups = await this.fetchHolders(round.conditionId);
      const sides = await Promise.all([
        this.sideSnapshot('YES', round.yesTokenId, holderGroups, round.conditionId, diagnostics),
        this.sideSnapshot('NO', round.noTokenId, holderGroups, round.conditionId, diagnostics),
      ]);
      const maxPositionPnl = maxNullable(sides.map((side) => side.topPositionPnl));
      return {
        status: 'enabled',
        updatedAt,
        topHoldersPerSide: this.config.participationTopHoldersPerSide,
        maxPositionPnl,
        totalTopHolderShares: sum(sides.map((side) => side.topHolderShares)),
        totalPositionPnl: sum(sides.map((side) => side.positionPnlSum)),
        sides,
        diagnostics,
      };
    } catch (error) {
      return emptySnapshot('unavailable', updatedAt, this.config.participationTopHoldersPerSide, [
        `Participation load failed: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }

  private async fetchHolders(conditionId: string): Promise<HolderResponse> {
    const url = new URL('/holders', normalizedBase(this.config.dataApiUrl));
    url.searchParams.set('market', conditionId);
    const response = await fetchWithTimeout(url);
    if (!response.ok) throw new Error(`holders returned ${response.status}`);
    const parsed = await response.json();
    return Array.isArray(parsed) ? parsed as HolderResponse : [];
  }

  private async sideSnapshot(
    label: 'YES' | 'NO',
    tokenId: string,
    holderGroups: HolderResponse,
    conditionId: string,
    diagnostics: string[],
  ): Promise<ParticipationSideSnapshot> {
    const holderGroup = holderGroups.find((group) => String(group.token || group.holders?.[0]?.asset || '') === tokenId);
    const holders = [...(holderGroup?.holders || [])]
      .map((holder) => ({
        wallet: String(holder.proxyWallet || '').trim(),
        shares: finiteNumber(holder.amount),
      }))
      .filter((holder) => holder.wallet && holder.shares > 0)
      .sort((a, b) => b.shares - a.shares)
      .slice(0, this.config.participationTopHoldersPerSide);

    const positions = await Promise.allSettled(holders.map((holder) => this.fetchPosition(conditionId, holder.wallet, tokenId, label)));
    const resolved = positions.flatMap((result, index) => {
      if (result.status === 'fulfilled') return result.value ? [result.value] : [];
      diagnostics.push(`${label} holder position lookup failed for ${shortWallet(holders[index]?.wallet)}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      return [];
    });
    const topHolderShares = sum(holders.map((holder) => holder.shares));
    const largestHolderShares = holders[0]?.shares || 0;

    return {
      label,
      holderCount: holders.length,
      topHolderShares,
      largestHolderShares,
      largestHolderShareRatio: topHolderShares > 0 ? largestHolderShares / topHolderShares : null,
      positionCount: resolved.length,
      topPositionPnl: maxNullable(resolved.map((position) => position.cashPnl)),
      positionPnlSum: sum(resolved.map((position) => position.cashPnl)),
      positionCurrentValueSum: sum(resolved.map((position) => position.currentValue)),
    };
  }

  private async fetchPosition(conditionId: string, wallet: string, tokenId: string, label: 'YES' | 'NO'): Promise<{ cashPnl: number; currentValue: number } | null> {
    const url = new URL('/positions', normalizedBase(this.config.dataApiUrl));
    url.searchParams.set('market', conditionId);
    url.searchParams.set('user', wallet);
    const response = await fetchWithTimeout(url);
    if (!response.ok) throw new Error(`positions returned ${response.status}`);
    const parsed = await response.json();
    const positions = Array.isArray(parsed) ? parsed as PositionResponse : [];
    const match = positions.find((position) => {
      const asset = String(position.asset || '').trim();
      const outcome = String(position.outcome || '').trim().toLowerCase();
      return asset === tokenId || outcome === (label === 'YES' ? 'up' : 'down');
    });
    if (!match) return null;
    return {
      cashPnl: finiteNumber(match.cashPnl),
      currentValue: finiteNumber(match.currentValue),
    };
  }
}

function emptySnapshot(status: MarketParticipationSnapshot['status'], updatedAt: string, topHoldersPerSide: number, diagnostics: string[]): MarketParticipationSnapshot {
  return {
    status,
    updatedAt,
    topHoldersPerSide,
    maxPositionPnl: null,
    totalTopHolderShares: 0,
    totalPositionPnl: 0,
    sides: [
      emptySide('YES'),
      emptySide('NO'),
    ],
    diagnostics,
  };
}

function emptySide(label: 'YES' | 'NO'): ParticipationSideSnapshot {
  return {
    label,
    holderCount: 0,
    topHolderShares: 0,
    largestHolderShares: 0,
    largestHolderShareRatio: null,
    positionCount: 0,
    topPositionPnl: null,
    positionPnlSum: 0,
    positionCurrentValueSum: 0,
  };
}

function normalizedBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') + '/';
}

async function fetchWithTimeout(url: URL): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function maxNullable(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value));
  return finite.length ? Math.max(...finite) : null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function shortWallet(wallet: string | undefined): string {
  if (!wallet) return 'unknown';
  return wallet.length > 12 ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : wallet;
}
