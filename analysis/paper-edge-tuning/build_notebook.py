#!/usr/bin/env python3
"""Build the executable audit notebook for the Paper edge analysis."""

from pathlib import Path

import nbformat as nbf


ROOT = Path(__file__).resolve().parent
nb = nbf.v4.new_notebook()
nb["metadata"] = {
    "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
    "language_info": {"name": "python", "version": "3"},
}
nb["cells"] = [
    nbf.v4.new_markdown_cell(
        "# Historical edge audit: Paper vs independent recorder\n\n"
        "## TL;DR\n\n"
        "No tradable edge is established. Paper's strongest segment is BTC 5m at Beijing 20:00–24:00, and a "
        "five-minute cooldown is directionally positive inside Paper. Both fail the independent touch-recorder "
        "check: EV remains negative using observed first-touch asks. The fill-model disagreement is larger than "
        "the candidate strategy EV, so measurement reconciliation comes before strategy deployment."
    ),
    nbf.v4.new_markdown_cell(
        "## Context and method\n\n"
        "- Unit: one settled Dual-entry profile/round.\n"
        "- Timezone: Asia/Shanghai (UTC+8).\n"
        "- Discovery: through 2026-08-12; holdout: after 2026-08-12.\n"
        "- Cooldown uses only outcomes settled before the next entry.\n"
        "- Day-block bootstrap preserves within-day dependence.\n"
        "- First and last Paper calendar days are partial. Strategy-check features were unavailable in the bounded extract.\n"
        "- Independent validation uses BTC 5m recorder rounds at a 29c ceiling, priced at each side's observed first bestAsk."
    ),
    nbf.v4.new_code_cell(
        "from pathlib import Path\n"
        "import json\n"
        "import pandas as pd\n"
        "from IPython.display import display\n\n"
        "ROOT = Path.cwd()\n"
        "frame = pd.read_csv(ROOT / 'rounds_snapshot.csv')\n"
        "results = json.loads((ROOT / 'analysis_results.json').read_text())\n"
        "recorder = json.loads((ROOT / 'recorder_validation.json').read_text())\n"
        "validation = json.loads((ROOT / 'validation_results.json').read_text())\n"
        "frame.shape, results['as_of'], validation['status']"
    ),
    nbf.v4.new_markdown_cell("## Data quality"),
    nbf.v4.new_code_cell(
        "dq = results['data_quality']\n"
        "pd.Series({\n"
        "    'round rows': dq['round_rows'],\n"
        "    'unique keys': dq['unique_round_keys'],\n"
        "    'duplicate keys': dq['duplicate_round_keys'],\n"
        "    'fill partition errors': dq['both_single_partition_errors'],\n"
        "    'strategy feature availability': 'unavailable',\n"
        "}).to_frame('value')"
    ),
    nbf.v4.new_markdown_cell("## Primary policy comparison"),
    nbf.v4.new_code_cell(
        "names = {\n"
        " 'baseline': 'Baseline',\n"
        " 'cooldown_5m_after_single': '5m cooldown after single',\n"
        " 'utc8_00_04': 'UTC+8 00–04',\n"
        " 'btc5m_utc8_00_04': 'BTC 5m, UTC+8 00–04',\n"
        " 'cooldown_5m_and_utc8_00_04_or_20_24': '5m cooldown + 00–04/20–24',\n"
        "}\n"
        "rows=[]\n"
        "for key,label in names.items():\n"
        "    item=results['policy_diagnostics'][key]\n"
        "    m=item['metrics']\n"
        "    rows.append({\n"
        "      'policy':label,'rounds':m['n'],'pnl':m['pnl'],'ev_per_round':m['ev'],\n"
        "      'roi_pct':m['roi_pct'],'positive_days':f\"{m['positive_days']}/{m['covered_days']}\",\n"
        "      'daily_std':m['daily_pnl_std'],'max_drawdown':m['daily_max_drawdown'],\n"
        "      'discovery_ev':item['discovery']['ev'],'holdout_ev':item['holdout']['ev'],\n"
        "      'bootstrap_low':item['block_bootstrap_ev95']['low'],'bootstrap_high':item['block_bootstrap_ev95']['high'],\n"
        "    })\n"
        "policy_table=pd.DataFrame(rows)\n"
        "display(policy_table)"
    ),
    nbf.v4.new_markdown_cell("## Time-block diagnostics"),
    nbf.v4.new_code_cell(
        "time_rows=[]\n"
        "for item in results['all_candidates']:\n"
        "    if item['dimension']=='time_block':\n"
        "        time_rows.append({\n"
        "          'time_block':item['value'],'rounds':item['full']['n'],'pnl':item['full']['pnl'],\n"
        "          'full_ev':item['full']['ev'],'discovery_ev':item['discovery']['ev'],\n"
        "          'holdout_ev':item['holdout']['ev'],'positive_days':f\"{item['full']['positive_days']}/{item['full']['covered_days']}\",\n"
        "        })\n"
        "display(pd.DataFrame(time_rows))"
    ),
    nbf.v4.new_markdown_cell("## Cross-source falsification test"),
    nbf.v4.new_code_cell(
        "paper = validation['btc5m_20_24_paper']['full']\n"
        "touch = validation['recorder_actual_touch']\n"
        "agreement = validation['cross_source_agreement']\n"
        "display(pd.DataFrame([\n"
        " {'source':'Paper, BTC5m 20–24','rounds':paper['n'],'ev':paper['ev'],\n"
        "  'ci_low':validation['btc5m_20_24_paper']['block_bootstrap_ev95']['low'],\n"
        "  'ci_high':validation['btc5m_20_24_paper']['block_bootstrap_ev95']['high']},\n"
        " {'source':'Recorder actual touch, all history','rounds':touch['btc5m_20_24_all_history']['rounds'],\n"
        "  'ev':touch['btc5m_20_24_all_history']['ev_per_share'],\n"
        "  'ci_low':touch['btc5m_20_24_all_history']['block_bootstrap_ev95']['low'],\n"
        "  'ci_high':touch['btc5m_20_24_all_history']['block_bootstrap_ev95']['high']},\n"
        " {'source':'Recorder cooldown, all history','rounds':touch['cooldown_all_history']['rounds'],\n"
        "  'ev':touch['cooldown_all_history']['ev_per_share'],\n"
        "  'ci_low':touch['cooldown_all_history']['block_bootstrap_ev95']['low'],\n"
        "  'ci_high':touch['cooldown_all_history']['block_bootstrap_ev95']['high']},\n"
        "]))\n"
        "display(pd.Series(agreement, name='value').drop('contingency').to_frame())"
    ),
    nbf.v4.new_markdown_cell(
        "## Takeaways\n\n"
        "1. Paper baseline is negative and its day-block 95% interval crosses zero.\n"
        "2. BTC 5m at Beijing 20:00–24:00 is the strongest Paper hypothesis, but independent recorder EV is negative across the longer history.\n"
        "3. Five-minute cooldown improves Paper and reduces recorder losses, but recorder EV remains significantly below zero. It is a risk-control hypothesis, not alpha.\n"
        "4. In the target segment, 35.1% of Paper side fills are not corroborated by the recorder; only 44 of 128 Paper paired rounds are paired in both sources.\n"
        "5. Avoiding 16:00–20:00 is the cleanest pre-registered avoidance arm, but no production strategy change is justified until fill semantics are reconciled."
    ),
]
nbf.write(nb, ROOT / "paper_edge_tuning.ipynb")
print(ROOT / "paper_edge_tuning.ipynb")
