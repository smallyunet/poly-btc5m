# poly-btc5m 策略项目完整复盘

> 覆盖时间：2026-06-24 至 2026-07-16  
> 整理时间：2026-07-16  
> 项目：`poly-btc5m`  
> 状态：生产服务已于 2026-07-16 停止，数据与配置保留

## 1. 一页结论

这个项目最终证明的不是“找到了一组能稳定赚钱的 BTC 5m 参数”，而是以下几件更重要的事：

1. **双边低价挂单的理论套利空间，长期被 single-fill 尾部风险完全压过。**
   - 双边都成交时，每股只赚 `1 - YES price - NO price` 的薄利。
   - 只成交一边时，策略变成没有方向优势的裸方向仓位，亏损可接近整条腿成本。
   - 实盘和 simulation 都反复表明：paired 的小额正收益不足以覆盖 single 的大额亏损。

2. **29c、45c、49c、动态选价、自动选币和 cooldown 都没有把 Dual 变成稳定正 EV。**
   - 29c 曾经是“最不亏”的价格，但不是正 EV。
   - 45c/49c 加各种 cooldown 后仍是负 EV。
   - 少数低价、超低频组合在小样本里转正，例如 `30c + 第一次 single 后停 6h`，但只交易 `16/452` 轮，属于明显的参数搜索过拟合信号。
   - cooldown 的真实作用是减少暴露和止血，不是创造 edge。

3. **Tail 尾盘追强侧比 Dual 更接近“预测市场策略”，但早期正收益被样本量和模型偏差高估。**
   - 初期 25 个 round 的所有 checkpoint/size 都显示正 PnL，60s/45s 尤其漂亮。
   - 后续发现了 fillability、ask-band、size 维度、checkpoint 选择、submit-time stale book、FAK retry 等大量执行偏差。
   - 最终保留数据里，BTC 5m Tail 的部分 12h checkpoint 仍为正，但按实际成交重建的保留窗口 Tail PnL 约为 `-$13.42`。
   - 高胜率不等于正 EV；Tail 的少数全额亏损仍能吞掉大量小胜。

4. **50c YES + 50c NO 的实验从收益结构上没有毛 edge，实际又暴露了最严重的 single 风险。**
   - 双边各成交时，投入 `$5`、结算 `$5`，毛收益约为 0。
   - 8 小时内 57 个结算轮次：25 个双边合计仅 `+$0.085`，32 个单边合计 `-$19.55`。
   - 账户从估算约 `$20.01` 降到 `$0.5497`，约亏损 97.3%。
   - 这次实验是项目最终停服的直接原因。

5. **项目在工程和研究方法上有大量收获，但作为实盘盈利策略失败。**
   - 建立了 recorder、回测、执行重放、live/simulation gate、跨资产 profile、风险状态和完整可观测界面。
   - 同时也暴露了最核心的问题：策略变化快于严格的 out-of-sample 验证，simulation 口径多次变化，保护 gate 曾被 bypass，真实资金承担了本应由 forward simulation 承担的探索成本。

最终判断：

> **在本项目实际尝试的价格、资产、cooldown、退出和参数选择范围内，没有证据支持 Dual 或 Tail 已形成可稳定实盘的正期望策略。最可靠的正向结论是“哪些做法不能赚钱，以及以后应该用什么研究纪律避免再次付出同样成本”。**

---

## 2. 证据范围与数字口径

本复盘交叉使用了四类证据：

1. Codex 中可检索到的 `poly-btc5m` 历史任务和逐轮聊天内容；
2. 2026-06-24 至 2026-07-15 的 Git 提交历史与关键版本配置；
3. 停服后服务器保留的 recorder 数据；
4. 历史任务中记录的线上 `/api/status`、`/api/state`、orders、fills、settlements、portfolio 快照。

停服后服务器最终保留的数据规模：

| 数据 | 最终保留规模 |
|---|---:|
| 5m touch simulation 历史完成行 | 261,072 |
| 5m touch all-time completed rounds | 13,193 |
| 5m Tail all-time completed rows | 74,100 |
| 5m Tail sampled rounds | 10,631 |
| runtime orders / fills / intents / settlements | 各最多 1,000 |
| single-fill hedge outcomes | 678 |
| single cooldown events | 39 |
| Tail cooldown events | 1 |

### 2.1 必须注意的限制

- runtime 数组有 `1,000` 条保留上限，所以最终文件不是项目全部逐笔历史。
- 项目期间换过钱包；因此 runtime settlement 合计不能直接解释成某一个钱包从初始本金到最终余额的现金流水。
- 某些 round 同时包含 entry 和 profit/loss exit，按 strategy 重建的 PnL 会有重叠，不能把各 strategy 数字简单相加。
- touch simulation 是“best ask 是否触达”的静态模型；它不能完整模拟订单在盘口中的排队、撤单、partial fill、延迟和实际 persistence。
- Tail summary 的模型和字段在项目中多次演进，早期 size-matrix 结果与后期 fixed-size 结果不能直接混为同一实验。
- 聊天记录检索覆盖了项目目录下可访问、可索引的历史任务；如果存在已删除、未同步或不在当前 Codex 索引中的会话，不可能在本报告中恢复。

因此，报告里的数字分为三种：

- **simulation 结果**：说明模型内表现；
- **execution-adjusted replay/backtest**：尽量贴近执行，但仍不是实盘；
- **live 结果**：真实订单和 settlement，优先级最高。

---

## 3. 项目阶段时间线

