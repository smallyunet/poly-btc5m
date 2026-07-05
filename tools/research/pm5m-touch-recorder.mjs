#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const DEFAULT_ASSETS = ['btc', 'eth', 'sol', 'doge', 'xrp', 'hype'];
const ROUND_SECONDS = 300;
const DEFAULT_GAMMA_URL = 'https://gamma-api.polymarket.com';
const DEFAULT_CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const config = {
  assets: args.assets || DEFAULT_ASSETS,
  minPrice: args.minPrice ?? 0.29,
  maxPrice: args.maxPrice ?? 0.49,
  step: args.step ?? 0.01,
  outDir: path.resolve(args.outDir || 'data-lab/pm-5m-touch'),
  gammaUrl: stripTrailingSlash(args.gammaUrl || DEFAULT_GAMMA_URL),
  clobWsUrl: args.clobWsUrl || DEFAULT_CLOB_WS_URL,
  discoveryMs: args.discoveryMs ?? 30_000,
  summaryMs: args.summaryMs ?? 5_000,
};

const priceLevels = buildPriceLevels(config.minPrice, config.maxPrice, config.step);
const rounds = new Map();
const tokenIndex = new Map();
let ws;
let subscribedKey = '';
let stopping = false;
let discoveryTimer;
let summaryTimer;

fs.mkdirSync(config.outDir, { recursive: true });

log(`starting Polymarket 5m touch recorder`);
log(`assets=${config.assets.join(',')} prices=${priceLevels.map((price) => cents(price)).join(',')} out=${config.outDir}`);

