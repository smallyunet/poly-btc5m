import WebSocket from 'ws';
import type { BtcFeatureSnapshot, BtcRoundConfig, DataFeedStatus, OrderBookQuote, PriceTick } from '../../../packages/shared/src';
import { quoteFromBook } from '../../../packages/polymarket/src';
import type { AppConfig } from './config';
import type { InMemoryStore } from './store';

export class MarketDataService {
  private readonly priceTicks: PriceTick[] = [];
  private readonly orderbooks = new Map<string, OrderBookQuote>();
  private rtds?: WebSocket;
  private clob?: WebSocket;
  private rtdsConnected = false;
  private clobConnected = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: InMemoryStore,
  ) {}

  start(round: BtcRoundConfig): void {
    this.connectRtds();
    this.connectClob(round);
  }

  refreshOrderbooks(round: BtcRoundConfig): OrderBookQuote[] {
    const tokenIds = [round.yesTokenId, round.noTokenId].filter(Boolean);
    return tokenIds.map((tokenId) => this.orderbooks.get(tokenId)).filter((item): item is OrderBookQuote => Boolean(item));
  }

  features(round: BtcRoundConfig): BtcFeatureSnapshot {
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
      source: this.rtdsConnected ? 'live' : 'unavailable',
    };
  }

  private connectRtds(): void {
    if (this.rtds) return;
    try {
      const ws = new WebSocket(this.config.rtdsWsUrl);
      this.rtds = ws;
      ws.on('open', () => {
        this.rtdsConnected = true;
        this.store.recordRuntimeLog({ level: 'info', source: 'market-data', message: 'RTDS websocket connected.' });
        ws.send(JSON.stringify({
          action: 'subscribe',
          subscriptions: [
            {
              topic: 'crypto_prices',
              type: 'update',
              filters: 'btcusdt',
            },
          ],
        }));
      });
      ws.on('message', (data) => this.handlePriceMessage(data.toString()));
      ws.on('close', () => {
        this.rtdsConnected = false;
        this.rtds = undefined;
        setTimeout(() => this.connectRtds(), 5_000).unref?.();
      });
      ws.on('error', (error) => {
        this.rtdsConnected = false;
        this.store.recordRuntimeLog({ level: 'warn', source: 'market-data', message: `RTDS websocket error: ${error.message}` });
      });
      const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING');
      }, 5_000);
      ws.on('close', () => clearInterval(ping));
    } catch (error) {
      this.store.recordRuntimeLog({ level: 'warn', source: 'market-data', message: `RTDS websocket failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private connectClob(round: BtcRoundConfig): void {
    if (this.clob) return;
    const tokenIds = [round.yesTokenId, round.noTokenId].filter(Boolean);
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
        setTimeout(() => this.connectClob(round), 5_000).unref?.();
      });
      ws.on('error', (error) => {
        this.clobConnected = false;
        this.store.recordRuntimeLog({ level: 'warn', source: 'market-data', message: `CLOB websocket error: ${error.message}` });
      });
    } catch (error) {
      this.store.recordRuntimeLog({ level: 'warn', source: 'market-data', message: `CLOB websocket failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private handlePriceMessage(data: unknown): void {
    try {
      const parsed = JSON.parse(String(data));
      const symbol = String(parsed?.payload?.symbol || parsed?.symbol || '').toLowerCase();
      if (symbol && symbol !== 'btcusdt' && symbol !== 'btc/usd') return;
      const price = findNumber(parsed, ['value']);
      if (price != null) this.recordPrice(price, 'rtds');
    } catch {
      // RTDS price frames are JSON. Ignore non-JSON frames such as server pongs.
    }
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

  private recordPrice(price: number, source: PriceTick['source']): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const cutoff = Date.now() - 10 * 60_000;
    this.priceTicks.push({ price, source, receivedAt: new Date().toISOString() });
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

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
