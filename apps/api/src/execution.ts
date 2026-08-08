import type { FillRecord, MarketProfileId, OrderBookQuote, OrderRecord, StateSnapshot, TradeIntent } from '../../../packages/shared/src';
import type { InMemoryStore } from './store';
import { isRoundEnded } from './store/helpers';

export type ExecutePaperIntentsParams = {
  store: InMemoryStore;
  snapshot: StateSnapshot;
  intents: TradeIntent[];
};

export function executePaperIntents(params: ExecutePaperIntentsParams): string[] {
  if (!params.intents.length) return [];
  const diagnostics: string[] = [];
  for (const intent of params.intents) {
    const executionKey = executionKeyFor(intent);
    if (params.store.hasNonFailedOrder(executionKey)) {
      params.store.updateIntent(intent.id, { status: 'rejected', rejectionReason: 'LOCAL_STRATEGY_ORDER_EXISTS' });
      diagnostics.push(`Paper execution blocked for ${intent.label}: LOCAL_STRATEGY_ORDER_EXISTS.`);
      continue;
    }
    const order = paperOrder(params.snapshot, intent, executionKey);
    params.store.recordOrder(order);
    params.store.updateIntent(intent.id, { status: 'executed' });
    const quote = params.snapshot.orderbooks.find((item) => item.tokenId === intent.tokenId);
    const fill = paperTouchFill(order, quote);
    if (fill) recordPaperFill(params.store, order, fill);
  }
  diagnostics.push(`Paper simulation recorded ${params.intents.length} GTC order intents.`);
  return diagnostics;
}

export function reconcilePaperOrders(params: { store: InMemoryStore; profileId: MarketProfileId; quotes: OrderBookQuote[]; nowMs?: number }): FillRecord[] {
  const nowMs = params.nowMs ?? Date.now();
  const quotes = new Map(params.quotes.map((quote) => [quote.tokenId, quote]));
  const fills: FillRecord[] = [];
  for (const order of params.store.ordersNeedingReconciliation(params.profileId, 1_000)) {
    if (paperOrderExpired(order, nowMs)) {
      params.store.recordOrder({ ...order, status: 'cancelled', updatedAt: new Date(nowMs).toISOString() });
      continue;
    }
    const fill = paperTouchFill(order, quotes.get(order.tokenId), nowMs);
    if (!fill) continue;
    recordPaperFill(params.store, order, fill);
    fills.push(fill);
  }
  return fills;
}

function recordPaperFill(store: InMemoryStore, order: OrderRecord, fill: FillRecord): void {
  store.recordFills([fill]);
  store.recordOrder({
    ...order,
    status: 'filled',
    filledSize: fill.size,
    avgFillPrice: fill.price,
    updatedAt: fill.matchedAt,
  });
}

function paperOrder(snapshot: StateSnapshot, intent: TradeIntent, executionKey: string): OrderRecord {
  return {
    id: `paper-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    profileId: intent.profileId,
    asset: intent.asset,
    interval: intent.interval,
    intentId: intent.id,
    strategy: intent.strategy,
    strategyProfile: intent.strategy === 'UPDOWN_NEXT_ROUND_50_49_STOP_ON_SINGLE' ? 'experiment_next_round' : 'classic',
    executionKey,
    roundId: intent.roundId,
    eventSlug: snapshot.round.eventSlug,
    marketTitle: snapshot.round.title,
    imageUrl: snapshot.round.imageUrl,
    tokenId: intent.tokenId,
    label: intent.label,
    side: intent.side,
    price: intent.limitPrice,
    size: roundDownShares(intent.shares),
    status: 'posted',
    createdAt: new Date().toISOString(),
    rawResponse: {
      paper: true,
      fillModel: 'best-ask-touch-full-fill-v1',
      submittedQuote: snapshot.orderbooks.find((quote) => quote.tokenId === intent.tokenId) || null,
    },
  };
}

function paperTouchFill(order: OrderRecord, quote: OrderBookQuote | undefined, nowMs = Date.now()): FillRecord | null {
  if (!quote || quote.source !== 'ws' || quote.bestAsk == null || quote.bestAsk > order.price) return null;
  const matchedAt = new Date(nowMs).toISOString();
  return {
    id: `paper-fill-${order.id}`,
    profileId: order.profileId,
    asset: order.asset,
    interval: order.interval,
    strategy: order.strategy,
    strategyProfile: order.strategyProfile,
    roundId: order.roundId,
    eventSlug: order.eventSlug,
    marketTitle: order.marketTitle,
    imageUrl: order.imageUrl,
    tokenId: order.tokenId,
    label: order.label,
    side: order.side,
    price: Math.min(order.price, quote.bestAsk),
    size: order.size,
    matchedAt,
    raw: { paper: true, fillModel: 'best-ask-touch-full-fill-v1', quote },
  };
}

function paperOrderExpired(order: OrderRecord, nowMs: number): boolean {
  const durationSeconds = order.interval === '1h' ? 3_600 : order.interval === '15m' ? 900 : 300;
  return isRoundEnded(order.roundId, nowMs, 0, durationSeconds);
}

function executionKeyFor(intent: TradeIntent): string {
  return [intent.profileId, intent.roundId, intent.strategy, intent.tokenId, intent.side].filter(Boolean).join(':');
}

function roundDownShares(shares: number): number {
  return Math.floor(shares * 100) / 100;
}
