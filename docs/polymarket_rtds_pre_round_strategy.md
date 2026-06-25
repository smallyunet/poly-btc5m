# Polymarket BTC 5m Strategy (RTDS + Pre-Round Regime Model)

## 0. Core Concept

This strategy does NOT trade BTC direction.

It predicts the **next 5-minute round regime** (CHOP vs TREND) using RTDS data, and pre-commits liquidity before the round begins.

---

## 1. System Inputs (RTDS)

### 1.1 BTC Price Feed (Polymarket RTDS WebSocket)
- BTC mid price
- micro-momentum
- realized range
- two-sided excursion around strike
- drift and momentum ratios
- dynamic CHOP score
- cross events vs strike

### 1.2 Orderbook Feed (CLOB WebSocket)
- YES/NO bid/ask
- live/fresh book validation
- token correctness
- buyable ask presence

---

## 2. Time Structure (Critical)

Each round:

- Observation Window: T-5min → T-30s
- Decision Window: T-30s → T
- Execution: T (round start)

⚠ All decisions must be made BEFORE T

---

## 3. Cross Definition

Cross is defined ONLY using BTC price:

cross occurs when:
sign(BTC_t - strike) ≠ sign(BTC_{t-1} - strike)

Cross is used for regime prediction, NOT execution timing.

---

## 4. Regime Model (Next Round Prediction)

### CHOP Regime (Trade)

Conditions:
- CHOP score passes threshold
- cross_120s passes threshold
- realized range is sufficient in bps
- two-sided excursion around strike is sufficient
- drift and momentum ratios are capped

Interpretation:
→ Market likely to oscillate around strike
→ Good for dual 45c strategy

---

### TREND Regime (Do NOT trade)

Conditions:
- cross_120s = 0
- strong momentum
- persistent drift away from strike

Interpretation:
→ One-sided move likely
→ 45c strategy breaks

---

### LOW ACTIVITY (Skip)

Conditions:
- low volatility
- low cross activity

---

## 5. Entry Conditions (Pre-Round)

Enable strategy ONLY IF:

- Regime = CHOP
- BTC path score passes threshold
- range and two-sided excursion are sufficient
- no strong drift or momentum by ratio
- next-round YES/NO orderbooks are live, fresh, and buyable

Otherwise: DO NOT TRADE

---

## 6. Execution Logic

At T-30s:

Place limit orders:

- YES @ 0.45
- NO @ 0.45

No further directional decision is made.
No exchange-level expiration is attached to the limit orders.
After round start, the bot does not add, exit, rebalance, or post any new trade intent.

---

## 7. Fill Scenarios

### Case A: Both fills
- Cost: 0.90
- Payout: 1.00
- Profit: +0.10 per pair

### Case B: Single fill
- Exposure becomes directional
- Outcome:
  - +2.75 if correct side
  - -2.25 if wrong side

---

## 8. Position Management

After round start:

- Do not add to either side
- Do not sell or exit single-sided exposure
- Do not rebalance
- Reconcile fills and wait for settlement

---

## 9. Risk Controls

- No trading in TREND regime
- No trading in zero-cross environments
- No trading in low volatility regimes
- Reject all trading after round start
- Limit exposure per round

---

## 10. Core Insight

This is NOT a price prediction system.

It is a:
- Regime prediction system
- Liquidity pre-commitment system
- Path-structure arbitrage model

---

## 11. Final Rule

Trade ONLY when:

BTC shows:
- High cross frequency
- High volatility
- No directional persistence

Otherwise: do nothing.
