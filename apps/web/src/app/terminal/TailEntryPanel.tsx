import type { StrategyCheck } from '../../../../../packages/shared/src';
import { formatMoney } from '../../lib/format';
import { blockerDetail, strategyCheckLabel } from '../dashboardHelpers';

type StrategyCondition = StrategyCheck['conditions'][number];

type Props = {
  tailEntryCheck?: StrategyCheck;
  checkpointCondition?: StrategyCondition;
  selectedSideCondition?: StrategyCondition;
  summaryEvCondition?: StrategyCondition;
  vwapCondition?: StrategyCondition;
  vwapCapCondition?: StrategyCondition;
  midpointGapCondition?: StrategyCondition;
  roundOrderLimitCondition?: StrategyCondition;
  currentRoundTailOrderCount: number;
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
  currentRoundTailOrderCount,
}: Props) {
  return (
    <div className="panel opsPanel">
      <h2>
        BTC 5m Tail Entry
        <span className="panelSubTitle">{tailEntryCheck ? strategyCheckLabel(tailEntryCheck) : 'pending'}</span>
      </h2>
      <div className="opsSystemList">
        <div><span>Status</span><strong>{tailEntryCheck?.status || 'pending'}</strong></div>
        <div><span>Checkpoint</span><strong>{checkpointCondition?.actual || '-'}</strong></div>
        <div><span>Selected side</span><strong>{selectedSideCondition?.actual || '-'}</strong></div>
        <div><span>Limit</span><strong>{tailEntryCheck?.limitPrice == null ? '-' : tailEntryCheck.limitPrice.toFixed(3)}</strong></div>
        <div><span>Amount</span><strong>{tailEntryCheck?.amountUsd == null ? '-' : formatMoney(tailEntryCheck.amountUsd)}</strong></div>
        <div><span>Summary EV</span><strong>{summaryEvCondition?.actual || '-'}</strong></div>
        <div><span>Live VWAP</span><strong>{vwapCondition?.actual || vwapCapCondition?.actual || '-'}</strong></div>
        <div><span>Midpoint gap</span><strong>{midpointGapCondition?.actual || '-'}</strong></div>
        <div><span>Round limit</span><strong>{roundOrderLimitCondition?.actual || '-'}</strong></div>
        <div><span>Tail orders</span><strong>{currentRoundTailOrderCount}</strong></div>
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
