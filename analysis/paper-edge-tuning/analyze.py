#!/usr/bin/env python3
"""Reproducible exploratory analysis for the Paper Dual-entry run.

The script reads the append-only Paper API over SSH, builds one row per settled
Dual round using only pre-entry features, and writes a bounded snapshot plus
candidate-filter diagnostics. It never mutates the remote service.
"""

from __future__ import annotations

import base64
import argparse
import json
import math
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parent
RUN_ID = "paper-20260809-7a4dfe6"
DISCOVERY_END_DAY = "2026-08-12"


REMOTE_EXTRACTOR = r"""
(async () => {
  const runId = '__RUN_ID__';
  const root = 'http://127.0.0.1:8788/api/paper/events?limit=500&runId=' + runId + '&entityType=';
  async function all(type) {
    let cursor = null;
    const rows = [];
    do {
      const response = await fetch(root + type + (cursor ? '&cursor=' + cursor : ''));
      if (!response.ok) throw new Error(type + ' HTTP ' + response.status);
      const page = await response.json();
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor);
    return rows;
  }
  function latestByEntity(rows) {
    const latest = new Map();
    for (const row of rows) if (!latest.has(row.entityId)) latest.set(row.entityId, row);
    return [...latest.values()];
  }
  function condition(check, label) {
    return check && Array.isArray(check.conditions)
      ? check.conditions.find((item) => item.label === label)?.actual
      : undefined;
  }
  function firstNumber(value) {
    const match = String(value || '').match(/-?[0-9]+(?:\.[0-9]+)?/);
    return match ? Number(match[0]) : null;
  }
  function queueRatio(value) {
    const match = String(value || '').match(/ratio\s+([0-9]+(?:\.[0-9]+)?)/);
    return match ? Number(match[1]) : null;
  }
  const raw = {};
  for (const type of ['settlement', 'fill', 'order']) raw[type] = await all(type);
  // Strategy checks are intentionally omitted from this bounded pass: the
  // current ledger volume makes that endpoint exceed the read-only audit
  // timeout. Keep the feature columns null rather than silently using a
  // partial extract.
  raw.strategy_check = [];
  const settlements = latestByEntity(raw.settlement)
    .filter((row) => row.payload && row.payload.status === 'settled');
  const fills = latestByEntity(raw.fill).map((row) => row.payload).filter(Boolean);
  const orders = latestByEntity(raw.order).map((row) => row.payload).filter(Boolean);
  const checks = raw.strategy_check
    .filter((row) => row.payload && row.payload.strategy === 'UPDOWN_DUAL_ENTRY');

  const fillsByRound = new Map();
  for (const fill of fills) {
    const key = fill.profileId + '|' + fill.roundId;
    const items = fillsByRound.get(key) || [];
    items.push(fill);
    fillsByRound.set(key, items);
  }
  const ordersByRound = new Map();
  for (const order of orders.filter((item) => item.strategy === 'UPDOWN_DUAL_ENTRY')) {
    const key = order.profileId + '|' + order.roundId;
    const items = ordersByRound.get(key) || [];
    items.push(order);
    ordersByRound.set(key, items);
  }
  const checksByRound = new Map();
  for (const row of checks) {
    const key = row.profileId + '|' + row.roundId;
    const items = checksByRound.get(key) || [];
    items.push(row);
    checksByRound.set(key, items);
  }

  const rounds = [];
  for (const row of settlements) {
    const settlement = row.payload;
    const key = settlement.profileId + '|' + settlement.roundId;
    const roundFills = fillsByRound.get(key) || [];
    const dualFills = roundFills.filter((fill) => fill.strategy === 'UPDOWN_DUAL_ENTRY');
    if (!dualFills.length) continue;
    const roundOrders = ordersByRound.get(key) || [];
    const entryMs = Math.min(...roundOrders.map((order) => Date.parse(order.createdAt)).filter(Number.isFinite));
    const entryAt = Number.isFinite(entryMs)
      ? new Date(entryMs).toISOString()
      : new Date(Math.min(...dualFills.map((fill) => Date.parse(fill.matchedAt)))).toISOString();
    const candidates = (checksByRound.get(key) || []).slice().sort((a, b) => {
      const da = Math.abs(Date.parse(a.occurredAt) - Date.parse(entryAt));
      const db = Math.abs(Date.parse(b.occurredAt) - Date.parse(entryAt));
      return da - db;
    });
    const check = candidates[0]?.payload;
    const yesFilled = dualFills.some((fill) => fill.side === 'BUY' && fill.label === 'YES');
    const noFilled = dualFills.some((fill) => fill.side === 'BUY' && fill.label === 'NO');
    const yesFillTimes = dualFills
      .filter((fill) => fill.side === 'BUY' && fill.label === 'YES')
      .map((fill) => Date.parse(fill.matchedAt))
      .filter(Number.isFinite);
    const noFillTimes = dualFills
      .filter((fill) => fill.side === 'BUY' && fill.label === 'NO')
      .map((fill) => Date.parse(fill.matchedAt))
      .filter(Number.isFinite);
    const firstFillFor = (label) => dualFills
      .filter((fill) => fill.side === 'BUY' && fill.label === label)
      .slice()
      .sort((a, b) => Date.parse(a.matchedAt) - Date.parse(b.matchedAt))[0];
    const quoteAgeSeconds = (fill) => {
      const quoteAt = Date.parse(fill?.raw?.quote?.updatedAt);
      const matchedAt = Date.parse(fill?.matchedAt);
      return Number.isFinite(quoteAt) && Number.isFinite(matchedAt) ? (matchedAt - quoteAt) / 1000 : null;
    };
    const yesFirstFill = firstFillFor('YES');
    const noFirstFill = firstFillFor('NO');
    const orderPrices = roundOrders.map((order) => Number(order.price)).filter(Number.isFinite);
    const local = new Date(Date.parse(entryAt) + 8 * 3600 * 1000);
    const roundEpoch = Number(String(settlement.roundId).match(/([0-9]{10})$/)?.[1]);
    const roundStartMs = Number.isFinite(roundEpoch) ? roundEpoch * 1000 : null;
    const yesFirstFillMs = yesFillTimes.length ? Math.min(...yesFillTimes) : null;
    const noFirstFillMs = noFillTimes.length ? Math.min(...noFillTimes) : null;
    const bothCompleteMs = yesFirstFillMs != null && noFirstFillMs != null
      ? Math.max(yesFirstFillMs, noFirstFillMs)
      : null;
    const regimeActual = condition(check, 'Regime is CHOP');
    rounds.push({
      round_id: settlement.roundId,
      profile_id: settlement.profileId,
      entry_at: entryAt,
      settled_at: row.occurredAt,
      beijing_day: local.toISOString().slice(0, 10),
      beijing_hour: local.getUTCHours(),
      seconds_to_round_start: Number.isFinite(roundEpoch) ? roundEpoch - Date.parse(entryAt) / 1000 : null,
      pnl: Number(settlement.pnl),
      cost: Number(settlement.totalCost),
      both_fill: yesFilled && noFilled,
      single_fill: yesFilled !== noFilled,
      yes_first_fill_at: yesFirstFillMs == null ? null : new Date(yesFirstFillMs).toISOString(),
      no_first_fill_at: noFirstFillMs == null ? null : new Date(noFirstFillMs).toISOString(),
      both_complete_at: bothCompleteMs == null ? null : new Date(bothCompleteMs).toISOString(),
      both_complete_seconds_to_start: bothCompleteMs == null || roundStartMs == null
        ? null
        : (roundStartMs - bothCompleteMs) / 1000,
      first_fill_seconds_to_start: roundStartMs == null || (!yesFillTimes.length && !noFillTimes.length)
        ? null
        : (roundStartMs - Math.min(...yesFillTimes, ...noFillTimes)) / 1000,
      yes_fill_quote_age_seconds: quoteAgeSeconds(yesFirstFill),
      no_fill_quote_age_seconds: quoteAgeSeconds(noFirstFill),
      limit_price: orderPrices.length ? orderPrices.reduce((a, b) => a + b, 0) / orderPrices.length : check?.limitPrice ?? null,
      regime: regimeActual ? String(regimeActual).split(' ')[0] : null,
      chop_score: firstNumber(condition(check, 'CHOP score threshold')),
      center_cross: firstNumber(condition(check, 'center cross_120s threshold')),
      range_bps: firstNumber(condition(check, 'range_120s sufficient')),
      drift_ratio: firstNumber(condition(check, 'drift ratio capped')),
      momentum_ratio: firstNumber(condition(check, 'momentum ratio capped')),
      queue_ratio: queueRatio(condition(check, 'Entry queue imbalance')),
      check_time_gap_seconds: candidates[0] ? Math.abs(Date.parse(candidates[0].occurredAt) - Date.parse(entryAt)) / 1000 : null,
    });
  }
  process.stdout.write(JSON.stringify({
    run_id: runId,
    extracted_at: new Date().toISOString(),
    raw_counts: Object.fromEntries(Object.entries(raw).map(([key, rows]) => [key, rows.length])),
    unique_counts: {
      settlement: latestByEntity(raw.settlement).length,
      fill: latestByEntity(raw.fill).length,
      order: latestByEntity(raw.order).length,
    },
    rounds,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
"""


