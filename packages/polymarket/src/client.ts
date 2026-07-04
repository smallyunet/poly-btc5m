import { Wallet } from '@ethersproject/wallet';
import type { FillRecord, MarketAsset, MarketInterval, MarketProfileId, OrderBookLevel, OrderBookQuote, OrderRecord, PositionSnapshot, TradeIntent } from '../../shared/src';

const POLYMARKET_DATA_API_URL = 'https://data-api.polymarket.com';

export type PolymarketClientConfig = {
  clobApiUrl: string;
  dataApiUrl?: string;
  chainId: number;
  ownerPrivateKey?: string;
  depositWallet?: string;
};

export type LimitOrderResult = {
  ok: boolean;
  orderId?: string;
  price: number;
  size: number;
  raw?: unknown;
  error?: string;
};

export type OpenOrderSummary = {
  id: string;
  tokenId: string;
  side: string;
  price: number | null;
  size: number | null;
  sizeMatched: number | null;
  status: string;
  raw: unknown;
};

export type CollateralBalanceAllowance = {
  balance: number;
  allowance: number | null;
};

export type FillTarget = Pick<OrderRecord, 'profileId' | 'asset' | 'interval' | 'roundId' | 'eventSlug' | 'marketTitle' | 'imageUrl' | 'tokenId' | 'label' | 'clobOrderId'>;

type ClobModule = {
  ClobClient: new (params: Record<string, unknown>) => any;
  Side: { BUY: unknown; SELL: unknown };
  OrderType: { GTC: unknown; GTD: unknown; FAK: unknown };
  AssetType: { COLLATERAL: unknown; CONDITIONAL: unknown };
};

async function importClobClient(): Promise<ClobModule> {
  return import('@polymarket/clob-client-v2') as unknown as ClobModule;
}

export class PolymarketAdapter {
  constructor(private readonly config: PolymarketClientConfig) {}

  async executeLimitIntent(intent: TradeIntent, options: { execute: boolean; orderType?: 'GTC' | 'GTD' | 'FAK'; expiration?: number }): Promise<LimitOrderResult> {
    if (!options.execute) {
      return { ok: true, price: intent.limitPrice, size: roundDownShares(intent.shares), raw: { dryRun: true, intent } };
    }
    if (!this.config.ownerPrivateKey?.trim()) throw new Error('OWNER_PRIVATE_KEY is required for execution.');
    if (!this.config.depositWallet?.trim()) throw new Error('POLYMARKET_DEPOSIT_WALLET is required for execution.');

    const { OrderType, Side } = await importClobClient();
    const client = await this.authenticatedClient();
    const [tickSize, negRisk] = await Promise.all([client.getTickSize(intent.tokenId), client.getNegRisk(intent.tokenId)]);
    const size = roundDownShares(intent.shares);
    const signedOrder = await client.createOrder(
      {
        tokenID: intent.tokenId,
        price: intent.limitPrice,
        side: intent.side === 'BUY' ? Side.BUY : Side.SELL,
        size,
        ...(options.orderType === 'GTD' && options.expiration ? { expiration: options.expiration } : {}),
      },
      { tickSize, negRisk },
    );
    const posted = await client.postOrder(signedOrder, clobOrderType(OrderType, options.orderType));
    const error = orderError(posted);
    return {
      ok: !error,
      orderId: typeof posted?.orderID === 'string' ? posted.orderID : typeof posted?.orderId === 'string' ? posted.orderId : undefined,
      price: intent.limitPrice,
      size,
      raw: posted,
      error,
    };
  }

  async getOpenOrders(params: { tokenId?: string } = {}): Promise<OpenOrderSummary[]> {
    const client = await this.authenticatedClient();
    const orders = await client.getOpenOrders(params.tokenId ? { asset_id: params.tokenId } : undefined, true);
    if (!Array.isArray(orders)) return [];
    return orders.map((order: any) => ({
      id: String(order.id || order.orderID || order.orderId || order.order_id || ''),
      tokenId: String(order.asset_id || order.token_id || order.tokenID || order.tokenId || ''),
      side: String(order.side || '').toUpperCase(),
      price: finiteNumber(order.price),
      size: finiteNumber(order.original_size ?? order.size),
      sizeMatched: finiteNumber(order.size_matched ?? order.matched_size ?? order.sizeMatched),
      status: String(order.status || ''),
      raw: order,
    }));
  }

  async cancelOrders(orderIds: string[]): Promise<unknown> {
    const ids = orderIds.map((id) => id.trim()).filter(Boolean);
    if (!ids.length) return { cancelled: [] };
    const client = await this.authenticatedClient();
    return client.cancelOrders(ids);
  }

