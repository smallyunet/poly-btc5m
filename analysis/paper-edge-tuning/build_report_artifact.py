#!/usr/bin/env python3
"""Build the canonical portable-report artifact payload from reviewed results."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parent
RESULTS = json.loads((ROOT / "analysis_results.json").read_text())
POLICIES = RESULTS["policy_diagnostics"]
RECORDER = json.loads((ROOT / "recorder_validation.json").read_text())
VALIDATION = json.loads((ROOT / "validation_results.json").read_text())


def metric_row(key: str, label: str, status: str) -> dict:
    item = POLICIES[key]
    m = item["metrics"]
    return {
        "policy": label,
        "status": status,
        "rounds": m["n"],
        "coverage": m["n"] / POLICIES["baseline"]["metrics"]["n"],
        "pnl": m["pnl"],
        "ev": m["ev"],
        "roi": m["roi_pct"] / 100,
        "positive_day_rate": m["positive_days"] / m["covered_days"],
        "daily_std": m["daily_pnl_std"],
        "worst_day": m["worst_day_pnl"],
        "max_drawdown": m["daily_max_drawdown"],
        "discovery_ev": item["discovery"]["ev"],
        "holdout_ev": item["holdout"]["ev"],
        "ci_low": item["block_bootstrap_ev95"]["low"],
        "ci_high": item["block_bootstrap_ev95"]["high"],
    }


policy_rows = [
    metric_row("baseline", "Baseline", "Negative reference"),
    metric_row("cooldown_5m_after_single", "5m cooldown after single", "Risk-control hypothesis"),
    metric_row("utc8_00_04", "UTC+8 00–04", "Time-window candidate"),
    metric_row("btc5m_utc8_00_04", "BTC 5m, UTC+8 00–04", "Profile-specific candidate"),
    metric_row("exclude_utc8_16_20", "Exclude UTC+8 16–20", "Avoidance candidate"),
    metric_row("utc8_00_04_or_20_24", "UTC+8 00–04 or 20–24", "Exploratory"),
    metric_row("cooldown_5m_and_utc8_00_04_or_20_24", "5m cooldown + 00–04/20–24", "Selection-biased combo"),
]

paper_target = next(
    item for item in RESULTS["all_candidates"]
    if item["dimension"] == "profile_time" and item["value"] == "btc-5m|20-24"
)
target_metrics = paper_target["full"]
policy_rows.append({
    "policy": "BTC 5m, UTC+8 20–24", "status": "Strongest Paper hypothesis",
    "rounds": target_metrics["n"], "coverage": target_metrics["n"] / POLICIES["baseline"]["metrics"]["n"],
    "pnl": target_metrics["pnl"], "ev": target_metrics["ev"], "roi": target_metrics["roi_pct"] / 100,
    "positive_day_rate": target_metrics["positive_days"] / target_metrics["covered_days"],
    "daily_std": target_metrics["daily_pnl_std"], "worst_day": target_metrics["worst_day_pnl"],
    "max_drawdown": target_metrics["daily_max_drawdown"], "discovery_ev": paper_target["discovery"]["ev"],
    "holdout_ev": paper_target["holdout"]["ev"],
    "ci_low": VALIDATION["btc5m_20_24_paper"]["block_bootstrap_ev95"]["low"],
    "ci_high": VALIDATION["btc5m_20_24_paper"]["block_bootstrap_ev95"]["high"],
})

daily_rows = []
for key, label in [
    ("baseline", "Baseline"),
    ("cooldown_5m_and_utc8_00_04_or_20_24", "5m cooldown + 00–04/20–24"),
]:
    for day, pnl in POLICIES[key]["daily_pnl"].items():
        daily_rows.append({"day": day, "series": label, "pnl": pnl})

time_rows = []
for item in RESULTS["all_candidates"]:
    if item["dimension"] == "time_block":
        time_rows.append({
            "time_block": item["value"],
            "rounds": item["full"]["n"],
            "pnl": item["full"]["pnl"],
            "ev": item["full"]["ev"],
            "discovery_ev": item["discovery"]["ev"],
            "holdout_ev": item["holdout"]["ev"],
            "positive_days": f"{item['full']['positive_days']}/{item['full']['covered_days']}",
        })

baseline = policy_rows[0]
combo = policy_rows[-1]
agreement = VALIDATION["cross_source_agreement"]
touch = RECORDER["btc5m_20_24_actual_touch_prices"]
cooldown_touch = RECORDER["btc5m_cooldown_actual_touch_prices"]
overview = [{
    "baseline_pnl": baseline["pnl"],
    "baseline_ev": baseline["ev"],
    "baseline_positive_days": baseline["positive_day_rate"],
    "paper_target_ev": target_metrics["ev"],
    "recorder_target_ev": touch["all_history"]["ev_per_share"],
    "paper_only_fill_rate": agreement["paper_only_side_fill_rate"],
}]

cross_source_rows = [
    {"test": "BTC5m 20–24", "source": "Paper", "period": "2026-08-09–15", "rounds": target_metrics["n"],
     "days": target_metrics["covered_days"], "ev": target_metrics["ev"],
     "ci_low": VALIDATION["btc5m_20_24_paper"]["block_bootstrap_ev95"]["low"],
     "ci_high": VALIDATION["btc5m_20_24_paper"]["block_bootstrap_ev95"]["high"],
     "result": "Positive hypothesis"},
    {"test": "BTC5m 20–24", "source": "Independent recorder", "period": "2026-07-05–08-17", "rounds": touch["all_history"]["rounds"],
     "days": touch["all_history"]["days"], "ev": touch["all_history"]["ev_per_share"],
     "ci_low": touch["all_history"]["block_bootstrap_ev95"]["low"], "ci_high": touch["all_history"]["block_bootstrap_ev95"]["high"],
     "result": "Rejected"},
    {"test": "5m cooldown", "source": "Independent recorder", "period": "2026-07-05–08-17", "rounds": cooldown_touch["all_history_cooldown"]["rounds"],
     "days": cooldown_touch["all_history_cooldown"]["days"], "ev": cooldown_touch["all_history_cooldown"]["ev_per_share"],
     "ci_low": cooldown_touch["all_history_cooldown"]["block_bootstrap_ev95"]["low"],
     "ci_high": cooldown_touch["all_history_cooldown"]["block_bootstrap_ev95"]["high"], "result": "Still negative"},
]


def sql_materialize(table: str, rows: list[dict]) -> tuple[list[dict], str]:
    """Round-trip report datasets through SQLite so widget provenance is actual SQL."""
    columns = list(rows[0])
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    definitions = []
    for column in columns:
        sample = next((row[column] for row in rows if row[column] is not None), "")
        sql_type = "REAL" if isinstance(sample, float) else "INTEGER" if isinstance(sample, int) else "TEXT"
        definitions.append(f'"{column}" {sql_type}')
    connection.execute(f'CREATE TABLE "{table}" ({", ".join(definitions)})')
    placeholders = ", ".join("?" for _ in columns)
    connection.executemany(
        f'INSERT INTO "{table}" VALUES ({placeholders})',
        [[row[column] for column in columns] for row in rows],
    )
    sql = f'SELECT {", ".join(chr(34) + column + chr(34) for column in columns)} FROM "{table}"'
    selected = [dict(row) for row in connection.execute(sql)]
    connection.close()
    return selected, sql


overview, overview_sql = sql_materialize("report_overview", overview)
policy_rows, policy_sql = sql_materialize("policy_comparison", policy_rows)
daily_rows, daily_sql = sql_materialize("daily_pnl", daily_rows)
time_rows, time_sql = sql_materialize("time_blocks", time_rows)
cross_source_rows, cross_source_sql = sql_materialize("cross_source", cross_source_rows)


def source(source_id: str, label: str, sql: str) -> dict:
    return {
        "id": source_id,
        "label": label,
        "query": {
            "engine": "sqlite",
            "sql": sql,
            "description": "Selects the reviewed report dataset materialized from the Paper ledger analysis.",
            "executed_at": RESULTS["as_of"],
        },
    }

artifact = {
    "surface": "report",
    "manifest": {
        "version": 1,
        "surface": "report",
        "title": "历史数据中的 Edge：Paper 与独立成交记录交叉审计",
        "description": "对 Paper 候选信号做 discovery/holdout、日区块 bootstrap 与独立 recorder 反证检验。",
        "generatedAt": RESULTS["as_of"],
        "cards": [
            {
                "id": "baseline_card",
                "description": "当前 Paper 基线为负，日区块 bootstrap 95% 区间跨零。",
                "dataset": "overview",
                "sourceId": "overview_sql",
                "metrics": [
                    {"label": "Baseline PnL", "field": "baseline_pnl", "format": "currency"},
                    {"label": "Baseline EV/round", "field": "baseline_ev", "format": "currency", "signed": True},
                    {"label": "Positive days", "field": "baseline_positive_days", "format": "percent"},
                ],
            },
            {
                "id": "validation_card",
                "description": "最强 Paper 分段在独立 recorder 上翻为负；成交分歧大于候选 EV。",
                "dataset": "overview",
                "sourceId": "overview_sql",
                "metrics": [
                    {"label": "Paper target EV", "field": "paper_target_ev", "format": "currency", "signed": True},
                    {"label": "Recorder target EV/share", "field": "recorder_target_ev", "format": "currency", "signed": True},
                    {"label": "Paper-only side fills", "field": "paper_only_fill_rate", "format": "percent"},
                ],
            },
        ],
        "charts": [
            {
                "id": "policy_ev",
                "title": "候选策略的每轮 EV",
                "subtitle": "组合策略的历史 EV 最高，但候选来自同一数据集的多重搜索。",
                "headerMarkdown": "柱高是每个已选择轮次的平均 PnL；**不是未见样本的收益保证**。",
                "type": "bar",
                "dataset": "policy_comparison",
                "sourceId": "policy_sql",
                "palette": {"kind": "diverging", "midpoint": 0},
                "encodings": {
                    "x": {"field": "policy", "type": "nominal", "label": "Policy"},
                    "y": {"field": "ev", "type": "quantitative", "label": "EV / round", "format": "currency"},
                    "tooltip": [
                        {"field": "rounds", "type": "quantitative", "label": "Rounds", "format": "number"},
                        {"field": "pnl", "type": "quantitative", "label": "PnL", "format": "currency"},
                        {"field": "coverage", "type": "quantitative", "label": "Coverage", "format": "percent"},
                    ],
                },
                "valueFormat": "currency",
            },
            {
                "id": "daily_pnl",
                "title": "Baseline 与最佳历史组合的逐日 PnL",
                "subtitle": "用于展示筛选如何改变逐日路径；组合来自事后搜索，首尾日不完整。",
                "type": "line",
                "dataset": "daily_pnl",
                "sourceId": "daily_sql",
                "palette": {"kind": "semantic", "name": "actual-vs-comparison"},
                "encodings": {
                    "x": {"field": "day", "type": "temporal", "label": "Beijing day"},
                    "y": {"field": "pnl", "type": "quantitative", "label": "Daily PnL", "format": "currency"},
                    "color": {"field": "series", "type": "nominal", "label": "Policy"},
                },
                "valueFormat": "currency",
            },
            {
                "id": "time_block_ev",
                "title": "北京时间四小时分段 EV",
                "subtitle": "20–24 全样本最高，但全 profile holdout 接近零；16–20 在前后段均为负。",
                "type": "bar",
                "dataset": "time_blocks",
                "sourceId": "time_sql",
                "palette": {"kind": "diverging", "midpoint": 0},
                "encodings": {
                    "x": {"field": "time_block", "type": "ordinal", "label": "UTC+8"},
                    "y": {"field": "ev", "type": "quantitative", "label": "EV / round", "format": "currency"},
                    "tooltip": [
                        {"field": "discovery_ev", "type": "quantitative", "label": "Discovery EV", "format": "currency"},
                        {"field": "holdout_ev", "type": "quantitative", "label": "Holdout EV", "format": "currency"},
                        {"field": "rounds", "type": "quantitative", "label": "Rounds", "format": "number"},
                    ],
                },
                "valueFormat": "currency",
            },
        ],
        "tables": [
            {
                "id": "policy_table",
                "title": "候选策略完整对比",
                "subtitle": "Discovery 截止 2026-08-12；Holdout 为之后的数据。置信区间未校正多重搜索。",
                "dataset": "policy_comparison",
                "sourceId": "policy_sql",
                "defaultSort": {"field": "ev", "direction": "desc"},
                "columns": [
                    {"field": "policy", "label": "Policy", "type": "text"},
                    {"field": "status", "label": "Role", "type": "text"},
                    {"field": "rounds", "label": "Rounds", "format": "number"},
                    {"field": "coverage", "label": "Coverage", "format": "percent"},
                    {"field": "pnl", "label": "PnL", "format": "currency"},
                    {"field": "ev", "label": "EV/round", "format": "currency", "movement": True},
                    {"field": "discovery_ev", "label": "Discovery EV", "format": "currency", "movement": True},
                    {"field": "holdout_ev", "label": "Holdout EV", "format": "currency", "movement": True},
                    {"field": "daily_std", "label": "Daily σ", "format": "currency"},
                    {"field": "max_drawdown", "label": "Daily max DD", "format": "currency", "movement": True},
                ],
            },
            {
                "id": "cross_source_table",
                "title": "关键候选的跨数据源验证",
                "subtitle": "Paper EV/round 与 recorder EV/share 的单位不同，不直接比较幅度；这里只检查符号、区间和成交一致性。",
                "dataset": "cross_source", "sourceId": "cross_source_sql",
                "columns": [
                    {"field": "test", "label": "Test", "type": "text"},
                    {"field": "source", "label": "Source", "type": "text"},
                    {"field": "period", "label": "Period", "type": "text"},
                    {"field": "rounds", "label": "Rounds", "format": "number"},
                    {"field": "days", "label": "Days", "format": "number"},
                    {"field": "ev", "label": "EV", "format": "currency", "movement": True},
                    {"field": "ci_low", "label": "95% low", "format": "currency", "movement": True},
                    {"field": "ci_high", "label": "95% high", "format": "currency", "movement": True},
                    {"field": "result", "label": "Verdict", "type": "text"}
                ]
            }
        ],
        "sources": [
            source("overview_sql", "Headline metrics from reviewed analysis", overview_sql),
            source("policy_sql", "Policy comparison from reviewed analysis", policy_sql),
            source("daily_sql", "Daily PnL from reviewed analysis", daily_sql),
            source("time_sql", "Time-block metrics from reviewed analysis", time_sql),
            source("cross_source_sql", "Cross-source falsification checks", cross_source_sql),
        ],
        "blocks": [
            {
                "id": "executive_summary",
                "type": "markdown",
                "body": "## Executive Summary / 执行摘要\n\n**目前没有找到可以部署的 edge。** Paper 中最强的候选是 BTC 5m 北京时间 20–24：336 轮、PnL +$50.25、EV/round +$0.150，discovery 和 holdout 都为正。但独立 recorder 用真实首次 bestAsk 重算后，全历史 880 轮 EV/share -$0.047，日区块 95% 区间完全低于零。目标分段 464 个 Paper 单边成交里，有 163 个（35.1%）没有被 recorder 看到；Paper 的 128 个双边成交，只有 44 个在两边都成立。**成交测量偏差大于策略信号，先修测量，再谈调参。**",
            },
            {"id": "headline_metrics", "type": "metric-strip", "cardIds": ["baseline_card", "validation_card"]},
            {
                "id": "key_findings",
                "type": "markdown",
                "body": "## Key Findings / 关键发现\n\n- Paper baseline：2,689 轮，PnL -$45.36，EV/round -$0.0169；日区块 95% 区间 -$0.124 至 +$0.082。\n- BTC 5m 20–24 是最强 Paper 分段，7 天中 6 天为正；但这是 39 个候选中挑出的赢家，holdout 只有 3 天。\n- 独立 recorder 覆盖 5,486 个 BTC 5m 轮次、21 个北京时间日期；20–24 与 cooldown 的 EV 都仍为负。\n- 5 分钟 cooldown 在 Paper 中 EV +$0.028；在 recorder 中只是把 EV/share 从 -$0.0523 改善到 -$0.0463，不能称为 alpha。\n- 16–20 在 Paper discovery 和 holdout 均为负，是较合理的预注册 avoidance arm。\n- 报价年龄不是主要解释：Paper 成交记录的 quote age 通常只有毫秒级；核心矛盾是两个独立 WS/快照语义对‘触价’的判定不一致。",
            },
            {"id": "policy_ev_block", "type": "chart", "chartId": "policy_ev"},
            {"id": "daily_block", "type": "chart", "chartId": "daily_pnl"},
            {"id": "time_block", "type": "chart", "chartId": "time_block_ev"},
            {"id": "policy_detail", "type": "table", "tableId": "policy_table", "layout": "full"},
            {"id": "cross_source_detail", "type": "table", "tableId": "cross_source_table", "layout": "full"},
            {
                "id": "recommended_next_steps",
                "type": "markdown",
                "body": "## Recommended Next Steps / 建议下一步\n\n1. 暂不调整或发布交易策略；先让 Paper 与 recorder 对同一 token、同一盘口事件产出可逐笔对账的 receipt。\n2. 将保守成交口径作为主口径：至少要求 recorder 可复核，进一步加入队列位置或触价折扣；报告 Paper-only、recorder-only 和共同成交率。\n3. 成交一致性达标后再冻结实验：A=baseline；B=结算 single 后 cooldown 5m；C=排除 16–20。20–24 仅作为探索臂，不作为优先上线候选。\n4. 连续跑满至少 30 个完整北京时间自然日，中途不重选窗口；主指标固定为 EV/eligible round、PnL/day、日最大回撤、覆盖率和跨源成交一致率。\n5. 只有独立成交口径下的日区块区间高于零，且收益不集中在少数日期，才进入小仓位真钱验证。",
            },
            {
                "id": "further_questions",
                "type": "markdown",
                "body": "## Further Questions / 后续问题\n\n- Paper 与 recorder 的差异来自初始盘口快照、增量 WS 丢包，还是订单事件与盘口事件的时间排序？\n- 对共同成交、Paper-only 与 recorder-only 三组，盘口深度和停留时间分别如何？\n- cooldown 的‘少亏’是否只是减少交易次数，还是对 paired rate 有稳定的条件提升？\n- 排除 16–20 在新的、冻结规则的样本里能否继续降低损失？",
            },
            {
                "id": "caveats",
                "type": "markdown",
                "body": "## Caveats & Assumptions / 限制与假设\n\n- Paper run 只有 8 个北京时间日期，首尾日不完整；候选搜索有明显多重比较偏差。\n- Holdout 是同一 run 的后段，不是真正独立实验；20–24 holdout 只有 3 天。\n- Recorder 只记录开盘到结算之间的触价；Paper 会提前挂单，因此两者不是完全相同的执行模型。但目标分段 Paper 双边成交均在开盘后完成，差异仍需要解释。\n- Recorder 的 actual-touch PnL 使用首次观察到的 bestAsk，不含真实队列、延迟和手续费，因此仍偏乐观；负结果具有反证意义。\n- cooldown 反事实假设跳过订单不会改变后续成交或资金占用。\n- Strategy-check 特征不可用，尚不能检验波动率、chop、drift、momentum 或 queue 状态。",
            },
        ],
    },
    "snapshot": {
        "version": 1,
        "generatedAt": RESULTS["as_of"],
        "status": "partial",
        "datasets": {
            "overview": overview,
            "policy_comparison": policy_rows,
            "daily_pnl": daily_rows,
            "time_blocks": time_rows,
            "cross_source": cross_source_rows,
        },
        "accessIssues": [
            {
                "id": "strategy_checks_unavailable",
                "dataset": "strategy_check_features",
                "message": "The bounded read-only extraction timed out for strategy_check events; feature-level tuning was not evaluated.",
            }
        ],
    },
    "package_info": {
        "originUrl": "artifact://paper-dual-entry-edge-tuning",
        "controls": {"edit": True, "refresh": True},
    },
    "sources": [
        source("overview_sql", "Headline metrics from reviewed analysis", overview_sql),
        source("policy_sql", "Policy comparison from reviewed analysis", policy_sql),
        source("daily_sql", "Daily PnL from reviewed analysis", daily_sql),
        source("time_sql", "Time-block metrics from reviewed analysis", time_sql),
        source("cross_source_sql", "Cross-source falsification checks", cross_source_sql),
    ],
}

(ROOT / "artifact.json").write_text(json.dumps(artifact, ensure_ascii=False, indent=2))
print(ROOT / "artifact.json")
