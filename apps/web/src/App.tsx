import React from 'react';
import { Activity, AlertTriangle, CheckCircle2, RefreshCw, Radio, Shield, Timer, TrendingUp } from 'lucide-react';

import type { DashboardState, OrderBookQuote, RuntimeLogRecord, StrategyCheck } from '../../../packages/shared/src';
import { api, DASHBOARD_REFRESH_MS } from './lib/api';
import { formatMoney, formatNumber, formatSeconds, modeLabel } from './lib/format';

export function App() {
  const [state, setState] = React.useState<DashboardState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

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

  if (error) return <Shell><div className="empty"><AlertTriangle size={36} />{error}</div></Shell>;
  if (!state) return <Shell><div className="empty"><RefreshCw className="spin" size={36} />Loading BTC 5m worker</div></Shell>;

  const snapshot = state.latestSnapshot;
  const eligible = state.strategyChecks.filter((check) => check.status === 'eligible').length;
  const activeOrders = state.orders.filter((order) => order.status === 'posted' || order.status === 'local' || order.status === 'partially_filled').length;
  const pnl = state.settlements.reduce((sum, item) => sum + item.pnl, 0);

  return (
    <Shell>
      <section className="topbar">
        <div>
          <h1>Poly BTC 5m</h1>
          <p>{snapshot.round.title || snapshot.round.eventSlug}</p>
        </div>
        <div className="actions">
          <button type="button" onClick={() => load()} disabled={refreshing}>
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} /> Refresh
          </button>
        </div>
      </section>

      <section className="digest">
        <Digest icon={<Activity size={16} />} label="Runtime" value={state.runtime.status} detail={modeLabel(state.runtime.executionMode)} tone={state.runtime.executionMode === 'live' ? 'warn' : 'neutral'} />
        <Digest icon={<Radio size={16} />} label="Feeds" value={state.feed.source} detail={`RTDS ${state.feed.rtdsConnected ? 'on' : 'off'} / CLOB ${state.feed.clobConnected ? 'on' : 'off'}`} tone={state.feed.source === 'live' ? 'good' : 'warn'} />
        <Digest icon={<Timer size={16} />} label="Round" value={snapshot.round.phase} detail={`${formatSeconds(snapshot.round.secondsToStart)} to start`} tone={snapshot.round.phase === 'decision' ? 'warn' : 'neutral'} />
        <Digest icon={<TrendingUp size={16} />} label="Regime" value={snapshot.regime} detail={`${eligible} eligible checks`} tone={snapshot.regime === 'CHOP' ? 'good' : snapshot.regime === 'TREND' ? 'bad' : 'neutral'} />
        <Digest icon={<Shield size={16} />} label="Orders" value={`${activeOrders} active`} detail={`${state.fills.length} fills`} tone={activeOrders ? 'warn' : 'neutral'} />
        <Digest icon={<CheckCircle2 size={16} />} label="PnL" value={formatMoney(pnl)} detail={`${state.settlements.length} settlements`} tone={pnl > 0 ? 'good' : pnl < 0 ? 'bad' : 'neutral'} />
      </section>

      <main className="grid">
        <Panel title="Round State" className="span-6">
          <MetricRows rows={[
            ['Event', snapshot.round.eventSlug],
            ['Start', new Date(snapshot.round.startAt).toLocaleString()],
            ['End', new Date(snapshot.round.endAt).toLocaleString()],
            ['Strike', formatNumber(snapshot.round.strike, 2)],
            ['BTC price', snapshot.features.price == null ? 'n/a' : formatNumber(snapshot.features.price, 2)],
            ['Seconds to end', formatSeconds(snapshot.round.secondsToEnd)],
          ]} />
        </Panel>

        <Panel title="Path Features" className="span-6">
          <MetricRows rows={[
            ['Source', snapshot.features.source],
            ['Samples 120s', String(snapshot.features.samples120s)],
            ['Cross 120s', String(snapshot.features.cross120s)],
            ['Volatility 120s', formatNumber(snapshot.features.volatility120s, 2)],
            ['Drift 120s', formatNumber(snapshot.features.drift120s, 2)],
            ['Momentum 30s', formatNumber(snapshot.features.momentum30s, 2)],
          ]} />
        </Panel>

        <Panel title="Orderbooks" className="span-12">
          <OrderbookTable quotes={snapshot.orderbooks} />
        </Panel>

        <Panel title="Strategy Checks" className="span-12">
          <StrategyChecks checks={state.strategyChecks} />
        </Panel>

        <Panel title="Orders" className="span-12">
          <DataTable headers={['Time', 'Round', 'Label', 'Side', 'Price', 'Size', 'Status', 'CLOB']}>
            {state.orders.slice(0, 80).map((order) => (
              <tr key={order.id}>
                <td>{new Date(order.createdAt).toLocaleTimeString()}</td>
                <td>{order.roundId}</td>
                <td>{order.label}</td>
                <td>{order.side}</td>
                <td>{order.price.toFixed(3)}</td>
                <td>{order.size.toFixed(2)}</td>
                <td><Badge tone={order.status === 'failed' ? 'bad' : order.status === 'filled' ? 'good' : 'neutral'}>{order.status}</Badge></td>
                <td>{order.clobOrderId || '-'}</td>
              </tr>
            ))}
          </DataTable>
        </Panel>

        <Panel title="Fills & Settlements" className="span-12">
          <DataTable headers={['Type', 'Time', 'Round', 'Label', 'Side/Winner', 'Price/Cost', 'Size/PnL']}>
            {state.fills.slice(0, 50).map((fill) => (
              <tr key={`fill-${fill.id}`}>
                <td>fill</td>
                <td>{new Date(fill.matchedAt).toLocaleTimeString()}</td>
                <td>{fill.roundId}</td>
                <td>{fill.label}</td>
                <td>{fill.side}</td>
                <td>{fill.price.toFixed(3)}</td>
                <td>{fill.size.toFixed(2)}</td>
              </tr>
            ))}
            {state.settlements.slice(0, 50).map((settlement) => (
              <tr key={`settlement-${settlement.id}`}>
                <td>settlement</td>
                <td>{new Date(settlement.resolvedAt).toLocaleTimeString()}</td>
                <td>{settlement.roundId}</td>
                <td>{settlement.status}</td>
                <td>{settlement.winningLabel || 'pending'}</td>
                <td>{formatMoney(settlement.totalCost)}</td>
                <td>{formatMoney(settlement.pnl)}</td>
              </tr>
            ))}
          </DataTable>
        </Panel>

        <Panel title="Runtime Logs" className="span-12">
          <LogList logs={state.runtimeLogs.slice(0, 100)} />
        </Panel>
      </main>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="appShell">{children}</div>;
}

