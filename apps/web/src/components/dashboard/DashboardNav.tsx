import { Activity, BarChart3, BookOpen, ChevronDown, CircleDollarSign, RefreshCw, ScrollText, Settings2, Terminal } from 'lucide-react';

import type { TabType } from '../../app/dashboardHelpers';
import { Badge } from './Ui';

type Props = {
  activeTab: TabType;
  executionMode: string;
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
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'simulation', label: 'Research', icon: BarChart3 },
  { id: 'portfolio', label: 'Portfolio', icon: CircleDollarSign },
];

const secondaryTabs: Array<{ id: TabType; label: string; icon: typeof Terminal }> = [
  { id: 'orderbooks', label: 'Order Books', icon: BookOpen },
  { id: 'strategy', label: 'Strategy Rules', icon: ScrollText },
  { id: 'logs', label: 'Runtime Logs', icon: Settings2 },
];

export function DashboardNav({
  activeTab,
  executionMode,
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
          <h1>BTC5m Operator</h1>
          <span>Dual + Tail execution</span>
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
        <Badge tone={executionMode === 'live' ? 'warn' : 'neutral'}>{executionMode}</Badge>
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
