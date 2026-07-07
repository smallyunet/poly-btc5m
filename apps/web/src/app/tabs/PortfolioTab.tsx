import { Info, PieChart } from 'lucide-react';
import type { DashboardState } from '../../../../../packages/shared/src';
import { formatMoney, formatNumber } from '../../lib/format';
import { formatEtTime, outcomeLabel, outcomeTone, shortenTokenId } from '../../lib/dashboardFormat';
import { Badge, DataTable, DecisionMetric } from '../../components/dashboard/Ui';
import {
  AssetIcon,
  AssetLabel,
  formatPercentValue,
  formatSignedMoney,
  portfolioStatusLabel,
  portfolioStatusTone,
  positionCost,
  positionPnl,
  positionValue,
} from '../dashboardHelpers';

type DashboardSnapshot = NonNullable<DashboardState['profiles'][number]['latestSnapshot']>;
type DisplayedPosition = DashboardSnapshot['positions'][number] & { profileId: string; profileLabel: string };

type Props = {
  portfolio: DashboardSnapshot['portfolio'];
  portfolioAvatarUrl?: string;
  portfolioInitial: string;
  portfolioProfileName?: string;
  portfolioProfileHandle?: string;
  displayedPositions: DisplayedPosition[];
  displayedPositionValue: number;
  displayedPositionCost: number;
  displayedUnrealizedPnl: number;
  displayedRoiPct: number | null;
  portfolioPnl: number;
  isAllProfiles: boolean;
  scopeLabel: string;
  settlementCount: number;
};