  async getAvailableShares(tokenId: string): Promise<number> {
    if (!tokenId.trim()) throw new Error('tokenId is required for balance reads.');
    const { AssetType } = await importClobClient();
    const client = await this.authenticatedClient();
    const response = await client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    return Number(readBalanceRaw(response)) / 1_000_000;
  }

  async getCollateralBalanceAllowance(): Promise<CollateralBalanceAllowance> {
    const { AssetType } = await importClobClient();
    const client = await this.authenticatedClient();
    const response = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    return {
      balance: Number(readBalanceRaw(response)) / 1_000_000,
      allowance: readMinAllowance(response),
    };
  }

  async getRecentFills(params: { profileId: MarketProfileId; asset: MarketAsset; interval: MarketInterval; roundId: string; eventSlug: string; tokenLabels: Map<string, 'YES' | 'NO'>; tokenId?: string; marketTitle?: string; imageUrl?: string }): Promise<FillRecord[]> {
    const client = await this.authenticatedClient();
    const trades = await client.getTrades(params.tokenId ? { asset_id: params.tokenId } : undefined, true);
    if (!Array.isArray(trades)) return [];
    const makerAddress = this.config.depositWallet?.trim().toLowerCase();
    return trades.flatMap((trade: any): FillRecord[] => {
      if (String(trade.trader_side || '').toUpperCase() === 'MAKER' && Array.isArray(trade.maker_orders)) {
        return trade.maker_orders
          .map((makerOrder: any, index: number): FillRecord | null => {
            if (makerAddress && String(makerOrder.maker_address || '').toLowerCase() !== makerAddress) return null;
            const tokenId = String(makerOrder.asset_id || makerOrder.token_id || '');
            const label = params.tokenLabels.get(tokenId);
            const price = finiteNumber(makerOrder.price);
            const size = finiteNumber(makerOrder.matched_amount ?? makerOrder.size);
            if (!label || price == null || size == null || size <= 0) return null;
            const clobOrderId = typeof makerOrder.order_id === 'string' ? makerOrder.order_id : undefined;
            return {
              id: String(`${trade.id || trade.transaction_hash || trade.match_time || Date.now()}:${clobOrderId || index}:${size}`),
              profileId: params.profileId,
              asset: params.asset,
              interval: params.interval,
              roundId: params.roundId,
              eventSlug: params.eventSlug,
              marketTitle: params.marketTitle,
              imageUrl: params.imageUrl,
              clobOrderId,
              tokenId,
              label,
              side: String(makerOrder.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
              price,
              size,
              matchedAt: typeof trade.match_time === 'string' ? trade.match_time : new Date().toISOString(),
              raw: { trade, makerOrder },
            };
          })
          .filter((item: FillRecord | null): item is FillRecord => Boolean(item));
      }

      const tokenId = String(trade.asset_id || trade.token_id || '');
      const label = params.tokenLabels.get(tokenId);
      const price = finiteNumber(trade.price);
      const size = finiteNumber(trade.size);
      if (!label || price == null || size == null || size <= 0) return [];
      return [{
          id: String(trade.id || `${tokenId}-${trade.match_time || Date.now()}`),
          profileId: params.profileId,
          asset: params.asset,
          interval: params.interval,
          roundId: params.roundId,
          eventSlug: params.eventSlug,
          marketTitle: params.marketTitle,
          imageUrl: params.imageUrl,
          clobOrderId: typeof trade.order_id === 'string' ? trade.order_id : undefined,
          tokenId,
          label,
          side: String(trade.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
          price,
          size,
          matchedAt: typeof trade.match_time === 'string' ? trade.match_time : new Date().toISOString(),
          raw: trade,
      }];
    });
  }

  async getRecentFillsForTargets(targets: FillTarget[]): Promise<FillRecord[]> {
    const uniqueTargets = dedupeTargets(targets);
    if (!uniqueTargets.length) return [];
    const client = await this.authenticatedClient();
    const trades = await client.getTrades(undefined, true);
    if (!Array.isArray(trades)) return [];

    const targetByOrderId = new Map(uniqueTargets.map((target) => [target.clobOrderId, target]).filter((entry): entry is [string, FillTarget] => Boolean(entry[0])));
    const targetByTokenId = new Map(uniqueTargets.map((target) => [target.tokenId, target]));
    const makerAddress = this.config.depositWallet?.trim().toLowerCase();

    return trades.flatMap((trade: any): FillRecord[] => {
      if (String(trade.trader_side || '').toUpperCase() === 'MAKER' && Array.isArray(trade.maker_orders)) {
        return trade.maker_orders
          .map((makerOrder: any, index: number): FillRecord | null => {
            if (makerAddress && String(makerOrder.maker_address || '').toLowerCase() !== makerAddress) return null;
            const tokenId = String(makerOrder.asset_id || makerOrder.token_id || '');
            const clobOrderId = typeof makerOrder.order_id === 'string' ? makerOrder.order_id : undefined;
            const target = (clobOrderId && targetByOrderId.get(clobOrderId)) || targetByTokenId.get(tokenId);
            if (!target) return null;
            const price = finiteNumber(makerOrder.price);
            const size = finiteNumber(makerOrder.matched_amount ?? makerOrder.size);
            if (price == null || size == null || size <= 0) return null;
            return {
              id: String(`${trade.id || trade.transaction_hash || trade.match_time || Date.now()}:${clobOrderId || index}:${size}`),
              profileId: target.profileId,
              asset: target.asset,
              interval: target.interval,
              roundId: target.roundId,
              eventSlug: target.eventSlug,
              marketTitle: target.marketTitle,
              imageUrl: target.imageUrl,
              clobOrderId,
              tokenId,
              label: target.label,
              side: String(makerOrder.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
              price,
              size,
              matchedAt: typeof trade.match_time === 'string' ? trade.match_time : new Date().toISOString(),
              raw: { trade, makerOrder },
            };
          })
          .filter((item: FillRecord | null): item is FillRecord => Boolean(item));
      }

      const tokenId = String(trade.asset_id || trade.token_id || '');
      const clobOrderId = typeof trade.order_id === 'string' ? trade.order_id : undefined;
      const target = (clobOrderId && targetByOrderId.get(clobOrderId)) || targetByTokenId.get(tokenId);
      if (!target) return [];
      const price = finiteNumber(trade.price);
      const size = finiteNumber(trade.size);
      if (price == null || size == null || size <= 0) return [];
      return [{
          id: String(trade.id || `${tokenId}-${trade.match_time || Date.now()}`),
          profileId: target.profileId,
          asset: target.asset,
          interval: target.interval,
          roundId: target.roundId,
          eventSlug: target.eventSlug,
          marketTitle: target.marketTitle,
          imageUrl: target.imageUrl,
          clobOrderId,
          tokenId,
          label: target.label,
          side: String(trade.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
          price,
          size,
          matchedAt: typeof trade.match_time === 'string' ? trade.match_time : new Date().toISOString(),
          raw: trade,
      }];
    });
  }

  async getPortfolioPositions(tokenLabels: Map<string, 'YES' | 'NO'> = new Map()): Promise<PositionSnapshot[]> {
    const address = this.config.depositWallet?.trim();
    if (!address) throw new Error('POLYMARKET_DEPOSIT_WALLET is required for position reads.');

    const dataApiUrl = this.config.dataApiUrl?.trim() || POLYMARKET_DATA_API_URL;
    const url = new URL('/positions', dataApiUrl);
    url.searchParams.set('user', address);
    url.searchParams.set('sizeThreshold', '0');
    url.searchParams.set('limit', '500');
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'poly-btc5m/0.1.0' } });
    if (!response.ok) throw new Error(`Polymarket Data API positions returned ${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page)) return [];
    return page
      .map((position: any): PositionSnapshot | null => {
        const tokenId = String(position.asset || position.tokenId || position.token_id || '');
        const label = tokenLabels.get(tokenId) || 'UNKNOWN';
        const shares = finiteNumber(position.size ?? position.balance);
        if (!tokenId || shares == null || shares <= 0) return null;
        return {
          tokenId,
          label,
          title: typeof position.title === 'string' ? position.title : typeof position.market === 'string' ? position.market : undefined,
          shares: roundShares(shares),
          avgPrice: finiteNumber(position.avgPrice ?? position.avg_price) ?? 0,
          currentPrice: finiteNumber(position.curPrice ?? position.currentPrice ?? position.price) ?? undefined,
          currentValue: finiteNumber(position.currentValue ?? position.current_value ?? position.value) ?? undefined,
          cashPnl: finiteNumber(position.cashPnl ?? position.cash_pnl ?? position.pnl) ?? undefined,
          percentPnl: finiteNumber(position.percentPnl ?? position.percent_pnl ?? position.percentPnlOpen ?? position.percent_pnl_open) ?? undefined,
          openedAt: typeof position.createdAt === 'string' ? position.createdAt : undefined,
          lastTradeAt: typeof position.lastTradeAt === 'string' ? position.lastTradeAt : undefined,
        };
      })
      .filter((item): item is PositionSnapshot => Boolean(item));
  }

  async getCurrentPositions(tokenLabels: Map<string, 'YES' | 'NO'>): Promise<PositionSnapshot[]> {
    return (await this.getPortfolioPositions(tokenLabels)).filter((position) => position.label !== 'UNKNOWN');
  }

  private async authenticatedClient(): Promise<any> {
    const ownerPrivateKey = this.config.ownerPrivateKey?.trim();
    const depositWallet = this.config.depositWallet?.trim();
    if (!ownerPrivateKey) throw new Error('OWNER_PRIVATE_KEY is required for authenticated CLOB calls.');
    if (!depositWallet) throw new Error('POLYMARKET_DEPOSIT_WALLET is required for authenticated CLOB calls.');

    const { ClobClient } = await importClobClient();
    const signer = new Wallet(ownerPrivateKey);
    const signerClient = new ClobClient({
      host: this.config.clobApiUrl,
      chain: this.config.chainId,
      signer,
      signatureType: 3,
      funderAddress: depositWallet,
      useServerTime: true,
    });
    const apiCreds = await this.resolveApiCreds(signerClient);
    return new ClobClient({
      host: this.config.clobApiUrl,
      chain: this.config.chainId,
      signer,
      creds: apiCreds,
      signatureType: 3,
      funderAddress: depositWallet,
      useServerTime: true,
    });
  }

  private async resolveApiCreds(client: any): Promise<unknown> {
    const resolved = await client.createOrDeriveApiKey?.().catch(() => undefined);
    if (resolved?.key && resolved?.secret && resolved?.passphrase) return resolved;
    const derived = await client.deriveApiKey?.().catch(() => undefined);
    if (derived?.key && derived?.secret && derived?.passphrase) return derived;
    throw new Error('Failed to resolve Polymarket CLOB API credentials.');
  }

}

function clobOrderType(OrderType: ClobModule['OrderType'], orderType: 'GTC' | 'GTD' | 'FAK' = 'GTC'): unknown {
  if (orderType === 'FAK') return OrderType.FAK;
  if (orderType === 'GTD') return OrderType.GTD;
  return OrderType.GTC;
}

export function quoteFromBook(tokenId: string, book: any, source: 'ws'): OrderBookQuote {
  const bids = normalizeLevels(book?.bids).sort((a, b) => b.price - a.price);
  const asks = normalizeLevels(book?.asks).sort((a, b) => a.price - b.price);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const bidDepth = depthAtTop(bids);
  const askDepth = depthAtTop(asks);
  const totalDepth = bidDepth + askDepth;
  return {
    tokenId,
    bestBid,
    bestAsk,
    midpoint: bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null,
    spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null,
    bidDepth,
    askDepth,
    imbalance: totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : null,
    updatedAt: new Date().toISOString(),
    source,
    bids,
    asks,
  };
}

function normalizeLevels(levels: unknown): OrderBookLevel[] {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((level: any) => ({ price: finiteNumber(level.price), size: finiteNumber(level.size) }))
    .filter((level): level is OrderBookLevel => level.price != null && level.size != null && level.price > 0 && level.size > 0);
}

function depthAtTop(levels: OrderBookLevel[]): number {
  return levels.slice(0, 3).reduce((sum, level) => sum + level.size, 0);
}

function roundDownShares(value: number): number {
  return Math.floor(value * 100) / 100;
}

function roundShares(value: number): number {
  return Math.floor(value * 100) / 100;
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dedupeTargets(targets: FillTarget[]): FillTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = target.clobOrderId || `${target.roundId}:${target.tokenId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(target.tokenId);
  });
}

function orderError(posted: any): string | undefined {
  if (typeof posted?.error === 'string' && posted.error.trim()) return posted.error;
  if (typeof posted?.errorMsg === 'string' && posted.errorMsg.trim()) return posted.errorMsg;
  if (posted?.success === false) return 'CLOB rejected order.';
  return undefined;
}

function readBalanceRaw(response: any): string {
  return String(response?.balance || response?.balances?.[0]?.balance || response?.available || '0');
}

function readMinAllowance(response: any): number | null {
  const allowances = response?.allowances;
  if (!allowances || typeof allowances !== 'object') return null;
  const values = Object.values(allowances)
    .map((value) => Number(value) / 1_000_000)
    .filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return Math.min(...values);
}
