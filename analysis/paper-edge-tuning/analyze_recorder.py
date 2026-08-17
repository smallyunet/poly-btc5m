#!/usr/bin/env python3
"""Validate the Paper time-window hypothesis against the independent touch recorder."""

from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parent
REMOTE_PATH = "/root/apps/poly-btc5m/data-lab/pm-5m-touch/round-results.ndjson"
REMOTE_ROUNDS_PATH = "/root/apps/poly-btc5m/data-lab/pm-5m-touch/rounds.ndjson"
REMOTE_TOUCHES_PATH = "/root/apps/poly-btc5m/data-lab/pm-5m-touch/touches.ndjson"
REMOTE_EXTRACTOR = r"""
import json

path = '__REMOTE_PATH__'
rounds_path = '__REMOTE_ROUNDS_PATH__'
touches_path = '__REMOTE_TOUCHES_PATH__'
latest = {}
discovered = {}
touches = {}
raw_rows = 0
invalid_rows = 0
with open(path, encoding='utf-8') as source:
    for line in source:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            invalid_rows += 1
            continue
        if row.get('type') != 'round_result' or row.get('asset') != 'btc' or row.get('price') != 0.29:
            continue
        raw_rows += 1
        slug = row.get('slug')
        if not slug:
            invalid_rows += 1
            continue
        previous = latest.get(slug)
        if previous is None or str(row.get('recordedAt', '')) >= str(previous.get('recordedAt', '')):
            latest[slug] = row
with open(rounds_path, encoding='utf-8') as source:
    for line in source:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get('type') != 'round_discovered' or row.get('asset') != 'btc' or not row.get('slug'):
            continue
        slug = row['slug']
        recorded_at = row.get('recordedAt')
        if recorded_at and (slug not in discovered or recorded_at < discovered[slug]):
            discovered[slug] = recorded_at
with open(touches_path, encoding='utf-8') as source:
    for line in source:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get('type') != 'touch' or row.get('asset') != 'btc' or not row.get('slug'):
            continue
        try:
            best_ask = float(row.get('bestAsk'))
        except (TypeError, ValueError):
            continue
        if best_ask > 0.290001 or row.get('side') not in ('YES', 'NO'):
            continue
        key = row['slug'] + '|' + row['side']
        recorded_at = str(row.get('recordedAt', ''))
        if key not in touches or recorded_at < str(touches[key].get('recordedAt', '')):
            touches[key] = {'recordedAt': recorded_at, 'bestAsk': best_ask}
for slug, row in latest.items():
    row['discoveredAt'] = discovered.get(slug)
    row['yesActualTouch'] = touches.get(slug + '|YES')
    row['noActualTouch'] = touches.get(slug + '|NO')
print(json.dumps({'raw_rows': raw_rows, 'invalid_rows': invalid_rows, 'rows': list(latest.values())}))
"""


def fetch() -> dict:
    source = (
        REMOTE_EXTRACTOR
        .replace("__REMOTE_PATH__", REMOTE_PATH)
        .replace("__REMOTE_ROUNDS_PATH__", REMOTE_ROUNDS_PATH)
        .replace("__REMOTE_TOUCHES_PATH__", REMOTE_TOUCHES_PATH)
    )
    encoded = base64.b64encode(source.encode()).decode()
    remote = f"python3 -c \"import base64;exec(base64.b64decode('{encoded}'))\""
    completed = subprocess.run(
        ["ssh", "-o", "ConnectTimeout=15", "a", remote],
        check=True,
        capture_output=True,
        text=True,
        timeout=180,
    )
    return json.loads(completed.stdout)


def block_bootstrap(frame: pd.DataFrame, iterations: int = 20_000, seed: int = 17) -> dict:
    days = [part["pnl_per_share"].to_numpy() for _, part in frame.groupby("beijing_day", observed=True)]
    rng = np.random.default_rng(seed)
    values = np.empty(iterations)
    for index in range(iterations):
        sample = [days[item] for item in rng.integers(0, len(days), len(days))]
        values[index] = np.concatenate(sample).mean()
    low, high = np.quantile(values, [0.025, 0.975])
    return {"low": round(float(low), 6), "high": round(float(high), 6)}


