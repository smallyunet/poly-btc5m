# Polymarket BTC 5m 策略

## 0. 核心原则

该策略**不**交易 BTC 方向。

worker 只面向**下一轮 BTC 5 分钟市场**。它可以在轮次开始前同时挂出 YES/NO 两侧 BUY 限价单。轮次开始后，它不会加仓、退出、再平衡，也不会发布任何新的交易意图。开始后，worker 只负责对账成交，并记录预估结算/PnL。

限价单不会附带交易所层面的过期时间。本地 `ttlSeconds` 只用于本地 intent/order 去重窗口。

---

## 1. 数据输入

### 1.1 BTC 价格源

BTC 价格来自 Polymarket RTDS：

```text
wss://ws-live-data.polymarket.com
```

策略使用 BTC 价格计算：

- 最新 BTC 价格
- 相对 strike 的穿越
- 120s 和 300s 已实现波动区间
- bps 口径区间
- 围绕 strike 的双侧偏离
- drift 和 momentum 比率
- 滚动区间分位数
- CHOP 分数

BTC 价格是判断下一轮是否可交易的主要信号。

### 1.2 CLOB 订单簿源

YES/NO 订单簿来自 Polymarket CLOB market websocket。

订单簿**不**用于预测 BTC 是否会震荡。它只作为正确性和执行门槛：

- token ID 必须匹配目标下一轮
- 订单簿来源必须是实时 websocket 数据
- 订单簿必须在 `MAX_ORDERBOOK_AGE_SECONDS` 内保持新鲜
- BUY 侧必须存在 best ask

spread、depth 和 imbalance 目前不属于入场预测逻辑。

---

## 2. 时间规则

目标轮次永远是确定性的下一轮：

```text
btc-updown-5m-<nextStartSec>
```

worker 不会因为本地已有订单或成交而继续锁定当前轮次。

只有在开始前决策窗口内才允许入场：

```text
0 <= secondsToStart <= decisionLeadSeconds
```

当前默认值：

```text
decisionLeadSeconds = 30
```

执行层还会强制检查开始后的硬门槛：

```text
Date.now() < round.startAt
```

如果不满足，执行会拒绝并返回：

```text
ROUND_ALREADY_STARTED
```

所有 SELL intent 都会被拒绝并返回：

```text
SELL_DISABLED_SETTLEMENT_ONLY
```

---

## 3. BTC 特征定义

### 3.1 Cross

Cross 只由 BTC 价格和轮次 strike 定义：

```text
sign(BTC_t - strike) != sign(BTC_t-1 - strike)
```

只有非零符号变化才计数。

### 3.2 已实现区间

```text
range120s = max(price over last 120s) - min(price over last 120s)
range300s = max(price over last 300s) - min(price over last 300s)
```

转换为 bps：

```text
rangeBps120s = range120s / latestPrice * 10000
rangeBps300s = range300s / latestPrice * 10000
```

### 3.3 双侧偏离

双侧偏离衡量 BTC 是否在 strike 两侧都出现了有意义的运动：

```text
upExcursion = max(price - strike, 0)
downExcursion = max(strike - price, 0)

upExcursionBps120s = upExcursion / latestPrice * 10000
downExcursionBps120s = downExcursion / latestPrice * 10000
minBiExcursionBps120s = min(upExcursionBps120s, downExcursionBps120s)
```

这是最重要的 CHOP 质量特征，因为策略希望 YES 和 NO 都有机会以便宜价格成交。

### 3.4 Drift Ratio

```text
drift120s = lastPrice120s - firstPrice120s
driftRatio120s = abs(drift120s) / range120s
```

越低越好。高比率意味着价格运动更偏方向性。

### 3.5 Momentum Ratio

```text
momentum30s = latestPrice - firstPriceWithinLast30s
momentumRatio30s = abs(momentum30s) / range120s
```

越低越好。高比率意味着最近路径过于单边。

### 3.6 区间分位数

worker 使用 30s 步长计算过去 10 分钟内的滚动 120s 区间，并将最新 120s 区间与这些窗口排序比较。

健康的中高区间分位数优于极低区间或极端离群区间。

---

## 4. CHOP 分数

`chopScore` 是一个 0-100 分数：

```text
chopScore =
  crossScore
+ rangeScore
+ twoSidedScore
+ driftScore
+ momentumScore
+ percentileScore
```

当前评分：