| 时间 | 阶段 | 核心变化 | 当时的判断 |
|---|---|---|---|
| 06-24 | 项目启动 | BTC 5m worker、round discovery、market data、双边 entry | 建立可运行原型 |
| 06-25 | Dynamic CHOP | 用 BTC 价格路径判断震荡；下一场预挂双边；动态 42–46c | 希望用震荡质量提高双边成交概率 |
| 06-25 | single cooldown | 第一次加入 4h cooldown | 已意识到 single 是核心风险 |
| 06-26–06-27 | hedge/exit | 早期、final、emergency hedge；profit exit；loss exit | 尝试在 single 后降低尾部损失 |
| 06-28–07-01 | GTC/实验 profile | 50/49 next-round profile、GTC、取消与重试修复 | 尝试用更直接的订单模型隔离策略 |
| 07-04–07-06 | 多 profile/多资产 | BTC/ETH/SOL/DOGE/XRP/HYPE；5m/15m/1h；自动选币 | 试图让 simulation 选择更有 edge 的市场 |
| 07-06 | touch simulation 扩展 | 29–49c 矩阵、asset selector、single penalty、lookback | 数据开始明确显示 Dual 全价格负 EV |
| 07-07 | 正 EV 硬 gate | `PM5M_SIM_REQUIRE_POSITIVE_EV=true` | 不再允许“最优但仍为负”的行实盘 |
| 07-07 | Tail simulation/live | 独立 orderbook-aware recorder；FAK 单边尾盘买强侧 | 初期小样本结果非常乐观 |
| 07-08–07-10 | Tail 口径修正 | 12h PnL gate、移除 fillRate gate、fixed size、多资产 Tail | 逐步修正 summary 与 live 语义不一致 |
| 07-10–07-12 | 风险再收紧 | pending single risk、Tail VWAP、EV band、Wilson margin、Tail cooldown | 从追求频率转向少而精 |
| 07-12 | Dual cooldown 120m | BTC 5m 六个 cooldown override 全改 120m | execution replay 仍负，只能继续降频 |
| 07-13 | Tail 自动选可执行 pair | checkpoint + ask-band 联合选择；live band match | 修正“最佳 checkpoint 但不可执行”的问题 |
| 07-13 | Tail live 执行修复 | 15m gate、5s grace、FAK retry refresh | 解决策略正确但实际无法下单的问题 |
| 07-15 | 50/50 实验 | BTC 5m/15m/1h 每个下一场 50c/50c、5 shares、stop off | 用最直接方式验证双边成交结构 |
| 07-15 | 1h round bug 修复 | 1h 曾误挂当前场；增加真实时间一致性 fail-closed | 发现执行正确性本身也能主导 PnL |
| 07-16 | 资金接近耗尽并停服 | 8h 亏 `-$19.465`，余额 `$0.5497` | 停止整套生产服务 |

---

## 4. 尝试过的策略全景

## 4.1 Dual：下一场双边挂单

核心思想：在下一场开始前，同时挂 YES 和 NO，争取双边都以总成本小于 `$1` 成交。

理论每股收益：

```text
paired profit = 1 - yesPrice - noPrice
```

例如：

- 45c + 45c：双边成交毛利 `10c/share`；
- 49c + 49c：双边成交毛利 `2c/share`；
- 50c + 50c：双边成交毛利 `0`。

但 single 时，PnL 取决于唯一成交的一边是否最终获胜：

```text
single win  = 1 - entryPrice
single loss = -entryPrice
```

项目最后证明，真正控制收益的不是 paired edge，而是：

```text
single 发生率 × single 失败率 × 单次损失
```

### 4.1.1 初始 CHOP/震荡过滤

主信号来自 BTC/Binance 价格路径，不把 orderbook spread/depth 当作 BTC 方向预测器。使用过的主要特征：

- `cross120s`
- `rangeBps120s`
- `minBiExcursionBps120s`
- `driftRatio120s`
- `momentumRatio30s`
- `excursionBalance120s`
- `chopScore`

典型门槛：

| 参数 | 尝试值 |
|---|---:|
| `MIN_CROSS_120S` | 2 |
| `MAX_ABS_DRIFT_120S` | 40 bps |
| `MAX_ABS_MOMENTUM_30S` | 28 bps |
| `MIN_CHOP_SCORE` | 70 |
| `MIN_LIVE_CHOP_SCORE` | 70、80 |
| `MIN_RANGE_BPS_120S` | 3 |
| `MIN_BI_EXCURSION_BPS_120S` | 1 |
| `MAX_DRIFT_RATIO_120S` | 0.45 |
| `MAX_MOMENTUM_RATIO_30S` | 0.55 |
| `ENTRY_CONFIRM_TICKS` | 3 |

曾经区分：

- `70–79`：可以被分类为 CHOP，但 live 不一定允许；
- `80+`：live entry；
- 后来又降回 70，甚至使用 `BYPASS_ENTRY_SCORE_GATING=true`。

关键教训：cooldown 不能替代 entry quality；但另一方面，当 simulation 已明确为负 EV 时，CHOP 分数也没有证明能提供足够 edge。

### 4.1.2 动态价格和动态 size

早期动态价格：

| CHOP score | 每边价格 |
|---:|---:|
| 70–79 | 0.42 |
| 80–89 | 0.44 |
| 90–94 | 0.45 |
| 95+ | 0.46 |

其他配置：

- `MAX_PAIR_COST=0.92`
- 初期 `ORDER_SHARES_PER_SIDE=10`
- `DYNAMIC_SHARES_ENABLED=true`
- `MAX_ORDER_SHARES_PER_SIDE=12.5`
- 后来关闭动态 size，固定每边 5 shares。

实际问题：价格越高，双边成交率上升，但 paired edge 变薄；single 亏损变大。价格越低，edge 变厚，但双边同时成交极少，none/single 占比仍高。

### 4.1.3 settlement-only 与后续退出的反复

项目曾明确规定：

