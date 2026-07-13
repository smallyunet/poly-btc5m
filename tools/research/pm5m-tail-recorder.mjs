#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

import { aggregateTailResults } from './pm5m-tail-summary.mjs';

const DEFAULT_ASSETS = ['btc', 'eth', 'sol', 'doge', 'xrp', 'hype'];
const DEFAULT_GAMMA_URL = 'https://gamma-api.polymarket.com';
const DEFAULT_CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const config = {
  interval: args.interval || '5m',
  assets: args.assets || DEFAULT_ASSETS,
  checkpoints: args.checkpoints || numberListFromEnv('PM5M_TAIL_CHECKPOINTS_SECONDS', [60, 45, 30, 20, 15, 10, 5]),
  size: args.size ?? firstNumberFromEnv(['PM5M_TAIL_SIZE', 'PM5M_TAIL_SIZES'], 2),
  topLevels: args.topLevels ?? numberFromEnv('PM5M_TAIL_TOP_LEVELS', 10),
  quoteMaxAgeMs: args.quoteMaxAgeMs ?? numberFromEnv('PM5M_TAIL_QUOTE_MAX_AGE_MS', 2_500),
  outDir: path.resolve(args.outDir || `data-lab/pm-${args.interval || '5m'}-tail`),
  gammaUrl: stripTrailingSlash(args.gammaUrl || DEFAULT_GAMMA_URL),
  clobWsUrl: args.clobWsUrl || DEFAULT_CLOB_WS_URL,
  discoveryMs: args.discoveryMs ?? 30_000,
  sampleMs: args.sampleMs ?? 1_000,
  summaryMs: args.summaryMs ?? 5_000,
  lookbackHours: args.lookbackHours ?? numberFromEnv('PM5M_TAIL_LOOKBACK_HOURS', 12),
};
config.roundSeconds = config.interval === '1h' ? 3600 : config.interval === '15m' ? 900 : 300;

config.checkpoints = [...new Set(config.checkpoints.filter((value) => value > 0))].sort((a, b) => b - a);
config.size = Number.isFinite(config.size) && config.size > 0 ? config.size : 2;

const rounds = new Map();
const tokenIndex = new Map();
const historicalResults = loadHistoricalResults();
let ws;
let subscribedKey = '';
let stopping = false;
let discoveryTimer;
let sampleTimer;
let summaryTimer;

fs.mkdirSync(config.outDir, { recursive: true });

log(`starting Polymarket ${config.interval} tail-entry recorder`);
log(`assets=${config.assets.join(',')} checkpoints=${config.checkpoints.join(',')}s size=${config.size} out=${config.outDir}`);
if (historicalResults.length) log(`loaded ${historicalResults.length} historical tail result rows`);