```text
crossScore       = min(cross120s / 3, 1) * 20
rangeScore       = min(rangeBps120s / 6, 1) * 20
twoSidedScore    = min(minBiExcursionBps120s / 2, 1) * 25
driftScore       = max(1 - driftRatio120s / 0.7, 0) * 15
momentumScore    = max(1 - momentumRatio30s / 0.8, 0) * 10
percentileScore  = up to 10
```

区间分位数评分：

- `0.35 <= percentile <= 0.90`：满分 10 分
- 缺失分位数：5 分
- 其他情况：随着偏离健康区间而衰减

高 CHOP 分数**不**意味着低波动。它表示 BTC 有足够的双侧运动，同时没有强烈的方向持续性。

---

## 5. Regime 分类

### 5.1 UNKNOWN

如果满足以下条件，regime 为 `UNKNOWN`：

```text
latest BTC price is missing
or samples120s < 8
```

### 5.2 CHOP

只有以下条件全部通过，regime 才是 `CHOP`：

```text
chopScore >= MIN_CHOP_SCORE
cross120s >= MIN_CROSS_120S
rangeBps120s >= MIN_RANGE_BPS_120S
minBiExcursionBps120s >= MIN_BI_EXCURSION_BPS_120S
driftRatio120s <= MAX_DRIFT_RATIO_120S
momentumRatio30s <= MAX_MOMENTUM_RATIO_30S
```

当前默认阈值：

```text
MIN_CHOP_SCORE=70
MIN_CROSS_120S=2
MIN_RANGE_BPS_120S=3
MIN_BI_EXCURSION_BPS_120S=1
MAX_DRIFT_RATIO_120S=0.45
MAX_MOMENTUM_RATIO_30S=0.55
```

### 5.3 TREND

如果满足以下条件，regime 为 `TREND`：

```text
cross120s == 0
and (
  drift/momentum ratio is uncontrolled
  or abs(drift120s) > MAX_ABS_DRIFT_120S
  or abs(momentum30s) > MAX_ABS_MOMENTUM_30S
)
```

当前默认兜底阈值：

```text
MAX_ABS_DRIFT_120S=40
MAX_ABS_MOMENTUM_30S=28
```

### 5.4 LOW_ACTIVITY

如果不是 `UNKNOWN`、`CHOP` 或 `TREND`，regime 为 `LOW_ACTIVITY`。

---

## 6. 入场资格

只有所有入场门槛都通过时，worker 才会创建成对 entry intents：

```text
Decision window passes
Regime is CHOP
YES and NO books are tradable
shares >= MIN_ORDER_SHARES
limit price is valid
pair cost <= MAX_PAIR_COST
```

订单簿可交易表示：

```text
book exists
book.source != mock
book age <= MAX_ORDERBOOK_AGE_SECONDS
bestAsk exists
```

默认执行规模设置：

```text
ORDER_SHARES_PER_SIDE=10
DYNAMIC_SHARES_ENABLED=true
MAX_ORDER_SHARES_PER_SIDE=12.5
MIN_ORDER_SHARES=5
MAX_ORDERBOOK_AGE_SECONDS=5
```

实盘部署可以覆盖 `ORDER_SHARES_PER_SIDE` 和 `MAX_ORDER_SHARES_PER_SIDE`。

---

## 7. 动态限价策略

动态定价通过以下配置启用：

```text
DYNAMIC_LIMIT_ENABLED=true
```

如果禁用，YES 和 NO 都使用：

```text
DUAL_LIMIT_PRICE
```

如果启用，基于分数的基础价格为：

```text
chopScore 70-79  => 0.42
chopScore 80-89  => 0.44
chopScore 90-94  => 0.45
chopScore >= 95  => 0.46
```

随后应用上限：

```text
if secondsToStart > 15:
  timeCap = 0.45
else:
  timeCap = 0.46

pairCostCap = MAX_PAIR_COST / 2
limitPrice = min(scorePrice, timeCap, MAX_DYNAMIC_LIMIT_PRICE, pairCostCap)
limitPrice = max(MIN_DYNAMIC_LIMIT_PRICE, limitPrice)
```

当前默认值：

```text
DUAL_LIMIT_PRICE=0.45
DYNAMIC_LIMIT_ENABLED=true
MIN_DYNAMIC_LIMIT_PRICE=0.42
MAX_DYNAMIC_LIMIT_PRICE=0.46
MAX_PAIR_COST=0.92
```

成对成本和边际：

```text
pairCost = YES limit + NO limit
pairEdge = 1 - pairCost
```

对称定价下：