- 只操作下一场；
- 开场后不再加仓；
- 等结算；
- 普通 entry 用 GTC。

后来为了 single 风险，又加入：

- single-fill hedge；
- profit exit；
- loss exit；
- pending single-fill risk；
- 取消未来 Dual open orders。

这说明策略从“纯 settlement-only”逐渐变成了一个复杂的 single 风险管理系统。复杂度增加并未创造 entry edge，只是在试图修复结构性尾部风险。

## 4.2 Touch simulation 驱动的 Dual

recorder 对 `0.29–0.49` 每 1c 一档记录 YES/NO best ask 是否触达。

EV 公式：

```text
pairedProfitPerShare = 1 - 2p
singleLossPerShare   = p
estimatedEvPerShare  = pairedRate × (1 - 2p) - singleRate × p
```

自动选价/选币曾使用：

```text
score = estimatedEvPerShare - singlePenalty × singleRate
```

尝试过的 `singlePenalty`：

- `0`
- `0.05`
- `0.1`
- `0.2`（回测搜索）

其他参数：

| 参数 | 尝试值/演进 |
|---|---|
| price range | 0.29–0.49 |
| min rounds | 100，后期 900 |
| lookback | 12h，后期 84h |
| summary max age | 10 min |
| fallback price | 0.45、0.31 |
| require positive EV | 初期没有；后来 true；末期实验 profile 又不依赖它 |
| asset selector max | 每个 interval Top 1 |

### 4.2.1 多资产和自动选币

最终支持：

- BTC
- ETH
- SOL
- DOGE
- XRP
- HYPE

以及：

- 5m
- 15m
- 1h

共 18 个 profile。

自动选择演进：

1. 先只做 BTC 5m；
2. 扩展 6 资产 5m simulation；
3. 5m 里选 Top 1；
4. 15m、1h 分别也在 6 资产中独立选 Top 1；
5. 每个 asset + interval 必须读取自己的 summary，不允许用 5m 或其他资产数据替代；
6. 最近窗口样本充足但 EV≤0 时，禁止 fallback 到 all-time 正 EV。

自动选币解决的是“在候选里挑相对最好”，但没有解决“所有候选都绝对不好”。项目早期最危险的实现就是：**选到最高分后，即使最高分仍是负 EV，也允许 live。**

## 4.3 single-fill 风险管理

### 4.3.1 cooldown 演进

使用过的主要 cooldown 版本：

| 阶段 | base | price-cap | execution | second | third |
|---|---:|---:|---:|---:|---:|
| 最早统一 cooldown | 4h | 4h | 4h | 4h | 4h |
| 自适应版本 | 30m | 60m | 120m | 120m | 240m |
| 后续较短版本 | 15m | 30m | 60m | 60m | 60m |
| BTC 5m override | 60m | 60m | 60m | 60m | 60m |
| 07-12 最终 Dual 决策 | 120m | 120m | 120m | 120m | 120m |

还尝试过：

- profile/interval 倍数：15m = 5m 的 3 倍，1h = 12 倍；
- 第 N 次 single 后停到次日；
- 第 N 次 single 后停 6h/12h；
- redeploy 时用 `REFRESH_SINGLE_FILL_COOLDOWN_ON_BOOT=true` 重算当前 cooldown；
- `BYPASS_SINGLE_FILL_COOLDOWN` 独立于 score bypass。

结论：cooldown 显著减少亏损，但主要通过少交易实现。

### 4.3.2 hedge 三阶段

尝试过的 hedge：

| 阶段 | 时间 | 关键 cap |
|---|---|---|
| early | 60s–30s | pair cost ≤ 1.02 |
| final | 30s–15s | missing leg ≤ 0.65；pair cost ≤ 1.10 |
| emergency | 15s–5s | missing leg ≤ 0.75；pair cost ≤ 1.20 |

hedge 的锁定 PnL 公式：

```text
hedgedPnlPerShare = 1 - originalAvgPrice - hedgePrice
```

这类 hedge 能降低最坏方向风险，但经常需要主动接受确定性损失。它是风险控制，不是盈利来源。

### 4.3.3 profit exit / loss exit

典型参数：

- profit exit：最小 PnL `$0.30`，窗口 20s–240s；
- loss exit：最大损失 `$0.75`，最小 bid 0.30，窗口 20s–180s；
- quote max age 1,000ms；
- price offset 0.01。

24h live counterfactual：

| 退出类型 | actual 相对 no-sell |
|---|---:|
| 所有 SELL exits | `-$3.40` |
| loss exit | `-$4.85` |
| profit exit | `+$1.45` |

因此后来保留 profit exit、关闭 loss exit。

## 4.4 Tail：尾盘买入强势侧

核心思想：在当前 round 临近结束时，根据 YES/NO 中间价选择强势侧，按真实 ask book 计算目标 size 的 VWAP，用 FAK 买入。

Tail 从一开始就被设计成独立于 Dual 的策略，因为两者完全不同：

- Dual：开盘前、双边、GTC、赚 pair edge；
- Tail：开盘后尾盘、单边、FAK、赚 `最终胜率 - 买入价格` 的 edge。

### 4.4.1 recorder 参数

尝试过：

- checkpoint：`60/45/30/20/15/10/5s`
- size matrix：`5/10/25 shares`
- 后来改为 simulation 固定 `2 shares`，size 不再作为优化轴
- top orderbook levels：10
- quote max age：2,500ms（recorder）
- lookback：12h
- ask bands：`<55c`、`55–65c`、`65–75c`、`75–85c`、`85c+`

### 4.4.2 live 参数演进

第一版：