await discoverAll();
connectWs();
summaryTimer = setInterval(() => writeSummary(), config.summaryMs);
sampleTimer = setInterval(() => sampleDueCheckpoints(), config.sampleMs);
discoveryTimer = setInterval(() => {
  void discoverAll()
    .then(() => syncSubscription())
    .then(() => finalizeExpiredRounds())
    .catch((error) => log(`discovery/finalize error: ${error.message}`));
}, config.discoveryMs);

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--interval') {
      parsed.interval = next;
      index += 1;
    }
    else if (arg === '--assets') {
      parsed.assets = String(next || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
      index += 1;
    } else if (arg === '--checkpoints') {
      parsed.checkpoints = parseNumberList(next);
      index += 1;
    } else if (arg === '--sizes') {
      parsed.size = parseNumberList(next)[0];
      index += 1;
    } else if (arg === '--size') {
      parsed.size = Number(next);
      index += 1;
    } else if (arg === '--top-levels') {
      parsed.topLevels = Number(next);
      index += 1;
    } else if (arg === '--quote-max-age-ms') {
      parsed.quoteMaxAgeMs = Number(next);
      index += 1;
    } else if (arg === '--out-dir') {
      parsed.outDir = next;
      index += 1;
    } else if (arg === '--gamma-url') {
      parsed.gammaUrl = next;
      index += 1;
    } else if (arg === '--clob-ws-url') {
      parsed.clobWsUrl = next;
      index += 1;
    } else if (arg === '--discovery-ms') {
      parsed.discoveryMs = Number(next);
      index += 1;
    } else if (arg === '--sample-ms') {
      parsed.sampleMs = Number(next);
      index += 1;
    } else if (arg === '--summary-ms') {
      parsed.summaryMs = Number(next);
      index += 1;
    } else if (arg === '--lookback-hours') {
      parsed.lookbackHours = Number(next);
      index += 1;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  npm run research:pm5m-tail -- [options]

Options:
  --assets btc,eth,sol,doge,xrp,hype
  --interval 5m|15m|1h
  --checkpoints 60,45,30,20,15,10,5
  --size 2
  --top-levels 10
  --quote-max-age-ms 2500
  --out-dir data-lab/pm-5m-tail
  --gamma-url https://gamma-api.polymarket.com
  --clob-ws-url wss://ws-subscriptions-clob.polymarket.com/ws/market
  --discovery-ms 30000
  --sample-ms 1000
  --summary-ms 5000
  --lookback-hours 12
`);
}

async function discoverAll() {
  const nowSec = Math.floor(Date.now() / 1000);
  const currentStart = Math.floor(nowSec / config.roundSeconds) * config.roundSeconds;
  const starts = [currentStart, currentStart + config.roundSeconds];
  for (const asset of config.assets) {
    for (const startSec of starts) {
      await discoverRound(asset, startSec);
    }
  }
}

async function discoverRound(asset, startSec) {
  const slug = `${asset}-updown-${config.interval}-${startSec}`;
  const key = `${asset}:${slug}`;
  if (rounds.has(key)) return;
  const market = await gammaMarket(slug);
  if (!isUsableMarket(market, slug)) return;
  const parsed = parseMarketTokens(market);
  if (!parsed.yesTokenId || !parsed.noTokenId) return;

  const round = {
    asset,
    slug,
    title: String(market.question || slug),
    startAt: new Date(startSec * 1000).toISOString(),
    endAt: new Date((startSec + config.roundSeconds) * 1000).toISOString(),
    yesTokenId: parsed.yesTokenId,
    noTokenId: parsed.noTokenId,
    firstSeenAt: new Date().toISOString(),
    finalized: false,
    winner: null,
    quotes: {
      YES: emptyQuote(parsed.yesTokenId),
      NO: emptyQuote(parsed.noTokenId),
    },
    samples: {},
  };
  rounds.set(key, round);
  tokenIndex.set(parsed.yesTokenId, { key, side: 'YES' });
  tokenIndex.set(parsed.noTokenId, { key, side: 'NO' });
  appendNdjson('rounds.ndjson', {
    type: 'round_discovered',
    recordedAt: new Date().toISOString(),
    asset,
    slug,
    title: round.title,
    startAt: round.startAt,
    endAt: round.endAt,
    yesTokenId: parsed.yesTokenId,
    noTokenId: parsed.noTokenId,
  });
  log(`discovered ${asset} ${slug}`);
}

async function gammaMarket(slug) {
  const url = `${config.gammaUrl}/markets/slug/${encodeURIComponent(slug)}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function isUsableMarket(market, expectedSlug) {
  if (!market || String(market.slug || '') !== expectedSlug) return false;
  const tokenIds = parseStringArray(market.clobTokenIds);
  const outcomes = parseStringArray(market.outcomes).map((item) => item.toLowerCase());
  return tokenIds.length >= 2 && outcomes.includes('up') && outcomes.includes('down');
}

function parseMarketTokens(market) {
  const tokenIds = parseStringArray(market.clobTokenIds);
  const outcomes = parseStringArray(market.outcomes).map((item) => item.toLowerCase());
  const upIndex = outcomes.indexOf('up');
  const downIndex = outcomes.indexOf('down');
  return {
    yesTokenId: tokenIds[upIndex >= 0 ? upIndex : 0],
    noTokenId: tokenIds[downIndex >= 0 ? downIndex : 1],
  };
}

function connectWs() {
  if (stopping || ws) return;
  ws = new WebSocket(config.clobWsUrl);
  ws.on('open', () => {
    log('CLOB market websocket connected');
    syncSubscription(true);
  });
  ws.on('message', (data) => handleOrderbookMessage(data.toString()));
  ws.on('close', () => {
    ws = undefined;
    subscribedKey = '';
    if (!stopping) setTimeout(connectWs, 5_000).unref?.();
  });
  ws.on('error', (error) => {
    log(`CLOB websocket error: ${error.message}`);
  });
}

function syncSubscription(force = false) {
  const tokenIds = [...tokenIndex.keys()].sort();
  const nextKey = tokenIds.join('|');
  if (!force && nextKey === subscribedKey) return;
  subscribedKey = nextKey;
  if (!ws || ws.readyState !== WebSocket.OPEN || tokenIds.length < 2) return;
  ws.send(JSON.stringify({
    type: 'market',
    assets_ids: tokenIds,
    custom_feature_enabled: true,
  }));
  log(`subscribed ${tokenIds.length} token orderbooks`);
}

function handleOrderbookMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      const tokenId = String(message.asset_id || message.token_id || message.tokenId || '');
      if (!tokenId) continue;
      if (Array.isArray(message.asks) || Array.isArray(message.bids)) {
        updateQuote(tokenId, {
          asks: normalizeLevels(message.asks, 'ask'),
          bids: normalizeLevels(message.bids, 'bid'),
        });
        continue;
      }
      if (message.event_type === 'best_bid_ask') {
        updateQuote(tokenId, {
          bestBid: finiteNumber(message.best_bid),
          bestAsk: finiteNumber(message.best_ask),
        });
        continue;
      }
      if (message.event_type === 'price_change' && Array.isArray(message.price_changes)) {
        for (const change of message.price_changes) {
          updateQuote(String(change.asset_id || ''), {
            bestBid: finiteNumber(change.best_bid),
            bestAsk: finiteNumber(change.best_ask),
          });
        }
      }
    }
  } catch {
    // Ignore malformed frames from the public stream.
  }
}

