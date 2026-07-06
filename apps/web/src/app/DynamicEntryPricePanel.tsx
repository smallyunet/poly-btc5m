import { Activity, Clock3, Database, TrendingUp } from 'lucide-react';

import type { DynamicEntryPriceSelection } from '../../../../packages/shared/src';
import { Badge } from '../components/dashboard/Ui';
import { formatEtTime } from '../lib/dashboardFormat';
import { formatEv, formatPriceCents, formatRate } from './dashboardHelpers';

type DynamicEntryPricePanelProps = {
  selection?: DynamicEntryPriceSelection;
  configuredPrice?: number | null;
};

export function DynamicEntryPricePanel({ selection, configuredPrice }: DynamicEntryPricePanelProps) {
  const price = selection?.selectedPrice ?? configuredPrice;
  const sourceTone = selection?.source === 'simulator' ? 'good' : selection?.source === 'fallback' ? 'warn' : 'neutral';
  const sourceLabel = selection?.source === 'simulator' ? 'SIMULATOR' : selection?.source === 'fallback' ? 'FALLBACK' : 'CONFIG';
  const nextSelection = selection?.nextSelectionAt ? formatEtTime(selection.nextSelectionAt) : '-';
  const updatedAt = selection?.selectedAt ? formatEtTime(selection.selectedAt) : '-';

  return (
    <section className={`dynamicEntryPricePanel ${selection?.source || 'config'}`} aria-label="BTC 5m dynamic simulator entry price">
      <div className="dynamicEntryPriceMain">
        <div>
          <span className="dynamicEntryPriceKicker">BTC 5m Entry Price</span>
          <strong>{formatPriceCents(price)}</strong>
        </div>
        <Badge tone={sourceTone}>{sourceLabel}</Badge>
      </div>

      <div className="dynamicEntryPriceStats" aria-label="Simulator selection metrics">
        <div>
          <TrendingUp size={14} aria-hidden="true" />
          <span>EV</span>
          <strong>{formatEv(selection?.estimatedEvPerShare)}</strong>
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
        <div>
          <Clock3 size={14} aria-hidden="true" />
          <span>Next</span>
          <strong>{nextSelection}</strong>
        </div>
      </div>

      <p>{selection?.reason || `Using configured entry price; last update ${updatedAt}.`}</p>
    </section>
  );
}
