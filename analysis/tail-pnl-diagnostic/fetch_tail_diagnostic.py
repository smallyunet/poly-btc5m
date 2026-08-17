#!/usr/bin/env python3
"""Read-only extraction of Tail simulator summaries and current Paper state."""

from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent
RUN_ID = "paper-20260809-7a4dfe6"

REMOTE = r"""
(async () => {
  const fs = require('fs');
  const path = require('path');
  const runId = '__RUN_ID__';
  const eventRoot = 'http://127.0.0.1:8788/api/paper/events?limit=500&runId=' + runId + '&entityType=';
  async function all(type) {
    let cursor = null;
    const rows = [];
    do {
      const response = await fetch(eventRoot + type + (cursor ? '&cursor=' + cursor : ''));
      if (!response.ok) throw new Error(type + ' HTTP ' + response.status);
      const page = await response.json();
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor);
    return rows;
  }
  const [settlements, fills, stateResponse] = await Promise.all([
    all('settlement'),
    all('fill'),
    fetch('http://127.0.0.1:8788/api/state'),
  ]);
  const state = await stateResponse.json();
  const specs = {
    '5m': process.env.PM5M_TAIL_ENTRY_SUMMARY_PATH || process.env.PM5M_TAIL_SUMMARY_PATH || 'data-lab/pm-5m-tail/summary.json',
    '15m': process.env.PM15M_TAIL_ENTRY_SUMMARY_PATH || 'data-lab/pm-15m-tail/summary.json',
    '1h': process.env.PM1H_TAIL_ENTRY_SUMMARY_PATH || 'data-lab/pm-1h-tail/summary.json',
  };
  const summaries = {};
  for (const [interval, configured] of Object.entries(specs)) {
    const resolved = path.resolve(process.cwd(), configured);
    summaries[interval] = fs.existsSync(resolved)
      ? JSON.parse(fs.readFileSync(resolved, 'utf8'))
      : { ok: false, missingPath: resolved };
  }
  const profiles = state.profiles || state.dashboard?.profiles || [];
  const tailChecks = profiles.map((profile) => ({
    profileId: profile.profile?.id || profile.id,
    checks: (profile.strategyChecks || []).filter((check) => check.strategy === 'UPDOWN_TAIL_ENTRY'),
  }));
  process.stdout.write(JSON.stringify({
    extractedAt: new Date().toISOString(),
    runId,
    eventCounts: {
      settlements: settlements.length,
      fills: fills.length,
      tailFills: fills.filter((row) => row.payload?.strategy === 'UPDOWN_TAIL_ENTRY').length,
    },
    summaries,
    tailChecks,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
"""


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    source = REMOTE.replace("__RUN_ID__", RUN_ID)
    encoded = base64.b64encode(source.encode()).decode()
    remote = "docker exec poly-btc5m-api-1 node -e " + json.dumps(
        f"eval(Buffer.from('{encoded}','base64').toString())"
    )
    completed = subprocess.run(
        ["ssh", "-o", "ConnectTimeout=15", "a", remote],
        check=True,
        capture_output=True,
        text=True,
        timeout=180,
    )
    snapshot = json.loads(completed.stdout)
    (ROOT / "tail_diagnostic_snapshot.json").write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps({
        "extractedAt": snapshot["extractedAt"],
        "eventCounts": snapshot["eventCounts"],
        "summaryGeneratedAt": {
            interval: value.get("generatedAt") for interval, value in snapshot["summaries"].items()
        },
    }, indent=2))


if __name__ == "__main__":
    main()
