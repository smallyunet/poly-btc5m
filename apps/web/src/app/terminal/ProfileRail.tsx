import type { DashboardState } from '../../../../../packages/shared/src';
import { Badge } from '../../components/dashboard/Ui';
import {
  AssetLabel,
  formatCooldownRemaining,
  formatSignedMoney,
  strategyCheckLabel,
  strategyCheckTone,
} from '../dashboardHelpers';
import type { ProfileStatusRow } from './types';

type Props = {
  profileStatusRows: ProfileStatusRow[];
  selectedProfileId: string;
  feedLabel: string;
  feed: DashboardState['profiles'][number]['feed'];
  runtimeStatus: string;
  alertLogCount: number;
  signalLogCount: number;
  portfolioPnl: number;
  diagnostics: string[];
  onSelectProfile: (profileId: string) => void;
};

export function ProfileRail({
  profileStatusRows,
  selectedProfileId,
  feedLabel,
  feed,
  runtimeStatus,
  alertLogCount,
  signalLogCount,
  portfolioPnl,
  diagnostics,
  onSelectProfile,
}: Props) {
  return (
    <aside className="opsRail">
      <div className="panel opsPanel">
        <h2>Profiles</h2>
        <div className="opsProfileList">
          {profileStatusRows.map(({ item, entryCheck, tailEntryCheck, hedgeCheck, profitExitCheck, cooldownActive }) => (
            <button key={item.profile.id} type="button" className={`opsProfileRow ${selectedProfileId === item.profile.id ? 'active' : ''}`} onClick={() => onSelectProfile(item.profile.id)}>
              <div>
                <strong><AssetLabel profileId={item.profile.id} label={item.profile.label} size="sm" /></strong>
                <span>{item.latestSnapshot?.round.phase || 'pending'} · {item.profile.status}</span>
              </div>
              <div className="opsProfileBadges">
                <Badge tone={strategyCheckTone(entryCheck)}>entry {strategyCheckLabel(entryCheck)}</Badge>
                <Badge tone={strategyCheckTone(tailEntryCheck)}>tail {strategyCheckLabel(tailEntryCheck)}</Badge>
                <Badge tone={strategyCheckTone(profitExitCheck)}>exit {strategyCheckLabel(profitExitCheck)}</Badge>
                <Badge tone={strategyCheckTone(hedgeCheck)}>hedge {strategyCheckLabel(hedgeCheck)}</Badge>
                {cooldownActive && <Badge tone="warn">{formatCooldownRemaining(item.entryCooldownUntil)}</Badge>}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="panel opsPanel">
        <h2>System</h2>
        <div className="opsSystemList">
          <div><span>Feed</span><strong>{feedLabel}</strong></div>
          <div><span>Binance</span><strong>{feed.binanceConnected ? 'connected' : 'offline'}</strong></div>
          <div><span>Runtime</span><strong>{runtimeStatus}</strong></div>
          <div><span>Alerts</span><strong>{alertLogCount}</strong></div>
          <div><span>Signals</span><strong>{signalLogCount}</strong></div>
          <div><span>Portfolio PnL</span><strong>{formatSignedMoney(portfolioPnl)}</strong></div>
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
