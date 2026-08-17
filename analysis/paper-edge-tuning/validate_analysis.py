#!/usr/bin/env python3
"""Independent arithmetic and cross-source checks for the Paper edge audit."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parent


def cooldown_after_single(frame: pd.DataFrame) -> pd.DataFrame:
    kept = []
    for _, profile in frame.groupby("profile_id"):
        blocked_until = pd.Timestamp.min.tz_localize("UTC")
        known = []
        for index, row in profile.sort_values("entry_at").iterrows():
            for settled_at, single in sorted(item for item in known if item[0] <= row.entry_at):
                if single:
                    blocked_until = max(blocked_until, settled_at + pd.Timedelta(minutes=5))
            known = [item for item in known if item[0] > row.entry_at]
            if row.entry_at >= blocked_until:
                kept.append(index)
                known.append((row.settled_at, bool(row.single_fill)))
    return frame.loc[kept]


def facts(frame: pd.DataFrame) -> dict:
    return {
        "n": len(frame),
        "pnl": round(float(frame.pnl.sum()), 6),
        "ev": round(float(frame.pnl.mean()), 6),
    }


def main() -> None:
    frame = pd.read_csv(ROOT / "rounds_snapshot.csv")
    frame["entry_at"] = pd.to_datetime(frame.entry_at, utc=True, format="mixed")
    frame["settled_at"] = pd.to_datetime(frame.settled_at, utc=True, format="mixed")
    frame["time_block"] = pd.cut(
        frame.beijing_hour,
        [0, 4, 8, 12, 16, 20, 24],
        right=False,
        labels=["00-04", "04-08", "08-12", "12-16", "16-20", "20-24"],
    )
    cooldown = cooldown_after_single(frame)
    calculated = {
        "baseline": facts(frame),
        "cooldown_5m_after_single": facts(cooldown),
        "utc8_00_04": facts(frame[frame.time_block == "00-04"]),
        "btc5m_utc8_00_04": facts(frame[(frame.profile_id == "btc-5m") & (frame.time_block == "00-04")]),
        "combo": facts(cooldown[cooldown.time_block.isin(["00-04", "20-24"])]),
    }
    results = json.loads((ROOT / "analysis_results.json").read_text())
    expected = results["policy_diagnostics"]
    mapping = {
        "baseline": "baseline",
        "cooldown_5m_after_single": "cooldown_5m_after_single",
        "utc8_00_04": "utc8_00_04",
        "btc5m_utc8_00_04": "btc5m_utc8_00_04",
        "combo": "cooldown_5m_and_utc8_00_04_or_20_24",
    }
    for name, key in mapping.items():
        target = expected[key]["metrics"]
        assert calculated[name] == {field: target[field] for field in ["n", "pnl", "ev"]}, (name, calculated[name], target)
    assert len(frame) == len(frame[["profile_id", "round_id"]].drop_duplicates())
    assert ((frame.both_fill.astype(int) + frame.single_fill.astype(int)) == 1).all()

    candidate = next(
        item for item in results["all_candidates"]
        if item["dimension"] == "profile_time" and item["value"] == "btc-5m|20-24"
    )
    assert candidate["full"]["n"] == 336
    assert candidate["discovery"]["ev"] > 0 and candidate["holdout"]["ev"] > 0
    target_frame = frame[(frame.profile_id == "btc-5m") & (frame.time_block == "20-24")]
    daily = target_frame.groupby("beijing_day").pnl.agg(["sum", "count"]).reset_index(drop=True)
    rng = np.random.default_rng(20260817)
    draws = rng.integers(0, len(daily), size=(20000, len(daily)))
    boot_ev = daily["sum"].to_numpy()[draws].sum(axis=1) / daily["count"].to_numpy()[draws].sum(axis=1)
    candidate["block_bootstrap_ev95"] = {
        "low": round(float(np.quantile(boot_ev, 0.025)), 6),
        "high": round(float(np.quantile(boot_ev, 0.975)), 6),
    }
    candidate["leave_one_day_out_ev"] = {
        "low": round(min((target_frame.pnl.sum() - row["sum"]) / (len(target_frame) - row["count"]) for _, row in daily.iterrows()), 6),
        "high": round(max((target_frame.pnl.sum() - row["sum"]) / (len(target_frame) - row["count"]) for _, row in daily.iterrows()), 6),
    }

    recorder = pd.read_csv(ROOT / "recorder_btc29_rounds.csv")
    btc = frame[frame.profile_id == "btc-5m"].copy()
    joined = btc.merge(recorder, left_on="round_id", right_on="slug", how="left", validate="one_to_one")
    assert len(joined) == len(btc) == 2017
    assert joined.slug.notna().all()
    joined["paper_yes"] = joined.yes_first_fill_at.notna()
    joined["paper_no"] = joined.no_first_fill_at.notna()
    joined["recorder_yes"] = joined.yesTouched.astype(bool)
    joined["recorder_no"] = joined.noTouched.astype(bool)
    joined["paper_outcome"] = joined.apply(
        lambda row: "paired" if row.paper_yes and row.paper_no else "single", axis=1
    )
    joined["recorder_outcome"] = joined.apply(
        lambda row: "paired" if row.recorder_yes and row.recorder_no else
        "single" if row.recorder_yes or row.recorder_no else "none", axis=1
    )
    target = joined[joined.time_block_x == "20-24"].copy()
    contingency = pd.crosstab(target.paper_outcome, target.recorder_outcome).reindex(
        index=["paired", "single"], columns=["none", "paired", "single"], fill_value=0
    )
    assert contingency.to_dict() == {
        "none": {"paired": 38, "single": 40},
        "paired": {"paired": 44, "single": 1},
        "single": {"paired": 46, "single": 167},
    }
    paper_side_fills = int(target.paper_yes.sum() + target.paper_no.sum())
    paper_only_sides = int((target.paper_yes & ~target.recorder_yes).sum() + (target.paper_no & ~target.recorder_no).sum())
    agreement = {
        "matched_btc5m_rounds": len(joined),
        "target_rounds": len(target),
        "paper_paired": int((target.paper_outcome == "paired").sum()),
        "recorder_paired": int((target.recorder_outcome == "paired").sum()),
        "paired_in_both": int(((target.paper_outcome == "paired") & (target.recorder_outcome == "paired")).sum()),
        "paper_side_fills": paper_side_fills,
        "paper_only_side_fills": paper_only_sides,
        "paper_only_side_fill_rate": round(paper_only_sides / paper_side_fills, 6),
        "contingency": contingency.to_dict(),
    }
    assert agreement["paper_only_side_fill_rate"] > 0.35

    recorder_results = json.loads((ROOT / "recorder_validation.json").read_text())
    actual = recorder_results["btc5m_20_24_actual_touch_prices"]
    cooldown_actual = recorder_results["btc5m_cooldown_actual_touch_prices"]
    assert actual["all_history"]["ev_per_share"] < 0
    assert actual["all_history"]["block_bootstrap_ev95"]["high"] < 0
    assert cooldown_actual["all_history_cooldown"]["ev_per_share"] < 0
    assert cooldown_actual["paper_overlap_cooldown"]["ev_per_share"] < 0

    validation = {
        "status": "pass",
        "paper_checks": calculated,
        "btc5m_20_24_paper": candidate,
        "cross_source_agreement": agreement,
        "recorder_actual_touch": {
            "btc5m_20_24_all_history": actual["all_history"],
            "btc5m_20_24_paper_overlap": actual["paper_run_overlap"],
            "cooldown_all_history": cooldown_actual["all_history_cooldown"],
            "cooldown_paper_overlap": cooldown_actual["paper_overlap_cooldown"],
        },
    }
    (ROOT / "validation_results.json").write_text(json.dumps(validation, ensure_ascii=False, indent=2))
    print(json.dumps({"status": "pass", "cross_source_agreement": agreement}, indent=2))


if __name__ == "__main__":
    main()
