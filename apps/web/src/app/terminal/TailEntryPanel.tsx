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
  selectedSummaryRowCondition?: StrategyCondition;
  selectedSideCondition?: StrategyCondition;
  summaryPnlCondition?: StrategyCondition;
  summaryEvCondition?: StrategyCondition;
  summaryMinVwapCondition?: StrategyCondition;
  vwapCondition?: StrategyCondition;
  vwapFloorCondition?: StrategyCondition;
  midpointGapCondition?: StrategyCondition;
  roundOrderLimitCondition?: StrategyCondition;
  currentRoundTailOrders: TailOrder[];
};

export function TailEntryPanel({
  tailEntryCheck,
  checkpointCondition,
  selectedSummaryRowCondition,
  selectedSideCondition,
  summaryPnlCondition,
  summaryEvCondition,
  summaryMinVwapCondition,
  vwapCondition,
  vwapFloorCondition,
  midpointGapCondition,
  roundOrderLimitCondition,
  currentRoundTailOrders,
}: Props) {
  const hasCurrentTailOrder = currentRoundTailOrders.length > 0;
  const latestCurrentOrder = currentRoundTailOrders[0];
  const failedCurrentOrders = currentRoundTailOrders.filter((order) => order.status === 'failed');
  const orderTone = failedCurrentOrders.length === currentRoundTailOrders.length && currentRoundTailOrders.length > 0 ? 'bad' : 'good';
  const primaryBlocker = tailEntryCheck?.blockers[0] || tailEntryCheck?.reason || 'waiting for strategy check';
  const decisionTone = hasCurrentTailOrder ? orderTone : tailEntryCheck?.status === 'eligible' ? 'good' : 'warn';
  const decisionLabel = hasCurrentTailOrder ? 'ORDER PLACED' : tailEntryCheck?.status === 'eligible' ? 'READY' : 'NO ORDER';
  const evaluatedRoundId = tailEntryCheck?.roundId;
  const decisionDetail = hasCurrentTailOrder && latestCurrentOrder
    ? `${outcomeLabel(latestCurrentOrder.label)} ${latestCurrentOrder.side} ${latestCurrentOrder.size.toFixed(2)} @ ${latestCurrentOrder.price.toFixed(3)} (${latestCurrentOrder.status})`
    : tailEntryCheck?.status === 'eligible'
      ? 'Tail entry gates are eligible; waiting for execution record.'
      : primaryBlocker;
  const checkpointActual = checkpointCondition?.actual || '-';

  return (
    <div className="panel opsPanel tailEntryPanel">
      <h2>
        BTC 5m Tail Entry
        <span className="panelSubTitle">{tailEntryCheck ? strategyCheckLabel(tailEntryCheck) : 'pending'}</span>
      </h2>

      <div className={`tailEntrySummary ${decisionTone}`}>
        <div>
          <span className="tailEntrySummaryKicker">Current tail decision</span>
          <strong>{decisionLabel}</strong>
          <p>{decisionDetail}</p>
        </div>
        <Badge tone={decisionTone}>{hasCurrentTailOrder ? `${currentRoundTailOrders.length} order${currentRoundTailOrders.length === 1 ? '' : 's'}` : tailEntryCheck?.status || 'pending'}</Badge>
      </div>

      <div className="tailEntryKeyGrid" aria-label="Tail entry key gates">
        <div>
          <span>When</span>
          <strong>{checkpointActual}</strong>
          <em>{checkpointCondition?.passed ? 'inside selected window' : 'waiting for selected window'}</em>
        </div>
        <div>
          <span>What side</span>
          <strong>{selectedSideCondition?.actual || '-'}</strong>
          <em>{midpointGapCondition?.actual || 'midpoint gap unavailable'}</em>
        </div>
        <div>
          <span>Live price</span>
          <strong>{vwapCondition?.actual || '-'}</strong>
          <em>{vwapFloorCondition?.actual || 'VWAP floor unavailable'}</em>
        </div>
        <div>
          <span>Simulation row</span>
          <strong>{selectedSummaryRowCondition?.actual || '-'}</strong>
          <em>{summaryPnlCondition?.actual || '12h PnL unavailable'}</em>
        </div>
      </div>

      <details className="compactDisclosure">
        <summary>
          <span>Technical details and current-round orders</span>
          <strong>{currentRoundTailOrders.length} orders · {tailEntryCheck?.blockers.length ?? 0} blockers</strong>
        </summary>
        <div className="compactDisclosureBody">
          <div className="tailEntryTechnicalGrid">
            <div><span>Status</span><strong>{tailEntryCheck?.status || 'pending'}</strong></div>
            <div><span>Tail round</span><strong>{evaluatedRoundId || '-'}</strong></div>
            <div><span>Checkpoint</span><strong>{checkpointActual}</strong></div>
            <div><span>Summary row</span><strong>{selectedSummaryRowCondition?.actual || '-'}</strong></div>
            <div><span>Selected side</span><strong>{selectedSideCondition?.actual || '-'}</strong></div>
            <div><span>Limit</span><strong>{tailEntryCheck?.limitPrice == null ? '-' : tailEntryCheck.limitPrice.toFixed(3)}</strong></div>
            <div><span>Amount</span><strong>{tailEntryCheck?.amountUsd == null ? '-' : formatMoney(tailEntryCheck.amountUsd)}</strong></div>
            <div><span>12h PnL gate</span><strong>{summaryPnlCondition?.actual || '-'}</strong></div>
            <div><span>Summary EV</span><strong>{summaryEvCondition?.actual || '-'}</strong></div>
            <div><span>Min price</span><strong>{summaryMinVwapCondition?.actual || '-'}</strong></div>
            <div><span>Live VWAP</span><strong>{vwapCondition?.actual || vwapFloorCondition?.actual || '-'}</strong></div>
            <div><span>Midpoint gap</span><strong>{midpointGapCondition?.actual || '-'}</strong></div>
            <div><span>Round limit</span><strong>{roundOrderLimitCondition?.actual || '-'}</strong></div>
            <div><span>Tail orders</span><strong>{currentRoundTailOrders.length}</strong></div>
          </div>

          <div className="tailEntryOrderBlock">
            <div className="tailEntryOrderHeader">
              <span>Current tail round orders</span>
              <strong>{currentRoundTailOrders.length ? `${currentRoundTailOrders.length} shown` : 'none'}</strong>
            </div>
            {currentRoundTailOrders.length > 0 ? (
              <div className="tailEntryOrders">
                {currentRoundTailOrders.map((order) => (
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
                <span>No Tail Entry order is recorded for this evaluated round. See Activity → Orders for older Tail attempts.</span>
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
      </details>
    </div>
  );
}