```text
0.42 + 0.42 = 0.84 cost, 0.16 edge
0.44 + 0.44 = 0.88 cost, 0.12 edge
0.45 + 0.45 = 0.90 cost, 0.10 edge
0.46 + 0.46 = 0.92 cost, 0.08 edge
```

该策略当前在正常运行中不会使用 48c，因为 48/48 只留下 4c 成对 edge，并且会增加单边成交的下行风险。

---

## 8. 动态 shares 策略

动态规模通过以下配置启用：

```text
DYNAMIC_SHARES_ENABLED=true
```

如果禁用，YES 和 NO 都使用：

```text
ORDER_SHARES_PER_SIDE
```

如果启用，基于分数的 shares multiplier 为：

```text
chopScore 70-79  => 0.50x ORDER_SHARES_PER_SIDE
chopScore 80-89  => 1.00x ORDER_SHARES_PER_SIDE
chopScore 90-94  => 1.00x ORDER_SHARES_PER_SIDE
chopScore >= 95  => 1.25x ORDER_SHARES_PER_SIDE
```

随后应用最大规模上限：

```text
shares = min(scoreShares, MAX_ORDER_SHARES_PER_SIDE)
```

该 sizing 策略刻意保持保守：主要风险降低来自低分入场减仓，极高 CHOP 分数只获得小幅加仓。

当前默认值：

```text
ORDER_SHARES_PER_SIDE=10
DYNAMIC_SHARES_ENABLED=true
MAX_ORDER_SHARES_PER_SIDE=12.5
MIN_ORDER_SHARES=5
```

---

## 9. Intent 生成

入场合格时，worker 创建两个 BUY LIMIT intents：

```text
YES BUY limitPrice, dynamic shares
NO  BUY limitPrice, dynamic shares
```

两侧使用相同的动态限价和相同的动态 shares。策略当前不会根据 BTC 方向对 YES 或 NO 做偏置。

Intent 字段：

- strategy: `BTC5M_DUAL_45`
- side: `BUY`
- orderType: `LIMIT`
- ttlSeconds: `decisionLeadSeconds`

`ttlSeconds` 是本地元数据/去重信息。它不会设置交易所订单过期时间。

---

## 10. 执行门槛

在实盘发布 intent 前，执行层会检查：

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

对 BUY 来说，订单簿必须有 best ask。对 SELL 来说，执行会在订单簿检查前拒绝，因为 settlement-only 模式禁用了所有 SELL 动作。

---

## 11. 轮次开始后

轮次开始后，worker 不会：

- 增加任一侧仓位
- 卖出
- 退出单边敞口
- 再平衡
- 发布新的交易意图

它只会：

- 同步市场数据
- 在配置钱包时读取仓位
- 对账成交
- 在轮次结算后估算 settlement/PnL

预估结算使用：

```text
winningLabel = latest BTC price >= strike ? YES : NO
payout = winning side filled BUY shares
pnl = payout - total BUY cost
```

本地结算行只是预估值，直到最终 Polymarket 结果被独立验证。

---

## 12. 成交场景

### 双侧成交

预期结果是成对敞口：

```text
pairCost < 1
payout = 1
profit = 1 - pairCost
```

### 单侧成交

仓位会变成方向性敞口。worker 在开始后仍然不会退出。

对于价格为 `p` 的一份份额：

```text
win:  1 - p
lose: -p
```

示例：

```text
p=0.42 => win +0.58, lose -0.42
p=0.44 => win +0.56, lose -0.44
p=0.45 => win +0.55, lose -0.45
p=0.46 => win +0.54, lose -0.46
```

这是策略的主要风险。动态定价的设计是：CHOP 分数较弱时使用更低价格，只有在 CHOP 信号更强时才提高价格。

---

## 13. Dashboard 展示面

dashboard 展示：

- `Market Regime`
- `BTC Dynamic Score`
- dynamic `Entry Limit`
- pair cost 和 pair edge
- 订单簿可交易状态
- 当前 blockers
- 开始后动作模式：`SETTLEMENT ONLY`
- 详细策略条件

该页面的目标是在不读日志的情况下展示当前决策和 blockers。

---

## 14. 最终规则

只有当 BTC 在下一轮开始前呈现高质量双侧 CHOP 结构时才交易。

以下情况不要交易：

- 数据缺失
- 目标不是下一轮
- 决策窗口已关闭
- BTC 是 TREND 或 LOW_ACTIVITY
- 订单簿缺失/过期/不可买
- 成对成本超过配置上限
- 轮次已经开始

开始后，除了对账成交并等待结算，不做任何其他事情。
