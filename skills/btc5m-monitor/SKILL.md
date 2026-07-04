# BTC 5m Monitor

Use this guide for a first local run, dry observation, and dashboard validation.

Monitor mode records strategy state and local intents but does not post real
Polymarket CLOB orders.

## When To Use

- You just cloned the repo.
- You want to verify Binance BTC price samples, Gamma round discovery, and CLOB
  orderbook subscriptions.
- You want to inspect the dashboard before enabling live trading.

## Required Setup

```bash
cp .env.example .env
npm install
npm run typecheck
npm test
npm run build
```

Keep this setting in `.env`:

```dotenv
EXECUTION_MODE=monitor
```

Wallet credentials are not required for monitor mode.

## Run

```bash
npm run dev:api
```

Open the dashboard:

```text
http://localhost:8788
```

## Check Runtime

```bash
curl http://localhost:8788/health
curl http://localhost:8788/api/status
curl http://localhost:8788/api/state
```

The worker should show:

- Binance BTCUSDT feed connected and sampled.
- Current or next BTC 5m round discovered.
- CLOB YES/NO books fresh.
- Strategy checks visible in the dashboard.

## Expected Behavior

In monitor mode, generated orders are local strategy intents only. If the setup
looks eligible, the dashboard can show generated or rejected intents, but no
real CLOB order should be posted.

## Stop

Use `Ctrl-C` in the terminal running `npm run dev:api`.