await discoverAll();
connectWs();
summaryTimer = setInterval(() => writeSummary(), config.summaryMs);
discoveryTimer = setInterval(() => {
  void discoverAll().then(() => syncSubscription()).catch((error) => log(`discovery error: ${error.message}`));
  finalizeExpiredRounds();
}, config.discoveryMs);

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--assets') {
      parsed.assets = String(next || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
      index += 1;
    } else if (arg === '--min-price') {
      parsed.minPrice = Number(next);
      index += 1;
    } else if (arg === '--max-price') {
      parsed.maxPrice = Number(next);
      index += 1;
    } else if (arg === '--step') {
      parsed.step = Number(next);
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
    } else if (arg === '--summary-ms') {
      parsed.summaryMs = Number(next);
      index += 1;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  npm run research:pm5m-touch -- [options]

Options:
  --assets btc,eth,sol,doge,xrp,hype
  --min-price 0.29
  --max-price 0.49
  --step 0.01
  --out-dir data-lab/pm-5m-touch
  --gamma-url https://gamma-api.polymarket.com
  --clob-ws-url wss://ws-subscriptions-clob.polymarket.com/ws/market
  --discovery-ms 30000
  --summary-ms 5000
`);
}

async function discoverAll() {
  const nowSec = Math.floor(Date.now() / 1000);
  const currentStart = Math.floor(nowSec / ROUND_SECONDS) * ROUND_SECONDS;
  const starts = [currentStart, currentStart + ROUND_SECONDS, currentStart + ROUND_SECONDS * 2];
  for (const asset of config.assets) {
    for (const startSec of starts) {
      await discoverRound(asset, startSec);
    }
  }
}

async function discoverRound(asset, startSec) {
  const slug = `${asset}-updown-5m-${startSec}`;
  const key = `${asset}:${slug}`;
  if (rounds.has(key)) return;
  const market = await gammaMarket(slug);
  if (!isUsableMarket(market, slug)) return;
  const tokenIds = parseStringArray(market.clobTokenIds);
  const outcomes = parseStringArray(market.outcomes).map((item) => item.toLowerCase());
  const upIndex = outcomes.indexOf('up');
  const downIndex = outcomes.indexOf('down');
  const yesTokenId = tokenIds[upIndex >= 0 ? upIndex : 0];
  const noTokenId = tokenIds[downIndex >= 0 ? downIndex : 1];
  if (!yesTokenId || !noTokenId) return;

  const round = {
    asset,
    slug,
    title: String(market.question || slug),
    startAt: new Date(startSec * 1000).toISOString(),
    endAt: new Date((startSec + ROUND_SECONDS) * 1000).toISOString(),
    yesTokenId,
    noTokenId,
    firstSeenAt: new Date().toISOString(),
    finalized: false,
    levels: Object.fromEntries(priceLevels.map((price) => [priceKey(price), {
      price,
      yesTouched: false,
      noTouched: false,
      yesFirstTouchAt: null,
      noFirstTouchAt: null,
      yesBestAsk: null,
      noBestAsk: null,
    }])),
  };
  rounds.set(key, round);
  tokenIndex.set(yesTokenId, { key, side: 'YES' });
  tokenIndex.set(noTokenId, { key, side: 'NO' });
  appendNdjson('rounds.ndjson', {
    type: 'round_discovered',
    recordedAt: new Date().toISOString(),
    asset,
    slug,
    title: round.title,
    startAt: round.startAt,
    endAt: round.endAt,
    yesTokenId,
    noTokenId,
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
  if (!market || market.active === false || market.closed === true) return false;
  if (String(market.slug || '') !== expectedSlug) return false;
  const tokenIds = parseStringArray(market.clobTokenIds);
  const outcomes = parseStringArray(market.outcomes).map((item) => item.toLowerCase());
  return tokenIds.length >= 2 && outcomes.includes('up') && outcomes.includes('down');
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
      if (tokenId && Array.isArray(message.asks)) {
        recordBestAsk(tokenId, bestAskFromLevels(message.asks));
        continue;
      }
      if (tokenId && message.event_type === 'best_bid_ask') {
        recordBestAsk(tokenId, finiteNumber(message.best_ask));
        continue;
      }
      if (message.event_type === 'price_change' && Array.isArray(message.price_changes)) {
        for (const change of message.price_changes) {
          recordBestAsk(String(change.asset_id || ''), finiteNumber(change.best_ask));
        }
      }
    }
  } catch {
    // Ignore malformed frames from the public stream.
  }
}

function recordBestAsk(tokenId, bestAsk) {
  if (!tokenId || bestAsk == null) return;
  const indexed = tokenIndex.get(tokenId);
  if (!indexed) return;
  const round = rounds.get(indexed.key);
  if (!round || round.finalized) return;
  const now = new Date();
  const nowIso = now.toISOString();
  if (now < new Date(round.startAt) || now > new Date(round.endAt)) return;

  let touchedAny = false;
  for (const level of Object.values(round.levels)) {
    if (bestAsk > level.price + 0.000001) continue;
    if (indexed.side === 'YES' && !level.yesTouched) {
      level.yesTouched = true;
      level.yesFirstTouchAt = nowIso;
      level.yesBestAsk = bestAsk;
      touchedAny = true;
    }
    if (indexed.side === 'NO' && !level.noTouched) {
      level.noTouched = true;
      level.noFirstTouchAt = nowIso;
      level.noBestAsk = bestAsk;
      touchedAny = true;
    }
  }
  if (touchedAny) {
    appendNdjson('touches.ndjson', {
      type: 'touch',
      recordedAt: nowIso,
      asset: round.asset,
      slug: round.slug,
      side: indexed.side,
      tokenId,
      bestAsk,
    });
    writeSummary();
  }
}

function finalizeExpiredRounds() {
  const now = Date.now();
  for (const round of rounds.values()) {
    if (round.finalized || now < new Date(round.endAt).getTime() + 1_000) continue;
    round.finalized = true;
    const results = resultRowsForRound(round);
    for (const result of results) appendNdjson('round-results.ndjson', result);
    log(`finalized ${round.asset} ${round.slug}`);
  }
  writeSummary();
}

function resultRowsForRound(round) {
  return Object.values(round.levels).map((level) => {
    const outcome = level.yesTouched && level.noTouched
      ? 'paired'
      : level.yesTouched || level.noTouched
        ? 'single'
        : 'none';
    return {
      type: 'round_result',
      recordedAt: new Date().toISOString(),
      asset: round.asset,
      slug: round.slug,
      title: round.title,
      startAt: round.startAt,
      endAt: round.endAt,
      price: level.price,
      yesTouched: level.yesTouched,
      noTouched: level.noTouched,
      yesFirstTouchAt: level.yesFirstTouchAt,
      noFirstTouchAt: level.noFirstTouchAt,
      outcome,
      pairedProfitPerShare: roundMoney(1 - 2 * level.price),
      singleLossPerShare: level.price,
      breakevenSingleRate: roundRatio((1 - 2 * level.price) / (1 - level.price)),
    };
  });
}

function writeSummary() {
  const completedResults = [];
  const activeResults = [];
  for (const round of rounds.values()) {
    const target = round.finalized ? completedResults : activeResults;
    target.push(...resultRowsForRound(round));
  }

  const summary = {
    ok: true,
    model: 'bestAsk touch-fill',
    generatedAt: new Date().toISOString(),
    config: {
      assets: config.assets,
      interval: '5m',
      minPrice: config.minPrice,
      maxPrice: config.maxPrice,
      step: config.step,
      priceLevels,
      gammaUrl: config.gammaUrl,
      clobWsUrl: config.clobWsUrl,
    },
    status: {
      websocketConnected: ws?.readyState === WebSocket.OPEN,
      subscribedTokens: subscribedKey ? subscribedKey.split('|').filter(Boolean).length : 0,
      activeRounds: [...rounds.values()].filter((round) => !round.finalized).length,
      completedRounds: [...rounds.values()].filter((round) => round.finalized).length,
    },
    active: aggregate(activeResults),
    completed: aggregate(completedResults),
    recentRounds: [...rounds.values()]
      .sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime())
      .slice(0, 30)
      .map((round) => ({
        asset: round.asset,
        slug: round.slug,
        title: round.title,
        startAt: round.startAt,
        endAt: round.endAt,
        finalized: round.finalized,
        levels: Object.values(round.levels).map((level) => ({
          price: level.price,
          outcome: level.yesTouched && level.noTouched ? 'paired' : level.yesTouched || level.noTouched ? 'single' : 'none',
          yesTouched: level.yesTouched,
          noTouched: level.noTouched,
        })),
      })),
  };
  writeJsonAtomic('summary.json', summary);
}

function aggregate(rows) {
  const byAssetPrice = new Map();
  const byPrice = new Map();
  for (const row of rows) {
    addAggregate(byAssetPrice, `${row.asset}:${priceKey(row.price)}`, row);
    addAggregate(byPrice, priceKey(row.price), row);
  }
  return {
    rounds: new Set(rows.map((row) => `${row.asset}:${row.slug}`)).size,
    rows: rows.length,
    byPrice: [...byPrice.values()].sort((a, b) => a.price - b.price).map(finalizeAggregate),
    byAssetPrice: [...byAssetPrice.values()].sort((a, b) => a.asset.localeCompare(b.asset) || a.price - b.price).map(finalizeAggregate),
  };
}

function addAggregate(map, key, row) {
  const item = map.get(key) || {
    asset: key.includes(':') ? row.asset : undefined,
    price: row.price,
    rounds: 0,
    paired: 0,
    single: 0,
    none: 0,
  };
  item.rounds += 1;
  item[row.outcome] += 1;
  map.set(key, item);
}

function finalizeAggregate(item) {
  const pairedRate = item.rounds ? item.paired / item.rounds : null;
  const singleRate = item.rounds ? item.single / item.rounds : null;
  const noneRate = item.rounds ? item.none / item.rounds : null;
  const pairedProfit = 1 - 2 * item.price;
  const singleLoss = item.price;
  return {
    ...item,
    pairedRate: roundRatio(pairedRate),
    singleRate: roundRatio(singleRate),
    noneRate: roundRatio(noneRate),
    breakevenSingleRate: roundRatio(pairedProfit / (pairedProfit + singleLoss)),
    estimatedEvPerShare: roundMoney((pairedRate || 0) * pairedProfit - (singleRate || 0) * singleLoss),
  };
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

function buildPriceLevels(min, max, step) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) || step <= 0 || min <= 0 || max <= 0 || min > max) {
    throw new Error('Invalid price range.');
  }
  const values = [];
  for (let price = Math.round(min * 100); price <= Math.round(max * 100); price += Math.round(step * 100)) {
    values.push(price / 100);
  }
  return values;
}

function bestAskFromLevels(levels) {
  if (!Array.isArray(levels)) return null;
  const asks = levels.map((level) => finiteNumber(level?.price)).filter((value) => value != null && value > 0);
  return asks.length ? Math.min(...asks) : null;
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

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function priceKey(price) {
  return price.toFixed(2);
}

function cents(price) {
  return `${Math.round(price * 100)}c`;
}

function roundRatio(value) {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 10_000) / 10_000;
}

function roundMoney(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function log(message) {
  console.log(`[pm5m-touch] ${new Date().toISOString()} ${message}`);
}

function shutdown() {
  stopping = true;
  clearInterval(discoveryTimer);
  clearInterval(summaryTimer);
  finalizeExpiredRounds();
  writeSummary();
  if (ws) ws.close();
  log('stopped');
  process.exit(0);
}