| 参数 | 值 |
|---|---:|
| checkpoints | 60,45 |
| live size | 5 |
| min rounds | 20 |
| min EV/share | 0.03 |
| min fill rate | 0.45 |
| max VWAP | 0.85 |
| max spread | 0.02 |
| max overround | 1.03 |
| min midpoint gap | 0.08 |
| quote max age | 1,500ms |
| max slippage | 0.02 |
| price offset | 0.001 |
| max orders/round | 1 |

中间经历过以下修正：

1. **从最高价格 cap 改成最低强势价格 floor。**
   - 用户明确认为 Tail 不应因“价格太高”被挡，而应要求强势侧至少足够强。
   - `PM5M_TAIL_ENTRY_MIN_VWAP=0.55`。
   - 但交易所仍有硬边界 `price <= 0.99`，`0.991` 必须 cap 到 `0.99`。

2. **移除 fillRate live gate。**
   - 线上有正 PnL row，但都因 fillRate < 0.45 被错误排除。
   - fillRate 后来只保留为参考指标。

3. **12h PnL gate。**
   - 有任意参数 `totalPnl > 0` 才开 live；全负则停止。
   - 一度按 totalPnl 最高的 checkpoint + size 下单。

4. **fixed-size 语义。**
   - 用户纠正：simulation 不应把 shares 数量当参数轴；live size 应只来自 env。
   - 最终 live size 主要是 `2 shares`。

5. **更保守的 EV gate。**
   - `MIN_EV_PER_SHARE=0.02`
   - `MIN_BAND_ROWS=50`，后改为 `MIN_BAND_FILLS=20`
   - win probability margin `0.01`
   - Wilson 95% lower bound

6. **固定 15s 与动态选择的反复。**
   - 回测一度认为固定 15s 比追逐近期最佳 checkpoint 更稳定。
   - 后来用户坚持参数应从 simulation 自动选择。
   - 最终使用 `PM_TAIL_ENTRY_AUTO_SELECT_CHECKPOINT=true`，并联合选择 checkpoint + ask-band 的可执行 pair。

7. **submit-time revalidation。**
   - 初次选择通过后，下单前必须重新读取 live book。
   - live ask band 必须与 simulation 选中的 band 一致。
   - retry 每次重新规划，不能复用 stale snapshot。

8. **Tail-only cooldown。**
   - 第一次亏损：15m；
   - repeat window：60m；
   - 第二次：60m；
   - 第三次：4h。

### 4.4.3 Tail live 的执行问题

真实遇到的 blocker/bug：

- Tail 错看下一场，持续 `ROUND_NOT_STARTED`；后修为独立 discover 当前场。
- checkpoint 窗口太窄，选中后到 submit 时已超时。
- FAK no-match 没有自动重试；后改为最多 3 次、间隔 750ms。
- FAK retry 复用 stale book；后改为每次刷新。
- 15m Tail 被 5m-only execution gate 硬挡。
- checkpoint 有正数据，但没有匹配的可执行 ask band。
- `0.991` 超过 CLOB 的硬 max 0.99。
- `.env` 被 deploy rsync 覆盖，导致代码正确但线上仍是旧参数。

## 4.5 next-round 50/49 与 50/50 实验

仓库已有实验 strategy id：`UPDOWN_NEXT_ROUND_50_49_STOP_ON_SINGLE`。

尝试过：

1. YES 50c + NO 49c，5 shares/side；
2. stop-on-single = true；
3. 后改 YES 50c + NO 50c；
4. stop-on-single = false；
5. BTC 5m/15m/1h 同时运行；
6. 跳过 CHOP、simulation、asset selector、confirm tick、participation 和 orderbook-ready gate；
7. 保留余额、token、重复订单、开场时间、签名和价格/数量安全 gate。

还研究过 49.8c：

- `.env` 和 intent 能表达 `0.498`；
- 但当时 BTC 5m/15m/1h 市场 tick size 都是 `0.01`；
- SDK 会把 0.498 对齐到 0.50；
- 若语义是“不高于 49.8c”，实际只能向下用 0.49；
- 因此没有把 49.8c 直接部署。

50c GTC 不是 post-only。若 best ask 是 30c，50c BUY limit 会立即以 30c 成交。一次 BTC 1h NO 就是以限价 50c、实际 30c 成交。

---

## 5. Simulation 与回测结果

## 5.1 Dual：29c 是否更好

2026-07-06 快照：

- completed rounds：1,164
- completed rows：24,444
- 29c 全资产 EV/share：`-0.047595`
- 29c BTC-only EV/share：`-0.004897`

结论：29c 是当时测试价格中最接近 breakeven 的档位，但仍是负 EV。正确表述是“亏得更少”，不是“更容易赚钱”。

## 5.2 Dual：早期全窗口稳定为负

2026-07-07 线上分析：

- all-time：436 轮，0.29–0.49 全部负 EV；
- 最近 12h：142 轮，全部负 EV；
- 更早的 294 轮：全部负 EV；
- 最近 27 轮：全部负 EV；
- 最近 10 轮：少数低价档局部为正，但 45c 为 `-0.105/share`，49c 为 `-0.141/share`；
- 最近 20 轮：仅两个低价档为正，45c 为 `-0.1175/share`，49c 为 `-0.1125/share`。

49c 的不同窗口：

| 窗口 | EV/share |
|---|---:|
| 早期 294 轮 | -0.084898 |
| 最近 12h | -0.080070 |
| all-time 436 轮 | -0.083326 |
| 最近 27 轮 | -0.136296 |

它不是“早期有效、后来坏掉”，而是从较长样本看一直为负。

## 5.3 cooldown 参数扫描

### 实盘 BTC 5m，134 轮

baseline：`PnL -23.851061`