@dataclass
class Metrics:
    n: int
    pnl: float
    cost: float
    ev: float
    roi_pct: float
    both_rate_pct: float
    single_rate_pct: float
    positive_days: int
    covered_days: int
    daily_pnl_mean: float
    daily_pnl_std: float
    worst_day_pnl: float
    daily_max_drawdown: float


def fetch_snapshot() -> dict:
    source = REMOTE_EXTRACTOR.replace("__RUN_ID__", RUN_ID)
    encoded = base64.b64encode(source.encode()).decode()
    remote = (
        "docker exec poly-btc5m-api-1 node -e "
        + json.dumps(f"eval(Buffer.from('{encoded}','base64').toString())")
    )
    completed = subprocess.run(
        ["ssh", "-o", "ConnectTimeout=15", "a", remote],
        check=True,
        capture_output=True,
        text=True,
        timeout=180,
    )
    return json.loads(completed.stdout)


def metrics(frame: pd.DataFrame) -> Metrics:
    n = len(frame)
    pnl = float(frame["pnl"].sum()) if n else 0.0
    cost = float(frame["cost"].sum()) if n else 0.0
    daily = frame.groupby("beijing_day", observed=True)["pnl"].sum() if n else pd.Series(dtype=float)
    daily_curve = daily.cumsum()
    if len(daily):
        equity = pd.concat([pd.Series([0.0]), daily_curve.reset_index(drop=True)], ignore_index=True)
        daily_drawdown = equity - equity.cummax()
    else:
        daily_drawdown = pd.Series(dtype=float)
    return Metrics(
        n=n,
        pnl=round(pnl, 6),
        cost=round(cost, 6),
        ev=round(pnl / n, 6) if n else 0.0,
        roi_pct=round(100 * pnl / cost, 3) if cost else 0.0,
        both_rate_pct=round(100 * float(frame["both_fill"].mean()), 3) if n else 0.0,
        single_rate_pct=round(100 * float(frame["single_fill"].mean()), 3) if n else 0.0,
        positive_days=int((daily > 0).sum()),
        covered_days=int(len(daily)),
        daily_pnl_mean=round(float(daily.mean()), 6) if len(daily) else 0.0,
        daily_pnl_std=round(float(daily.std(ddof=1)), 6) if len(daily) > 1 else 0.0,
        worst_day_pnl=round(float(daily.min()), 6) if len(daily) else 0.0,
        daily_max_drawdown=round(float(daily_drawdown.min()), 6) if len(daily) else 0.0,
    )


