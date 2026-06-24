import type { BtcFeatureSnapshot, BtcRoundConfig, DataFeedStatus, OrderBookQuote, PriceTick } from '../../../packages/shared/src';
import { quoteFromBook, type PolymarketAdapter } from '../../../packages/polymarket/src';
import type { AppConfig } from './config';
import type { InMemoryStore } from './store';

type WsLike = WebSocket & { readyState: number };

const OPEN = 1;

export class MarketDataService {
  private readonly priceTicks: PriceTick[] = [];
  private readonly orderbooks = new Map<string, OrderBookQuote>();
  private rtds?: WsLike;
  private clob?: WsLike;
  private rtdsConnected = false;
  private clobConnected = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: InMemoryStore,
    private readonly adapter: PolymarketAdapter,
  ) {}

  start(round: BtcRoundConfig): void {
    this.connectRtds();
    this.connectClob(round);
    if (this.config.staticBtcPrice != null) {
      this.recordPrice(this.config.staticBtcPrice, 'manual');
    }
  }

  async refreshOrderbooks(round: BtcRoundConfig): Promise<OrderBookQuote[]> {
    const tokenIds = [round.yesTokenId, round.noTokenId].filter(Boolean);
    for (const tokenId of tokenIds) {
      const current = this.orderbooks.get(tokenId);
      const ageMs = current ? Date.now() - new Date(current.updatedAt).getTime() : Number.POSITIVE_INFINITY;
      if (current && ageMs < this.config.maxOrderbookAgeSeconds * 1000) continue;
      try {
        this.orderbooks.set(tokenId, await this.adapter.getOrderBookQuote(tokenId));
      } catch (error) {
        this.store.recordRuntimeLog({
          level: 'warn',
          source: 'market-data',
          message: `Orderbook refresh failed for ${tokenId}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return tokenIds.map((tokenId) => this.orderbooks.get(tokenId)).filter((item): item is OrderBookQuote => Boolean(item));
  }

  features(round: BtcRoundConfig): BtcFeatureSnapshot {
    this.seedSimulatedPriceIfNeeded(round);
    const now = Date.now();
    const ticks = this.priceTicks.filter((tick) => now - new Date(tick.receivedAt).getTime() <= 120_000);
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
    const first = prices[0];
    const last = prices.at(-1);
    const volatility120s = prices.length > 1 ? stddev(prices) : 0;
    const drift120s = first != null && last != null ? last - first : 0;
    const thirtyAgo = ticks.find((tick) => now - new Date(tick.receivedAt).getTime() <= 30_000);
    const momentum30s = thirtyAgo && latest ? latest.price - thirtyAgo.price : 0;

    return {
      price: latest?.price ?? null,
      strike: round.strike,
      cross120s,
      crossFrequency: samples120s ? cross120s / Math.max(1, samples120s / 60) : 0,
      volatility120s,
      drift120s,
      momentum30s,
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
      rtdsConnected: this.rtdsConnected,
      clobConnected: this.clobConnected,
      lastPriceAt: latestPrice?.receivedAt,
      lastOrderbookAt: latestBook?.updatedAt,
      priceSamples: this.priceTicks.length,
      source: this.rtdsConnected || this.clobConnected ? 'live' : 'fallback',
    };
  }

  private connectRtds(): void {
    if (!this.config.rtdsWsUrl || this.rtds) return;
    if (typeof WebSocket === 'undefined') {
      this.store.recordRuntimeLog({ level: 'warn', source: 'market-data', message: 'Global WebSocket is unavailable; RTDS listener is disabled.' });
      return;
    }
    try {
      const ws = new WebSocket(this.config.rtdsWsUrl) as WsLike;
      this.rtds = ws;
      ws.addEventListener('open', () => {
        this.rtdsConnected = true;
        this.store.recordRuntimeLog({ level: 'info', source: 'market-data', message: 'RTDS websocket connected.' });
      });
      ws.addEventListener('message', (event) => this.handlePriceMessage(event.data));
      ws.addEventListener('close', () => {
        this.rtdsConnected = false;
        this.rtds = undefined;
        setTimeout(() => this.connectRtds(), 5_000).unref?.();
      });
      ws.addEventListener('error', () => {
        this.rtdsConnected = false;
      });
    } catch (error) {
      this.store.recordRuntimeLog({ level: 'warn', source: 'market-data', message: `RTDS websocket failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private connectClob(round: BtcRoundConfig): void {
    if (!this.config.clobWsUrl || this.clob) return;
    if (typeof WebSocket === 'undefined') return;
    const tokenIds = [round.yesTokenId, round.noTokenId].filter(Boolean);
    if (!tokenIds.length) return;
    try {
      const ws = new WebSocket(this.config.clobWsUrl) as WsLike;
      this.clob = ws;
      ws.addEventListener('open', () => {
        this.clobConnected = true;
        this.store.recordRuntimeLog({ level: 'info', source: 'market-data', message: 'CLOB websocket connected.' });
        if (ws.readyState === OPEN) {
          ws.send(JSON.stringify({ type: 'market', assets_ids: tokenIds }));
        }
      });
      ws.addEventListener('message', (event) => this.handleOrderbookMessage(event.data));
      ws.addEventListener('close', () => {
        this.clobConnected = false;
        this.clob = undefined;
        setTimeout(() => this.connectClob(round), 5_000).unref?.();
      });
      ws.addEventListener('error', () => {
        this.clobConnected = false;
      });
    } catch (error) {
      this.store.recordRuntimeLog({ level: 'warn', source: 'market-data', message: `CLOB websocket failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private handlePriceMessage(data: unknown): void {
    try {
      const parsed = JSON.parse(String(data));
      const price = findNumber(parsed, ['price', 'mid', 'midpoint', 'btc', 'value']);
      if (price != null) this.recordPrice(price, 'rtds');
    } catch {
      const price = Number(data);
      if (Number.isFinite(price)) this.recordPrice(price, 'rtds');
    }
  }

  private handleOrderbookMessage(data: unknown): void {
    try {
      const parsed = JSON.parse(String(data));
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      for (const message of messages) {
        const tokenId = String(message.asset_id || message.token_id || message.tokenId || '');
        if (!tokenId) continue;
        this.orderbooks.set(tokenId, quoteFromBook(tokenId, message, 'ws'));
      }
    } catch {
      // Ignore malformed websocket frames; the REST refresh path remains authoritative.
    }
  }

  private recordPrice(price: number, source: PriceTick['source']): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const cutoff = Date.now() - 10 * 60_000;
    this.priceTicks.push({ price, source, receivedAt: new Date().toISOString() });
    while (this.priceTicks.length && new Date(this.priceTicks[0].receivedAt).getTime() < cutoff) {
      this.priceTicks.shift();
    }
  }

  private seedSimulatedPriceIfNeeded(round: BtcRoundConfig): void {
    const latest = this.priceTicks.at(-1);
    if (latest && Date.now() - new Date(latest.receivedAt).getTime() < 4_000) return;
    const base = this.config.staticBtcPrice ?? round.strike;
    const t = Date.now() / 1000;
    const price = base + Math.sin(t / 7) * 18 + Math.sin(t / 17) * 9;
    this.recordPrice(price, 'simulated');
  }
}

function stddev(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function findNumber(value: any, keys: string[]): number | null {
  for (const key of keys) {
    const parsed = Number(value?.[key]);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === 'object') {
        const found = findNumber(nested, keys);
        if (found != null) return found;
      }
    }
  }
  return null;
}