| 参数 | 参与 | 跳过 | PnL | 相对少亏 |
|---|---:|---:|---:|---:|
| 第 1 次 single 后停 12h | 30 | 104 | -3.049359 | +20.801702 |
| 第 1 次 single 后停到次日 | 17 | 117 | -3.900000 | +19.951061 |
| 第 2 次 single 后停到次日 | 28 | 106 | -6.649999 | +17.201062 |
| 第 4 次 single 后停 12h | 54 | 80 | -9.151342 | +14.699719 |
| 第 3 次 single 后停到次日 | 37 | 97 | -10.400836 | +13.450225 |

所有组合仍为负。

### 45c simulation，452 轮

baseline：`PnL/share -32.45`，平均 `-0.071792/share`

| 参数 | 参与 | 跳过 | PnL/share | 平均 EV |
|---|---:|---:|---:|---:|
| 第 1 次 single 后停到次日 | 9 | 443 | -0.95 | -0.105556 |
| 第 1 次 single 后停 6h | 25 | 427 | -1.65 | -0.066000 |
| 第 2 次 single 后停 6h | 46 | 406 | -2.10 | -0.045652 |
| 第 4 次 single 后停 12h | 45 | 407 | -2.10 | -0.046667 |

### 49c simulation，452 轮

baseline：`PnL/share -38.56`，平均 `-0.085310/share`

| 参数 | 参与 | 跳过 | PnL/share | 平均 EV |
|---|---:|---:|---:|---:|
| 第 1 次 single 后停到次日 | 9 | 443 | -1.39 | -0.154444 |
| 第 1 次 single 后停 12h | 4 | 448 | -1.96 | -0.490000 |
| 第 1 次 single 后停 6h | 46 | 406 | -2.16 | -0.046957 |
| 第 2 次 single 后停 12h | 26 | 426 | -2.54 | -0.097692 |

小样本异常：`30c + 第一次 single 后停 6h` 得到 `+0.70 PnL/share`，但只参与 16/452 轮。这个结果不应被当成可部署参数。

## 5.4 rolling / execution-adjusted replay

生产数据曾有 49,518 条 touch result，all-time 2,358 rounds。293 个 warmup 后 eligible BTC 轮次上：

| 组合 | trades | PnL / EV opportunity |
|---|---:|---:|
| 当前：`EV - 0.1×singleRate` + 45m/60m/240m | 35 | PnL -2.92；EV opp -0.009966 |
| 旧版：30m/120m/120m | 37 | PnL -4.11；EV opp -0.014027 |
| minTrades≥50 的较好组合：pure EV + 45m/60m/60m | 60 | EV opp -0.002423 |

即使更贴近真实执行，结果仍然只是更接近 0，没有稳定转正。因此最终选择是延长 cooldown，而不是宣称找到盈利参数。

## 5.5 停服时最终 touch 快照

最终 5m summary：

- lookback：84h
- 6 资产合计 rounds：6,033
- BTC rounds：1,006
- price：0.29–0.49

代表价格：

| Price | 全资产 EV/share | BTC EV/share | BTC paired rate | BTC single rate |
|---:|---:|---:|---:|---:|
| 0.29 | -0.139489 | -0.141501 | 3.58% | 53.98% |
| 0.30 | -0.145914 | -0.148708 | 3.68% | 54.47% |
| 0.36 | -0.190671 | -0.195268 | 7.46% | 60.04% |
| 0.40 | -0.224200 | -0.221869 | 11.93% | 61.43% |
| 0.45 | -0.264752 | -0.269185 | 19.78% | 64.21% |
| 0.49 | -0.267434 | -0.258479 | 34.89% | 54.17% |

最终快照再次确认：所有测试价格为负。并且随着数据增多，早期“29c 接近 breakeven”的结论没有保持。

## 5.6 Tail 初期小样本结果

2026-07-07 第一批完整数据：25 rounds，525 rows。

| T-End | Fill rows | PnL | Avg EV/share |
|---:|---:|---:|---:|
| 60s | 39/75 | +70.36 | +0.1353 |
| 45s | 44/75 | +68.15 | +0.1165 |
| 30s | 38/75 | +44.47 | +0.0888 |
| 20s | 37/75 | +23.10 | +0.0475 |
| 15s | 43/75 | +20.70 | +0.0367 |
| 10s | 28/75 | +17.40 | +0.0477 |
| 5s | 26/75 | +14.45 | +0.0427 |

当时看起来“越早进越好”，60s/45s 最佳。但问题包括：

- 只有 25 个 round；
- 多个 size 重复放大同一 round 的结果；
- `wins` 和 `fillable` 口径曾导致 win rate 看起来超过 100%；
- quote missing 很多；
- 真实 FAK、延迟和 ask-band 匹配尚未纳入。

这是项目中最典型的“小样本漂亮曲线”案例。

## 5.7 Tail 最终数据

停服时 BTC 5m，最近 12h、固定 size 2：

| T-End | rows | fill rate | win rate | avg VWAP | avg PnL/share | total PnL |
|---:|---:|---:|---:|---:|---:|---:|
| 60s | 139 | 79.14% | 82.73% | 0.7884 | +0.01738 | +3.8240 |
| 45s | 139 | 80.58% | 86.61% | 0.8111 | +0.04052 | +9.0763 |
| 30s | 139 | 74.82% | 85.58% | 0.8175 | +0.00684 | +1.4220 |
| 20s | 139 | 74.10% | 86.41% | 0.8356 | -0.00398 | -0.8193 |
| 15s | 139 | 73.38% | 86.27% | 0.8262 | +0.00420 | +0.8560 |
| 10s | 137 | 69.34% | 89.47% | 0.8250 | +0.02636 | +5.0080 |
| 5s | 126 | 73.81% | 88.17% | 0.8452 | +0.01989 | +3.6993 |

BTC 15m 最近窗口：