def metrics(frame: pd.DataFrame) -> dict:
    daily = frame.groupby("beijing_day", observed=True)["pnl_per_share"].sum()
    leave_one_day_out = [
        float(frame.loc[frame["beijing_day"] != day, "pnl_per_share"].mean())
        for day in daily.index
    ]
    return {
        "rounds": int(len(frame)),
        "days": int(len(daily)),
        "paired_rate": round(float((frame["outcome"] == "paired").mean()), 6),
        "single_rate": round(float((frame["outcome"] == "single").mean()), 6),
        "none_rate": round(float((frame["outcome"] == "none").mean()), 6),
        "ev_per_share": round(float(frame["pnl_per_share"].mean()), 6),
        "positive_days": int((daily > 0).sum()),
        "daily_pnl_per_share": {str(day): round(float(value), 6) for day, value in daily.items()},
        "block_bootstrap_ev95": block_bootstrap(frame),
        "leave_one_day_out_ev": {
            "low": round(min(leave_one_day_out), 6),
            "high": round(max(leave_one_day_out), 6),
        },
    }


def cooldown_after_single(frame: pd.DataFrame, minutes: int = 5) -> pd.DataFrame:
    kept = []
    blocked_until = pd.Timestamp.min.tz_localize("UTC")
    for index, row in frame.sort_values("startAt").iterrows():
        if row["startAt"] < blocked_until:
            continue
        kept.append(index)
        if row["outcome"] == "single":
            blocked_until = pd.to_datetime(row["endAt"], utc=True) + pd.Timedelta(minutes=minutes)
    return frame.loc[kept]


