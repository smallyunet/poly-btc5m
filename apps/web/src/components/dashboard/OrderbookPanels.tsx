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
  const pairState = pairAskCost == null ? 'MISSING' : pairAskCost <= 0.9 ? 'AVAILABLE' : 'EXPENSIVE';
  const pairTone = pairAskCost == null ? 'bad' : pairAskCost <= 0.9 ? 'good' : 'warn';
  const bookState = quotes.length === 0 ? 'UNKNOWN' : quotes.every((quote) => quote.source === 'ws') ? 'LIVE WS' : 'MIXED';

  return (
    <section className="orderbookHero" aria-label="Orderbook execution summary">
      <div className={`orderbookHeroPrimary ${pairTone}`}>
        <span>Executable Pair</span>
        <strong>{pairState}</strong>
        <p>
          Pair ask cost {pairAskCost == null ? '-' : pairAskCost.toFixed(3)}
          {pairEdge == null ? ' / waiting for both books' : ` / edge ${pairEdge.toFixed(3)}`}
        </p>
        <div className="quotePairStrip">
          <span>UP ask <strong>{yesQuote?.bestAsk == null ? '-' : yesQuote.bestAsk.toFixed(3)}</strong></span>
          <span>DOWN ask <strong>{noQuote?.bestAsk == null ? '-' : noQuote.bestAsk.toFixed(3)}</strong></span>
        </div>
      </div>
      <div className="orderbookHeroMetrics">
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
          value={bookState}
          detail={newestQuoteAt ? formatEtTime(new Date(newestQuoteAt).toISOString()) : 'not updated'}
          tone={quotes.length > 0 && quotes.every((quote) => quote.source === 'ws') ? 'good' : 'neutral'}
        />
      </div>
    </section>
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
  const makerCoverage = (activeLevel?.minBidQueueShares ?? 0) / Math.max(depth.baseSharesPerSide, 1);
  const sameLevelCoverage = (activeLevel?.minBidAtLimitShares ?? 0) / Math.max(depth.baseSharesPerSide, 1);
  const immediateShares = activeLevel?.pairedImmediateShares ?? 0;

  return (
    <div className="orderbookCapacityBlock">
      <div className="capacityHeader">
        <div>
          <span className="sectionKicker">Depth at Active Limit</span>
          <h3>{formatCapacityPrice(depth.activeLimitPrice)} execution capacity</h3>
          <p>
            Current size {formatCapacityShares(depth.baseSharesPerSide)} shares per side / refreshed {formatEtTime(depth.updatedAt)}
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
          <div key={tier.label} className={`capacityTier ${tier.tone}`}>
            <span>{tier.label}</span>
            <strong>{formatCapacityShares(tier.maxSharesPerSide)} sh</strong>
            <em>{formatMoney(tier.maxPairAmountUsd)} pair</em>
            <div className="capacityMeter" aria-hidden="true">
              <span style={{ width: `${Math.min(tier.exactLevelSharePct * 100, 100)}%` }}></span>
            </div>
            <small>{formatNumber(tier.exactLevelSharePct * 100, 0)}% of level cap</small>
          </div>
        ))}
      </div>

      <div className="capacityFocus">
        <DecisionMetric
          label="Active Maker Queue"
          value={formatCapacityShares(activeLevel?.minBidQueueShares ?? 0)}
          detail={`${formatNumber(makerCoverage, 1)}x current size at-or-above ${formatCapacityPrice(depth.activeLimitPrice)}`}
          tone={makerCoverage >= 10 ? 'good' : 'warn'}
        />
        <DecisionMetric
          label="Same-Level Queue"
          value={formatCapacityShares(activeLevel?.minBidAtLimitShares ?? 0)}
          detail={`${formatNumber(sameLevelCoverage, 1)}x current size at exact active limit`}
          tone={sameLevelCoverage >= 5 ? 'good' : 'warn'}
        />
        <DecisionMetric
          label="Immediate Fill"
          value={formatCapacityShares(immediateShares)}
          detail={`marketable shares at ${formatCapacityPrice(depth.activeLimitPrice)}`}
          tone={immediateShares > 0 ? 'warn' : 'neutral'}
        />
      </div>

      <DataTable headers={['Limit', 'Immediate Pair', 'Immediate Cost', 'Maker Queue', 'Same-Level Queue', 'Queue Ratio']} className="capacityDepthTable">
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
    <section className="quoteMatrix" aria-label="Outcome orderbook quotes">
      <div className="quoteMatrixHeader">
        <div>
          <span className="sectionKicker">Outcome Books</span>
          <h3>UP / DOWN quote health</h3>
        </div>
        <span>{quotes.length} books</span>
      </div>
      <DataTable headers={['Outcome', 'Token ID', 'Source', 'Bid', 'Ask', 'Mid', 'Spread', 'Bid Depth', 'Ask Depth', 'Updated']} className="quoteTable">
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
    </section>
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