function updateQuote(tokenId, update) {
  const indexed = tokenIndex.get(tokenId);
  if (!indexed) return;
  const round = rounds.get(indexed.key);
  if (!round || round.finalized) return;
  const quote = round.quotes[indexed.side];
  if (Array.isArray(update.asks) && update.asks.length) quote.asks = update.asks.slice(0, config.topLevels);
  if (Array.isArray(update.bids) && update.bids.length) quote.bids = update.bids.slice(0, config.topLevels);
  if (update.bestAsk != null) quote.bestAsk = update.bestAsk;
  else if (quote.asks.length) quote.bestAsk = quote.asks[0].price;
  if (update.bestBid != null) quote.bestBid = update.bestBid;
  else if (quote.bids.length) quote.bestBid = quote.bids[0].price;
  quote.spread = quote.bestAsk != null && quote.bestBid != null ? roundMoney(quote.bestAsk - quote.bestBid) : null;
  quote.updatedAt = new Date().toISOString();
}

function sampleDueCheckpoints() {
  const now = Date.now();
  for (const round of rounds.values()) {
    if (round.finalized) continue;
    const startMs = Date.parse(round.startAt);
    const endMs = Date.parse(round.endAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || now < startMs || now > endMs) continue;
    const secondsToEnd = (endMs - now) / 1000;
    for (const checkpoint of config.checkpoints) {
      const key = String(checkpoint);
      if (round.samples[key] || secondsToEnd > checkpoint || secondsToEnd <= 0) continue;
      const sample = buildSample(round, checkpoint, now);
      round.samples[key] = sample;
      appendNdjson('samples.ndjson', sample);
    }
  }
  writeSummary();
}

