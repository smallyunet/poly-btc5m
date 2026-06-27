# Polymarket BTC 5m 策略

## 0. 核心原则

该策略**不**交易 BTC 方向。

worker 主要面向**下一轮 BTC 5 分钟市场**。它可以在轮次开始前同时挂出 YES/NO 两侧 BUY 限价单；常规入场单会作为 GTD limit order 提交，并在轮次开始时间过期。轮次开始后，默认仍然是 settlement-only；两个明确的 single-fill 风控可以在开始后动作：`BTC5M_SINGLE_FILL_PROFIT_EXIT` 可以在已成交侧已经有利润时取消缺失侧 BUY，并用 capped FAK SELL limit 卖出已成交侧；`BTC5M_SINGLE_FILL_HEDGE` 可以在最后窗口取消缺失侧旧限价单，并在价格上限内用 aggressive FAK BUY LIMIT 补买缺失侧。它不会发送无上限 market order。

本地 `ttlSeconds` 只用于本地 intent/order 去重窗口。交易所层面的订单生命周期单独控制：常规入场使用在轮次开始时间过期的 GTD，profit-exit 和最终窗口 hedge 使用 FAK，未成交剩余会立即取消。

---

## 1. 数据输入

### 1.1 BTC 价格源

BTC 价格来自 Binance 公开 BTCUSDT aggTrade websocket：

```text
wss://stream.binance.com:9443/ws/btcusdt@aggTrade
```

该 websocket 是公开成交数据源，但策略不会把每一笔成交都当作独立路径样本。worker 会按固定频率记录最新 Binance 成交价：

```text
BINANCE_PRICE_SAMPLE_MS=1000
```

这样既使用 Binance 更高质量的价格源，又让 `cross120s`、`samples120s` 和 CHOP 分数保持秒级路径语义。默认动态阈值因此不需要因为 Binance 原始消息更多而直接放大。

策略使用 BTC 价格计算：

- 最新 BTC 价格
- 相对 strike 的穿越
- 相对最近 120s 中位价 center 的穿越
- 120s 和 300s 已实现波动区间
- bps 口径区间
- 围绕 strike 和最近 120s 中位价 center 的双侧偏离
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

普通入场执行层还会强制检查开始后的硬门槛：

```text
Date.now() < round.startAt
```

普通入场如果不满足，执行会拒绝并返回：

```text
ROUND_ALREADY_STARTED
```

普通入场 SELL intent 会被拒绝并返回：

```text
SELL_DISABLED_SETTLEMENT_ONLY
```

独立的 profit-exit executor 是唯一允许的开始后 SELL 路径。

最后窗口单侧补单使用独立时间门槛：

```text
secondsToEnd <= SINGLE_FILL_HEDGE_WINDOW_SECONDS
secondsToEnd > SINGLE_FILL_HEDGE_MIN_SECONDS_TO_END
```

当前默认值：

```text
SINGLE_FILL_HEDGE_WINDOW_SECONDS=30
SINGLE_FILL_HEDGE_MIN_SECONDS_TO_END=5
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

双侧偏离会保留两套口径。strike 口径用于理解当前市场线附近的运动：

```text
upExcursion = max(price - strike, 0)
downExcursion = max(strike - price, 0)

upExcursionBps120s = upExcursion / latestPrice * 10000
downExcursionBps120s = downExcursion / latestPrice * 10000
minBiExcursionBps120s = min(upExcursionBps120s, downExcursionBps120s)
excursionBalance120s = min(upExcursionBps120s, downExcursionBps120s) / max(upExcursionBps120s, downExcursionBps120s)
```

CHOP 分类和打分使用 center 口径，避免在下一轮开盘 strike 尚未锁定前完全依赖估计 strike：

```text
centerPrice120s = median(price over last 120s)
centerCross120s = crossings of centerPrice120s
centerUpExcursion = max(price - centerPrice120s, 0)
centerDownExcursion = max(centerPrice120s - price, 0)

centerMinBiExcursionBps120s = min(centerUpExcursionBps120s, centerDownExcursionBps120s)
centerExcursionBalance120s = min(centerUpExcursionBps120s, centerDownExcursionBps120s) / max(centerUpExcursionBps120s, centerDownExcursionBps120s)
latestRangePosition120s = (latestPrice - low120s) / range120s
```

这是最重要的 CHOP 质量特征，因为策略要识别的是围绕短期均衡中心的反复运动，而不是单纯的大幅波动。`centerExcursionBalance120s` 越接近 1，说明 center 上下两侧运动越均衡；如果一侧很深、另一侧只是轻微触碰，评分会被压低。

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

区间分位数目前保留为诊断特征，不再直接增加 `chopScore`。

---

## 4. CHOP 分数

`chopScore` 是一个 0-100 分数：

```text
chopScore =
  crossScore
