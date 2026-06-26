# Polymarket BTC 5m Strategy

## 0. Core Principle

This strategy does **not** trade BTC direction.

The worker primarily targets the **next BTC 5-minute round**. It may place paired YES/NO BUY limit orders before the round starts. After the round starts, the default mode is still settlement-only. The only exception is the optional `BTC5M_SINGLE_FILL_HEDGE` risk control: if only one side has filled in the final window, the worker may cancel stale missing-side limit orders and submit a capped aggressive BUY LIMIT for the missing side. It never sells and never sends an uncapped market order.

No exchange-level expiration is attached to the limit orders. Local `ttlSeconds` is only used for local intent/order dedupe windows.

---

## 1. Data Inputs

### 1.1 BTC Price Feed

BTC price comes from Polymarket RTDS over `wss://ws-live-data.polymarket.com`.

The strategy uses BTC price to compute:

- latest BTC price
- strike-relative crosses
- realized range over 120s and 300s
- range in bps
- two-sided excursion around strike
- drift and momentum ratios
- rolling range percentile
- CHOP score

BTC price is the primary signal for whether the next round is tradeable.

### 1.2 CLOB Orderbook Feed

YES/NO books come from the Polymarket CLOB market websocket.

Orderbook is **not** used to predict whether BTC will chop. It is only used as a correctness/execution gate:

- token IDs must match the target next round
- book source must be live websocket data
- book must be fresh within `MAX_ORDERBOOK_AGE_SECONDS`
- BUY side must have a best ask

Spread, depth, and imbalance are not part of the current entry prediction logic.

---

## 2. Time Rules

The target round is always the deterministic next round:

```text
btc-updown-5m-<nextStartSec>
```

The worker does not continue targeting a current round because it has local orders or fills.

Entry is allowed only during the pre-start decision window:

```text
0 <= secondsToStart <= decisionLeadSeconds
```

Current default:

```text
decisionLeadSeconds = 30
```

Normal entry execution also enforces a hard post-start gate:

```text
Date.now() < round.startAt
```

If this is false, normal entry execution rejects with:

```text
ROUND_ALREADY_STARTED
```

All SELL intents are rejected with:

```text
SELL_DISABLED_SETTLEMENT_ONLY
```

The final-window single-fill hedge uses a separate time gate:

```text
secondsToEnd <= SINGLE_FILL_HEDGE_WINDOW_SECONDS
secondsToEnd > SINGLE_FILL_HEDGE_MIN_SECONDS_TO_END
```

Current defaults:

```text
SINGLE_FILL_HEDGE_WINDOW_SECONDS=30
SINGLE_FILL_HEDGE_MIN_SECONDS_TO_END=5
```

---

## 3. BTC Feature Definitions

### 3.1 Cross

Cross is defined only from BTC price and round strike:

```text
sign(BTC_t - strike) != sign(BTC_t-1 - strike)
```

Only non-zero sign changes count.

### 3.2 Realized Range

```text
range120s = max(price over last 120s) - min(price over last 120s)
range300s = max(price over last 300s) - min(price over last 300s)
```

Converted to bps:

```text
rangeBps120s = range120s / latestPrice * 10000
rangeBps300s = range300s / latestPrice * 10000
```

### 3.3 Two-Sided Excursion

Two-sided excursion measures whether BTC moved meaningfully on both sides of strike:

```text
upExcursion = max(price - strike, 0)
downExcursion = max(strike - price, 0)

upExcursionBps120s = upExcursion / latestPrice * 10000
downExcursionBps120s = downExcursion / latestPrice * 10000
minBiExcursionBps120s = min(upExcursionBps120s, downExcursionBps120s)
excursionBalance120s = min(upExcursionBps120s, downExcursionBps120s) / max(upExcursionBps120s, downExcursionBps120s)
```

This is the most important CHOP quality feature because the strategy wants both YES and NO to have a chance to trade cheaply. `excursionBalance120s` is closest to 1 when both sides move similarly; a path with one deep side and one shallow touch is scored lower.

### 3.4 Drift Ratio