function buildSample(round, checkpoint, nowMs) {
  const yes = quoteSnapshot(round.quotes.YES, nowMs);
  const no = quoteSnapshot(round.quotes.NO, nowMs);
  const selectedSide = selectStrongSide(yes, no);
  const selectedQuote = selectedSide === 'YES' ? yes : selectedSide === 'NO' ? no : null;
  const fill = selectedQuote ? buyVwap(selectedQuote.asks, config.size) : null;
  const fillable = Boolean(fill?.fillable);
  const vwap = fill?.vwap ?? null;
  const status = selectedSide == null
    ? 'quote_missing'
    : fillable
      ? 'sampled'
      : 'insufficient_depth';
  return {
    type: 'tail_sample',
    recordedAt: new Date(nowMs).toISOString(),
    asset: round.asset,
    slug: round.slug,
    title: round.title,
    startAt: round.startAt,
    endAt: round.endAt,
    checkpointSeconds: checkpoint,
    secondsToEnd: roundMoney((Date.parse(round.endAt) - nowMs) / 1000),
    status,
    selectedSide,
    yes,
    no,
    overroundAsk: yes.bestAsk != null && no.bestAsk != null ? roundMoney(yes.bestAsk + no.bestAsk) : null,
    overroundBid: yes.bestBid != null && no.bestBid != null ? roundMoney(yes.bestBid + no.bestBid) : null,
    size: config.size,
    fillable,
    vwap,
    cost: fill?.cost ?? null,
    filledShares: fill?.filledShares ?? 0,
    slippage: vwap != null && selectedQuote?.bestAsk != null ? roundMoney(vwap - selectedQuote.bestAsk) : null,
  };
}

function quoteSnapshot(quote, nowMs) {
  const updatedMs = quote.updatedAt ? Date.parse(quote.updatedAt) : NaN;
  const ageMs = Number.isFinite(updatedMs) ? nowMs - updatedMs : null;
  const stale = ageMs == null || ageMs > config.quoteMaxAgeMs;
  return {
    tokenId: quote.tokenId,
    bestBid: quote.bestBid,
    bestAsk: quote.bestAsk,
    midpoint: quote.bestBid != null && quote.bestAsk != null ? roundMoney((quote.bestBid + quote.bestAsk) / 2) : null,
    spread: quote.spread,
    updatedAt: quote.updatedAt,
    ageMs,
    stale,
    bids: quote.bids,
    asks: quote.asks,
  };
}

function selectStrongSide(yes, no) {
  if (yes.stale || no.stale || yes.midpoint == null || no.midpoint == null) return null;
  if (yes.midpoint > no.midpoint) return 'YES';
  if (no.midpoint > yes.midpoint) return 'NO';
  if (yes.bestAsk != null && no.bestAsk != null) return yes.bestAsk >= no.bestAsk ? 'YES' : 'NO';
  return null;
}

function buyVwap(asks, targetSize) {
  let remaining = targetSize;
  let cost = 0;
  for (const level of asks) {
    if (remaining <= 0) break;
    const shares = Math.min(remaining, level.size);
    cost += shares * level.price;
    remaining -= shares;
  }
  const filledShares = roundMoney(targetSize - remaining);
  return {
    fillable: remaining <= 0.000001,
    filledShares,
    cost: roundMoney(cost),
    vwap: filledShares > 0 ? roundMoney(cost / filledShares) : null,
  };
}

async function finalizeExpiredRounds() {
  const now = Date.now();
  for (const round of rounds.values()) {
    if (round.finalized || now < Date.parse(round.endAt) + 1_000) continue;
    const market = await gammaMarket(round.slug);
    const winner = winnerFromMarket(market);
    if (!winner) continue;
    round.finalized = true;
    round.winner = winner;
    const results = resultRowsForRound(round);
    for (const result of results) appendNdjson('tail-results.ndjson', result);
    log(`finalized ${round.asset} ${round.slug} winner=${winner}`);
  }
  writeSummary();
}

function winnerFromMarket(market) {
  const outcomes = parseStringArray(market?.outcomes).map((item) => item.toLowerCase());
  const prices = parseStringArray(market?.outcomePrices).map(Number);
  if (!outcomes.length || !prices.length) return null;
  const upIndex = outcomes.indexOf('up');
  const downIndex = outcomes.indexOf('down');
  const upPrice = prices[upIndex >= 0 ? upIndex : 0];
  const downPrice = prices[downIndex >= 0 ? downIndex : 1];
  if (upPrice === 1) return 'YES';
  if (downPrice === 1) return 'NO';
  return null;
}