def add_split_metrics(frame: pd.DataFrame, label: str, dimension: str, value: str) -> dict:
    discovery = frame[frame["beijing_day"] <= DISCOVERY_END_DAY]
    holdout = frame[frame["beijing_day"] > DISCOVERY_END_DAY]
    return {
        "candidate": label,
        "dimension": dimension,
        "value": value,
        "full": asdict(metrics(frame)),
        "discovery": asdict(metrics(discovery)),
        "holdout": asdict(metrics(holdout)),
    }


def block_bootstrap_ev(frame: pd.DataFrame, iterations: int = 10_000, seed: int = 17) -> dict:
    by_day = [part["pnl"].to_numpy() for _, part in frame.groupby("beijing_day", observed=True)]
    if not by_day:
        return {"low": None, "high": None}
    rng = np.random.default_rng(seed)
    values = np.empty(iterations)
    for index in range(iterations):
        sample = [by_day[item] for item in rng.integers(0, len(by_day), len(by_day))]
        joined = np.concatenate(sample)
        values[index] = joined.mean()
    low, high = np.quantile(values, [0.025, 0.975])
    return {"low": round(float(low), 6), "high": round(float(high), 6)}


def segment_candidates(frame: pd.DataFrame) -> list[dict]:
    candidates: list[dict] = []

    # Four-hour UTC+8 blocks are coarse enough to avoid tiny hourly slices.
    labels = ["00-04", "04-08", "08-12", "12-16", "16-20", "20-24"]
    frame = frame.copy()
    frame["time_block"] = pd.cut(frame["beijing_hour"], bins=[0, 4, 8, 12, 16, 20, 24], right=False, labels=labels)
    for value, part in frame.groupby("time_block", observed=True):
        candidates.append(add_split_metrics(part, f"UTC+8 {value}", "time_block", str(value)))
    for (profile, value), part in frame.groupby(["profile_id", "time_block"], observed=True):
        candidates.append(add_split_metrics(part, f"{profile} UTC+8 {value}", "profile_time", f"{profile}|{value}"))

    for (profile, value), part in frame.dropna(subset=["limit_price"]).groupby(["profile_id", "limit_price"], observed=True):
        if len(part) >= 40:
            candidates.append(add_split_metrics(part, f"{profile} limit {value:.2f}", "profile_limit", f"{profile}|{value:.2f}"))

    for (profile, value), part in frame.dropna(subset=["regime"]).groupby(["profile_id", "regime"], observed=True):
        if len(part) >= 40:
            candidates.append(add_split_metrics(part, f"{profile} {value}", "profile_regime", f"{profile}|{value}"))

    discovery = frame[frame["beijing_day"] <= DISCOVERY_END_DAY]
    for feature in ["chop_score", "range_bps", "drift_ratio", "momentum_ratio", "queue_ratio"]:
        available = discovery[feature].dropna()
        if available.nunique() < 4:
            continue
        edges = sorted(set(float(item) for item in available.quantile([0, 0.25, 0.5, 0.75, 1]).values))
        if len(edges) < 3:
            continue
        edges[0] = -math.inf
        edges[-1] = math.inf
        cut = pd.cut(frame[feature], bins=edges, include_lowest=True, duplicates="drop")
        for value, part in frame.groupby(cut, observed=True):
            if len(part) >= 60:
                candidates.append(add_split_metrics(part, f"{feature} {value}", feature, str(value)))
    return candidates


