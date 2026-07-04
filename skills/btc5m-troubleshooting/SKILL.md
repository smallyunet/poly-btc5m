# BTC 5m Troubleshooting

Use this guide when the worker is running but the dashboard, feeds, rounds, or
orders do not look right.

## Start With Status

```bash
curl http://localhost:8788/health
curl http://localhost:8788/api/status
curl http://localhost:8788/api/state
```

For Docker:

```bash
docker compose logs -f api
```

For production:

```bash
docker compose -f docker-compose.prod.yml logs -f api
```

## Binance Price Missing

Check `.env`:

```dotenv
BINANCE_BTC_WS_URL=wss://stream.binance.com:9443/ws/btcusdt@aggTrade
BINANCE_PRICE_SAMPLE_MS=1000
```

Expected behavior: if Binance is not connected or no `btcusdt` trade has been
sampled, the regime remains `UNKNOWN` and entries are blocked.

## Round Discovery Fails

Check:

```dotenv
POLYMARKET_GAMMA_API_URL=https://gamma-api.polymarket.com
MARKET_SERIES_SLUG=btc-updown-5m
```

The worker discovers deterministic `btc-updown-5m-<roundStartSec>` markets from
Gamma. If the market is missing, inactive, or closed, strategy entry is blocked.

## CLOB Books Stale Or Missing

Check:

```dotenv
POLYMARKET_CLOB_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
MAX_ORDERBOOK_AGE_SECONDS=5
```

Expected behavior: if either YES or NO book is missing or stale, entry is
blocked with orderbook diagnostics.

## No Orders In Monitor Mode

This is expected. Monitor mode records local strategy decisions but does not
post real CLOB orders:

```dotenv
EXECUTION_MODE=monitor
```

Use the dashboard strategy checks to see whether the setup is blocked by regime,
decision window, stale books, participation, queue imbalance, live score floor,
or cooldown.

## No Orders In Live Mode

Check:

- `EXECUTION_MODE=live`
- `OWNER_PRIVATE_KEY` is set.
- `POLYMARKET_DEPOSIT_WALLET` is set.
- The next round is inside the pre-start decision window.
- Regime is `CHOP`.
- `MIN_LIVE_CHOP_SCORE` is not too high for current conditions.
- No active single-fill cooldown is blocking entry.
- No duplicate local or Polymarket open order exists for the same round/token.

## Single-Sided Fill

Single-sided fills are a known risk of paired pre-round orders. The runtime can
use the configured profit-exit or three-stage hedge paths, but it never sends
uncapped market orders.

Relevant knobs:

```dotenv
SINGLE_FILL_PROFIT_EXIT_ENABLED=true
SINGLE_FILL_HEDGE_ENABLED=true
SINGLE_FILL_EARLY_HEDGE_WINDOW_SECONDS=60
SINGLE_FILL_HEDGE_WINDOW_SECONDS=30
SINGLE_FILL_EMERGENCY_HEDGE_WINDOW_SECONDS=15
```

If the missing-side price is above the configured caps, the bot can leave the
single-sided exposure open through settlement and apply an adaptive cooldown.

## Dashboard Unauthorized

If `DASHBOARD_INTERNAL_API_KEY` is set, API calls must include:

```text
x-dashboard-internal-key: <key>
```

Unset the key only for private local development.

## Runtime State Problems

Check that the configured path is writable:

```dotenv
RUNTIME_STATE_PATH=data/runtime-state.json
```

In production, it should be:

```dotenv
RUNTIME_STATE_PATH=/app/data/runtime-state.json
```

The production compose file bind-mounts `./data` into `/app/data`.