function resultRowsForRound(round) {
  const rows = [];
  for (const sample of Object.values(round.samples)) {
    const pnlPerShare = sample.fillable && sample.selectedSide && sample.vwap != null
      ? roundMoney((sample.selectedSide === round.winner ? 1 : 0) - sample.vwap)
      : null;
    rows.push({
      type: 'tail_result',
      recordedAt: new Date().toISOString(),
      asset: round.asset,
      slug: round.slug,
      title: round.title,
      startAt: round.startAt,
      endAt: round.endAt,
      checkpointSeconds: sample.checkpointSeconds,
      selectedSide: sample.selectedSide,
      winner: round.winner,
      selectedWon: sample.fillable && sample.selectedSide != null ? sample.selectedSide === round.winner : null,
      size: sample.size ?? config.size,
      fillable: sample.fillable,
      vwap: sample.vwap,
      cost: sample.cost,
      filledShares: sample.filledShares,
      slippage: sample.slippage,
      selectedBestAsk: sample.selectedSide === 'YES' ? sample.yes.bestAsk : sample.selectedSide === 'NO' ? sample.no.bestAsk : null,
      selectedMidpoint: sample.selectedSide === 'YES' ? sample.yes.midpoint : sample.selectedSide === 'NO' ? sample.no.midpoint : null,
      selectedSpread: sample.selectedSide === 'YES' ? sample.yes.spread : sample.selectedSide === 'NO' ? sample.no.spread : null,
      midpointGap: sample.yes.midpoint != null && sample.no.midpoint != null ? roundMoney(Math.abs(sample.yes.midpoint - sample.no.midpoint)) : null,
      overroundAsk: sample.overroundAsk,
      pnlPerShare,
      pnl: pnlPerShare == null ? null : roundMoney(pnlPerShare * (sample.size ?? config.size)),
    });
  }
  return rows;
}

function writeSummary() {
  const currentResults = [];
  for (const round of rounds.values()) {
    if (round.finalized) currentResults.push(...resultRowsForRound(round));
  }
  const allResults = uniqueResults([...historicalResults, ...currentResults]);
  const windowStartMs = config.lookbackHours > 0 ? Date.now() - config.lookbackHours * 60 * 60 * 1000 : null;
  const windowResults = windowStartMs == null
    ? allResults
    : allResults.filter((row) => rowStartMs(row) == null || rowStartMs(row) >= windowStartMs);
  const summary = {
    ok: true,
    model: 'tail-entry orderbook VWAP',
    generatedAt: new Date().toISOString(),
    config: {
      assets: config.assets,
      interval: config.interval,
      checkpoints: config.checkpoints,
      size: config.size,
      topLevels: config.topLevels,
      quoteMaxAgeMs: config.quoteMaxAgeMs,
      lookbackHours: config.lookbackHours,
      lookbackStartAt: windowStartMs == null ? null : new Date(windowStartMs).toISOString(),
      gammaUrl: config.gammaUrl,
      clobWsUrl: config.clobWsUrl,
    },
    status: {
      websocketConnected: ws?.readyState === WebSocket.OPEN,
      subscribedTokens: subscribedKey ? subscribedKey.split('|').filter(Boolean).length : 0,
      activeRounds: [...rounds.values()].filter((round) => !round.finalized).length,
      sampledRounds: new Set(allResults.map((row) => `${row.asset}:${row.slug}`)).size,
      completedRows: windowResults.length,
      completedAllTimeRows: allResults.length,
      historicalRows: historicalResults.length,
    },
    active: activeSummary(),
    completed: aggregateTailResults(windowResults),
    completedAllTime: aggregateTailResults(allResults),
    recentRounds: [...rounds.values()]
      .sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt))
      .slice(0, 30)
      .map((round) => ({
        asset: round.asset,
        slug: round.slug,
        title: round.title,
        startAt: round.startAt,
        endAt: round.endAt,
        finalized: round.finalized,
        winner: round.winner,
        samples: Object.values(round.samples)
          .sort((a, b) => b.checkpointSeconds - a.checkpointSeconds)
          .map((sample) => ({
            recordedAt: sample.recordedAt,
            checkpointSeconds: sample.checkpointSeconds,
            status: sample.status,
            selectedSide: sample.selectedSide,
            yesMidpoint: sample.yes.midpoint,
            noMidpoint: sample.no.midpoint,
            selectedBestAsk: sample.selectedSide === 'YES' ? sample.yes.bestAsk : sample.selectedSide === 'NO' ? sample.no.bestAsk : null,
            overroundAsk: sample.overroundAsk,
            size: sample.size ?? config.size,
            fillable: sample.fillable,
            vwap: sample.vwap,
            cost: sample.cost,
            filledShares: sample.filledShares,
            slippage: sample.slippage,
          })),
      })),
  };
  writeJsonAtomic('summary.json', summary);
}

