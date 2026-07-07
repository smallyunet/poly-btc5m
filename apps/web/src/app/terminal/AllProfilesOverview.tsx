import type { DashboardState } from '../../../../../packages/shared/src';
import { DecisionMetric, Badge } from '../../components/dashboard/Ui';
import {
  AssetLabel,
  assetSelectorScoreLabel,
  assetRouteLabel,
  formatCooldownRemaining,
  formatEv,
  formatPriceCents,
  formatSignedMoney,
  strategyCheckLabel,
} from '../dashboardHelpers';
import type { ProfileStatusRow } from './types';

type Props = {
  state: DashboardState;
  enabledProfileCount: number;
  liveProfileCount: number;
  executionLabel: string;
  orderCount: number;
  fillCount: number;
  settlementCount: number;
  displayedPositionCount: number;
  portfolioPnl: number;
  profileStatusRows: ProfileStatusRow[];
  onSelectProfile: (profileId: string) => void;
};

export function AllProfilesOverview({
  state,
  enabledProfileCount,
  liveProfileCount,
  executionLabel,
  orderCount,
  fillCount,
  settlementCount,
  displayedPositionCount,
  portfolioPnl,
  profileStatusRows,
  onSelectProfile,
}: Props) {
  return (
    <div className="scopeWorkspace">
      <section className="panel scopePanel">
        <div className="sectionHeader">
          <div>
            <span className="sectionKicker">All Profiles</span>
            <h2>Runtime Overview</h2>
          </div>
          <Badge tone={state.runtime.executionMode === 'live' ? 'warn' : 'neutral'}>{executionLabel}</Badge>
        </div>
        <div className="scopeMetricGrid">
          <DecisionMetric label="Enabled" value={`${enabledProfileCount}/${state.profiles.length}`} detail={`${liveProfileCount} live profiles`} tone={liveProfileCount > 0 ? 'warn' : 'neutral'} />
          <DecisionMetric label="Orders" value={String(orderCount)} detail={`${fillCount} fills / ${settlementCount} settlements`} tone={orderCount > 0 ? 'good' : 'neutral'} />
          <DecisionMetric label="Open Positions" value={String(displayedPositionCount)} detail="latest profile snapshots" tone={displayedPositionCount > 0 ? 'warn' : 'neutral'} />
          <DecisionMetric label="Settled PnL" value={formatSignedMoney(portfolioPnl)} detail="filtered settlements" tone={portfolioPnl > 0 ? 'good' : portfolioPnl < 0 ? 'bad' : 'neutral'} />
        </div>
      </section>

      <section className="profileGridPanel" aria-label="Profile runtime matrix">
        {profileStatusRows.map(({ item, entryCheck, tailEntryCheck, hedgeCheck, profitExitCheck, cooldownActive }) => (
          <button key={item.profile.id} type="button" className="profileRuntimeCard" onClick={() => onSelectProfile(item.profile.id)}>
            <div className="profileRuntimeHeader">
              <div>
                <strong><AssetLabel profileId={item.profile.id} label={item.profile.label} size="sm" /></strong>
                <span>{item.profile.status} · {item.latestSnapshot?.round.phase || 'pending'}</span>
              </div>
              <Badge tone={item.profile.status === 'live' ? 'warn' : item.profile.status === 'monitor' ? 'neutral' : 'bad'}>{item.profile.status}</Badge>
            </div>
            <div className="profileRuntimeStats">
              <div><span>Entry</span><strong>{strategyCheckLabel(entryCheck)}</strong></div>
              <div><span>Tail</span><strong>{strategyCheckLabel(tailEntryCheck)}</strong></div>
              <div><span>Price</span><strong>{item.dynamicEntryPrice ? formatPriceCents(item.dynamicEntryPrice.selectedPrice) : entryCheck?.limitPrice != null ? formatPriceCents(entryCheck.limitPrice) : '-'}</strong></div>
              <div><span>Route</span><strong>{assetRouteLabel(item.dynamicEntryPrice)}</strong></div>
              <div><span>Score</span><strong>{assetSelectorScoreLabel(item.dynamicEntryPrice)}</strong></div>
              <div><span>Exit</span><strong>{strategyCheckLabel(profitExitCheck)}</strong></div>
              <div><span>Hedge</span><strong>{strategyCheckLabel(hedgeCheck)}</strong></div>
              <div><span>Cooldown</span><strong>{cooldownActive ? formatCooldownRemaining(item.entryCooldownUntil) : 'clear'}</strong></div>
            </div>
            <div className="profileRuntimeFooter">
              <span>{item.stats.orders} orders</span>
              <span>{item.stats.fills} fills</span>
              <strong className={item.stats.settledPnl >= 0 ? 'pass' : 'fail'}>{formatSignedMoney(item.stats.settledPnl)}</strong>
            </div>
          </button>
        ))}
      </section>
    </div>
  );
}
