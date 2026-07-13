#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function repriceTailResult(sample, result, size) {
  const selectedQuote = sample.selectedSide === 'YES' ? sample.yes : sample.selectedSide === 'NO' ? sample.no : null;
  const fill = selectedQuote ? buyVwap(selectedQuote.asks || [], size) : null;
  const fillable = Boolean(fill?.fillable);
  const vwap = fill?.vwap ?? null;
  const selectedWon = fillable && sample.selectedSide != null ? sample.selectedSide === result.winner : null;
  const pnlPerShare = fillable && vwap != null ? roundMoney((selectedWon ? 1 : 0) - vwap) : null;
  return {
    ...result,
    selectedSide: sample.selectedSide,
    selectedWon,
    size,
    fillable,
    vwap,
    cost: fill?.cost ?? null,
    filledShares: fill?.filledShares ?? 0,
    slippage: vwap != null && selectedQuote?.bestAsk != null ? roundMoney(vwap - selectedQuote.bestAsk) : null,
    selectedBestAsk: selectedQuote?.bestAsk ?? null,
    selectedMidpoint: selectedQuote?.midpoint ?? null,
    selectedSpread: selectedQuote?.spread ?? null,
    midpointGap: sample.yes?.midpoint != null && sample.no?.midpoint != null ? roundMoney(Math.abs(sample.yes.midpoint - sample.no.midpoint)) : null,
    overroundAsk: sample.overroundAsk,
    pnlPerShare,
    pnl: pnlPerShare == null ? null : roundMoney(pnlPerShare * size),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.outDir || 'data-lab/pm-5m-tail');
  const size = Number(args.size || 2);
  if (!Number.isFinite(size) || size <= 0) throw new Error('--size must be a positive number');
  const samplesPath = path.join(outDir, 'samples.ndjson');
  const resultsPath = path.join(outDir, 'tail-results.ndjson');
  if (!fs.existsSync(samplesPath) || !fs.existsSync(resultsPath)) {
    console.log(`[tail-reprice] skipped ${outDir}: samples or results file missing`);
    return;
  }

  const results = readUnique(resultsPath);
  const samples = readUnique(samplesPath);
  const repriced = [];
  for (const [key, result] of results) {
    const sample = samples.get(key);
    if (sample) repriced.push(repriceTailResult(sample, result, size));
  }
  repriced.sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt) || Number(left.checkpointSeconds) - Number(right.checkpointSeconds));
  const backupPath = `${resultsPath}.before-size-${size}`;
  if (!fs.existsSync(backupPath)) fs.copyFileSync(resultsPath, backupPath);
  const tmpPath = `${resultsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${repriced.map((row) => JSON.stringify(row)).join('\n')}\n`);
  fs.renameSync(tmpPath, resultsPath);
  console.log(`[tail-reprice] ${outDir}: ${repriced.length}/${results.size} results repriced to size=${size}; backup=${backupPath}`);
}

function readUnique(filePath) {
  const rows = new Map();
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    rows.set(`${row.asset}:${row.slug}:${row.checkpointSeconds}`, row);
  }
  return rows;
}

function buyVwap(asks, targetSize) {
  let remaining = targetSize;
  let cost = 0;
  for (const level of asks) {
    if (remaining <= 0) break;
    const shares = Math.min(remaining, Number(level.size));
    cost += shares * Number(level.price);
    remaining -= shares;
  }
  const filledShares = roundMoney(targetSize - remaining);
  return { fillable: remaining <= 0.000001, filledShares, cost: roundMoney(cost), vwap: filledShares > 0 ? roundMoney(cost / filledShares) : null };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out-dir') { parsed.outDir = argv[index + 1]; index += 1; }
    else if (argv[index] === '--size') { parsed.size = argv[index + 1]; index += 1; }
  }
  return parsed;
}

function roundMoney(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