function activeSummary() {
  const activeRounds = [...rounds.values()].filter((round) => !round.finalized);
  const samples = activeRounds.flatMap((round) => Object.values(round.samples));
  return {
    rounds: activeRounds.length,
    samples: samples.length,
    latestSampleAt: samples.map((sample) => sample.recordedAt).sort().at(-1) || null,
  };
}

function loadHistoricalResults() {
  const filePath = path.join(config.outDir, 'tail-results.ndjson');
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  const allowedAssets = new Set(config.assets);
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const row = parseHistoricalResult(line);
      if (!row || !allowedAssets.has(row.asset)) continue;
      rows.push(row);
    }
  } catch (error) {
    log(`failed to load historical tail results: ${error.message}`);
  }
  return uniqueResults(rows);
}

function parseHistoricalResult(line) {
  try {
    const row = JSON.parse(line);
    const asset = String(row.asset || '').trim().toLowerCase();
    const slug = String(row.slug || '').trim();
    const checkpointSeconds = finiteNumber(row.checkpointSeconds);
    const size = finiteNumber(row.size) ?? config.size;
    if (!asset || !slug || checkpointSeconds == null) return null;
    return {
      ...row,
      asset,
      slug,
      checkpointSeconds,
      size,
      fillable: Boolean(row.fillable),
      selectedWon: row.selectedWon == null ? null : Boolean(row.selectedWon),
      vwap: finiteNumber(row.vwap),
      pnlPerShare: finiteNumber(row.pnlPerShare),
      pnl: finiteNumber(row.pnl),
      selectedBestAsk: finiteNumber(row.selectedBestAsk),
      selectedSpread: finiteNumber(row.selectedSpread),
      overroundAsk: finiteNumber(row.overroundAsk),
    };
  } catch {
    return null;
  }
}

function uniqueResults(rows) {
  const byKey = new Map();
  for (const row of rows) byKey.set(resultKey(row), row);
  return [...byKey.values()];
}

function resultKey(row) {
  return `${row.asset}:${row.slug}:${row.checkpointSeconds}`;
}

function rowStartMs(row) {
  const value = typeof row.startAt === 'string' ? Date.parse(row.startAt) : NaN;
  return Number.isFinite(value) ? value : null;
}

function emptyQuote(tokenId) {
  return {
    tokenId,
    bestBid: null,
    bestAsk: null,
    midpoint: null,
    spread: null,
    updatedAt: null,
    bids: [],
    asks: [],
  };
}

function normalizeLevels(levels, side) {
  if (!Array.isArray(levels)) return [];
  const normalized = levels.map((level) => ({
    price: finiteNumber(level?.price),
    size: finiteNumber(level?.size),
  })).filter((level) => level.price != null && level.size != null && level.price > 0 && level.size > 0);
  return normalized.sort((a, b) => side === 'ask' ? a.price - b.price : b.price - a.price);
}

function parseStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item ?? '').trim()).filter(Boolean);
  } catch {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function parseNumberList(value) {
  return String(value || '').split(',').map((item) => Number(item.trim())).filter(Number.isFinite);
}

function numberListFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseNumberList(raw);
  return parsed.length ? parsed : fallback;
}

function firstNumberFromEnv(names, fallback) {
  for (const name of names) {
    const parsed = parseNumberList(process.env[name]);
    if (parsed.length) return parsed[0];
  }
  return fallback;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberFromEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function appendNdjson(filename, value) {
  fs.appendFileSync(path.join(config.outDir, filename), `${JSON.stringify(value)}\n`);
}

function writeJsonAtomic(filename, value) {
  const target = path.join(config.outDir, filename);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
}

function roundMoney(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function log(message) {
  console.log(`[pm5m-tail] ${new Date().toISOString()} ${message}`);
}

function shutdown() {
  stopping = true;
  clearInterval(discoveryTimer);
  clearInterval(sampleTimer);
  clearInterval(summaryTimer);
  void finalizeExpiredRounds().finally(() => {
    writeSummary();
    if (ws) ws.close();
    log('stopped');
    process.exit(0);
  });
}