def simulate_cooldown(frame: pd.DataFrame, minutes: int, trigger: str) -> pd.DataFrame:
    selected: list[int] = []
    for _, profile_frame in frame.groupby("profile_id", observed=True):
        ordered = profile_frame.sort_values("entry_at")
        cooldown_until = pd.Timestamp.min.tz_localize("UTC")
        pending: list[tuple[pd.Timestamp, bool]] = []
        for index, row in ordered.iterrows():
            entry_at = row["entry_at"]
            newly_resolved = [item for item in pending if item[0] <= entry_at]
            pending = [item for item in pending if item[0] > entry_at]
            for resolved_at, should_trigger in sorted(newly_resolved):
                if should_trigger:
                    cooldown_until = max(cooldown_until, resolved_at + pd.Timedelta(minutes=minutes))
            if entry_at < cooldown_until:
                continue
            selected.append(index)
            should_trigger = bool(row["single_fill"]) if trigger == "single" else float(row["pnl"]) < 0
            pending.append((row["settled_at"], should_trigger))
    return frame.loc[selected].sort_values("entry_at")


def cooldown_candidates(frame: pd.DataFrame) -> list[dict]:
    rows = []
    for trigger in ["single", "loss"]:
        for minutes in [5, 10, 15, 30, 60, 120, 240]:
            selected = simulate_cooldown(frame, minutes, trigger)
            rows.append(add_split_metrics(selected, f"{minutes}m after {trigger}", f"cooldown_{trigger}", str(minutes)))
    return rows


def previous_outcome_candidates(frame: pd.DataFrame) -> list[dict]:
    enriched = []
    for _, part in frame.groupby("profile_id", observed=True):
        ordered = part.sort_values("entry_at").copy()
        # Only outcomes resolved before the next entry are available to a real policy.
        settled = []
        states = []
        for _, row in ordered.iterrows():
            available = [item for item in settled if item[0] <= row["entry_at"]]
            states.append(available[-1][1] if available else "none")
            state = "both" if row["both_fill"] else "single"
            settled.append((row["settled_at"], state))
            settled.sort(key=lambda item: item[0])
        ordered["previous_resolved_outcome"] = states
        enriched.append(ordered)
    combined = pd.concat(enriched).sort_values("entry_at")
    rows = []
    for value, part in combined.groupby("previous_resolved_outcome", observed=True):
        if value != "none":
            rows.append(add_split_metrics(part, f"after previous {value}", "previous_outcome", str(value)))
    return rows