def main() -> None:
    extracted = fetch()
    frame = pd.DataFrame(extracted["rows"])
    frame["startAt"] = pd.to_datetime(frame["startAt"], utc=True)
    frame["endAt"] = pd.to_datetime(frame["endAt"], utc=True)
    frame["discoveredAt"] = pd.to_datetime(frame["discoveredAt"], utc=True)
    frame["discovery_lead_seconds"] = (frame["startAt"] - frame["discoveredAt"]).dt.total_seconds()
    frame["simulated_entry_at"] = frame["startAt"] - pd.Timedelta(seconds=15)
    local = frame["simulated_entry_at"] + pd.Timedelta(hours=8)
    frame["beijing_day"] = local.dt.strftime("%Y-%m-%d")
    frame["beijing_hour"] = local.dt.hour
    frame["time_block"] = pd.cut(
        frame["beijing_hour"],
        bins=[0, 4, 8, 12, 16, 20, 24],
        right=False,
        labels=["00-04", "04-08", "08-12", "12-16", "16-20", "20-24"],
    )
    frame["pnl_per_share"] = np.select(
        [frame["outcome"] == "paired", frame["outcome"] == "single"],
        [frame["pairedProfitPerShare"], -frame["singleLossPerShare"]],
        default=0.0,
    )
    frame["yes_actual_ask"] = frame["yesActualTouch"].map(
        lambda value: value.get("bestAsk") if isinstance(value, dict) else np.nan
    )
    frame["no_actual_ask"] = frame["noActualTouch"].map(
        lambda value: value.get("bestAsk") if isinstance(value, dict) else np.nan
    )
    frame["actual_touch_pnl_per_share"] = np.select(
        [
            frame["yes_actual_ask"].notna() & frame["no_actual_ask"].notna(),
            frame["yes_actual_ask"].notna(),
            frame["no_actual_ask"].notna(),
        ],
        [
            1 - frame["yes_actual_ask"] - frame["no_actual_ask"],
            -frame["yes_actual_ask"],
            -frame["no_actual_ask"],
        ],
        default=0.0,
    )
    frame[[
        "slug", "startAt", "discoveredAt", "discovery_lead_seconds", "outcome",
        "yesTouched", "noTouched", "yesFirstTouchAt", "noFirstTouchAt", "pnl_per_share",
        "yes_actual_ask", "no_actual_ask", "actual_touch_pnl_per_share",
        "beijing_day", "beijing_hour", "time_block",
    ]].to_csv(ROOT / "recorder_btc29_rounds.csv", index=False)

    blocks = []
    for block, part in frame.groupby("time_block", observed=True):
        blocks.append({"time_block": str(block), **metrics(part)})

    window = frame[frame["time_block"] == "20-24"]
    prestart_window = window[window["discovery_lead_seconds"] >= 0]
    periods = {
        "all_history": metrics(window),
        "before_paper_run": metrics(window[window["beijing_day"] < "2026-08-09"]),
        "paper_run_overlap": metrics(window[window["beijing_day"].between("2026-08-09", "2026-08-15")]),
        "after_paper_run_start": metrics(window[window["beijing_day"] >= "2026-08-09"]),
        "prestart_discovery_only": metrics(prestart_window),
        "prestart_paper_overlap": metrics(
            prestart_window[prestart_window["beijing_day"].between("2026-08-09", "2026-08-15")]
        ),
    }
    actual_touch_periods = {
        name: metrics(part.rename(columns={"pnl_per_share": "limit_model_pnl"}).assign(
            pnl_per_share=part["actual_touch_pnl_per_share"]
        ))
        for name, part in {
            "all_history": window,
            "before_paper_run": window[window["beijing_day"] < "2026-08-09"],
            "paper_run_overlap": window[window["beijing_day"].between("2026-08-09", "2026-08-15")],
            "after_paper_run_start": window[window["beijing_day"] >= "2026-08-09"],
        }.items()
    }
    actual_frame = frame.rename(columns={"pnl_per_share": "limit_model_pnl"}).assign(
        pnl_per_share=frame["actual_touch_pnl_per_share"]
    )
    recorder_cooldown = cooldown_after_single(actual_frame)
    cooldown_periods = {
        "all_history_baseline": metrics(actual_frame),
        "all_history_cooldown": metrics(recorder_cooldown),
        "paper_overlap_baseline": metrics(
            actual_frame[actual_frame["beijing_day"].between("2026-08-09", "2026-08-15")]
        ),
        "paper_overlap_cooldown": metrics(
            recorder_cooldown[recorder_cooldown["beijing_day"].between("2026-08-09", "2026-08-15")]
        ),
    }

    result = {
        "source": REMOTE_PATH,
        "model": "bestAsk touch-fill; paired earns 1-2p, single loses p, none earns 0",
        "price": 0.29,
        "entry_time_assumption_seconds_before_start": 15,
        "data_quality": {
            "raw_rows": extracted["raw_rows"],
            "unique_rounds": int(len(frame)),
            "duplicate_rows_removed": int(extracted["raw_rows"] - len(frame)),
            "invalid_rows": extracted["invalid_rows"],
            "min_start_at": frame["startAt"].min().isoformat(),
            "max_start_at": frame["startAt"].max().isoformat(),
            "missing_outcome": int(frame["outcome"].isna().sum()),
            "unexpected_outcome": int((~frame["outcome"].isin(["paired", "single", "none"])).sum()),
            "missing_discovered_at": int(frame["discoveredAt"].isna().sum()),
            "discovered_before_start": int((frame["discovery_lead_seconds"] >= 0).sum()),
            "discovered_after_start": int((frame["discovery_lead_seconds"] < 0).sum()),
            "discovery_lead_seconds_quantiles": {
                str(quantile): round(float(value), 3)
                for quantile, value in frame["discovery_lead_seconds"].quantile([0, 0.1, 0.5, 0.9, 1]).items()
            },
        },
        "time_blocks": blocks,
        "btc5m_20_24": periods,
        "btc5m_20_24_actual_touch_prices": actual_touch_periods,
        "btc5m_cooldown_actual_touch_prices": cooldown_periods,
    }
    (ROOT / "recorder_validation.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