- 60/45/30/20s 均为负；
- 15s：`+0.02167/share`，total `+4.15988`；
- 10s：`+0.02423/share`，total `+3.5368`；
- 5s：`+0.01005/share`，total `+1.5880`。

这些结果说明 Tail 仍有值得研究的局部参数，但不能推导为已经可实盘：同一时期的实际 Tail 成交重建仍为负，说明 simulation 与 execution 之间仍存在显著 gap。

---

## 6. 实盘结果

## 6.1 早期收益曲线

2026-07-07 用户截图：

- Portfolio：`$16.25`
- All-time P/L：`-$68.64`
- 过去一天：`-$6.00 (-26.96%)`

同时线上状态显示：

- BTC 5m settled：127 轮
- settled PnL：约 `-$22.00`
- single：29/127 = 22.83%
- 当时这些 single 胜率为 0/29
- 当前选中 49c simulation EV：`-0.076479/share`

真正的问题是 simulation 已经显示负 EV，但执行层仍然 eligible。之后才加入 positive EV 硬 gate。

## 6.2 24h exit 分析

一次 24h 快照：

- settled rounds：220
- total PnL：`-48.687369`
- paired-hold：正收益
- single-hold：强负收益
- SELL exits：混合

counterfactual：

- 所有 SELL actual PnL `15.000002`
- no-sell PnL `18.400002`
- 总体 SELL 相对 no-sell：`-3.40`
- loss exit：`-4.85`
- profit exit：`+1.45`

结论：loss exit 是负优化，profit exit 有小幅正贡献。

## 6.3 最终保留的 1,000 个 settlement

范围：2026-06-27 至 2026-07-16。

| 维度 | rounds | PnL |
|---|---:|---:|
| 全部保留 settlement | 1,000 | -79.658032 |
| 可识别 5m | 813 | -78.775651 |
| 可识别 15m | 139 | +8.862617 |
| legacy / human-readable slug | 48 | -9.744998 |

这是应用账本保留窗口，不是单钱包现金流水；但它非常明确地说明主要亏损集中在 5m。

按日最差阶段：

| UTC 日期 | rounds | PnL |
|---|---:|---:|
| 07-06 | 226 | -42.995602 |
| 07-11 | 74 | -18.189296 |
| 07-05 | 149 | -11.511264 |
| 07-02 | 9 | -12.099232 |

## 6.4 按 fill strategy 重建的保留窗口结果

| Strategy | 已结算 round | 重建 PnL | 胜/负/平 |
|---|---:|---:|---:|
| Dual entry | 263 | -38.527622 | 171 / 92 / 0 |
| next-round 50/49/50 experiment | 103 | -5.015000 | 32 / 27 / 44 |
| Tail entry | 273 | -13.423570 | 239 / 34 / 0 |
| profit exit fills | 36 | -2.000000 | 15 / 21 / 0 |
| loss exit fills | 5 | -4.850000 | 2 / 3 / 0 |

注意：

- 这是从保留的 fills + settlement 重建；更早 fills 可能已被 1,000 条上限裁掉。
- exit strategy 与原 entry strategy 在同一 round 内重叠，不能把表格各行相加。
- Tail 的胜率很高，但少数 loss 足以让总 PnL 为负，这正是“胜率不等于 EV”的直接证据。

## 6.5 50/50 实验最终 8 小时

截至北京时间 2026-07-16 09:51：

- 可用 USDC：`$0.5497`
- 过去 8h settled PnL：`-$19.465`
- 估算 8h 前资金：`$20.01`（假设无充值/提现）
- 亏损比例：约 97.3%
- runtime 已被 `INSUFFICIENT_AVAILABLE_COLLATERAL` 阻断

分解：

| 结果 | rounds | PnL |
|---|---:|---:|
| 双边成交 | 25 | +0.085 |
| 单边成交 | 32 | -19.550 |
| 单边胜/负 | 12 / 20 | — |

按 interval：

| Interval | PnL |
|---|---:|
| BTC 5m | -15.015 |
| BTC 15m | -2.050 |
| BTC 1h | -2.400 |

这组数据几乎是 Dual 结构的完美缩影：双边组合本身接近 0，但 single 的不对称损失迅速清空本金。

---

## 7. 失败的参数、组合与具体原因

## 7.1 价格参数失败

- **45c/49c**：paired edge 存在，但 single rate 和 single loss 使长期 EV 为负。
- **29c**：短期最接近 breakeven，但最终大样本 BTC EV/share 仍约 `-0.1415`。
- **30c + 极端 cooldown**：小样本转正但交易量过低，过拟合风险高。
- **49.8c**：市场 tick size 0.01，无法精确表达；SDK 会对齐到 50c。
- **50c/50c**：理论毛 edge 为 0，任何 single、延迟或执行误差都会使结果为负。

## 7.2 CHOP/波动率参数失败

- CHOP 分数能描述“是否双边震荡”，但没有证明能预测下一场两个 45–49c 订单都能成交。
- `MIN_LIVE_CHOP_SCORE=80` 降低交易量，但 cooldown/score 仍未创造正 EV。
- 后来 bypass score 扩大了样本，也同时放大了负 edge。
- orderbook 被正确定位为执行 gate，而非 BTC regime predictor；但这也意味着仅靠 BTC path feature 无法解决新 round 的盘口排队与成交问题。

## 7.3 cooldown 失败

- 1 次 single 后停 12h 是最强止血，但几乎停止交易。
- “一天 3 次 single 后停”减少亏损，但保留样本的平均 EV 甚至可能更差。
- 120m cooldown 只能减少亏损频率，不能改变单笔的负收益结构。
- Tail cooldown 同样是 circuit breaker，不是选出正 EV regime 的模型。

## 7.4 自动选价/选币失败

