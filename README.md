# poly-btc5m

Research and execution infrastructure for recurring Polymarket crypto Up/Down
markets.

> [!WARNING]
> This repository is a **completed strategy research project, not a profitable
> trading system**. The production stack was stopped on 2026-07-16 after the
> tested Dual, Tail, and 50/50 strategies failed to establish stable positive
> expected value. The code can still place real orders when configured for
> `live`; use `monitor` unless you are deliberately conducting a new,
> independently validated experiment.

## What this project established

The original idea was simple: place low-priced orders on both sides of a
recurring market and keep the spread when both orders fill. The project grew
into a multi-asset research and execution platform with independent recorders,
simulation-driven parameter selection, single-fill risk controls, Tail entry,
and a live operations dashboard.

The engineering worked. The tested strategies did not produce a durable edge.

### Main findings

1. **Dual's small paired profit did not cover its single-fill tail risk.**
   When both sides fill, profit per share is `1 - YES price - NO price`. When
   only one side fills, the position becomes an unproven directional bet. In
   both simulation and live execution, infrequent large single losses consumed
   many small paired wins.

2. **Changing price, asset, interval, selector, exit, or cooldown did not make
   Dual reliably positive EV.**
   Prices from 29c through 49c, dynamic 42c-46c pricing, CHOP filters, six
   assets, 5m/15m/1h intervals, automatic Top-1 selection, and multiple
   cooldown policies were tested. At one early snapshot 29c was merely the
   least-negative row (`-0.047595` EV/share across assets and `-0.004897` for
   BTC); the larger final retained BTC sample was about `-0.1415` EV/share.
   Cooldown reduced exposure and losses, but did not create an edge.

3. **Tail was more defensible conceptually, but its early positive result did
   not survive execution-aware validation.**
   The first 25-round sample showed positive PnL at every checkpoint and size.
   Later work exposed sample-size, fillability, ask-band, size-selection,
   stale-book, and FAK retry biases. Some rolling simulation rows remained
   positive, while reconstructed PnL from retained actual Tail fills was about
   `-$13.42`. High win rate was not enough to offset occasional full losses.

4. **The final 50c + 50c experiment made the structural problem explicit.**
   A paired fill has approximately zero gross edge, so every single fill is
   uncompensated risk. Over eight hours, 57 settled rounds produced:

   | Outcome | Rounds | PnL |
   |---|---:|---:|
   | Both sides filled | 25 | `+$0.085` |
   | One side filled | 32 | `-$19.55` |
   | **Total** | **57** | **`-$19.465`** |

   Estimated account value fell from about `$20.01` to `$0.5497` (about
   `-97.3%`, assuming no deposits or withdrawals). This experiment triggered
   the final production shutdown.

The bounded conclusion is:

> Within the prices, assets, intervals, selectors, cooldowns, exits, and live
> execution paths tested by this project, there is no evidence that Dual or
> Tail is ready for stable profitable deployment. "Best available" must never
> be confused with "positive EV."

## Read the full retrospective

- [Technical audit and complete parameter/result inventory](docs/poly-btc5m-strategy-project-postmortem-zh.md)
- [Chronological, story-style project retrospective](docs/poly-btc5m-strategy-project-story-zh.md)

The technical audit is the source of truth for historical figures. It separates
simulation, execution-adjusted replay, and actual live results, and records the
limitations of each evidence source.

## Strategy families tested

### Dual: paired next-round limit orders

Dual posts YES and NO limit orders before a round starts.

```text
paired PnL/share = 1 - yesPrice - noPrice
single win/share = 1 - entryPrice
single loss/share = -entryPrice
```

The project tested:

- fixed 29c-50c prices and dynamic 42c-46c pricing;
- fixed and score-scaled order sizes;
- BTC, ETH, SOL, DOGE, XRP, and HYPE;
- 5m, 15m, and 1h recurring markets;
- Binance path/CHOP filters and an entry-score bypass experiment;
- simulation-selected price and automatic Top-1 asset selection;
- single penalties of `0`, `0.05`, `0.1`, and `0.2` in selector research;
- confirmation ticks, participation checks, queue-imbalance diagnostics, and
  positive-EV availability gates;
- staged hedge, profit exit, loss exit, provisional single-risk blocking, and
  cooldowns from minutes to hours.