+ rangeScore
+ twoSidedScore
+ balanceScore
+ driftScore
+ momentumScore
```

当前评分：

```text
crossScore       = min(centerCross120s / 4, 1) * 25
rangeScore       = min(rangeBps120s / 3, 1) * 10
twoSidedScore    = min(centerMinBiExcursionBps120s / 2, 1) * 25
balanceScore     = centerExcursionBalance120s * 15
driftScore       = max(1 - driftRatio120s / 0.7, 0) * 15
momentumScore    = max(1 - momentumRatio30s / 0.8, 0) * 10
```

`rangeScore` 现在只表达最低活跃度：达到约 3bps 后不再因为区间更大而继续加分。更高的动态限价和 shares 主要来自穿越次数、双侧幅度、双侧均衡、低漂移和低短动量。

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
centerCross120s >= MIN_CROSS_120S
rangeBps120s >= MIN_RANGE_BPS_120S
centerMinBiExcursionBps120s >= MIN_BI_EXCURSION_BPS_120S
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
entry-limit bid queue imbalance <= MAX_ENTRY_QUEUE_IMBALANCE
PM participation gate passes when data is available
live mode chopScore >= MIN_LIVE_CHOP_SCORE
entry setup stays eligible for ENTRY_CONFIRM_TICKS consecutive bot ticks
```

live 模式比基础 CHOP 分类更严格。70-79 分仍可作为 CHOP 诊断和 monitor 观察，但真实下单要求：

```text
MIN_LIVE_CHOP_SCORE=80
ENTRY_CONFIRM_TICKS=3
```

这样可以防止短暂翻成 CHOP 或边缘 42c 档位立即发真实订单。

订单簿可交易表示：

```text
book exists
book.source != mock
book age <= MAX_ORDERBOOK_AGE_SECONDS
bestAsk exists
```

入场队列不平衡使用 YES/NO 在 `limitPrice` 及以上的 bid levels 计算：

```text
yesBidQueue = sum(YES bids where price >= limitPrice)
noBidQueue = sum(NO bids where price >= limitPrice)
queueRatio = max(yesBidQueue, noBidQueue) / min(yesBidQueue, noBidQueue)
```

当前默认值：

```text
MAX_ENTRY_QUEUE_IMBALANCE=5
```

这是极端情况执行质量过滤器，不是核心预测信号。轻微不平衡不会阻塞；如果 websocket 当前只有 top quote、缺少完整 bid levels，该检查只展示 `unknown`，不会阻塞入场。

参与度 gate 使用绑定到 Gamma `conditionId` 的 Polymarket data-api 数据：

```text
holders?market=<conditionId>
positions?market=<conditionId>&user=<top-holder-wallet>
```

它会检查两边 outcome 的头部 holder 和有限的 holder-position 数据：

```text
holder count per side >= MIN_PARTICIPATION_HOLDERS_PER_SIDE
top holder shares per side >= MIN_PARTICIPATION_TOP_HOLDER_SHARES_PER_SIDE
largest holder share ratio <= MAX_PARTICIPATION_HOLDER_CONCENTRATION
max visible position PnL >= MIN_PARTICIPATION_TOP_POSITION_PNL
visible position PnL sum >= MIN_PARTICIPATION_POSITION_PNL_SUM
```

当前默认值：

```text
PARTICIPATION_ENABLED=true
PARTICIPATION_CACHE_MS=30000
PARTICIPATION_TOP_HOLDERS_PER_SIDE=8
MIN_PARTICIPATION_HOLDERS_PER_SIDE=3
MIN_PARTICIPATION_TOP_HOLDER_SHARES_PER_SIDE=300
MIN_PARTICIPATION_TOP_POSITION_PNL=40
MIN_PARTICIPATION_POSITION_PNL_SUM=100
MAX_PARTICIPATION_HOLDER_CONCENTRATION=0.75
```

这是一个偏保守的流动性/活跃度过滤器。如果 participation 数据被关闭、缺失或短暂不可用，dashboard 会展示该状态，但策略不会只因为数据缺失而阻塞入场。

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

`ttlSeconds` 是本地元数据/去重信息。实盘入场会把这些 intent 作为 GTD limit order 提交到 CLOB，过期时间设置为 `round.startAt`。

---

## 10. 执行门槛

在实盘发布普通入场 intent 前，执行层会检查：

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

对普通入场 BUY 来说，订单簿必须有 best ask。普通入场执行器仍然拒绝 SELL intent；唯一 SELL 路径是独立的 single-fill profit exit 规则。

单侧止盈退出执行层检查：

```text
SINGLE_FILL_PROFIT_EXIT_ENABLED=true
round is running and inside the profit-exit window
exactly one side has net BUY exposure
filled-side book is live/fresh under SINGLE_FILL_PROFIT_EXIT_MAX_ORDERBOOK_AGE_MS
filled-side bestBid >= SINGLE_FILL_PROFIT_EXIT_MIN_PRICE
capped FAK SELL limit realizes at least SINGLE_FILL_PROFIT_EXIT_MIN_PNL_USD
no recent local profit-exit duplicate exists
```

止盈退出不是 market order，而是 capped FAK sell limit：