- “相对最好”不等于“绝对可交易”。
- 早期 selector 会选择最高分负 EV 行。
- 12h 样本充足但负 EV 时 fallback 到 all-time 正 EV，会让 live 继续；后来已修复。
- Top-1 资产竞争会产生频繁选择变化，但没有证明跨资产排名能稳定 out-of-sample。
- 18 profile 增加了复杂度，还曾导致 confirmation counter 跨 profile 泄漏，所有 profile 卡在 `ENTRY_SIGNAL_CONFIRMING`。

## 7.5 Tail 参数失败

- **初期 60s/45s、5/10/25 shares**：结果漂亮但只有 25 round。
- **fillRate ≥ 0.45**：把正 PnL 行全部挡掉，说明 blocker 命名和真实语义不一致。
- **按 totalPnl 选 size**：大 size 天然放大 total PnL，导致把 size 错当成 edge；后改 fixed-size。
- **最高 VWAP cap**：与“买强势侧”的用户定义冲突；后改最低强势 floor。
- **固定 15s**：更稳定但违背“实时从 simulation 选最佳参数”的策略目标。
- **只选 checkpoint**：可能选到没有可执行 ask band 的参数；后改 checkpoint + band pair。
- **win probability margin**：更保守，但如果模型本身存在 selection bias，统计下界仍不能修复执行 gap。
- **高 win rate**：最终实际 Tail 273 个 round 中 239 胜、34 负，仍合计亏损。

## 7.6 退出和 hedge 失败

- loss exit 实测相对 hold `-$4.85`，属于负优化。
- profit exit 有阶段性正贡献，但保留窗口重建并不稳定为正。
- emergency hedge 将尾部风险换成确定性 locked loss，适合风控，不适合解释为盈利策略。
- 风险逻辑越来越复杂，说明 entry edge 不足以独立成立。

## 7.7 50/50 实验失败

- `STOP_ON_SINGLE=false` 允许 single 风险连续累积。
- GTC 不是 post-only，可能立即吃低价 ask，而不是在 50c maker 排队。
- 一侧订单从 open orders 消失曾被本地统一显示为 cancelled，但 CLOB 实际可能是 INVALID。
- 1h discovery 曾把当前场 token 配上下一场 `startAt`，导致误挂已开场市场。
- 修复 1h bug 后，策略自身的 single 结构风险仍然存在，并在 8h 内耗尽本金。

---

## 8. 工程与研究方法复盘

## 8.1 做得好的地方

1. **快速建立真实闭环。**
   - market discovery、Binance feed、CLOB orderbook、订单、成交、settlement、dashboard 全部连通。

2. **逐步形成可观测性。**
   - strategy checks、blockers、runtime state、build SHA、order strategy、simulation summary 都能追溯。

3. **simulation 与 live 被逐渐分离。**
   - Dual touch recorder 与 Tail orderbook-aware recorder 独立运行。
   - Tail 最终有 submit-time revalidation、FAK retry 和可执行 band matching。

4. **关键风险最终都被显式建模。**
   - cooldown、pending single risk、duplicate gate、collateral gate、max order、round time validation。

5. **最终愿意依据数据停服。**
   - 在余额接近耗尽后停止整套 compose，而不是继续用更多参数解释亏损。

## 8.2 做得不好的地方

1. **实盘探索开始得太早。**
   - 初始 Tail 只有 25 个 round 就启用 live。
   - Dual 在 simulation 全负时仍通过 bypass 继续执行。

2. **模型口径不断变化，结果容易被误读。**
   - 12h vs all-time；
   - touch vs execution replay；
   - size matrix vs fixed size；
   - checkpoint PnL vs ask-band EV；
   - wins vs fillable。

3. **参数搜索缺少严格 out-of-sample。**
   - 多价格、多 cooldown、多资产、多窗口共同搜索，很容易得到低频小样本的偶然正值。
   - “best parameter”多次来自同一份用于发现和评估的数据。

4. **策略 edge 和风控优化混在一起。**
   - cooldown、hedge、profit/loss exit 能改变损失路径，但不代表 entry 策略变成正 EV。

5. **配置和部署状态曾多次漂移。**
   - `.env` 不传给 recorder；
   - deploy 覆盖 remote `.env`；
   - persisted cooldown 不随新 env 自动刷新；
   - status 与实际签名价格可能因 tick-size normalization 不一致。

6. **钱包和 runtime 历史没有形成严格实验 ledger。**
   - 换钱包后，应用历史、账户余额和策略阶段难以一一对账。
   - 1,000 条 cap 让长期策略归因不完整。

## 8.3 根本原因

项目的根本问题可以概括为：

```text
策略假设更新速度 > 数据积累速度 > 严格验证速度
```

每次看到一个局部问题，就加入一个新 gate、cooldown、selector 或执行修复。工程越来越完善，但研究对象本身不断变化，导致很少有一个固定策略能经历足够长、严格隔离的 forward test。

---

## 9. 最终结论

### 9.1 关于 Dual

- 测试范围内没有可部署的稳定正 EV 参数。
- 价格降低、CHOP、自动选币、positive EV gate、cooldown 都不能消除 single-fill 结构风险。
- 50/50 实验进一步证明：当 paired edge 为 0 时，single 会迅速主导结果。
- 不建议在没有 post-only、明确 queue/fill 模型和独立 forward 证据前重新实盘。

### 9.2 关于 Tail

- Tail 是更值得继续研究的方向，因为它尝试估计“真实胜率是否高于实际 VWAP”。
- 但当前项目结果不足以证明可赚钱：simulation 局部为正，实际保留窗口为负。
- 若继续研究，应完全重新设立实验：固定模型、fixed size、按 executable band、纯 shadow、严格 walk-forward。

### 9.3 关于 cooldown 和风控

