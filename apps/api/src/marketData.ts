import WebSocket from 'ws';
import type { BtcFeatureSnapshot, BtcRoundConfig, DataFeedStatus, OrderBookQuote, PriceTick } from '../../../packages/shared/src';
import { quoteFromBook } from '../../../packages/polymarket/src';
import type { AppConfig } from './config';
import type { InMemoryStore } from './store';

export class MarketDataService {
  private readonly priceTicks: PriceTick[] = [];
  private readonly orderbooks = new Map<string, OrderBookQuote>();
  private binance?: WebSocket;
  private clob?: WebSocket;
  private clobTokenKey = '';
  private clobReconnect?: NodeJS.Timeout;
  private binanceConnected = false;
  private clobConnected = false;
  private lastBinanceSampleAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly store: InMemoryStore,
  ) {}

  start(): void {
    this.connectBinance();
  }

  syncClobRound(round: BtcRoundConfig, extraTokenIds: string[] = []): void {
    const tokenIds = dedupe([round.yesTokenId, round.noTokenId, ...extraTokenIds].filter(Boolean));
    const nextKey = tokenIds.join('|');
    if (tokenIds.length < 2) {
      if (!this.clobTokenKey) return;
      this.closeClob();
      this.clobTokenKey = '';
      return;
    }
    if (this.clobTokenKey === nextKey && this.clob) return;
    this.closeClob();
    this.clobTokenKey = nextKey;
    this.connectClob(tokenIds);
  }

  refreshOrderbooks(round: BtcRoundConfig): OrderBookQuote[] {
    const tokenIds = [round.yesTokenId, round.noTokenId].filter(Boolean);
    return tokenIds.map((tokenId) => this.orderbooks.get(tokenId)).filter((item): item is OrderBookQuote => Boolean(item));
  }

  refreshOrderbooksForTokenIds(tokenIds: string[]): OrderBookQuote[] {
    return dedupe(tokenIds.filter(Boolean)).map((tokenId) => this.orderbooks.get(tokenId)).filter((item): item is OrderBookQuote => Boolean(item));
  }

  features(round: BtcRoundConfig): BtcFeatureSnapshot {
    const now = Date.now();
    const ticks = this.binanceConnected ? this.priceTicks.filter((tick) => now - new Date(tick.receivedAt).getTime() <= 120_000) : [];
    const ticks300s = this.binanceConnected ? this.priceTicks.filter((tick) => now - new Date(tick.receivedAt).getTime() <= 300_000) : [];
    const latest = ticks.at(-1);
    const samples120s = ticks.length;
    let cross120s = 0;
    let latestCrossAt: string | undefined;
    for (let i = 1; i < ticks.length; i += 1) {
      const prev = Math.sign(ticks[i - 1].price - round.strike);
      const next = Math.sign(ticks[i].price - round.strike);
      if (prev !== 0 && next !== 0 && prev !== next) {
        cross120s += 1;
        latestCrossAt = ticks[i].receivedAt;
      }
    }
    const prices = ticks.map((tick) => tick.price);
    const prices300s = ticks300s.map((tick) => tick.price);
    const first = prices[0];
    const last = prices.at(-1);
    const volatility120s = prices.length > 1 ? stddev(prices) : 0;
    const drift120s = first != null && last != null ? last - first : 0;
    const thirtyAgo = ticks.find((tick) => now - new Date(tick.receivedAt).getTime() <= 30_000);
    const momentum30s = thirtyAgo && latest ? latest.price - thirtyAgo.price : 0;
    const range120s = range(prices);
    const range300s = range(prices300s);
    const denominator = latest?.price && latest.price > 0 ? latest.price : round.strike;
    const rangeBps120s = bps(range120s, denominator);
    const rangeBps300s = bps(range300s, denominator);
    const upExcursion = prices.length ? Math.max(0, ...prices.map((price) => price - round.strike)) : 0;
    const downExcursion = prices.length ? Math.max(0, ...prices.map((price) => round.strike - price)) : 0;
    const upExcursionBps120s = bps(upExcursion, denominator);
    const downExcursionBps120s = bps(downExcursion, denominator);
    const minBiExcursionBps120s = Math.min(upExcursionBps120s, downExcursionBps120s);
    const maxBiExcursionBps120s = Math.max(upExcursionBps120s, downExcursionBps120s);
    const excursionBalance120s = maxBiExcursionBps120s > 0 ? minBiExcursionBps120s / maxBiExcursionBps120s : 0;
    const driftRatio120s = range120s > 0 ? Math.abs(drift120s) / range120s : 1;
    const momentumRatio30s = range120s > 0 ? Math.abs(momentum30s) / range120s : 1;
    const rangePercentile120s = rollingRangePercentile(this.priceTicks, now, 120_000);
    const chopScore = scoreChop({
      cross120s,
      rangeBps120s,
      minBiExcursionBps120s,
      excursionBalance120s,
      driftRatio120s,
      momentumRatio30s,
      rangePercentile120s,
    });

    return {
      price: latest?.price ?? null,
      strike: round.strike,
      cross120s,
      crossFrequency: samples120s ? cross120s / Math.max(1, samples120s / 60) : 0,
      volatility120s,
      drift120s,
      momentum30s,
      range120s,
      range300s,
      rangeBps120s,
      rangeBps300s,
      upExcursionBps120s,
      downExcursionBps120s,
      minBiExcursionBps120s,
      excursionBalance120s,
      driftRatio120s,
      momentumRatio30s,
      rangePercentile120s,
      chopScore,
      samples120s,
      latestCrossAt,
      source: latest?.source ?? 'none',
      updatedAt: latest?.receivedAt ?? new Date().toISOString(),
    };
  }

  status(): DataFeedStatus {
    const latestPrice = this.priceTicks.at(-1);
    const latestBook = [...this.orderbooks.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
    return {
      binanceConnected: this.binanceConnected,
      clobConnected: this.clobConnected,
      lastPriceAt: latestPrice?.receivedAt,
      lastOrderbookAt: latestBook?.updatedAt,
      priceSamples: this.priceTicks.length,
      source: this.binanceConnected ? 'live' : 'unavailable',
    };
  }

  latestPrice(): number | null {
    return this.priceTicks.at(-1)?.price ?? null;
  }

  private connectBinance(): void {
    if (this.binance) return;
    try {
      const ws = new WebSocket(this.config.binanceWsUrl);
      this.binance = ws;
      ws.on('open', () => {
        this.binanceConnected = true;
        this.store.recordRuntimeLog({ level: 'info', source: 'market-data', message: 'Binance BTC websocket connected.' });
      });
      ws.on('message', (data) => this.handleBinancePriceMessage(data.toString()));
      ws.on('close', () => {
        this.binanceConnected = false;
        this.binance = undefined;
        setTimeout(() => this.connectBinance(), 5_000).unref?.();
      });
      ws.on('error', (error) => {
        this.binanceConnected = false;
        this.store.recordRuntimeLog({ level: 'warn', source: 'market-data', message: `Binance BTC websocket error: ${error.message}` });
      });
    } catch (error) {
      this.store.recordRuntimeLog({ level: 'warn', source: 'market-data', message: `Binance BTC websocket failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private connectClob(tokenIds: string[]): void {
    if (this.clob) return;
    if (tokenIds.length < 2) {
      this.store.recordRuntimeLog({ level: 'warn', source: 'market-data', message: 'CLOB websocket is disabled until both YES and NO token IDs are configured.' });
      return;
    }
    try {
      const ws = new WebSocket(this.config.clobWsUrl);
      this.clob = ws;
      ws.on('open', () => {
        this.clobConnected = true;
        this.store.recordRuntimeLog({ level: 'info', source: 'market-data', message: 'CLOB websocket connected.' });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'market',
            assets_ids: tokenIds,
            custom_feature_enabled: true,
          }));
        }
      });
      ws.on('message', (data) => this.handleOrderbookMessage(data.toString()));
      ws.on('close', () => {
        this.clobConnected = false;
        this.clob = undefined;
        if (this.clobTokenKey) {
          this.clobReconnect = setTimeout(() => this.connectClob(this.clobTokenKey.split('|').filter(Boolean)), 5_000);
          this.clobReconnect.unref?.();
        }
      });
      ws.on('error', (error) => {
        this.clobConnected = false;
        this.store.recordRuntimeLog({ level: 'warn', source: 'market-data', message: `CLOB websocket error: ${error.message}` });
      });
    } catch (error) {
      this.store.recordRuntimeLog({ level: 'warn', source: 'market-data', message: `CLOB websocket failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private closeClob(): void {
    if (this.clobReconnect) {
      clearTimeout(this.clobReconnect);
      this.clobReconnect = undefined;
    }
    if (this.clob) {
      try {
        this.clob.close();
      } catch {
        // Ignore close errors; the next sync will establish the target subscription.
      }
      this.clob = undefined;
    }
    this.clobConnected = false;
  }

  private handleBinancePriceMessage(data: unknown): void {
    try {
      const parsed = JSON.parse(String(data));
      const streamPayload = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
      const symbol = String(streamPayload?.s || streamPayload?.symbol || '').toLowerCase();
      if (symbol && symbol !== 'btcusdt') return;
      const price = finiteNumber(streamPayload?.p ?? streamPayload?.c ?? streamPayload?.price);
      if (price != null) this.recordSampledBinancePrice(price);
    } catch {
      // Ignore malformed websocket frames; missing price samples block strategy entry.
    }
  }

  private recordSampledBinancePrice(price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const now = Date.now();
    if (now - this.lastBinanceSampleAt < this.config.binancePriceSampleMs) return;
    this.lastBinanceSampleAt = now;
    this.recordPrice(price, 'binance', new Date(now).toISOString());
  }

  private handleOrderbookMessage(data: unknown): void {
    try {
      const parsed = JSON.parse(String(data));
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      for (const message of messages) {
        const tokenId = String(message.asset_id || message.token_id || message.tokenId || '');
        if (tokenId && Array.isArray(message.bids) && Array.isArray(message.asks)) {
          this.orderbooks.set(tokenId, quoteFromBook(tokenId, message, 'ws'));
          continue;
        }
        if (tokenId && message.event_type === 'best_bid_ask') {
          this.upsertTopQuote(tokenId, message.best_bid, message.best_ask, message.spread);
          continue;
        }
        if (message.event_type === 'price_change' && Array.isArray(message.price_changes)) {
          for (const change of message.price_changes) {
            const changedTokenId = String(change.asset_id || '');
            if (changedTokenId) this.upsertTopQuote(changedTokenId, change.best_bid, change.best_ask);
          }
        }
      }
    } catch {
      // Ignore malformed websocket frames; stale or missing books block strategy entry.
    }
  }

  private upsertTopQuote(tokenId: string, bestBidRaw: unknown, bestAskRaw: unknown, spreadRaw?: unknown): void {
    const current = this.orderbooks.get(tokenId);
    const bestBid = finiteNumber(bestBidRaw);
    const bestAsk = finiteNumber(bestAskRaw);
    const spread = finiteNumber(spreadRaw) ?? (bestBid != null && bestAsk != null ? bestAsk - bestBid : null);
    this.orderbooks.set(tokenId, {
      tokenId,
      bestBid,
      bestAsk,
      midpoint: bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null,
      spread,
      bidDepth: current?.bidDepth ?? 0,
      askDepth: current?.askDepth ?? 0,
      imbalance: current?.imbalance ?? null,
      updatedAt: new Date().toISOString(),
      source: 'ws',
      bids: current?.bids,
      asks: current?.asks,
    });
  }

  private recordPrice(price: number, source: PriceTick['source'], receivedAt = new Date().toISOString()): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const cutoff = Date.now() - 10 * 60_000;
    this.priceTicks.push({ price, source, receivedAt });
    while (this.priceTicks.length && new Date(this.priceTicks[0].receivedAt).getTime() < cutoff) {
      this.priceTicks.shift();
    }
  }

}

function stddev(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function range(values: number[]): number {
  if (values.length < 2) return 0;
  return Math.max(...values) - Math.min(...values);
}

function bps(value: number, denominator: number): number {
  return denominator > 0 ? (value / denominator) * 10_000 : 0;
}

function rollingRangePercentile(ticks: PriceTick[], now: number, windowMs: number): number | null {
  const windows: number[] = [];
  const start = now - 10 * 60_000;
  for (let end = start + windowMs; end <= now; end += 30_000) {
    const prices = ticks
      .filter((tick) => {
        const time = new Date(tick.receivedAt).getTime();
        return time > end - windowMs && time <= end;
      })
      .map((tick) => tick.price);
    const value = range(prices);
    if (value > 0) windows.push(value);
  }
  if (windows.length < 3) return null;
  const current = windows.at(-1);
  if (current == null) return null;
  const belowOrEqual = windows.filter((value) => value <= current).length;
  return belowOrEqual / windows.length;
}

export function scoreChop(input: {
  cross120s: number;
  rangeBps120s: number;
  minBiExcursionBps120s: number;
  excursionBalance120s: number;
  driftRatio120s: number;
  momentumRatio30s: number;
  rangePercentile120s: number | null;
}): number {
  const crossScore = clamp(input.cross120s / 4) * 25;
  const rangeScore = clamp(input.rangeBps120s / 3) * 10;
  const twoSidedScore = clamp(input.minBiExcursionBps120s / 2) * 25;
  const balanceScore = clamp(input.excursionBalance120s) * 15;
  const driftScore = clamp(1 - input.driftRatio120s / 0.7) * 15;
  const momentumScore = clamp(1 - input.momentumRatio30s / 0.8) * 10;
  return Math.round((crossScore + rangeScore + twoSidedScore + balanceScore + driftScore + momentumScore) * 10) / 10;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