```text
exitLimitPrice = max(SINGLE_FILL_PROFIT_EXIT_MIN_PRICE, bestBid - SINGLE_FILL_PROFIT_EXIT_PRICE_OFFSET)
```

单侧补单执行层额外检查：

```text
SINGLE_FILL_HEDGE_ENABLED=true
round is running and inside the hedge window
one BUY side exceeds the other side by at least MIN_ORDER_SHARES
missing-side book is live/fresh
missing-side bestAsk <= SINGLE_FILL_HEDGE_MAX_PRICE
dominant average fill price + hedge limit <= SINGLE_FILL_HEDGE_MAX_PAIR_COST
no recent local hedge duplicate exists
```

每个最终窗口内的 hedge candidate 都会记录结构化 outcome。无论是 blocked、failed 还是 posted，dashboard 都应能看到结果；重复订单保护和短失败冷却也会记录明确 outcome，避免 final single-fill 轮次在页面上没有原因。

补单价格不是 market order，而是 capped aggressive FAK limit：

```text
hedgeLimitPrice = min(bestAsk + SINGLE_FILL_HEDGE_PRICE_OFFSET, SINGLE_FILL_HEDGE_MAX_PRICE)
```

---

## 11. 轮次开始后

轮次开始后，worker 通常不会：

- 增加任一侧仓位
- 再平衡
- 发布新的交易意图

第一个例外是 single-fill 止盈退出。触发条件：

- 当前轮次已开始且位于配置的 profit-exit 窗口内
- 恰好只有一侧存在净 BUY 敞口
- 已成交侧 live best bid 不低于 `SINGLE_FILL_PROFIT_EXIT_MIN_PRICE`
- quote 新鲜度不超过 `SINGLE_FILL_PROFIT_EXIT_MAX_ORDERBOOK_AGE_MS`
- capped FAK SELL limit 至少实现 `SINGLE_FILL_PROFIT_EXIT_MIN_PNL_USD`

取消缺失侧 BUY 并再次对账后，worker 会对已成交侧发送 FAK SELL LIMIT。如果 bid 跌破配置底线，则跳过卖出，single 敞口继续交给 hedge/final review 路径处理。

第二个例外是最后窗口单侧补单风控。触发条件：

- 当前轮次已开始且进入 `SINGLE_FILL_HEDGE_WINDOW_SECONDS`
- 距离结束仍大于 `SINGLE_FILL_HEDGE_MIN_SECONDS_TO_END`
- 一侧 BUY 成交 shares 明显大于另一侧
- 缺失侧 live best ask 不超过 `SINGLE_FILL_HEDGE_MAX_PRICE`
- 已成交侧均价加补单限价不超过 `SINGLE_FILL_HEDGE_MAX_PAIR_COST`

触发后，worker 会：

- 取消缺失侧仍未成交的旧 BUY limit order
- 再次对账 fills
- 用 capped aggressive FAK BUY LIMIT 补买缺失侧差额

除此之外，它只会：

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

仓位会变成方向性敞口。旧策略会一直持有到结算；现在可选的单侧补单风控会在最后窗口尝试用价格上限买入缺失侧，把方向性敞口转成接近固定结果。

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

如果最后窗口补入缺失侧，结果变为：

```text
hedgedPnlPerShare = 1 - originalAvgPrice - hedgeLimitPrice
```

示例，已成交一侧均价为 `0.44`：

```text
hedgeLimit=0.55 => +0.01/share
hedgeLimit=0.65 => -0.09/share
hedgeLimit=0.80 => -0.24/share
no hedge and original side loses => -0.44/share
```

因此补单风控的目标是降低 single-fill 尾部损失，而不是无条件提高收益。价格超过上限时，worker 不会追单。

### 单侧成交后的 cooldown

最终结算复盘仍然是 cooldown 的触发点。只要最终 BUY fills 已经成对，说明 hedge 成功或原订单后来成交，不会触发 single-fill cooldown。

如果最终仍是 single，cooldown 根据最后窗口 hedge 结果决定：

```text
base single                    => SINGLE_FILL_COOLDOWN_BASE_MS              默认 30m
hedge blocked by price/cost cap => SINGLE_FILL_COOLDOWN_PRICE_CAP_MS         默认 60m
hedge failed by API/cancel/post => SINGLE_FILL_COOLDOWN_EXECUTION_MS         默认 2h
2h 内第 2 次 final single       => max(current, SINGLE_FILL_COOLDOWN_SECOND_MS) 默认 2h
2h 内第 3 次及以上              => max(current, SINGLE_FILL_COOLDOWN_THIRD_MS)  默认 4h
```

这个规则把 4h 从固定主观值改成递增故障保护：普通 single 不会直接跳过 48 轮，只有连续 single 或执行层失败才会升到长暂停。

---

## 13. Dashboard 展示面

dashboard 展示：

- `Market Regime`
- `BTC Dynamic Score`
- dynamic `Entry Limit`
- pair cost 和 pair edge
- 订单簿可交易状态
- 当前 blockers
- 开始后动作模式：默认 settlement-only，可显示 capped single-fill profit-exit 和 hedge 日志
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
