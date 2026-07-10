import type { PolymarketAdapter } from '../../../packages/polymarket/src';
import type { InMemoryStore, PendingSingleFillRiskRecord } from './store';

export async function cancelFutureDualOrdersForPendingRisk(
  store: InMemoryStore,
  adapter: PolymarketAdapter,
  risk: PendingSingleFillRiskRecord,
): Promise<string[]> {
  const orders = store.futureOpenDualOrders(risk.profileId, risk.roundId);
  const clobOrderIds = orders.map((order) => order.clobOrderId).filter((id): id is string => Boolean(id));
  if (!clobOrderIds.length) return [];
  try {
    if (store.getRuntime().executionMode === 'live') await adapter.cancelOrders(clobOrderIds);
    store.markOrdersCancelled(clobOrderIds);
    store.recordRuntimeLog({
      level: 'warn',
      source: 'execution',
      message: `Cancelled ${clobOrderIds.length} future Dual order(s) while single-fill risk is pending.`,
      details: {
        reason: 'PENDING_SINGLE_FILL_RISK',
        profileId: risk.profileId,
        sourceProfileId: risk.sourceProfileId,
        sourceRoundId: risk.roundId,
        clobOrderIds,
      },
    });
    return [];
  } catch (error) {
    return [`Future Dual cancellation failed for pending single-fill risk: ${error instanceof Error ? error.message : String(error)}`];
  }
}
