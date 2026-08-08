import { Activity, BarChart3, BookOpen, ChevronDown, RefreshCw, ScrollText, Settings2, Terminal } from 'lucide-react';

import type { TabType } from '../../app/dashboardHelpers';
import { Badge } from './Ui';

type Props = {
  activeTab: TabType;
  runtimeStatus: string;
  refreshing: boolean;
  lastRefreshLabel: string;
  refreshStatusLabel: string;
  refreshAriaStatus: string;
  onTabChange: (tab: TabType) => void;
  onRefresh: () => void;
};

const primaryTabs: Array<{ id: TabType; label: string; icon: typeof Terminal }> = [
  { id: 'terminal', label: 'Overview', icon: Terminal },
  { id: 'activity', label: 'Performance', icon: Activity },
  { id: 'simulation', label: 'Research', icon: BarChart3 },
  { id: 'orderbooks', label: 'Market Data', icon: BookOpen },
];

const secondaryTabs: Array<{ id: TabType; label: string; icon: typeof Terminal }> = [
  { id: 'strategy', label: 'Experiment Config', icon: ScrollText },
  { id: 'logs', label: 'Runtime Logs', icon: Settings2 },
];

export function DashboardNav({
  activeTab,
  runtimeStatus,
  refreshing,
  lastRefreshLabel,
  refreshStatusLabel,
  refreshAriaStatus,
  onTabChange,
  onRefresh,
}: Props) {
  const secondaryActive = secondaryTabs.some((tab) => tab.id === activeTab);

  return (
    <header className="topbar dashboardNav">
      <div className="dashboardBrand">
        <span className="dashboardBrandMark">P</span>
        <div>
          <h1>BTC5m Paper Lab</h1>
          <span>Dual + Tail research runtime</span>
        </div>
      </div>

      <nav className="tabBar" aria-label="Dashboard views">
        {primaryTabs.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={`tabBtn ${activeTab === id ? 'active' : ''}`} aria-current={activeTab === id ? 'page' : undefined} onClick={() => onTabChange(id)}>
            <Icon size={14} /> {label}
          </button>
        ))}
        <details className={`navMore ${secondaryActive ? 'active' : ''}`}>
          <summary className="tabBtn">
            More <ChevronDown size={13} />
          </summary>
          <div className="navMoreMenu">
            {secondaryTabs.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" className={activeTab === id ? 'active' : ''} aria-current={activeTab === id ? 'page' : undefined} onClick={(event) => {
                onTabChange(id);
                event.currentTarget.closest('details')?.removeAttribute('open');
              }}>
                <Icon size={14} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </details>
      </nav>

      <div className="navRuntime">
        <Badge tone={runtimeStatus === 'running' ? 'good' : 'bad'}>{runtimeStatus}</Badge>
        <button
          type="button"
          className="navRefresh"
          onClick={onRefresh}
          disabled={refreshing}
          title={`${refreshStatusLabel}; last refresh ${lastRefreshLabel}`}
          aria-label={`Refresh dashboard. ${refreshAriaStatus}. Last refresh ${lastRefreshLabel}.`}
        >
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
          <span>{lastRefreshLabel}</span>
        </button>
      </div>
    </header>
  );
}
