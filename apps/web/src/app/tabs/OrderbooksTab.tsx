import type { DashboardState } from '../../../../../packages/shared/src';
import { formatEtTime } from '../../lib/dashboardFormat';
import { OrderbookCapacityPanel, OrderbookExecutionSummary, OrderbookTable } from '../../components/dashboard/OrderbookPanels';
import { Badge } from '../../components/dashboard/Ui';
import { AssetLabel } from '../dashboardHelpers';

type DashboardSnapshot = NonNullable<DashboardState['profiles'][number]['latestSnapshot']>;

type Props = {
  state: DashboardState;
  snapshot: DashboardSnapshot;
  isAllProfiles: boolean;
  scopeLabel: string;
  onSelectProfile: (profileId: string) => void;
};

export function OrderbooksTab({ state, snapshot, isAllProfiles, scopeLabel, onSelectProfile }: Props) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <span className="sectionKicker">{scopeLabel}</span>
          <h2>Polymarket CLOB Order Books</h2>
        </div>
      </div>
      {isAllProfiles ? (
        <div className="profileGridPanel compact">
          {state.profiles.map((item) => (
            <button key={item.profile.id} type="button" className="profileRuntimeCard" onClick={() => onSelectProfile(item.profile.id)}>
              <div className="profileRuntimeHeader">
                <div>
                  <strong><AssetLabel profileId={item.profile.id} label={item.profile.label} size="sm" /></strong>
                  <span>{item.latestSnapshot?.round.id || 'waiting for round'}</span>
                </div>
                <Badge tone={item.feed.clobConnected ? 'good' : 'bad'}>CLOB {item.feed.clobConnected ? 'on' : 'off'}</Badge>
              </div>
              <div className="profileRuntimeStats">
                <div><span>Round</span><strong>{item.latestSnapshot?.round.phase || 'pending'}</strong></div>
                <div><span>Orderbooks</span><strong>{item.latestSnapshot?.orderbooks.length || 0}</strong></div>
                <div><span>Depth</span><strong>{item.latestSnapshot?.orderbookDepth ? 'loaded' : 'empty'}</strong></div>
                <div><span>Updated</span><strong>{item.feed.lastOrderbookAt ? formatEtTime(item.feed.lastOrderbookAt) : 'n/a'}</strong></div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <>
          <OrderbookExecutionSummary quotes={snapshot.orderbooks} yesTokenId={snapshot.round.yesTokenId} noTokenId={snapshot.round.noTokenId} />
          <OrderbookCapacityPanel depth={snapshot.orderbookDepth} />
          <OrderbookTable quotes={snapshot.orderbooks} yesTokenId={snapshot.round.yesTokenId} noTokenId={snapshot.round.noTokenId} />
        </>
      )}
    </div>
  );
}