export function PortfolioTab({
  portfolio,
  portfolioAvatarUrl,
  portfolioInitial,
  portfolioProfileName,
  portfolioProfileHandle,
  displayedPositions,
  displayedPositionValue,
  displayedPositionCost,
  displayedUnrealizedPnl,
  displayedRoiPct,
  portfolioPnl,
  isAllProfiles,
  scopeLabel,
  settlementCount,
}: Props) {
  return (
    <div className="portfolioWorkspace">
      <section className="panel">
        <h2>
          Account Portfolio
          <span className="panelSubTitle">{portfolio?.updatedAt ? `updated ${formatEtTime(portfolio.updatedAt)}` : 'waiting for snapshot'}</span>
        </h2>

        {portfolio ? (
          <>
            <div className="portfolioHero">
              <div className="portfolioIdentity">
                <div className="portfolioAvatar" aria-hidden="true">
                  {portfolioAvatarUrl ? (
                    <img src={portfolioAvatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  ) : (
                    <span>{portfolioInitial}</span>
                  )}
                </div>
                <div className="portfolioIdentityText">
                  <span className="decisionKicker">Configured Account</span>
                  <strong title={portfolioProfileName || portfolio.accountAddress || ''}>{portfolioProfileName || (portfolio.accountAddress ? shortenTokenId(portfolio.accountAddress) : 'not configured')}</strong>
                  {portfolioProfileHandle && <em>{portfolioProfileHandle}</em>}
                  <p title={portfolio.accountAddress || ''}>{portfolio.accountAddress ? shortenTokenId(portfolio.accountAddress) : 'not configured'} · {portfolio.hasOwnerPrivateKey ? 'CLOB balance reads enabled' : 'OWNER_PRIVATE_KEY missing; positions only'}</p>
                </div>
              </div>
              <Badge tone={portfolioStatusTone(portfolio.status)}>{portfolioStatusLabel(portfolio.status)}</Badge>
            </div>

            <div className="portfolioMetricGrid">
              <DecisionMetric label="Collateral Balance" value={portfolio.collateralBalance == null ? 'n/a' : formatMoney(portfolio.collateralBalance)} detail="CLOB collateral" tone={portfolio.collateralBalance == null ? 'neutral' : 'good'} />
              <DecisionMetric label="Position Value" value={formatMoney(displayedPositionValue)} detail={`${displayedPositions.length} scoped positions`} tone={displayedPositionValue > 0 ? 'good' : 'neutral'} />
              <DecisionMetric label="Open Cost" value={formatMoney(displayedPositionCost)} detail="scoped entry basis" tone="neutral" />
              <DecisionMetric label="Unrealized PnL" value={formatSignedMoney(displayedUnrealizedPnl)} detail="scoped positions" tone={displayedUnrealizedPnl > 0 ? 'good' : displayedUnrealizedPnl < 0 ? 'bad' : 'neutral'} />
              <DecisionMetric label="Settled PnL" value={formatSignedMoney(portfolio.settledPnl)} detail={`${settlementCount} records`} tone={portfolio.settledPnl > 0 ? 'good' : portfolio.settledPnl < 0 ? 'bad' : 'neutral'} />
              <DecisionMetric label="Total PnL" value={formatSignedMoney(portfolioPnl + displayedUnrealizedPnl)} detail="scoped settled + unrealized" tone={(portfolioPnl + displayedUnrealizedPnl) > 0 ? 'good' : (portfolioPnl + displayedUnrealizedPnl) < 0 ? 'bad' : 'neutral'} />
              <DecisionMetric label="ROI" value={formatPercentValue(displayedRoiPct)} detail="scoped PnL / open cost" tone={displayedRoiPct == null ? 'neutral' : displayedRoiPct > 0 ? 'good' : displayedRoiPct < 0 ? 'bad' : 'neutral'} />
            </div>

            {portfolio.diagnostics.length > 0 && (
              <div className="portfolioDiagnostics">
                {portfolio.diagnostics.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="empty" style={{ minHeight: '120px' }}>
            <Info size={20} style={{ color: 'var(--text-muted)' }} />
            <p className="emptyText">No portfolio snapshot has been captured yet</p>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>
          Active Positions
          <span className="panelSubTitle">{displayedPositions.length ? `${displayedPositions.length} positions in ${scopeLabel}` : 'no scoped positions'}</span>
        </h2>
        {displayedPositions.length > 0 ? (
          <DataTable headers={isAllProfiles ? ['Profile', 'Market', 'Outcome', 'Shares', 'Avg', 'Value', 'PnL', 'ROI'] : ['Market', 'Outcome', 'Shares', 'Avg', 'Value', 'PnL', 'ROI']}>
            {displayedPositions.map((position) => {
              const value = positionValue(position);
              const cost = positionCost(position);
              const pnlValue = positionPnl(position);
              const roi = cost > 0 ? (pnlValue / cost) * 100 : null;
              return (
                <tr key={`${position.profileId}:${position.tokenId}`}>
                  {isAllProfiles && <td><Badge tone="neutral"><AssetLabel profileId={position.profileId} label={position.profileLabel} /></Badge></td>}
                  <td>
                    <div className="marketCell compact">
                      <AssetIcon profileId={position.profileId} size="sm" />
                      <div>
                        <span className="marketTitle">{position.title || 'Polymarket position'}</span>
                        <span className="mutedBlock mono">{shortenTokenId(position.tokenId)}</span>
                      </div>
                    </div>
                  </td>
                  <td><Badge tone={outcomeTone(position.label)}>{outcomeLabel(position.label)}</Badge></td>
                  <td className="mono">{formatNumber(position.shares, 2)}</td>
                  <td className="mono">${position.avgPrice.toFixed(3)}</td>
                  <td className="mono">{formatMoney(value)}</td>
                  <td className={`mono ${pnlValue >= 0 ? 'pass' : 'fail'}`}>{formatSignedMoney(pnlValue)}</td>
                  <td className={`mono ${roi == null ? '' : roi >= 0 ? 'pass' : 'fail'}`}>{formatPercentValue(roi)}</td>
                </tr>
              );
            })}
          </DataTable>
        ) : (
          <div className="empty" style={{ minHeight: '140px' }}>
            <PieChart size={22} style={{ color: 'var(--text-muted)' }} />
            <p className="emptyText">{portfolio?.status === 'disabled' ? 'Configure POLYMARKET_DEPOSIT_WALLET to load account positions' : 'No active positions found for this account'}</p>
          </div>
        )}
      </section>
    </div>
  );
}
