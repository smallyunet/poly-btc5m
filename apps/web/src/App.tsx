import React from 'react';
import { 
  Activity, 
  AlertTriangle, 
  CheckCircle2, 
  RefreshCw, 
  Radio, 
  Shield, 
  Timer, 
  TrendingUp,
  BookOpen,
  History,
  Terminal,
  Cpu,
  Search,
  Info
} from 'lucide-react';

import type { DashboardState, OrderBookQuote, RuntimeLogRecord, StrategyCheck } from '../../../packages/shared/src';
import { api, DASHBOARD_REFRESH_MS } from './lib/api';
import { formatMoney, formatNumber, formatSeconds, modeLabel } from './lib/format';

type TabType = 'terminal' | 'orderbooks' | 'activity' | 'strategy' | 'logs';

// Helper to shorten long crypto addresses/token IDs
function shortenTokenId(id: string): string {
  if (!id) return '-';
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}...${id.slice(-8)}`;
}

function outcomeLabel(label: 'YES' | 'NO'): string {
  return label === 'YES' ? 'UP' : 'DOWN';
}

function outcomeTone(label: 'YES' | 'NO'): 'good' | 'bad' {
  return label === 'YES' ? 'good' : 'bad';
}

function formatEtTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'n/a';
  return `${date.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })} ET`;
}

export function App() {
  const [state, setState] = React.useState<DashboardState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  
  // Navigation Tab State
  const [activeTab, setActiveTab] = React.useState<TabType>('terminal');

  // Logs Search & Filter States
  const [logSearch, setLogSearch] = React.useState('');
  const [logLevel, setLogLevel] = React.useState<string>('all');
  const [logSource, setLogSource] = React.useState<string>('all');

  // Ref for auto-scrolling the log console
  const consoleRef = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(async (silent = false) => {
    try {
      if (!silent) setRefreshing(true);
      setError(null);
      setState(await api<DashboardState>('/api/state'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), DASHBOARD_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Filter logs in real-time
  const filteredLogs = React.useMemo(() => {
    if (!state?.runtimeLogs) return [];
    return state.runtimeLogs.filter((log) => {
      const matchesSearch = logSearch
        ? log.message.toLowerCase().includes(logSearch.toLowerCase()) || 
          log.source.toLowerCase().includes(logSearch.toLowerCase())
        : true;
      const matchesLevel = logLevel === 'all' ? true : log.level === logLevel;
      const matchesSource = logSource === 'all' ? true : log.source === logSource;
      return matchesSearch && matchesLevel && matchesSource;
    });
  }, [state?.runtimeLogs, logSearch, logLevel, logSource]);

  // Auto-scroll log console to bottom when new logs arrive
  React.useEffect(() => {
    if (consoleRef.current && activeTab === 'logs') {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [filteredLogs, activeTab]);

  if (error) {
    return (
      <Shell>
        <div className="empty">
          <AlertTriangle size={48} className="fail" />
          <p className="emptyText">{error}</p>
          <button type="button" onClick={() => load()}>
            <RefreshCw size={14} /> Retry Connection
          </button>
        </div>
      </Shell>
    );
  }

  if (!state) {
    return (
      <Shell>
        <div className="empty">
          <RefreshCw className="spin" size={48} style={{ color: 'var(--color-primary)' }} />
          <p className="emptyText">Initializing BTC 5m Trading Terminal...</p>
        </div>
      </Shell>
    );
  }

  const snapshot = state.latestSnapshot;
  const eligible = state.strategyChecks.filter((check) => check.status === 'eligible').length;
  const activeOrders = state.orders.filter((order) => (
    order.status === 'posted'
    || order.status === 'partially_filled'
    || (state.runtime.executionMode === 'monitor' && order.status === 'local')
  )).length;
  const pnl = state.settlements.reduce((sum, item) => sum + item.pnl, 0);

  // Time progress bar calculation
  const secondsToEnd = snapshot.round.secondsToEnd;
  const secondsToStart = snapshot.round.secondsToStart;
  const totalRoundDuration = 300; // 5 minutes
  const isRoundStarted = secondsToStart <= 0;
  const roundElapsedSeconds = isRoundStarted ? totalRoundDuration - Math.max(0, secondsToEnd) : 0;
  const progressPct = Math.min(100, Math.max(0, (roundElapsedSeconds / totalRoundDuration) * 100));
  let progressColorClass = 'safe';
  if (!isRoundStarted && secondsToStart <= 30) {
    progressColorClass = 'warning';
  } else if (isRoundStarted && secondsToEnd < 30) {
    progressColorClass = 'danger';
  } else if (isRoundStarted && secondsToEnd <= 120) {
    progressColorClass = 'warning';
  }

  // BTC vs Strike calculations for visual gauge
  const btcPrice = snapshot.features.price;
  const strikePrice = snapshot.round.strike;
  const priceDiff = btcPrice != null ? btcPrice - strikePrice : null;
  const isBtcAboveStrike = priceDiff != null && priceDiff >= 0;
  
  // Dynamic scale: range window represents the width of the gauge bar.
  // We center it at the strike, and range represents +/- delta.
  const rangeDelta = priceDiff != null ? Math.max(100, Math.abs(priceDiff) * 1.6) : 100;
  const gaugePct = priceDiff != null ? Math.min(95, Math.max(5, 50 + (priceDiff / rangeDelta) * 50)) : 50;

  // Round phase detail text logic (prevents negative countdowns once started)
  const roundPhaseDetail = isRoundStarted
    ? `${formatSeconds(secondsToEnd)} remaining`
    : `${formatSeconds(secondsToStart)} to start`;
  const timelineDetail = isRoundStarted ? `${formatSeconds(secondsToEnd)} remaining` : `${formatSeconds(secondsToStart)} to start`;
  const strikeLabel = snapshot.round.strikeStatus === 'locked' ? 'Opening Strike' : 'Estimated Open';
  const terminalGaugeStatus = snapshot.round.strikeStatus === 'locked'
    ? (isBtcAboveStrike ? 'BTC >= OPEN (UP WINS)' : 'BTC < OPEN (DOWN WINS)')
    : 'PRE-ROUND OPEN ESTIMATE';

  return (
    <Shell>
      {/* Top Header Bar */}
      <section className="topbar">
        <div>
          <h1>
            <Cpu size={24} style={{ color: 'var(--color-primary)' }} />
            Poly BTC 5m Terminal
          </h1>
          <p>{snapshot.round.title || snapshot.round.eventSlug}</p>
        </div>
        
        {/* Navigation Tabs */}
        <nav className="tabBar">
          <button className={`tabBtn ${activeTab === 'terminal' ? 'active' : ''}`} onClick={() => setActiveTab('terminal')}>
            <Terminal size={14} /> Terminal
          </button>
          <button className={`tabBtn ${activeTab === 'orderbooks' ? 'active' : ''}`} onClick={() => setActiveTab('orderbooks')}>
            <BookOpen size={14} /> Order Books
          </button>
          <button className={`tabBtn ${activeTab === 'activity' ? 'active' : ''}`} onClick={() => setActiveTab('activity')}>
            <History size={14} /> Activity & PnL
          </button>
          <button className={`tabBtn ${activeTab === 'strategy' ? 'active' : ''}`} onClick={() => setActiveTab('strategy')}>
            <Cpu size={14} /> Strategy Rules
          </button>
          <button className={`tabBtn ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>
            <Terminal size={14} /> Logs
          </button>
        </nav>

        <div className="actions">
          <button type="button" onClick={() => load()} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
            {refreshing ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
      </section>

      {/* Top Status Cards / Digest */}
      <section className="digest">
        <Digest 
          icon={<Activity size={16} />} 
          label="Runtime" 
          value={state.runtime.status.toUpperCase()} 
          detail={modeLabel(state.runtime.executionMode)} 
          tone={state.runtime.executionMode === 'live' ? 'warn' : 'neutral'} 
        />
        <Digest 
          icon={<Radio size={16} />} 
          label="Feeds Connection" 
          value={state.feed.source.toUpperCase()} 
          detail={`RTDS: ${state.feed.rtdsConnected ? 'ON' : 'OFF'} / CLOB: ${state.feed.clobConnected ? 'ON' : 'OFF'}`} 
          tone={state.feed.source === 'live' && state.feed.rtdsConnected ? 'good' : 'warn'} 
        />
        <Digest 
          icon={<Timer size={16} />} 
          label="Round Phase" 
          value={snapshot.round.phase.toUpperCase()} 
          detail={roundPhaseDetail} 
          tone={snapshot.round.phase === 'decision' || snapshot.round.phase === 'posting' ? 'warn' : 'neutral'} 
        />
        <Digest 
          icon={<TrendingUp size={16} />} 
          label="Market Regime" 
          value={snapshot.regime} 
          detail={`${eligible} eligible checks`} 
          tone={snapshot.regime === 'CHOP' ? 'good' : snapshot.regime === 'TREND' ? 'bad' : 'neutral'} 
        />
        <Digest 
          icon={<Shield size={16} />} 
          label="Active Trades" 
          value={`${activeOrders} Orders`} 
          detail={`${state.fills.length} fills / ${state.orders.length} total`} 
          tone={activeOrders ? 'warn' : 'neutral'} 
        />
        <Digest 
          icon={<CheckCircle2 size={16} />} 
          label="Net Realized PnL" 
          value={formatMoney(pnl)} 
          detail={`${state.settlements.length} settled rounds`} 
          tone={pnl > 0 ? 'good' : pnl < 0 ? 'bad' : 'neutral'} 
        />
      </section>

      {/* Main Tabbed Area */}
      <main>
        {activeTab === 'terminal' && (
          <div className="grid">
            {/* Left Column (Main widgets) */}
            <div className="span-8" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              
              {/* BTC Price vs Strike Visualizer */}
              {btcPrice != null && strikePrice != null && priceDiff != null && (
                <div className="panel">
                  <h2>BTC Price vs. Strike Position</h2>
                  <div className="gaugeContainer">
                    <div className="gaugeHeader">
                      <span>Live Tracker</span>
                      <strong className={isBtcAboveStrike ? 'pass' : 'fail'} style={{ fontSize: '13px' }}>
                        {terminalGaugeStatus}
                      </strong>
                    </div>
                    <div className="gaugeTrack">
                      <div className="gaugeStrikeZone"></div>
                      <div className={`gaugeFill ${isBtcAboveStrike ? 'above' : 'below'}`} style={{ 
                        left: isBtcAboveStrike ? '50%' : `${gaugePct}%`, 
                        width: isBtcAboveStrike ? `${gaugePct - 50}%` : `${50 - gaugePct}%` 
                      }}></div>
                      <div className={`gaugePointer ${isBtcAboveStrike ? 'above' : 'below'}`} style={{ left: `${gaugePct}%` }}></div>
                    </div>
                    <div className="gaugeLabels">
                      <span className="gaugeSideLabel NO">DOWN ZONE (Below)</span>
                      <span className="gaugeCenterLabel" style={{ fontSize: '12px', fontWeight: 500 }}>
                        {strikeLabel}: <strong style={{ color: 'var(--text-primary)' }}>${formatNumber(strikePrice, 2)}</strong> | Price: <strong style={{ color: 'var(--text-primary)' }}>${formatNumber(btcPrice, 2)}</strong> ({priceDiff >= 0 ? '+' : ''}{priceDiff.toFixed(2)} USD)
                      </span>
                      <span className="gaugeSideLabel YES">UP ZONE (Above)</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Active Positions Panel */}
              <div className="panel">
                <h2>Active Portfolio Positions</h2>
                <div className="positionsList">
                  {snapshot.positions && snapshot.positions.length > 0 ? (
                    snapshot.positions.map((pos) => {
                      const quote = snapshot.orderbooks.find((q) => q.tokenId === pos.tokenId);
                      // Estimate current market price from orderbook midpoint or best bid/ask
                      const currentPrice = quote?.midpoint ?? (
                        (quote?.bestBid != null && quote?.bestAsk != null) 
                          ? (quote.bestBid + quote.bestAsk) / 2 
                          : pos.avgPrice
                      );
                      const unrealizedPnL = (currentPrice - pos.avgPrice) * pos.shares;
                      const value = currentPrice * pos.shares;
                      const cost = pos.shares * pos.avgPrice;
                      
                      return (
                        <div key={pos.tokenId} className={`positionCard ${pos.label}`}>
                          <div className="posToken">
                            <div className="posTokenName">{outcomeLabel(pos.label)} Token</div>
                            <div className="posTokenSide">{outcomeLabel(pos.label)} Shares</div>
                          </div>
                          <div className="posStats">
                            <span>Shares / Avg Entry</span>
                            <strong>{formatNumber(pos.shares, 1)} @ {pos.avgPrice.toFixed(3)}</strong>
                          </div>
                          <div className="posStats">
                            <span>Market Value / Cost</span>
                            <strong>{formatMoney(value)} / {formatMoney(cost)}</strong>
                          </div>
                          <div className="posPnL">
                            <span>Unrealized PnL</span>
                            <strong className={`posPnLAmount ${unrealizedPnL >= 0 ? 'profit' : 'loss'}`}>
                              {unrealizedPnL >= 0 ? '+' : ''}{formatMoney(unrealizedPnL)}
                            </strong>
                          </div>
                        </div>
                      );
                    })
                  ) : snapshot.positionReadStatus === 'disabled' ? (
                    <div className="empty" style={{ minHeight: '100px', background: 'rgba(0, 0, 0, 0.008)', border: '1px dashed var(--border-color)', borderRadius: '10px' }}>
                      <Info size={20} style={{ color: 'var(--text-muted)' }} />
                      <p className="emptyText">Position reads disabled until a deposit wallet is configured</p>
                    </div>
                  ) : (
                    <div className="empty" style={{ minHeight: '100px', background: 'rgba(0, 0, 0, 0.008)', border: '1px dashed var(--border-color)', borderRadius: '10px' }}>
                      <Info size={20} style={{ color: 'var(--text-muted)' }} />
                      <p className="emptyText">No active token positions held in this round</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Strategy Checks */}
              <div className="panel">
                <h2>Strategy Eligibility & Entry Checks</h2>
                <div className="checks">
                  {state.strategyChecks.map((check) => (
                    <article key={check.strategy} className={`checkCard ${check.status}`}>
                      <div className="checkCardHeader">
                        <h3>{check.title}</h3>
                        <Badge tone={check.status === 'eligible' ? 'good' : check.status === 'blocked' ? 'bad' : 'neutral'}>
                          {check.status}
                        </Badge>
                      </div>
                      <p className="checkReason">{check.reason}</p>
                      <div className="checkConditions">
                        {check.conditions.map((condition) => (
                          <div key={condition.label} className="checkConditionRow">
                            <span className="checkConditionLabel">{condition.label}</span>
                            <span className={`checkConditionValue ${condition.passed ? 'pass' : 'fail'}`}>
                              {condition.actual}
                            </span>
                          </div>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </div>

            {/* Right Column (Side status metrics) */}
            <div className="span-4" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              
              {/* Round Progress Countdown */}
              <div className="panel">
                <h2>Round Timeline</h2>
                <div className="progressBarContainer">
                  <div className="progressBarLabel">
                    <span>Phase: <strong style={{ color: 'var(--text-primary)' }}>{snapshot.round.phase.toUpperCase()}</strong></span>
                    <span>{timelineDetail}</span>
                  </div>
                  <div className="progressTrack">
                    <div className={`progressFill ${progressColorClass}`} style={{ width: `${progressPct}%` }}></div>
                  </div>
                </div>
              </div>

              {/* Round Details */}
              <div className="panel">
                <h2>Round Specifications</h2>
                <div className="metrics">
                  <div className="metricRow">
                    <span className="metricLabel">Round ID</span>
                    <span className="metricValue">{snapshot.round.id}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Snapshot ID</span>
                    <span className="metricValue" style={{ fontSize: '11px' }}>{snapshot.id}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Event Slug</span>
                    <span className="metricValue" style={{ fontSize: '11px' }}>{snapshot.round.eventSlug}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">{strikeLabel}</span>
                    <span className="metricValue">${formatNumber(snapshot.round.strike, 2)}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Start Time</span>
                    <span className="metricValue">{formatEtTime(snapshot.round.startAt)}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">End Time</span>
                    <span className="metricValue">{formatEtTime(snapshot.round.endAt)}</span>
                  </div>
                </div>
              </div>

              {/* Analytics Features */}
              <div className="panel">
                <h2>Path Features (120s)</h2>
                <div className="metrics">
                  <div className="metricRow">
                    <span className="metricLabel">Data Feed Source</span>
                    <span className="metricValue"><Badge tone="good">{snapshot.features.source}</Badge></span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Price Samples</span>
                    <span className="metricValue">{snapshot.features.samples120s}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Strike Crosses</span>
                    <span className="metricValue">{snapshot.features.cross120s}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Volatility (120s)</span>
                    <span className="metricValue">{formatNumber(snapshot.features.volatility120s, 2)}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Drift (120s)</span>
                    <span className="metricValue">{formatNumber(snapshot.features.drift120s, 2)}</span>
                  </div>
                  <div className="metricRow">
                    <span className="metricLabel">Momentum (30s)</span>
                    <span className="metricValue">{formatNumber(snapshot.features.momentum30s, 2)}</span>
                  </div>
                </div>
              </div>

              {/* System Diagnostics */}
              {snapshot.diagnostics && snapshot.diagnostics.length > 0 && (
                <div className="panel">
                  <h2>Diagnostics</h2>
                  <div className="metrics" style={{ gap: '8px' }}>
                    {snapshot.diagnostics.map((diag, i) => (
                      <div key={i} className="metricRow" style={{ borderBottom: 'none', padding: '2px 0' }}>
                        <span className="metricValue" style={{ color: 'var(--color-warning)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
                          • {diag}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'orderbooks' && (
          <div className="panel">
            <h2>Polymarket CLOB Order Books</h2>
            <OrderbookTable quotes={snapshot.orderbooks} yesTokenId={snapshot.round.yesTokenId} noTokenId={snapshot.round.noTokenId} />
          </div>
        )}

        {activeTab === 'activity' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            
            {/* Active / Recent Orders */}
            <div className="panel">
              <h2>Active Orders & Intent History</h2>
              {state.orders.length > 0 ? (
                <DataTable headers={['Time (ET)', 'Round ID', 'Outcome', 'Side', 'Price', 'Size', 'Status', 'Polymarket CLOB Order ID']}>
                  {state.orders.slice(0, 100).map((order) => (
                    <tr key={order.id}>
                      <td className="mono">{formatEtTime(order.createdAt)}</td>
                      <td className="mono" style={{ fontSize: '11px' }}>{order.roundId}</td>
                      <td><Badge tone={outcomeTone(order.label)}>{outcomeLabel(order.label)}</Badge></td>
                      <td>
                        <strong style={{ color: order.side === 'BUY' ? 'var(--color-success)' : 'var(--color-danger)' }}>
                          {order.side}
                        </strong>
                      </td>
                      <td className="mono">${order.price.toFixed(3)}</td>
                      <td className="mono">{order.size.toFixed(1)}</td>
                      <td>
                        <Badge tone={order.status === 'failed' ? 'bad' : order.status === 'filled' ? 'good' : order.status === 'posted' ? 'warn' : 'neutral'}>
                          {order.status}
                        </Badge>
                      </td>
                      <td className="mono" style={{ fontSize: '11px' }} title={order.clobOrderId || ''}>
                        {order.clobOrderId ? shortenTokenId(order.clobOrderId) : '-'}
                      </td>
                    </tr>
                  ))}
                </DataTable>
              ) : (
                <div className="empty" style={{ minHeight: '150px' }}>
                  <p className="emptyText">No orders placed by the bot yet</p>
                </div>
              )}
            </div>

            {/* Fills & Settlements */}
            <div className="panel">
              <h2>Trade Fills & Settlement History</h2>
              {(state.fills.length > 0 || state.settlements.length > 0) ? (
                <DataTable headers={['Record Type', 'Time (ET)', 'Round ID', 'Details', 'Position/Winner', 'Price/Cost', 'Size/PnL']}>
                  {/* Fills list */}
                  {state.fills.slice(0, 50).map((fill) => (
                    <tr key={`fill-${fill.id}`}>
                      <td><Badge tone="neutral">FILL</Badge></td>
                      <td className="mono">{formatEtTime(fill.matchedAt)}</td>
                      <td className="mono" style={{ fontSize: '11px' }}>{fill.roundId}</td>
                      <td>{outcomeLabel(fill.label)} Match</td>
                      <td>
                        <strong style={{ color: fill.side === 'BUY' ? 'var(--color-success)' : 'var(--color-danger)' }}>
                          {fill.side}
                        </strong>
                      </td>
                      <td className="mono">${fill.price.toFixed(3)}</td>
                      <td className="mono">{fill.size.toFixed(1)}</td>
                    </tr>
                  ))}
                  {/* Settlements list */}
                  {state.settlements.slice(0, 50).map((settlement) => (
                    <tr key={`settlement-${settlement.id}`}>
                      <td><Badge tone="good">SETTLEMENT</Badge></td>
                      <td className="mono">{formatEtTime(settlement.resolvedAt)}</td>
                      <td className="mono" style={{ fontSize: '11px' }}>{settlement.roundId}</td>
                      <td>{settlement.status.toUpperCase()}</td>
                      <td>
                        <Badge tone={settlement.winningLabel === 'YES' ? 'good' : settlement.winningLabel === 'NO' ? 'bad' : 'neutral'}>
                          {settlement.winningLabel ? outcomeLabel(settlement.winningLabel) : 'pending'}
                        </Badge>
                      </td>
                      <td className="mono">{formatMoney(settlement.totalCost)}</td>
                      <td className={`mono ${settlement.pnl >= 0 ? 'pass' : 'fail'}`} style={{ fontWeight: 700 }}>
                        {settlement.pnl >= 0 ? '+' : ''}{formatMoney(settlement.pnl)}
                      </td>
                    </tr>
                  ))}
                </DataTable>
              ) : (
                <div className="empty" style={{ minHeight: '150px' }}>
                  <p className="emptyText">No filled trades or settled rounds found</p>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'strategy' && (
          <div className="panel">
            <h2>Trading Strategy & Configured Rules</h2>
            <div className="rulesGrid">
              {state.rules && state.rules.length > 0 ? (
                state.rules.map((rule) => (
                  <div key={rule.id} className="ruleCard">
                    <div className="ruleHeader">
                      <span className="ruleTitle">{rule.title} ({rule.id})</span>
                      <span className="ruleAllocation">{rule.allocationPct}% ALLOCATION</span>
                    </div>
                    <p className="ruleSummary">{rule.summary}</p>
                    <div className="ruleLists">
                      <div className="ruleSection">
                        <h4>Entry triggers</h4>
                        <ul>
                          {rule.entryRules.map((entry, idx) => (
                            <li key={idx}>{entry}</li>
                          ))}
                        </ul>
                      </div>
                      <div className="ruleSection">
                        <h4>Exit parameters</h4>
                        <ul>
                          {rule.exitRules.map((exit, idx) => (
                            <li key={idx}>{exit}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty" style={{ width: '100%' }}>
                  <p className="emptyText">No strategy rules loaded in bot configuration</p>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="panel">
            <h2>Runtime Logs & System Output</h2>
            <div className="logsViewContainer">
              
              {/* Logs filter controls */}
              <div className="logsControlBar">
                <div className="searchWrapper">
                  <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
                  <input 
                    type="text" 
                    className="logSearchInput" 
                    style={{ paddingLeft: '34px' }}
                    placeholder="Search logs by message or source..." 
                    value={logSearch} 
                    onChange={(e) => setLogSearch(e.target.value)}
                  />
                </div>
                
                <select 
                  className="logFilterSelect" 
                  value={logLevel} 
                  onChange={(e) => setLogLevel(e.target.value)}
                >
                  <option value="all">All Levels</option>
                  <option value="info">Info</option>
                  <option value="warn">Warning</option>
                  <option value="error">Error</option>
                </select>

                <select 
                  className="logFilterSelect" 
                  value={logSource} 
                  onChange={(e) => setLogSource(e.target.value)}
                >
                  <option value="all">All Sources</option>
                  <option value="worker">Worker</option>
                  <option value="api">API</option>
                  <option value="execution">Execution</option>
                  <option value="market-data">Market Data</option>
                  <option value="operator">Operator</option>
                </select>

                {/* Counter */}
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                  {filteredLogs.length} of {state.runtimeLogs.length} logs
                </span>
              </div>

              {/* Console log box */}
              <div className="consoleWindow" ref={consoleRef}>
                {filteredLogs.length > 0 ? (
                  filteredLogs.map((log) => (
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
            </div>
          </div>
        )}
      </main>
    </Shell>
  );
}

// Layout helper components
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="appShell">{children}</div>;
}

function Digest({ 
  icon, 
  label, 
  value, 
  detail, 
  tone 
}: { 
  icon: React.ReactNode; 
  label: string; 
  value: string; 
  detail: string; 
  tone: 'good' | 'warn' | 'bad' | 'neutral' 
}) {
  return (
    <div className={`digestCard ${tone}`}>
      <div className="digestHeader">
        {icon}
        <span>{label}</span>
        {(tone === 'good' || tone === 'warn' || tone === 'bad') && (
          <span className={`liveDot ${tone}`} style={{ marginLeft: 'auto' }}></span>
        )}
      </div>
      <strong className="digestValue">{value}</strong>
      <em className="digestDetail">{detail}</em>
    </div>
  );
}

function OrderbookTable({ quotes, yesTokenId, noTokenId }: { quotes: OrderBookQuote[]; yesTokenId: string; noTokenId: string }) {
  // Scale depths relative to max depths found in the quotes list
  const maxBidDepth = Math.max(...quotes.map((q) => q.bidDepth), 1);
  const maxAskDepth = Math.max(...quotes.map((q) => q.askDepth), 1);

  return (
    <DataTable headers={['Outcome', 'Token ID', 'Data Source', 'Best Bid', 'Best Ask', 'Midpoint', 'Spread', 'Bid Liquidity (Depth)', 'Ask Liquidity (Depth)', 'Last Updated (ET)']}>
      {quotes.map((quote) => {
        const bidPct = (quote.bidDepth / maxBidDepth) * 80; // max 80% width
        const askPct = (quote.askDepth / maxAskDepth) * 80;
        const label = quote.tokenId === yesTokenId ? 'YES' : quote.tokenId === noTokenId ? 'NO' : null;
        
        return (
          <tr key={quote.tokenId}>
            <td>{label ? <Badge tone={outcomeTone(label)}>{outcomeLabel(label)}</Badge> : '-'}</td>
            <td className="mono" style={{ fontSize: '11px' }} title={quote.tokenId}>{shortenTokenId(quote.tokenId)}</td>
            <td><Badge tone={quote.source === 'ws' ? 'good' : 'neutral'}>{quote.source.toUpperCase()}</Badge></td>
            <td className="mono" style={{ color: 'var(--color-success)', fontWeight: 600 }}>
              {quote.bestBid == null ? '-' : quote.bestBid.toFixed(3)}
            </td>
            <td className="mono" style={{ color: 'var(--color-danger)', fontWeight: 600 }}>
              {quote.bestAsk == null ? '-' : quote.bestAsk.toFixed(3)}
            </td>
            <td className="mono">{quote.midpoint == null ? '-' : quote.midpoint.toFixed(3)}</td>
            <td className="mono">{quote.spread == null ? '-' : quote.spread.toFixed(3)}</td>
            
            {/* Liquidities with background bar gauges */}
            <td className="depthCell">
              <div className="depthFill bid" style={{ width: `${bidPct}%` }}></div>
              <span style={{ position: 'relative', zIndex: 1 }}>{quote.bidDepth.toFixed(2)}</span>
            </td>
            <td className="depthCell">
              <div className="depthFill ask" style={{ width: `${askPct}%` }}></div>
              <span style={{ position: 'relative', zIndex: 1 }}>{quote.askDepth.toFixed(2)}</span>
            </td>
            
            <td className="mono">{formatEtTime(quote.updatedAt)}</td>
          </tr>
        );
      })}
    </DataTable>
  );
}

function DataTable({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            {headers.map((header) => <th key={header}>{header}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'neutral'; children: React.ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
