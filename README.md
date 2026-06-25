# poly-btc5m

Deployable Polymarket BTC 5-minute strategy worker and operator dashboard.

The strategy is based on `docs/polymarket_rtds_pre_round_strategy.md`: it does not predict BTC direction. It classifies the next 5-minute round as `CHOP`, `TREND`, or `LOW_ACTIVITY`, and only in `CHOP` does it prepare paired `YES @ 0.45` and `NO @ 0.45` limit orders.

## Structure

```text
apps/api              Express API, worker loop, RTDS/CLOB data service
apps/web              React dashboard served by the API in production
packages/shared       Shared schemas and dashboard/runtime types
packages/strategy     Pure BTC 5m regime and order-intent engine
packages/polymarket   Local Polymarket CLOB adapter
configs               Non-secret market/round configs
deploy                Docker/Caddy/Nginx deployment files
docs                  Strategy notes
```

## Local Development

```bash
cp .env.example .env
npm install
npm run typecheck
npm test
npm run build
npm run dev:api
```

Open the dashboard at http://localhost:8788.

The default mode is `EXECUTION_MODE=monitor`. In monitor mode the worker records local order intents but does not post CLOB orders.

## Runtime Model

The worker runs every `BOT_TICK_MS` and produces one `DashboardState` snapshot:

- Discovers the next BTC 5m round from deterministic `btc-updown-5m-<roundStartSec>` slugs and Gamma `/markets/slug/:slug`.
- Maintains recent BTC price samples only from Polymarket RTDS over `wss://ws-live-data.polymarket.com`.
- Maintains YES/NO CLOB orderbooks only from the Polymarket CLOB market websocket.
- Computes `cross120s`, `volatility120s`, `drift120s`, and `momentum30s`.
- Classifies the round regime.
- Generates paired 45c entry intents during the pre-round decision window when the regime is `CHOP`.
- Reconciles recent fills and estimates settlement/PnL after a round has ended.

## Configuration

Edit `.env` and `configs/btc5m.example.json`.

Required for real trading:

```dotenv
EXECUTION_MODE=live
POLYMARKET_DEPOSIT_WALLET=0x...
OWNER_PRIVATE_KEY=...
```

Recommended live feed settings:

```dotenv
POLYMARKET_RTDS_WS_URL=wss://ws-live-data.polymarket.com
POLYMARKET_CLOB_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
POLYMARKET_GAMMA_API_URL=https://gamma-api.polymarket.com
BOT_TICK_MS=2000
MAX_ORDERBOOK_AGE_SECONDS=5
RUNTIME_MAX_RECORDS=1000
```

BTC price has no HTTP/manual/simulated fallback. The worker subscribes to the RTDS `crypto_prices` stream and only accepts `btcusdt` updates. If RTDS is not connected or no `btcusdt` tick has arrived, the regime remains `UNKNOWN` and entry orders are blocked.
Orderbook price also has no REST fallback. The worker discovers the next 5-minute BTC Up/Down market from Gamma, maps `Up` to the local `YES` side and `Down` to the local `NO` side, then subscribes to both token IDs over the CLOB market websocket. If discovery fails, the CLOB websocket is not connected, or books are missing/stale, entry orders are blocked.

The round strike is the BTC price at the beginning of the 5-minute Polymarket range. Before the next round starts, the dashboard shows the latest RTDS BTC price as an estimate. Once the round starts, the first available RTDS BTC price is persisted as that round's opening strike.

`RUNTIME_MAX_RECORDS` bounds retained intents, orders, fills, and settlement records in memory and in `runtime-state.json`. The dashboard paginates long activity and log lists so the UI does not render the full retained history at once.

Strategy thresholds:

```dotenv
DUAL_LIMIT_PRICE=0.45
ORDER_SHARES_PER_SIDE=10
MIN_ORDER_SHARES=5
MIN_CROSS_120S=2
MIN_VOLATILITY_120S=12
MAX_ABS_DRIFT_120S=40
MAX_ABS_MOMENTUM_30S=28
SINGLE_FILL_GRACE_SECONDS=75
ENABLE_SINGLE_EXIT_STRATEGY=true
```

Set `ENABLE_SINGLE_EXIT_STRATEGY=false` to disable the `BTC5M_SINGLE_EXIT` sell-side risk exit. Paired 45c entry orders remain enabled.

Live entry orders are configured as CLOB limit order `price + size`:

- `DUAL_LIMIT_PRICE` becomes the `price` sent to `createOrder`.
- `ORDER_SHARES_PER_SIDE` becomes the `size` sent to `createOrder` for each YES/NO side.

## Docker

```bash
cp .env.example .env
docker compose up --build api web
```

API + dashboard: http://localhost:8788

Standalone web container: http://localhost:4174

## Server Deployment

If `ssh a` logs into the target server:

```bash
./deploy/deploy-a.sh
```

Production uses Caddy as the public reverse proxy in front of the API/dashboard container. Defaults are `HTTP_PORT=8088` and `HTTPS_PORT=8444` so this project can run on the same server as `poly-elon` without taking 80/443.

Runtime state is persisted on the server under:

```text
~/apps/poly-btc5m/data/runtime-state.json
```

`docker-compose.prod.yml` bind-mounts `./data` into the API container and overrides `RUNTIME_STATE_PATH` to `/app/data/runtime-state.json`. The deploy script creates `data/` and excludes it from `rsync --delete`, so order intents, posted orders, fills, settlements, and captured round strikes survive container rebuilds and redeploys.

The repository expects a certificate at:

```text
certs/b.dark20.xyz.pem
certs/b.dark20.xyz.key
```

The included local certificate is self-signed for `b.dark20.xyz`. With that certificate, set Cloudflare SSL/TLS mode to `Full`, not `Full strict`, and set the Origin Rule destination port to `8444`. For `Full strict`, replace these files with a Cloudflare Origin Certificate for `b.dark20.xyz`.

## Safety

- Keep `EXECUTION_MODE=monitor` until RTDS, Gamma round discovery, CLOB token subscriptions, balances, and signed-order posting are verified.
- Do not commit `.env`, private keys, or deposit-wallet secrets.
- Do not expose the dashboard publicly without authentication or a private network boundary.
- Treat local `settlement` rows as estimates until validated against Polymarket final resolution data.
