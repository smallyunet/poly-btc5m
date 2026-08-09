import type { DashboardState } from '../../../../../packages/shared/src';
import { formatSignedMoney } from '../dashboardHelpers';

type Props = {
  feedLabel: string;
  feed: DashboardState['profiles'][number]['feed'];
  runtimeStatus: string;
  alertLogCount: number;
  signalLogCount: number;
  settledPnl: number;
  diagnostics: string[];
};

export function ProfileRail({
  feedLabel,
  feed,
  runtimeStatus,
  alertLogCount,
  signalLogCount,
  settledPnl,
  diagnostics,
}: Props) {
  return (
    <aside className="opsRail">
      <div className="panel opsPanel">
        <h2>System</h2>
        <div className="opsSystemList">
          <div><span>Feed</span><strong>{feedLabel}</strong></div>
          <div><span>Binance</span><strong>{feed.binanceConnected ? 'connected' : 'offline'}</strong></div>
          <div><span>Runtime</span><strong>{runtimeStatus}</strong></div>
          <div><span>Alerts</span><strong>{alertLogCount}</strong></div>
          <div><span>Signals</span><strong>{signalLogCount}</strong></div>
          <div><span>Settled PnL</span><strong>{formatSignedMoney(settledPnl)}</strong></div>
        </div>
      </div>

      {diagnostics.length > 0 && (
        <details className="panel opsPanel opsDiagnostics">
          <summary>
            <span>Diagnostics</span>
            <strong>{diagnostics.length}</strong>
          </summary>
          <div className="opsDiagnosticList">
            {diagnostics.map((diag, index) => (
              <span key={`${diag}-${index}`}>{diag}</span>
            ))}
          </div>
        </details>
      )}
    </aside>
  );
}
