export function aggregateTailResults(rows) {
  return {
    rows: rows.length,
    byCheckpoint: aggregateBy(rows, (row) => `${row.checkpointSeconds}`, (row) => ({ checkpointSeconds: row.checkpointSeconds })),
    byAssetCheckpoint: aggregateBy(rows, (row) => `${row.asset}:${row.checkpointSeconds}`, (row) => ({ asset: row.asset, checkpointSeconds: row.checkpointSeconds })),
    byAskBand: aggregateBy(rows, (row) => `${row.checkpointSeconds}:${askBand(row.vwap)}`, (row) => ({ checkpointSeconds: row.checkpointSeconds, askBand: askBand(row.vwap) })),
    byAssetAskBand: aggregateBy(rows, (row) => `${row.asset}:${row.checkpointSeconds}:${askBand(row.vwap)}`, (row) => ({ asset: row.asset, checkpointSeconds: row.checkpointSeconds, askBand: askBand(row.vwap) })),
  };
}

export function askBand(value) {
  if (value == null) return 'missing';
  if (value < 0.55) return '<55c';
  if (value < 0.65) return '55-65c';
  if (value < 0.75) return '65-75c';
  if (value < 0.85) return '75-85c';
  return '85c+';
}

function aggregateBy(rows, keyFn, seedFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const item = map.get(key) || {
      ...seedFn(row), rows: 0, fillable: 0, wins: 0, totalPnl: 0, totalPnlPerShare: 0,
      totalVwap: 0, totalSpread: 0, totalOverroundAsk: 0, vwapCount: 0, spreadCount: 0, overroundCount: 0,
    };
    item.rows += 1;
    if (row.fillable) item.fillable += 1;
    if (row.fillable && row.selectedWon) item.wins += 1;
    if (row.pnl != null) item.totalPnl += row.pnl;
    if (row.pnlPerShare != null) item.totalPnlPerShare += row.pnlPerShare;
    if (row.vwap != null) { item.totalVwap += row.vwap; item.vwapCount += 1; }
    if (row.selectedSpread != null) { item.totalSpread += row.selectedSpread; item.spreadCount += 1; }
    if (row.overroundAsk != null) { item.totalOverroundAsk += row.overroundAsk; item.overroundCount += 1; }
    map.set(key, item);
  }
  return [...map.values()].map((item) => ({
    ...item,
    fillRate: roundRatio(item.rows ? item.fillable / item.rows : null),
    winRate: roundRatio(item.fillable ? item.wins / item.fillable : null),
    avgVwap: roundMoneyOrNull(item.vwapCount ? item.totalVwap / item.vwapCount : null),
    avgSpread: roundMoneyOrNull(item.spreadCount ? item.totalSpread / item.spreadCount : null),
    avgOverroundAsk: roundMoneyOrNull(item.overroundCount ? item.totalOverroundAsk / item.overroundCount : null),
    avgPnlPerShare: roundMoneyOrNull(item.fillable ? item.totalPnlPerShare / item.fillable : null),
    totalPnl: roundMoney(item.totalPnl),
  })).sort((a, b) => String(a.asset || '').localeCompare(String(b.asset || '')) || (b.checkpointSeconds - a.checkpointSeconds) || String(a.askBand || '').localeCompare(String(b.askBand || '')));
}

function roundRatio(value) {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 10_000) / 10_000;
}

function roundMoney(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundMoneyOrNull(value) {
  return value == null || !Number.isFinite(value) ? null : roundMoney(value);
}