```text
drift120s = lastPrice120s - firstPrice120s
driftRatio120s = abs(drift120s) / range120s
```

Lower is better. A high ratio means the move is more directional.

### 3.5 Momentum Ratio

```text
momentum30s = latestPrice - firstPriceWithinLast30s
momentumRatio30s = abs(momentum30s) / range120s
```

Lower is better. A high ratio means the recent path is too one-sided.

### 3.6 Range Percentile

The worker computes rolling 120s ranges over the last 10 minutes using 30s steps. The latest 120s range is ranked against those windows.

Healthy middle-high range percentiles are better than extremely low or extreme outlier ranges.

Range percentile is currently kept as a diagnostic feature. It no longer directly increases `chopScore`.

---

## 4. CHOP Score

`chopScore` is a 0-100 score:

```text
chopScore =
  crossScore
+ rangeScore
+ twoSidedScore
+ balanceScore
+ driftScore
+ momentumScore
```

Current scoring:

```text
crossScore       = min(cross120s / 4, 1) * 25
rangeScore       = min(rangeBps120s / 3, 1) * 10
twoSidedScore    = min(minBiExcursionBps120s / 2, 1) * 25
balanceScore     = excursionBalance120s * 15
driftScore       = max(1 - driftRatio120s / 0.7, 0) * 15
momentumScore    = max(1 - momentumRatio30s / 0.8, 0) * 10
```

`rangeScore` now represents a minimum activity gate: once the path reaches roughly 3bps, larger range does not keep adding score. Higher dynamic limit prices and shares mostly come from repeated crosses, two-sided excursion, balanced excursions, low drift, and low short-term momentum.

High CHOP score does **not** mean low volatility. It means BTC has enough two-sided movement without strong directional persistence.

---

## 5. Regime Classification

### 5.1 UNKNOWN

Regime is `UNKNOWN` if:

```text
latest BTC price is missing
or samples120s < 8
```

### 5.2 CHOP

Regime is `CHOP` only if all of these pass:

```text
chopScore >= MIN_CHOP_SCORE
cross120s >= MIN_CROSS_120S
rangeBps120s >= MIN_RANGE_BPS_120S
minBiExcursionBps120s >= MIN_BI_EXCURSION_BPS_120S
driftRatio120s <= MAX_DRIFT_RATIO_120S
momentumRatio30s <= MAX_MOMENTUM_RATIO_30S
```

Current default thresholds:

```text
MIN_CHOP_SCORE=70
MIN_CROSS_120S=2
MIN_RANGE_BPS_120S=3
MIN_BI_EXCURSION_BPS_120S=1
MAX_DRIFT_RATIO_120S=0.45
MAX_MOMENTUM_RATIO_30S=0.55
```

### 5.3 TREND

Regime is `TREND` if:

```text
cross120s == 0
and (
  drift/momentum ratio is uncontrolled
  or abs(drift120s) > MAX_ABS_DRIFT_120S
  or abs(momentum30s) > MAX_ABS_MOMENTUM_30S
)
```

Current default fallback thresholds:

```text
MAX_ABS_DRIFT_120S=40
MAX_ABS_MOMENTUM_30S=28
```

### 5.4 LOW_ACTIVITY

If not `UNKNOWN`, `CHOP`, or `TREND`, the regime is `LOW_ACTIVITY`.

---

## 6. Entry Eligibility

The worker creates paired entry intents only if all entry gates pass:

```text
Decision window passes
Regime is CHOP
YES and NO books are tradable
shares >= MIN_ORDER_SHARES
limit price is valid
pair cost <= MAX_PAIR_COST
```

Orderbook tradable means:

```text
book exists
book.source != mock
book age <= MAX_ORDERBOOK_AGE_SECONDS
bestAsk exists
```

Default execution size settings:

```text
ORDER_SHARES_PER_SIDE=10
DYNAMIC_SHARES_ENABLED=true
MAX_ORDER_SHARES_PER_SIDE=12.5
MIN_ORDER_SHARES=5
MAX_ORDERBOOK_AGE_SECONDS=5
```

Live deployment may override `ORDER_SHARES_PER_SIDE` and `MAX_ORDER_SHARES_PER_SIDE`.