- cooldown 有价值，但只应被描述为 circuit breaker。
- profit exit 可能有用，loss exit 当前证据为负。
- hedge 应用于限制单次灾难损失，不应被当作提高 EV 的工具。

### 9.4 关于项目成败

作为“赚钱策略项目”，它失败了。  
作为“低本金快速验证预测市场微结构假设的研究项目”，它产生了非常丰富且可复用的结论。

最重要的成果不是某个参数，而是这三个否定性结论：

1. **best available negative EV 仍然是 negative EV；相对排名不能替代绝对门槛。**
2. **高胜率、低波动和 cooldown 都不能自动推出正期望。**
3. **执行系统越复杂，越应该先质疑 entry edge，而不是继续给负 edge 加保护层。**

---

## 10. 如果未来重新开始，建议的研究协议

1. **先冻结策略定义。**
   - 至少 7–14 天内不改参数和模型。

2. **只保留一个策略族。**
   - 建议 Tail；不要同时跑 Dual、Tail、50/50 和多个 exit 版本。

3. **固定 size。**
   - simulation 与 live shadow 都用同一固定 size，例如 2 shares。

4. **严格按可执行盘口模拟。**
   - 记录完整 ask ladder、tick size、实际可成交 VWAP、latency buffer、FAK outcome。

5. **分离 discovery/train/test。**
   - 例如 7 天选参数，后 7 天冻结参数验证；不能在 test 上重新选 best。

6. **预注册成功标准。**
   - 最少 N 个独立 round；
   - net EV 置信区间下界 > 0；
   - 最大 drawdown；
   - fill rate；
   - latency-adjusted PnL；
   - 不能只看 win rate。

7. **纯 shadow 足够长。**
   - 直到 simulation 和真实可执行报价的偏差被量化。

8. **小额 live 也必须有硬预算。**
   - 单策略独立钱包；
   - 最大累计亏损；
   - 最大单日亏损；
   - 触发后自动 stop，不允许在同一实验里临时放宽。

9. **禁止 bypass 绝对 EV gate。**
   - bypass 只能用于 monitor/shadow；不能用于真实资金。

10. **建立 append-only experiment ledger。**
    - 每个版本记录 commit、env hash、钱包、开始/结束时间、策略定义、结果和停止原因。
    - 不再依赖 1,000 条 runtime-state 滚动窗口做长期研究。

---

## 11. 关键版本索引

| Commit | 含义 |
|---|---|
| `8fe87e9` | Dynamic CHOP / next-round / settlement-only |
| `2c7a113` | 4h single-fill cooldown |
| `d0240b1` | balanced oscillation CHOP |
| `85b9a5f` | emergency single-fill hedge |
| `d5229ce` | independent 5m touch simulator |
| `614fb33` | live asset selector |
| `5b334c0` | Tail recorder |
| `4d75dd3` | positive simulator EV hard gate |
| `71a3f3e` | BTC 5m Tail live |
| `cdf4609` | pending single-fill risk + Tail VWAP ceiling |
| `960c4ef` | conservative Tail EV/cooldown policy |
| `df44929` | BTC 5m cooldown 120m |
| `d8ea9a6` | executable Tail pair selection |
| `93d9486` | preserve production `.env` |
| `3df2464` | Tail live execution fixes |
| `89d6c22` | continuous next-round 50/50 experiment |
| `fab613a` | 1h next-round discovery fix |

## 12. 关键历史任务索引

以下 thread id 对应本复盘使用的主要聊天证据：

- `019efd03-b11c-7a52-8619-2effb0a990bc`：Dynamic CHOP 与 settlement-only
- `019efede-f421-7ab3-9ce3-e8765a1ff3ab`：4h cooldown 与 single postmortem
- `019f090f-3584-7643-ab73-da1f4358f301`：三阶段 hedge
- `019f3691-db9f-7a50-9bf7-3c8646eb3952`：29c simulation EV
- `019f3aea-108c-79e0-91d2-d812e6daedc3`：收益曲线、负 EV、cooldown 回测、Tail 起点
- `019f3b96-99b3-7231-a00d-3a47cf185833`：Tail simulation/live 完整演进
- `019f3d2c-c6fc-79d3-b55e-1353d37faa62`：Dual/Tail 12h live gate 对齐
- `019f4afc-5afe-7e40-813d-962fa55ae211`：6 资产、3 interval、Top-1 与独立 summary
- `019f4c13-29e5-75d0-857b-098584dab044`：live 风险审计与修复
- `019f5173-2f9b-71d2-a229-d3f0e14af0da`：Tail EV、alternation、cooldown 优化
- `019f5587-d52d-7981-8b13-30e220ffc1cf`：execution-adjusted replay 与 120m cooldown
- `019f59be-5364-7120-a129-fe69cc2bca70`：Tail executable pair selection
- `019f5afc-7c32-7312-9a9e-089a0dcb2903`：Tail live execution fix
- `019f65fe-4915-7801-9fa7-d717e9fe6b76`：50/50 实验
- `019f6653-765f-7923-9be2-2098bf664aa4`：1h 当前场 bug 修复
- `019f689d-9cf1-78a1-8e30-82f50d46e25e`：最终 8h 亏损与停服

---

## 13. 最后一句复盘

这次最惨痛的部分，不是最后 `$20` 左右的实验资金几乎归零，而是项目多次已经从 simulation 看到了负 EV，却仍然因为“也许换一个价格、资产、窗口、cooldown、exit 或 selector 就会好”而继续让 live 承担研究成本。

最有价值的结论也恰恰来自这里：

> **下一次不应该先问“还有哪个参数没试”，而应该先问“这个 edge 是否已经在完全冻结、可执行、out-of-sample 的数据里被证明存在”。**
