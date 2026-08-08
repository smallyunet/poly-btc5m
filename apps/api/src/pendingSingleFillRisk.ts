import type { InMemoryStore, PendingSingleFillRiskRecord } from './store';

export async function cancelFutureDualOrdersForPendingRisk(
  store: InMemoryStore,
  risk: PendingSingleFillRiskRecord,
): Promise<string[]> {
  const orders = store.futureOpenDualOrders(risk.profileId, risk.roundId);
  if (!orders.length) return [];
  store.markOrdersCancelled(orders.map((order) => order.id));
  store.recordRuntimeLog({
    level: 'warn',
    source: 'execution',
    message: `Paper risk blocked ${orders.length} future Dual order(s).`,
    details: {
      reason: 'PENDING_SINGLE_FILL_RISK',
      profileId: risk.profileId,
      sourceProfileId: risk.sourceProfileId,
      sourceRoundId: risk.roundId,
      orderIds: orders.map((order) => order.id),
    },
  });
  return [];
}
