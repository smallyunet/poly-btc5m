import { Activity, Database, TrendingUp } from 'lucide-react';

import type { DynamicEntryPriceSelection } from '../../../../packages/shared/src';
import { Badge } from '../components/dashboard/Ui';
import { formatEtTime } from '../lib/dashboardFormat';
import { assetNameForProfile, formatEv, formatPriceCents, formatRate } from './dashboardHelpers';

type DynamicEntryPricePanelProps = {
  selection?: DynamicEntryPriceSelection;
  configuredPrice?: number | null;
};

export function DynamicEntryPricePanel({ selection, configuredPrice }: DynamicEntryPricePanelProps) {
  const price = selection?.selectedPrice ?? configuredPrice;
  const sourceTone = selection?.source === 'simulator' ? 'good' : selection?.source === 'fallback' ? 'warn' : 'neutral';
  const sourceLabel = selection?.source === 'simulator' ? 'SIMULATOR' : selection?.source === 'fallback' ? 'FALLBACK' : 'CONFIG';
  const updatedAt = selection?.selectedAt ? formatEtTime(selection.selectedAt) : '-';
  const title = selection?.profileId ? `${assetNameForProfile(selection.profileId)} ${selection.profileId.split('-')[1] || ''} Entry Price` : 'Entry Price';
  const selectorFormula = selection?.assetSelectorSinglePenalty != null
    ? `score = EV - ${selection.assetSelectorSinglePenalty.toFixed(3)} * single`
    : undefined;

  return (
    <section className={`dynamicEntryPricePanel ${selection?.source || 'config'}`} aria-label={`${title} dynamic simulator entry price`}>
      <div className="dynamicEntryPriceMain">
        <div>
          <span className="dynamicEntryPriceKicker">{title}</span>
          <strong>{formatPriceCents(price)}</strong>
        </div>
        <Badge tone={sourceTone}>{sourceLabel}</Badge>
      </div>

      <div className="dynamicEntryPriceStats compact" aria-label="Simulator selection metrics">
        <div>
          <TrendingUp size={14} aria-hidden="true" />
          <span>EV</span>
          <strong>{formatEv(selection?.assetSelectorEv ?? selection?.estimatedEvPerShare)}</strong>
        </div>
        <div>
          <Activity size={14} aria-hidden="true" />
          <span>Single</span>
          <strong>{formatRate(selection?.singleRate)}</strong>
        </div>
        <div>
          <Database size={14} aria-hidden="true" />
          <span>Rounds</span>
          <strong>{selection?.rounds ?? '-'}</strong>
        </div>
      </div>

      <details className="dynamicEntryReason">
        <summary>Why this price</summary>
        <p>{selection?.reason || `Using configured entry price; last update ${updatedAt}.`}{selectorFormula ? ` ${selectorFormula}.` : ''}</p>
      </details>
    </section>
  );
}