---

## 7. Dynamic Limit Price Policy

Dynamic pricing is enabled by:

```text
DYNAMIC_LIMIT_ENABLED=true
```

If disabled, both YES and NO use:

```text
DUAL_LIMIT_PRICE
```

If enabled, the score-based base price is:

```text
chopScore 70-79  => 0.42
chopScore 80-89  => 0.44
chopScore 90-94  => 0.45
chopScore >= 95  => 0.46
```

Then caps are applied:

```text
if secondsToStart > 15:
  timeCap = 0.45
else:
  timeCap = 0.46

pairCostCap = MAX_PAIR_COST / 2
limitPrice = min(scorePrice, timeCap, MAX_DYNAMIC_LIMIT_PRICE, pairCostCap)
limitPrice = max(MIN_DYNAMIC_LIMIT_PRICE, limitPrice)
```

Current defaults:

```text
DUAL_LIMIT_PRICE=0.45
DYNAMIC_LIMIT_ENABLED=true
MIN_DYNAMIC_LIMIT_PRICE=0.42
MAX_DYNAMIC_LIMIT_PRICE=0.46
MAX_PAIR_COST=0.92
```

Pair cost and edge:

```text
pairCost = YES limit + NO limit
pairEdge = 1 - pairCost
```

With symmetric pricing:

```text
0.42 + 0.42 = 0.84 cost, 0.16 edge
0.44 + 0.44 = 0.88 cost, 0.12 edge
0.45 + 0.45 = 0.90 cost, 0.10 edge
0.46 + 0.46 = 0.92 cost, 0.08 edge
```

The strategy currently does not use 48c in normal operation because 48/48 leaves only 4c pair edge and increases single-fill downside.

---

## 8. Dynamic Shares Policy

Dynamic sizing is enabled by:

```text
DYNAMIC_SHARES_ENABLED=true
```

If disabled, both YES and NO use:

```text
ORDER_SHARES_PER_SIDE
```

If enabled, the score-based shares multiplier is:

```text
chopScore 70-79  => 0.50x ORDER_SHARES_PER_SIDE
chopScore 80-89  => 1.00x ORDER_SHARES_PER_SIDE
chopScore 90-94  => 1.00x ORDER_SHARES_PER_SIDE
chopScore >= 95  => 1.25x ORDER_SHARES_PER_SIDE
```

Then the max size cap is applied:

```text
shares = min(scoreShares, MAX_ORDER_SHARES_PER_SIDE)
```

This sizing policy is intentionally conservative: the main risk reduction comes from cutting size on edge-score entries, while very high CHOP scores only get a small size increase.

Current defaults:

```text
ORDER_SHARES_PER_SIDE=10
DYNAMIC_SHARES_ENABLED=true
MAX_ORDER_SHARES_PER_SIDE=12.5
MIN_ORDER_SHARES=5
```

---

## 9. Intent Generation

When entry is eligible, the worker creates two BUY LIMIT intents:

```text
YES BUY limitPrice, dynamic shares
NO  BUY limitPrice, dynamic shares
```

Both sides use the same dynamic limit price and the same dynamic shares. The strategy does not currently bias YES vs NO based on BTC direction.

Intent fields:

- strategy: `BTC5M_DUAL_45`
- side: `BUY`
- orderType: `LIMIT`
- ttlSeconds: `decisionLeadSeconds`

`ttlSeconds` is local metadata/dedupe. It does not set exchange order expiration.

---

## 10. Execution Gates

Before posting a normal entry intent live, execution checks:

```text
token is in the target round
intent.side is not SELL
current time is before round start
runtime is live and not degraded
OWNER_PRIVATE_KEY exists
POLYMARKET_DEPOSIT_WALLET exists
order type is LIMIT
limit price is valid
shares are valid
orderbook is live/fresh and has the needed side
no local duplicate order exists
no recent failed duplicate exists
no open Polymarket order exists for the same token
```

For BUY, orderbook must have best ask. For SELL, execution rejects before orderbook checks because this strategy disables all SELL actions.

Single-fill hedge execution additionally checks:

