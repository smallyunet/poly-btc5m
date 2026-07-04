import type { OrderBookQuote, OrderbookDepthSnapshot } from '../../../../../packages/shared/src';
import { formatMoney, formatNumber } from '../../lib/format';
import { formatEtTime, outcomeLabel, outcomeTone, shortenTokenId } from '../../lib/dashboardFormat';
import { Badge, DataTable, DecisionMetric } from './Ui';

export function OrderbookExecutionSummary({ quotes, yesTokenId, noTokenId }: { quotes: OrderBookQuote[]; yesTokenId: string; noTokenId: string }) {
  const yesQuote = quotes.find((quote) => quote.tokenId === yesTokenId);
  const noQuote = quotes.find((quote) => quote.tokenId === noTokenId);
  const pairAskCost = yesQuote?.bestAsk != null && noQuote?.bestAsk != null ? yesQuote.bestAsk + noQuote.bestAsk : null;
  const pairEdge = pairAskCost == null ? null : 1 - pairAskCost;
  const spreadState = quotes.length === 0 ? 'UNKNOWN' : quotes.every((quote) => quote.spread != null && quote.spread <= 0.02) ? 'TIGHT' : 'WIDE';
  const yesDepth = yesQuote ? yesQuote.askDepth + yesQuote.bidDepth : 0;
  const noDepth = noQuote ? noQuote.askDepth + noQuote.bidDepth : 0;
  const depthRatio = yesDepth > 0 && noDepth > 0 ? Math.max(yesDepth, noDepth) / Math.min(yesDepth, noDepth) : null;
  const imbalanceLabel = depthRatio == null ? 'UNKNOWN' : depthRatio >= 2 ? 'IMBALANCED' : 'BALANCED';
  const newestQuoteAt = quotes.length ? Math.max(...quotes.map((quote) => toSortTime(quote.updatedAt)), 0) : 0;

  return (
    <div className="orderbookSummary">
      <DecisionMetric
        label="Pair Ask Cost"
        value={pairAskCost == null ? '-' : pairAskCost.toFixed(3)}
        detail={pairEdge == null ? 'waiting for both books' : `edge ${pairEdge.toFixed(3)}`}
        tone={pairEdge == null ? 'neutral' : pairEdge >= 0.08 ? 'good' : 'warn'}
      />
      <DecisionMetric
        label="Executable Pair"
        value={pairAskCost == null ? 'MISSING' : pairAskCost <= 0.9 ? 'AVAILABLE' : 'EXPENSIVE'}
        detail={`UP ${yesQuote?.bestAsk == null ? '-' : yesQuote.bestAsk.toFixed(3)} / DOWN ${noQuote?.bestAsk == null ? '-' : noQuote.bestAsk.toFixed(3)}`}
        tone={pairAskCost == null ? 'bad' : pairAskCost <= 0.9 ? 'good' : 'warn'}
      />
      <DecisionMetric
        label="Spread State"
        value={spreadState}
        detail={quotes.length ? quotes.map((quote) => quote.spread == null ? '-' : quote.spread.toFixed(3)).join(' / ') : 'no quotes'}
        tone={spreadState === 'TIGHT' ? 'good' : spreadState === 'WIDE' ? 'warn' : 'neutral'}
      />
      <DecisionMetric
        label="Liquidity Balance"
        value={imbalanceLabel}
        detail={depthRatio == null ? 'depth unavailable' : `${depthRatio.toFixed(2)}x depth ratio`}
        tone={imbalanceLabel === 'BALANCED' ? 'good' : imbalanceLabel === 'IMBALANCED' ? 'warn' : 'neutral'}
      />
      <DecisionMetric
        label="Book Freshness"
        value={quotes.length === 0 ? 'UNKNOWN' : quotes.every((quote) => quote.source === 'ws') ? 'LIVE WS' : 'MIXED'}
        detail={newestQuoteAt ? formatEtTime(new Date(newestQuoteAt).toISOString()) : 'not updated'}
        tone={quotes.length > 0 && quotes.every((quote) => quote.source === 'ws') ? 'good' : 'neutral'}
      />
    </div>
  );
}

