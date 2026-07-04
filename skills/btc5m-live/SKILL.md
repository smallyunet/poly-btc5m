# BTC 5m Live

Use this guide only when moving from observation to real Polymarket trading.

Live mode can post signed CLOB orders. Start with small size and keep the
dashboard private.

## When To Use

- Monitor mode has been stable.
- Binance, Gamma, and CLOB feeds are healthy.
- The wallet has the intended USDC balance and permissions.
- You understand the paired pre-round CHOP strategy and single-fill risk paths.

## Required Environment

Set these in `.env`:

```dotenv
EXECUTION_MODE=live
POLYMARKET_DEPOSIT_WALLET=0x...
OWNER_PRIVATE_KEY=...
```

Keep the dashboard protected if it is reachable outside localhost:

```dotenv
DASHBOARD_INTERNAL_API_KEY=replace-with-a-long-random-value
```

## Size Controls

Start with conservative size:

```dotenv
ORDER_SHARES_PER_SIDE=5
MAX_ORDER_SHARES_PER_SIDE=5
MIN_ORDER_SHARES=5
MAX_PAIR_COST=0.92
MIN_LIVE_CHOP_SCORE=80
ENTRY_CONFIRM_TICKS=3
```

Do not enable live trading with large order sizes before observing at least one
complete round cycle in monitor mode.

## Run

```bash
npm run build
npm run start:api
```

For local development with live mode:

```bash
npm run dev:api
```

## Live Checklist

- `EXECUTION_MODE=live` is intentional.
- `OWNER_PRIVATE_KEY` belongs to the intended wallet.
- `POLYMARKET_DEPOSIT_WALLET` matches the intended Polymarket funder.
- Binance BTCUSDT samples are fresh.
- Gamma round discovery resolves the next `btc-updown-5m-*` market.
- CLOB orderbooks are fresh for both sides.
- Dashboard does not show degraded runtime.
- Order size and pair-cost caps are small enough for a failed round.

## Strategy Boundary

The classic profile does not predict BTC direction. It posts paired YES/NO BUY
limit orders before the next round starts when the BTC path is classified as
balanced CHOP. After round start, normal entries stop; only explicit single-fill
profit-exit or hedge controls can act.

## Stop

Use `Ctrl-C` for foreground runs. For Docker or production runs, use the
corresponding Docker or deploy guide.
