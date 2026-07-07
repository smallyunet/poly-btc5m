import type { DashboardState, StrategyCheck } from '../../../../../packages/shared/src';
import { formatEtTime, outcomeLabel, outcomeTone, shortenTokenId } from '../../lib/dashboardFormat';
import { formatMoney } from '../../lib/format';
import { Badge } from '../../components/dashboard/Ui';
import { orderFailureReason, orderMarketTitle, strategyCheckLabel } from '../dashboardHelpers';

type StrategyCondition = StrategyCheck['conditions'][number];
type TailOrder = DashboardState['orders'][number];

type Props = {
  tailEntryCheck?: StrategyCheck;
  checkpointCondition?: StrategyCondition;
  selectedSideCondition?: StrategyCondition;
  summaryEvCondition?: StrategyCondition;
  vwapCondition?: StrategyCondition;
  vwapCapCondition?: StrategyCondition;
  midpointGapCondition?: StrategyCondition;
  roundOrderLimitCondition?: StrategyCondition;
  currentRoundTailOrders: TailOrder[];
  recentTailOrders: TailOrder[];
  secondsToStart: number;
};

export function TailEntryPanel({
  tailEntryCheck,
  checkpointCondition,
  selectedSideCondition,
  summaryEvCondition,
  vwapCondition,
  vwapCapCondition,
  midpointGapCondition,
  roundOrderLimitCondition,
  currentRoundTailOrders,
  recentTailOrders,
  secondsToStart,
}: Props) {
  const hasCurrentTailOrder = currentRoundTailOrders.length > 0;
  const latestCurrentOrder = currentRoundTailOrders[0];
  const failedCurrentOrders = currentRoundTailOrders.filter((order) => order.status === 'failed');
  const orderTone = failedCurrentOrders.length === currentRoundTailOrders.length && currentRoundTailOrders.length > 0 ? 'bad' : 'good';
  const primaryBlocker = tailEntryCheck?.blockers[0] || tailEntryCheck?.reason || 'waiting for strategy check';
  const decisionTone = hasCurrentTailOrder ? orderTone : tailEntryCheck?.status === 'eligible' ? 'good' : 'warn';
  const decisionLabel = hasCurrentTailOrder ? 'ORDER PLACED' : tailEntryCheck?.status === 'eligible' ? 'READY' : 'NO ORDER';
  const decisionDetail = hasCurrentTailOrder && latestCurrentOrder
    ? `${outcomeLabel(latestCurrentOrder.label)} ${latestCurrentOrder.side} ${latestCurrentOrder.size.toFixed(2)} @ ${latestCurrentOrder.price.toFixed(3)} (${latestCurrentOrder.status})`
    : tailEntryCheck?.status === 'eligible'
      ? 'Tail entry gates are eligible; waiting for execution record.'
      : primaryBlocker;
  const checkpointActual = secondsToStart > 0
    ? `${secondsToStart.toFixed(1)}s to start`
    : checkpointCondition?.actual || '-';
  const visibleOrders = currentRoundTailOrders.length > 0 ? currentRoundTailOrders : recentTailOrders.slice(0, 3);

  return (
    <div className="panel opsPanel">
      <h2>
        BTC 5m Tail Entry
        <span className="panelSubTitle">{tailEntryCheck ? strategyCheckLabel(tailEntryCheck) : 'pending'}</span>
      </h2>

      <div className={`tailEntrySummary ${decisionTone}`}>
        <div>
          <span className="tailEntrySummaryKicker">Current round order state</span>
          <strong>{decisionLabel}</strong>
          <p>{decisionDetail}</p>
        </div>
        <Badge tone={decisionTone}>{hasCurrentTailOrder ? `${currentRoundTailOrders.length} order${currentRoundTailOrders.length === 1 ? '' : 's'}` : tailEntryCheck?.status || 'pending'}</Badge>
      </div>

      <div className="opsSystemList">
        <div><span>Status</span><strong>{tailEntryCheck?.status || 'pending'}</strong></div>
        <div><span>Checkpoint</span><strong>{checkpointActual}</strong></div>
        <div><span>Selected side</span><strong>{selectedSideCondition?.actual || '-'}</strong></div>
        <div><span>Limit</span><strong>{tailEntryCheck?.limitPrice == null ? '-' : tailEntryCheck.limitPrice.toFixed(3)}</strong></div>
        <div><span>Amount</span><strong>{tailEntryCheck?.amountUsd == null ? '-' : formatMoney(tailEntryCheck.amountUsd)}</strong></div>
        <div><span>Summary EV</span><strong>{summaryEvCondition?.actual || '-'}</strong></div>
        <div><span>Live VWAP</span><strong>{vwapCondition?.actual || vwapCapCondition?.actual || '-'}</strong></div>
        <div><span>Midpoint gap</span><strong>{midpointGapCondition?.actual || '-'}</strong></div>
        <div><span>Round limit</span><strong>{roundOrderLimitCondition?.actual || '-'}</strong></div>
        <div><span>Tail orders</span><strong>{currentRoundTailOrders.length}</strong></div>
      </div>

      <div className="tailEntryOrderBlock">
        <div className="tailEntryOrderHeader">
          <span>{currentRoundTailOrders.length > 0 ? 'Current round order records' : 'Latest tail order records'}</span>
          <strong>{visibleOrders.length ? `${visibleOrders.length} shown` : 'none'}</strong>
        </div>
        {visibleOrders.length > 0 ? (
          <div className="tailEntryOrders">
            {visibleOrders.map((order) => (
              <div key={order.id} className="tailEntryOrderRow">
                <div>
                  <Badge tone={order.status === 'failed' ? 'bad' : order.status === 'filled' ? 'good' : order.status === 'posted' ? 'warn' : 'neutral'}>{order.status}</Badge>
                  <Badge tone={outcomeTone(order.label)}>{outcomeLabel(order.label)}</Badge>
                </div>
                <strong>{order.side} {order.size.toFixed(2)} @ {order.price.toFixed(3)}</strong>
                <span>{formatEtTime(order.createdAt)} · {shortenTokenId(order.clobOrderId || order.id)}</span>
                <em title={orderMarketTitle(order)}>{orderFailureReason(order)}</em>
              </div>
            ))}
          </div>
        ) : (
          <div className="tailEntryNoOrder">
            <strong>{primaryBlocker}</strong>
            <span>No BTC 5m tail order is recorded for the current round.</span>
          </div>
        )}
      </div>

      {tailEntryCheck?.blockers.length ? (
        <div className="portfolioDiagnostics">
          {tailEntryCheck.blockers.slice(0, 6).map((blocker) => (
            <span key={blocker}>{blocker}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