```text
SINGLE_FILL_HEDGE_ENABLED=true
round is running and inside the hedge window
one BUY side exceeds the other side by at least MIN_ORDER_SHARES
missing-side book is live/fresh
missing-side bestAsk <= SINGLE_FILL_HEDGE_MAX_PRICE
dominant average fill price + hedge limit <= SINGLE_FILL_HEDGE_MAX_PAIR_COST
no recent local hedge duplicate exists
```

The hedge is not a market order. It is a capped aggressive limit:

```text
hedgeLimitPrice = min(bestAsk + SINGLE_FILL_HEDGE_PRICE_OFFSET, SINGLE_FILL_HEDGE_MAX_PRICE)
```

---

## 11. After Round Start

After round start, the worker normally does not:

- add to either side
- sell
- exit single-sided exposure
- rebalance
- post new trade intents

The only exception is final-window single-fill hedging. Trigger conditions:

- the active round has started and is inside `SINGLE_FILL_HEDGE_WINDOW_SECONDS`
- more than `SINGLE_FILL_HEDGE_MIN_SECONDS_TO_END` remains
- one BUY side materially exceeds the other side
- the missing-side live best ask is not above `SINGLE_FILL_HEDGE_MAX_PRICE`
- dominant-side average fill price plus hedge limit is not above `SINGLE_FILL_HEDGE_MAX_PAIR_COST`

When triggered, the worker:

- cancels stale missing-side BUY limit orders
- reconciles fills again
- submits a capped aggressive BUY LIMIT for the missing-side share gap

Otherwise it only:

- syncs market data
- reads positions when wallet is configured
- reconciles fills
- estimates settlement/PnL after the round is settled

Estimated settlement uses:

```text
winningLabel = latest BTC price >= strike ? YES : NO
payout = winning side filled BUY shares
pnl = payout - total BUY cost
```

Local settlement rows are estimates until final Polymarket resolution is independently verified.

---

## 12. Fill Scenarios

### Both Sides Fill

The intended outcome is paired exposure:

```text
pairCost < 1
payout = 1
profit = 1 - pairCost
```

### One Side Fills

The position becomes directional exposure. The old strategy held it through settlement; the optional single-fill hedge now tries to buy the missing side in the final window with a price cap, turning directional exposure into a near-fixed outcome.

For one share at price `p`:

```text
win:  1 - p
lose: -p
```

Examples:

```text
p=0.42 => win +0.58, lose -0.42
p=0.44 => win +0.56, lose -0.44
p=0.45 => win +0.55, lose -0.45
p=0.46 => win +0.54, lose -0.46
```

This is the main risk of the strategy. Dynamic pricing is designed to use lower prices for weaker CHOP scores and only raise price when the CHOP signal is stronger.

If the final-window hedge buys the missing side, the outcome becomes:

```text
hedgedPnlPerShare = 1 - originalAvgPrice - hedgeLimitPrice
```

Example with original average fill price `0.44`:

```text
hedgeLimit=0.55 => +0.01/share
hedgeLimit=0.65 => -0.09/share
hedgeLimit=0.80 => -0.24/share
no hedge and original side loses => -0.44/share
```

The hedge is therefore a tail-loss reducer, not an unconditional return enhancer. If the cap is exceeded, the worker does not chase.

---

## 13. Dashboard Surfaces

The dashboard shows:

- `Market Regime`
- `BTC Dynamic Score`
- dynamic `Entry Limit`
- pair cost and pair edge
- orderbook tradability status
- current blockers
- post-start action mode: default settlement-only, with capped single-fill hedge activity visible in logs
- detailed strategy conditions

The page is intended to make the current decision and blockers visible without reading logs.

---

## 14. Final Rule

Trade only when BTC shows a high-quality two-sided CHOP structure before the next round starts.

Do not trade when:

- data is missing
- the target is not the next round
- the decision window is closed
- BTC is TREND or LOW_ACTIVITY
- orderbooks are missing/stale/not buyable
- pair cost exceeds the configured cap
- the round has already started

After start, do nothing except reconcile fills and wait for settlement.
