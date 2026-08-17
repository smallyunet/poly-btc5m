#!/usr/bin/env python3
"""Build a canonical portable report for the Tail PnL diagnostic."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SNAPSHOT = json.loads((ROOT / "tail_diagnostic_snapshot.json").read_text())
SUMMARY_5M = SNAPSHOT["summaries"]["5m"]
SUMMARY_15M = SNAPSHOT["summaries"]["15m"]


def sql_materialize(table: str, rows: list[dict]) -> tuple[list[dict], str]:
    columns = list(rows[0])
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    definitions = []
    for column in columns:
        sample = next((row[column] for row in rows if row[column] is not None), "")
        kind = "REAL" if isinstance(sample, float) else "INTEGER" if isinstance(sample, int) else "TEXT"
        definitions.append(f'"{column}" {kind}')
    connection.execute(f'CREATE TABLE "{table}" ({", ".join(definitions)})')
    connection.executemany(
        f'INSERT INTO "{table}" VALUES ({", ".join("?" for _ in columns)})',
        [[row[column] for column in columns] for row in rows],
    )
    sql = f'SELECT {", ".join(chr(34) + column + chr(34) for column in columns)} FROM "{table}"'
    selected = [dict(row) for row in connection.execute(sql)]
    connection.close()
    return selected, sql


all_checkpoints = {row["checkpointSeconds"]: row for row in SUMMARY_5M["completed"]["byCheckpoint"]}
btc_rows = [row for row in SUMMARY_5M["completed"]["byAssetCheckpoint"] if row.get("asset") == "btc"]
checkpoint_rows = []
for row in btc_rows:
    checkpoint = row["checkpointSeconds"]
    for series, source_row in [("BTC 5m", row), ("All 5m assets", all_checkpoints[checkpoint])]:
        checkpoint_rows.append({
            "checkpoint": f"T-{checkpoint}s",
            "checkpoint_seconds": checkpoint,
            "series": series,
            "rows": source_row["rows"],
            "fillable": source_row["fillable"],
            "wins": source_row["wins"],
            "win_rate": source_row["winRate"],
            "avg_vwap": source_row["avgVwap"],
            "ev_per_share": source_row["avgPnlPerShare"],
            "total_pnl": source_row["totalPnl"],
        })

btc_table = [{
    "checkpoint": f"T-{row['checkpointSeconds']}s",
    "observed_rows": row["rows"],
    "fillable": row["fillable"],
    "wins": row["wins"],
    "win_rate": row["winRate"],
    "avg_vwap": row["avgVwap"],
    "probability_gap": row["winRate"] - row["avgVwap"],
    "ev_per_share": row["avgPnlPerShare"],
    "total_pnl": row["totalPnl"],
} for row in btc_rows]

sign_rows = []
for interval, summary in [("5m", SUMMARY_5M), ("15m", SUMMARY_15M)]:
    for group, label in [
        ("byCheckpoint", "Checkpoint"),
        ("byAssetCheckpoint", "Asset × checkpoint"),
        ("byAskBand", "Checkpoint × ask band"),
        ("byAssetAskBand", "Asset × checkpoint × band"),
    ]:
        rows = summary["completed"].get(group, [])
        for sign, count in [
            ("Positive", sum((row.get("totalPnl") or 0) > 0 for row in rows)),
            ("Negative", sum((row.get("totalPnl") or 0) < 0 for row in rows)),
            ("Zero/missing", sum((row.get("totalPnl") or 0) == 0 for row in rows)),
        ]:
            sign_rows.append({"scope": f"{interval} {label}", "interval": interval, "group": label, "sign": sign, "count": count})

overview = [{
    "settlements": SNAPSHOT["eventCounts"]["settlements"],
    "fills": SNAPSHOT["eventCounts"]["fills"],
    "tail_fills": SNAPSHOT["eventCounts"]["tailFills"],
    "btc_positive_checkpoints": sum(row["totalPnl"] > 0 for row in btc_rows),
    "btc_checkpoint_count": len(btc_rows),
    "all_asset_negative_slices": sum(row["totalPnl"] < 0 for row in SUMMARY_5M["completed"]["byAssetCheckpoint"]),
}]

overview, overview_sql = sql_materialize("tail_overview", overview)
checkpoint_rows, checkpoint_sql = sql_materialize("tail_checkpoint_comparison", checkpoint_rows)
btc_table, btc_sql = sql_materialize("btc_checkpoint_detail", btc_table)
sign_rows, sign_sql = sql_materialize("tail_sign_counts", sign_rows)


def source(source_id: str, label: str, sql: str) -> dict:
    return {
        "id": source_id,
        "label": label,
        "query": {
            "engine": "sqlite",
            "sql": sql,
            "description": "Selects reviewed rows materialized from the read-only Paper API and Tail summary snapshot.",
            "executed_at": SNAPSHOT["extractedAt"],
        },
    }


sources = [
    source("overview_sql", "Paper event and Tail overview", overview_sql),
    source("checkpoint_sql", "5m checkpoint comparison", checkpoint_sql),
    source("btc_sql", "BTC 5m checkpoint detail", btc_sql),
    source("sign_sql", "Tail summary sign counts", sign_sql),
]

artifact = {
    "surface": "report",
    "manifest": {
        "version": 1,
        "surface": "report",
        "title": "为什么尾盘 PnL 看起来全是正的",
        "description": "区分 BTC 5m 模拟器切片、自动参数筛选和实际 Paper 成交。",
        "generatedAt": SNAPSHOT["extractedAt"],
        "charts": [
            {
                "id": "checkpoint_ev",
                "title": "5m checkpoint EV/share",
                "subtitle": "最近 12 小时；BTC 与六资产汇总使用相同 checkpoint 定义。",
                "type": "bar",
                "dataset": "checkpoint_comparison",
                "sourceId": "checkpoint_sql",
                "palette": {"kind": "categorical"},
                "encodings": {
                    "x": {"field": "checkpoint", "type": "ordinal", "label": "Checkpoint"},
                    "y": {"field": "ev_per_share", "type": "quantitative", "label": "EV / share", "format": "currency"},
                    "color": {"field": "series", "type": "nominal", "label": "Scope"},
                    "tooltip": [
                        {"field": "fillable", "type": "quantitative", "label": "Fillable", "format": "number"},
                        {"field": "win_rate", "type": "quantitative", "label": "Win rate", "format": "percent"},
                        {"field": "avg_vwap", "type": "quantitative", "label": "Avg VWAP", "format": "number"},
                    ],
                },
                "valueFormat": "currency",
            },
            {
                "id": "sign_counts",
                "title": "尾盘汇总行的 PnL 符号",
                "subtitle": "完整 summary 包含大量负值；BTC checkpoint 只是其中一个短窗切片。",
                "type": "bar",
                "dataset": "sign_counts",
                "sourceId": "sign_sql",
                "palette": {"kind": "categorical"},
                "encodings": {
                    "x": {"field": "scope", "type": "nominal", "label": "Summary slice"},
                    "y": {"field": "count", "type": "quantitative", "label": "Rows", "format": "number"},
                    "color": {"field": "sign", "type": "nominal", "label": "PnL sign"},
                },
                "valueFormat": "number",
            },
        ],
        "tables": [
            {
                "id": "btc_detail",
                "title": "BTC 5m checkpoint 明细",
                "subtitle": "最近 12 小时；每个 checkpoint 共享大量相同市场，并非七个独立实验。",
                "dataset": "btc_detail",
                "sourceId": "btc_sql",
                "defaultSort": {"field": "checkpoint", "direction": "desc"},
                "columns": [
                    {"field": "checkpoint", "label": "Checkpoint", "type": "text"},
                    {"field": "observed_rows", "label": "Observed", "format": "number"},
                    {"field": "fillable", "label": "Fillable", "format": "number"},
                    {"field": "wins", "label": "Wins", "format": "number"},
                    {"field": "win_rate", "label": "Win rate", "format": "percent"},
                    {"field": "avg_vwap", "label": "Avg VWAP", "format": "number"},
                    {"field": "probability_gap", "label": "Win − VWAP", "format": "percent", "movement": True},
                    {"field": "ev_per_share", "label": "EV/share", "format": "currency", "movement": True},
                    {"field": "total_pnl", "label": "PnL", "format": "currency", "movement": True},
                ],
            }
        ],
        "sources": sources,
        "blocks": [
            {
                "id": "executive_summary",
                "type": "markdown",
                "body": "## Executive Summary\n\n- **并不是所有尾盘数据都为正。** 最新 5m summary 中，六资产 checkpoint 有 4 正、3 负；asset × checkpoint 有 23 正、19 负。你看到的是 BTC 5m 最近 12 小时的 checkpoint 切片，恰好 7/7 为正。\n- **正收益来自 realized win rate 暂时高于成交 VWAP。** 单边买入的 EV/share 近似 `win rate − VWAP`；BTC 各 checkpoint 的差值约 +3.4 至 +7.5 个百分点。\n- **显示结果还叠加了事后筛选。** 运行时只会从 `totalPnl > 0`、EV 达标、样本数达标的 ask band 中选择最佳组合，所以‘Selected simulation pair’必然是正的。\n- **这不是已实现的 Paper 盈利。** 当前 run 有 2,688 条结算、3,729 条 fill，但 Tail fill 为 0；现在看到的 PnL 全来自滚动模拟器。",
            },
            {
                "id": "mechanics",
                "type": "markdown",
                "body": "## 正 PnL 的直接数学原因\n\nTail 每次只买临近到期时盘口更强的一边。若买入价为 `p`，胜出时每股赚 `1−p`，失败时每股亏 `p`，因此一组样本的平均 PnL/share 近似 `实际胜率−平均 VWAP`。最近窗口里 BTC 的强边胜率为 86.8%–100%，平均 VWAP 为 83.2%–94.2%，于是七个 checkpoint 都显示正值。这个差值是样本结果，不代表市场错误定价已经被证明。",
            },
            {"id": "checkpoint_chart", "type": "chart", "chartId": "checkpoint_ev"},
            {
                "id": "correlation",
                "type": "markdown",
                "body": "## 七个正值不是七次独立验证\n\n每个 BTC checkpoint 都观察约 139–141 个相同市场，真正满足可成交条件的只有 41–53 个。一个市场若尾盘强边最终获胜，可能同时抬高 60s、45s、30s 等多个 checkpoint，因此七行高度相关。尤其 T-5s 的 49/49 和其他接近 100% 的胜率，更像短窗口与相关样本的集中表现，不能简单相乘成很高置信度。",
            },
            {"id": "btc_table_block", "type": "table", "tableId": "btc_detail", "layout": "full"},
            {
                "id": "selection",
                "type": "markdown",
                "body": "## 完整数据包含负值，参数选择只保留正值\n\n5m 六资产汇总在 30s、20s、15s checkpoint 都为负；更细的 asset × checkpoint 中有 19/42 行为负，asset × checkpoint × ask band 中有 63/187 行为负。与此同时，策略代码明确过滤 `totalPnl <= 0` 与 EV 未达阈值的 band，再按 EV、PnL 和 fill rate 排序取第一名。因此选择面板显示绿色是门槛设计的一部分，不是独立证据。",
            },
            {"id": "sign_chart_block", "type": "chart", "chartId": "sign_counts"},
            {
                "id": "execution",
                "type": "markdown",
                "body": "## 模拟撮合会放大表面稳定性\n\nTail 模型使用 `fak-vwap-immediate-full-fill-v1`：在 checkpoint 按当时 ask 深度计算 VWAP，并假设立即全额成交。它没有模拟决策延迟、盘口撤单、抢单、冲击和 adverse selection。当前被选中的 BTC 5m 组合是 60s / 85c+，28 个 fillable 样本全部获胜，PnL +$2.84；但 Wilson 95% 胜率下界只有 87.9%，而当前价格对应的所需胜率接近 100%，且该约束目前仅作参考、不是硬门槛。",
            },
            {
                "id": "recommended_next_steps",
                "type": "markdown",
                "body": "## Recommended Next Steps\n\n1. 把‘selected pair PnL’与‘全部候选 PnL’分开展示，避免选择后偏差。\n2. 先解决 Tail 与 Dual 同轮冲突并开独立 Tail-only Paper arm；当前 `TAIL_DUAL_ROUND_CONFLICT` 使真实 Tail fill 为 0。\n3. 固定 checkpoint/ask band 至少 30 天，不再按 12 小时滚动窗口每日追逐最佳参数。\n4. 将 Wilson 下界相对成交价的 margin 设为硬门槛，并增加延迟/成交折扣敏感性分析。\n5. 用逐市场 block bootstrap，而不是把 checkpoint 行当成独立样本。",
            },
            {
                "id": "further_questions",
                "type": "markdown",
                "body": "## Further Questions\n\n- BTC 的正差值能否在不重选参数的未来 30 天持续？\n- 加入 250–1000ms 延迟、部分成交和更差一个 tick 后，EV 是否仍高于零？\n- edge 是否主要集中在少数 ask band、周末或高波动市场？",
            },
            {
                "id": "caveats",
                "type": "markdown",
                "body": "## Caveats & Assumptions\n\n- 5m summary 仅回看最近 12 小时，15m 回看 48 小时；结果会快速变化。\n- PnL 未包含真实交易费用、队列位置和资金占用。\n- 当前 Paper run 没有 Tail 成交，因此无法用实际 Tail ledger 验证 simulator 与 runtime 的偏差。\n- 多个 checkpoint 共享相同市场，普通逐行置信区间会严重高估有效样本量。",
            },
        ],
    },
    "snapshot": {
        "version": 1,
        "generatedAt": SNAPSHOT["extractedAt"],
        "status": "ready",
        "datasets": {
            "overview": overview,
            "checkpoint_comparison": checkpoint_rows,
            "btc_detail": btc_table,
            "sign_counts": sign_rows,
        },
    },
    "sources": sources,
    "package_info": {"originUrl": "artifact://tail-pnl-diagnostic", "controls": {"edit": True, "refresh": True}},
}

(ROOT / "artifact.json").write_text(json.dumps(artifact, ensure_ascii=False, indent=2))
print(ROOT / "artifact.json")