function Panel({ title, className, children }: { title: string; className?: string; children: React.ReactNode }) {
  return <section className={`panel ${className || ''}`}><h2>{title}</h2>{children}</section>;
}

function Digest({ icon, label, value, detail, tone }: { icon: React.ReactNode; label: string; value: string; detail: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }) {
  return <div className={`digestCard ${tone}`}>{icon}<span>{label}</span><strong>{value}</strong><em>{detail}</em></div>;
}

function MetricRows({ rows }: { rows: [string, string][] }) {
  return <dl className="metrics">{rows.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>;
}

function OrderbookTable({ quotes }: { quotes: OrderBookQuote[] }) {
  return (
    <DataTable headers={['Token', 'Source', 'Best Bid', 'Best Ask', 'Spread', 'Bid Depth', 'Ask Depth', 'Updated']}>
      {quotes.map((quote) => (
        <tr key={quote.tokenId}>
          <td className="mono">{quote.tokenId || '-'}</td>
          <td>{quote.source}</td>
          <td>{quote.bestBid == null ? '-' : quote.bestBid.toFixed(3)}</td>
          <td>{quote.bestAsk == null ? '-' : quote.bestAsk.toFixed(3)}</td>
          <td>{quote.spread == null ? '-' : quote.spread.toFixed(3)}</td>
          <td>{quote.bidDepth.toFixed(2)}</td>
          <td>{quote.askDepth.toFixed(2)}</td>
          <td>{new Date(quote.updatedAt).toLocaleTimeString()}</td>
        </tr>
      ))}
    </DataTable>
  );
}

function StrategyChecks({ checks }: { checks: StrategyCheck[] }) {
  return (
    <div className="checks">
      {checks.map((check) => (
        <article key={check.strategy} className="checkCard">
          <div><h3>{check.title}</h3><Badge tone={check.status === 'eligible' ? 'good' : check.status === 'blocked' ? 'bad' : 'neutral'}>{check.status}</Badge></div>
          <p>{check.reason}</p>
          <ul>{check.conditions.map((condition) => <li key={condition.label}><span>{condition.label}</span><strong className={condition.passed ? 'pass' : 'fail'}>{condition.actual}</strong></li>)}</ul>
        </article>
      ))}
    </div>
  );
}

function DataTable({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return <div className="tableWrap"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}

function LogList({ logs }: { logs: RuntimeLogRecord[] }) {
  return <div className="logs">{logs.map((log) => <div key={log.id} className={`log ${log.level}`}><span>{new Date(log.createdAt).toLocaleTimeString()}</span><strong>{log.source}</strong><p>{log.message}</p></div>)}</div>;
}

function Badge({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'neutral'; children: React.ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