export function OrderbookCapacityPanel({ depth }: { depth?: OrderbookDepthSnapshot }) {
  if (!depth) {
    return (
      <div className="orderbookCapacityBlock">
        <p className="emptyText">No orderbook depth capacity snapshot yet</p>
      </div>
    );
  }
  const activeLevel = nearestDepthLevel(depth);

  return (
    <div className="orderbookCapacityBlock">
      <div className="capacityHeader">
        <div>
          <h3>Strategy Capacity</h3>
          <p>
            Active limit {formatCapacityPrice(depth.activeLimitPrice)} / current size {formatCapacityShares(depth.baseSharesPerSide)} shares per side / {formatEtTime(depth.updatedAt)}
          </p>
        </div>
        <Badge tone={depth.status === 'ready' ? 'good' : 'warn'}>{depth.status.toUpperCase()}</Badge>
      </div>

      {depth.diagnostics.length > 0 && (
        <div className="capacityDiagnostics">
          {depth.diagnostics.map((item) => <span key={item}>{item}</span>)}
        </div>
      )}

      <div className="capacityTierGrid">
        {depth.tiers.map((tier) => (
          <DecisionMetric
            key={tier.label}
            label={tier.label}
            value={`${formatCapacityShares(tier.maxSharesPerSide)} sh`}
            detail={`~${formatMoney(tier.maxPairAmountUsd)} pair / ${formatNumber(tier.exactLevelSharePct * 100, 0)}% level cap`}
            tone={tier.tone}
          />
        ))}
      </div>

      <div className="capacityFocus">
        <DecisionMetric
          label="Active Maker Queue"
          value={formatCapacityShares(activeLevel?.minBidQueueShares ?? 0)}
          detail={`min shares at-or-above ${formatCapacityPrice(depth.activeLimitPrice)}`}
          tone={(activeLevel?.minBidQueueShares ?? 0) >= depth.baseSharesPerSide * 10 ? 'good' : 'warn'}
        />
        <DecisionMetric
          label="Same-Level Queue"
          value={formatCapacityShares(activeLevel?.minBidAtLimitShares ?? 0)}
          detail="thin side at exact active limit"
          tone={(activeLevel?.minBidAtLimitShares ?? 0) >= depth.baseSharesPerSide * 5 ? 'good' : 'warn'}
        />
        <DecisionMetric
          label="Immediate Fill"
          value={formatCapacityShares(activeLevel?.pairedImmediateShares ?? 0)}
          detail={`marketable shares at ${formatCapacityPrice(depth.activeLimitPrice)}`}
          tone={(activeLevel?.pairedImmediateShares ?? 0) > 0 ? 'warn' : 'neutral'}
        />
      </div>

      <DataTable headers={['Limit', 'Immediate Pair', 'Immediate Cost', 'Maker Queue', 'Same-Level Queue', 'Queue Ratio']}>
        {depth.levels.map((level) => (
          <tr key={level.limitPrice} className={Math.abs(level.limitPrice - depth.activeLimitPrice) < 0.000001 ? 'activeDepthRow' : undefined}>
            <td className="mono">{formatCapacityPrice(level.limitPrice)}</td>
            <td className="mono">{formatCapacityShares(level.pairedImmediateShares)} sh</td>
            <td className="mono">{formatMoney(level.pairedImmediateCostUsd)}</td>
            <td className="mono">{formatCapacityShares(level.minBidQueueShares)} sh</td>
            <td className="mono">{formatCapacityShares(level.minBidAtLimitShares)} sh</td>
            <td className="mono">{level.queueRatio == null ? '-' : `${formatNumber(level.queueRatio, 2)}x`}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

export function OrderbookTable({ quotes, yesTokenId, noTokenId }: { quotes: OrderBookQuote[]; yesTokenId: string; noTokenId: string }) {
  const maxBidDepth = Math.max(...quotes.map((q) => q.bidDepth), 1);
  const maxAskDepth = Math.max(...quotes.map((q) => q.askDepth), 1);

  return (
    <DataTable headers={['Outcome', 'Token ID', 'Data Source', 'Best Bid', 'Best Ask', 'Midpoint', 'Spread', 'Bid Liquidity (Depth)', 'Ask Liquidity (Depth)', 'Last Updated (ET)']}>
      {quotes.map((quote) => {
        const bidPct = (quote.bidDepth / maxBidDepth) * 80;
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

function nearestDepthLevel(depth: OrderbookDepthSnapshot) {
  return depth.levels.find((level) => Math.abs(level.limitPrice - depth.activeLimitPrice) < 0.000001)
    || depth.levels.reduce((closest, level) => (
      Math.abs(level.limitPrice - depth.activeLimitPrice) < Math.abs(closest.limitPrice - depth.activeLimitPrice) ? level : closest
    ), depth.levels[0]);
}

function formatCapacityPrice(value: number): string {
  return `${Math.round(value * 100)}c`;
}

function formatCapacityShares(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 1000) return `${formatNumber(value / 1000, 1)}k`;
  return formatNumber(value, value >= 100 ? 0 : 1);
}

function toSortTime(value?: string | number): number {
  if (value == null) return 0;
  const numeric = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(numeric) ? numeric : 0;
}