def named_policy_frames(frame: pd.DataFrame) -> dict[str, pd.DataFrame]:
    enriched = frame.copy()
    enriched["time_block"] = pd.cut(
        enriched["beijing_hour"],
        bins=[0, 4, 8, 12, 16, 20, 24],
        right=False,
        labels=["00-04", "04-08", "08-12", "12-16", "16-20", "20-24"],
    )
    cooldown = simulate_cooldown(enriched, 5, "single")
    return {
        "baseline": enriched,
        "cooldown_5m_after_single": cooldown,
        "utc8_00_04": enriched[enriched["time_block"] == "00-04"],
        "btc5m_utc8_00_04": enriched[
            (enriched["profile_id"] == "btc-5m") & (enriched["time_block"] == "00-04")
        ],
        "exclude_utc8_16_20": enriched[enriched["time_block"] != "16-20"],
        "utc8_00_04_or_20_24": enriched[enriched["time_block"].isin(["00-04", "20-24"])],
        "cooldown_5m_and_utc8_00_04_or_20_24": cooldown[
            cooldown["time_block"].isin(["00-04", "20-24"])
        ],
    }


def policy_diagnostics(frame: pd.DataFrame) -> dict:
    rows = {}
    for name, selected in named_policy_frames(frame).items():
        daily = selected.groupby("beijing_day", observed=True)["pnl"].sum()
        rows[name] = {
            "metrics": asdict(metrics(selected)),
            "discovery": asdict(metrics(selected[selected["beijing_day"] <= DISCOVERY_END_DAY])),
            "holdout": asdict(metrics(selected[selected["beijing_day"] > DISCOVERY_END_DAY])),
            "block_bootstrap_ev95": block_bootstrap_ev(selected),
            "daily_pnl": {str(day): round(float(value), 6) for day, value in daily.items()},
        }
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reuse-snapshot", action="store_true")
    args = parser.parse_args()
    ROOT.mkdir(parents=True, exist_ok=True)
    snapshot_path = ROOT / "rounds_snapshot.json"
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8")) if args.reuse_snapshot else fetch_snapshot()
    if not args.reuse_snapshot:
        snapshot_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
    frame = pd.DataFrame(snapshot["rounds"])
    frame["entry_at"] = pd.to_datetime(frame["entry_at"], utc=True)
    frame["settled_at"] = pd.to_datetime(frame["settled_at"], utc=True)
    frame.to_csv(ROOT / "rounds_snapshot.csv", index=False)

    data_quality = {
        "round_rows": len(frame),
        "unique_round_keys": int(frame[["profile_id", "round_id"]].drop_duplicates().shape[0]),
        "duplicate_round_keys": int(frame.duplicated(["profile_id", "round_id"]).sum()),
        "min_entry_at": frame["entry_at"].min().isoformat(),
        "max_entry_at": frame["entry_at"].max().isoformat(),
        "missing_rates": {column: round(float(frame[column].isna().mean()), 6) for column in frame.columns},
        "check_gap_over_10s": (
            int((frame["check_time_gap_seconds"].dropna() > 10).sum())
            if frame["check_time_gap_seconds"].notna().any()
            else None
        ),
        "both_single_partition_errors": int(((frame["both_fill"].astype(int) + frame["single_fill"].astype(int)) != 1).sum()),
        "raw_counts": snapshot["raw_counts"],
        "unique_counts": snapshot["unique_counts"],
    }

    candidates = segment_candidates(frame)
    candidates += cooldown_candidates(frame)
    candidates += previous_outcome_candidates(frame)
    eligible = [
        item for item in candidates
        if item["discovery"]["n"] >= 80
        and item["holdout"]["n"] >= 80
        and item["discovery"]["ev"] > 0
        and item["holdout"]["ev"] > 0
    ]
    eligible.sort(key=lambda item: (item["holdout"]["ev"], item["full"]["ev"]), reverse=True)

    results = {
        "run_id": RUN_ID,
        "as_of": snapshot["extracted_at"],
        "timezone": "Asia/Shanghai",
        "discovery_end_day": DISCOVERY_END_DAY,
        "data_quality": data_quality,
        "baseline": asdict(metrics(frame)),
        "baseline_block_bootstrap_ev95": block_bootstrap_ev(frame),
        "policy_diagnostics": policy_diagnostics(frame),
        "candidate_count": len(candidates),
        "candidates_passing_split_gate": eligible,
        "all_candidates": candidates,
    }
    (ROOT / "analysis_results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps({
        "as_of": results["as_of"],
        "data_quality": data_quality,
        "baseline": results["baseline"],
        "baseline_block_bootstrap_ev95": results["baseline_block_bootstrap_ev95"],
        "candidate_count": len(candidates),
        "passing": eligible[:12],
    }, indent=2))


if __name__ == "__main__":
    main()