The important failure mode was structural: increasing price improved paired
fill probability while shrinking paired edge and increasing single loss;
decreasing price increased nominal paired edge but made useful paired fills too
rare. Parameter searches occasionally found positive low-frequency cells—for
example 30c plus a six-hour cooldown traded only 16 of 452 rounds—but those
cells were not credible out-of-sample evidence.

### Tail: buy the stronger side near round end

Tail asks a different question: whether the stronger side's estimated win
probability is greater than the executable ask-book VWAP near settlement.

The recorder sampled 60s, 45s, 30s, 20s, 15s, 10s, and 5s checkpoints. The
implementation evolved from checkpoint-level ranking into checkpoint plus
ask-band selection with fixed-size VWAP, minimum samples, EV gates, optional
Wilson-bound margin, submit-time book revalidation, same-round Dual exclusion,
and Tail-only escalating cooldown.

This removed several optimistic modeling errors, but it did not establish live
positive EV. Tail remains the more coherent hypothesis for future research,
not a validated strategy in this repository.

### `experiment_next_round`: 50/49 and 50/50

The experiment profile deliberately bypassed most strategy-selection logic to
test raw next-round fill structure. It preserved credentials, balance, timing,
price/size, and duplicate-order safety gates, but disabled ordinary Tail and
classic exit/hedge paths.

The 50/50 run is historical evidence, not a template to repeat. Its paired edge
was zero before fees and execution costs, while `EXPERIMENT_STOP_ON_SINGLE=false`
allowed repeated single exposure.

## Evidence retained

At shutdown, the research/runtime surfaces retained approximately:

| Evidence | Retained scale |
|---|---:|
| 5m touch simulation completed rows | 261,072 |
| 5m touch all-time completed rounds | 13,193 |
| 5m Tail completed rows | 74,100 |
| 5m Tail sampled rounds | 10,631 |
| Runtime orders/fills/intents/settlements | up to 1,000 each |
| Single-fill hedge outcomes | 678 |
| Single-fill cooldown events | 39 |
| Tail cooldown events | 1 |

These figures are not all directly additive:

- runtime arrays were capped at 1,000 records and are not complete project
  history;
- wallets changed during the project;
- rounds containing entry and exit activity can overlap strategy-level PnL
  reconstructions;
- touch simulation modeled best-ask touch, not queue position, latency,
  cancellation, partial fill, or actual order persistence;
- the Tail summary schema and execution model changed during the project.

Use the following evidence order when evaluating a claim:

1. actual settled live orders;
2. execution-adjusted replay;
3. static simulation;
4. small-sample exploratory results.

## Repository structure

```text
apps/api              Express API, worker loop, data services, execution
apps/web              React operations and research dashboard
packages/shared       Shared schemas and runtime/dashboard types
packages/strategy     Profile-neutral Up/Down entry and risk engine
packages/polymarket   Local Polymarket CLOB adapter
tools/research        Independent touch and Tail recorders/repricing tools
configs               Non-secret market/round configuration examples
deploy                Docker, Caddy, Nginx, and historical deployment scripts
docs                  Strategy notes and full project retrospectives
skills                Monitor, live, Docker, deploy, and troubleshooting guides
```

## Safe local setup

```bash
cp .env.example .env
npm install
npm run typecheck
npm test
npm run build
```

Set `EXECUTION_MODE=monitor` in `.env`, then start the API and dashboard:

```bash
npm run dev:api
npm run dev:web
```

- API and production-served dashboard: <http://localhost:8788>
- Vite development dashboard: <http://localhost:5173>

Monitor mode records local order intents without posting CLOB orders. A default
in code or in `.env.example` must not be treated as a recommendation for live
trading.

## Independent research recorders

### Paired/single touch recorder

```bash
npm run research:pm5m-touch -- --assets btc,eth,sol,doge,xrp,hype --min-price 0.29 --max-price 0.49
npm run research:pm5m-touch -- --assets btc,eth,sol,doge,xrp,hype --interval 15m --min-price 0.29 --max-price 0.49
npm run research:pm5m-touch -- --assets btc,eth,sol,doge,xrp,hype --interval 1h --min-price 0.29 --max-price 0.49
```

The recorder uses Gamma HTTP and the Polymarket CLOB market websocket. It does
not import the bot runtime or place orders. Results are written to ignored
interval-specific paths such as `data-lab/pm-5m-touch/`. The dashboard reads a
summary through a read-only API endpoint.

