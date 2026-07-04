# poly-btc5m Skills

Scenario guides for running and operating the BTC 5-minute Polymarket worker.

Use these guides as focused entry points instead of reading the full project
documentation first.

## Guides

- `btc5m-monitor/` - first run and dashboard observation in monitor mode.
- `btc5m-live/` - live trading setup, safety checks, and risk knobs.
- `btc5m-docker/` - local Docker run path for users who do not want a local Node setup.
- `btc5m-deploy/` - production-style server deployment with Docker Compose and Caddy.
- `btc5m-troubleshooting/` - diagnosis by symptom when feeds, rounds, orders, or dashboard access fail.

## Safety Default

The safe default is monitor mode:

```bash
EXECUTION_MODE=monitor
```

Only switch to `EXECUTION_MODE=live` after the Binance price feed, Polymarket
round discovery, CLOB orderbooks, wallet balance, and signed-order posting are
verified.
