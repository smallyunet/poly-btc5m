import React from 'react';
import { Search } from 'lucide-react';
import type { DashboardState } from '../../../../../packages/shared/src';
import { formatEtTime } from '../../lib/dashboardFormat';
import { PaginationControls } from '../../components/dashboard/Ui';
import { LOG_PAGE_SIZE } from '../dashboardHelpers';

type RuntimeLog = DashboardState['runtimeLogs'][number];

type Props = {
  allLogCount: number;
  filteredLogs: RuntimeLog[];
  pageRows: RuntimeLog[];
  page: number;
  totalPages: number;
  logSearch: string;
  logLevel: string;
  logSource: string;
  hideRoutineLogs: boolean;
  alertLogCount: number;
  signalLogCount: number;
  consoleRef: React.RefObject<HTMLDivElement | null>;
  onSearchChange: (value: string) => void;
  onLevelChange: (value: string) => void;
  onSourceChange: (value: string) => void;
  onToggleRoutineLogs: () => void;
  onPageChange: (page: number) => void;
};

export function LogsTab({
  allLogCount,
  filteredLogs,
  pageRows,
  page,
  totalPages,
  logSearch,
  logLevel,
  logSource,
  hideRoutineLogs,
  alertLogCount,
  signalLogCount,
  consoleRef,
  onSearchChange,
  onLevelChange,
  onSourceChange,
  onToggleRoutineLogs,
  onPageChange,
}: Props) {
  return (
    <div className="panel">
      <h2>Runtime Logs & System Output</h2>
      <div className="logsViewContainer">
        <div className="logsControlBar">
          <div className="searchWrapper">
            <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
            <input
              type="text"
              className="logSearchInput"
              style={{ paddingLeft: '34px' }}
              placeholder="Search logs by message or source..."
              value={logSearch}
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </div>

          <select className="logFilterSelect" value={logLevel} onChange={(event) => onLevelChange(event.target.value)}>
            <option value="all">All Levels</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
          </select>

          <select className="logFilterSelect" value={logSource} onChange={(event) => onSourceChange(event.target.value)}>
            <option value="all">All Sources</option>
            <option value="worker">Worker</option>
            <option value="api">API</option>
            <option value="execution">Execution</option>
            <option value="market-data">Market Data</option>
            <option value="operator">Operator</option>
          </select>

          <button type="button" className={`logModeButton ${hideRoutineLogs ? 'active' : ''}`} onClick={onToggleRoutineLogs}>
            {hideRoutineLogs ? 'Signal View' : 'Raw View'}
          </button>

          <div className="logCounters">
            <span>{filteredLogs.length} of {allLogCount} logs</span>
            <strong>{alertLogCount} alerts</strong>
            <span>{signalLogCount} signal</span>
          </div>
        </div>

        <div className="consoleWindow" ref={consoleRef}>
          {filteredLogs.length > 0 ? (
            pageRows.map((log) => (
              <div key={log.id} className={`consoleLogLine ${log.level}`}>
                <span className="logTime">{formatEtTime(log.createdAt)}</span>
                <span className="logSource">[{log.source}]</span>
                <span className={`logLevelTag ${log.level}`}>{log.level}</span>
                <span className="logMessage">{log.message}</span>
              </div>
            ))
          ) : (
            <div className="empty" style={{ minHeight: '200px' }}>
              <p className="emptyText">No log records matches your filters</p>
            </div>
          )}
        </div>
        <PaginationControls
          page={page}
          totalPages={totalPages}
          totalRows={filteredLogs.length}
          pageSize={LOG_PAGE_SIZE}
          onPageChange={onPageChange}
        />
      </div>
    </div>
  );
}