Treat its EV as an optimistic screening statistic, not executable PnL. The
static model cannot reproduce real queue and persistence behavior.

### Tail orderbook recorder

```bash
npm run research:pm5m-tail -- --assets btc,eth,sol,doge,xrp,hype --checkpoints 60,45,30,20,15,10,5 --size 2
```

This recorder samples YES/NO orderbooks at configured seconds-to-end
checkpoints, chooses the stronger side by midpoint, computes fixed-size ask-book
VWAP, waits for Gamma resolution, and writes results under
`data-lab/pm-5m-tail/` (with equivalent interval-specific directories).

Changing checkpoint, lookback, size, or ask band after inspecting the same
sample is parameter search. Validate any selected rule on a later untouched
window before drawing a profitability conclusion.

## Runtime model

For every enabled asset/interval profile, the worker can:

- discover deterministic recurring Up/Down rounds through Gamma;
- sample per-asset Binance aggregate-trade prices;
- maintain YES/NO books from the Polymarket CLOB websocket;
- compute price-path features and CHOP diagnostics;
- create Dual or Tail intents according to the active strategy profile;
- reconcile orders/fills, execute bounded risk actions, and estimate settlement;
- expose profile state, simulation summaries, orders, fills, cooldowns, and
  settlements in the dashboard.

There is no HTTP/manual/simulated fallback for the live crypto price or CLOB
orderbook. Missing, disconnected, or stale required feeds block entry.

## Configuration

Configuration lives in `.env` and `configs/btc5m.example.json`. The full set of
environment keys and historical values is documented in `.env.example` and in
the technical retrospective.

Real order signing requires:

```dotenv
EXECUTION_MODE=live
POLYMARKET_DEPOSIT_WALLET=0x...
OWNER_PRIVATE_KEY=...
```

Those values only enable execution; they do not make the selected strategy
profitable. Do not switch to `live` merely because feeds, tests, or simulation
are green.

For operational guidance, use:

- `skills/btc5m-monitor/SKILL.md` — feed, discovery, book, and dashboard checks;
- `skills/btc5m-live/SKILL.md` — historical live execution controls and risks;
- `skills/btc5m-docker/SKILL.md` — local Docker path;
- `skills/btc5m-deploy/SKILL.md` — historical server deployment path;
- `skills/btc5m-troubleshooting/SKILL.md` — round, feed, order, and UI diagnosis.

## Validation

```bash
npm run typecheck
npm test
npm run build
```

Unit tests cover the strategy engine, multi-profile runtime, selectors, Tail
entry, execution, pending single risk, hedge, profit/loss exits, discovery,
market data, persistence, and notifications. They validate implementation
behavior, not economic profitability.

## Historical deployment notes

The former server deployment used:

```bash
./deploy/deploy-a.sh
```

Runtime state was persisted at:

```text
~/apps/poly-btc5m/data/runtime-state.json
```

The deployment script preserves `data/` and the server-owned `.env` across
syncs. The production stack is intentionally stopped; this section remains for
forensic reproducibility, not as an instruction to restart it.

## Safety and future research rules

- Default to `monitor`; treat every live run as a separately authorized
  experiment with a hard loss budget.
- Require an absolute positive-EV gate. Never trade the top-ranked candidate
  when every candidate is negative.
- Freeze parameters before the forward window. Do not tune and evaluate on the
  same rounds.
- Model queue position, latency, cancellation, partial fills, order persistence,
  fees, and slippage before promoting simulation results.
- Judge paired and single outcomes together. Paired fill rate alone is not a
  strategy metric.
- Treat cooldown, hedge, and exits as loss-shaping controls, not sources of
  edge.
- Require sufficient out-of-sample volume and a positive lower confidence bound
  on net EV before considering live capital.
- Stop automatically on data disagreement, unexpected round timing, repeated
  single fills, or a breached loss budget.
- Do not commit `.env`, private keys, wallet secrets, runtime state, or raw
  account data.
- Do not expose the dashboard publicly without authentication or a private
  network boundary.

The project's most reusable result is methodological: a sophisticated selector,
a high win rate, or a loss-reducing cooldown cannot rescue a strategy whose
execution-adjusted expected value remains negative.
