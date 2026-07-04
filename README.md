# poly-btc5m

Deployable Polymarket BTC 5-minute strategy worker and operator dashboard.

The strategy is based on `docs/binance_btc_pre_round_strategy.md`: it does not predict BTC direction. It classifies the next 5-minute round as `CHOP`, `TREND`, or `LOW_ACTIVITY`, and only in `CHOP` does it prepare paired YES/NO limit orders using the score-based dynamic limit policy.

## Structure

```text
apps/api              Express API, worker loop, Binance/CLOB data service
apps/web              React dashboard served by the API in production
packages/shared       Shared schemas and dashboard/runtime types
packages/strategy     Pure BTC 5m regime and order-intent engine
packages/polymarket   Local Polymarket CLOB adapter
configs               Non-secret market/round configs
deploy                Docker/Caddy/Nginx deployment files
docs                  Strategy notes
skills                Scenario guides for monitor, live, Docker, deploy, and troubleshooting flows
```

## Skills / Scenario Guides

Focused scenario guides live under `skills/`:

- `skills/btc5m-monitor/` - first run and monitor-mode dashboard validation.
- `skills/btc5m-live/` - live trading setup, safety checklist, and risk knobs.
- `skills/btc5m-docker/` - local Docker run path.
- `skills/btc5m-deploy/` - server deployment with Docker Compose and Caddy.
- `skills/btc5m-troubleshooting/` - feed, round, order, and dashboard diagnosis.

Start with `skills/btc5m-monitor/SKILL.md` for dry-run validation. The current
production default is `EXECUTION_MODE=live`; use `monitor` when feeds, round
discovery, orderbooks, wallet config, or dashboard state still need validation.

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

The production default mode is `EXECUTION_MODE=live`. In monitor mode the worker records local order intents but does not post CLOB orders.

## Runtime Model

The worker runs every `BOT_TICK_MS` and produces one `DashboardState` snapshot:

- Discovers the next BTC 5m round from deterministic `btc-updown-5m-<roundStartSec>` slugs and Gamma `/markets/slug/:slug`.
- Maintains recent BTC price samples only from Binance public BTCUSDT aggTrade websocket over `wss://stream.binance.com:9443/ws/btcusdt@aggTrade`.
- Maintains YES/NO CLOB orderbooks only from the Polymarket CLOB market websocket.
- Computes BTC path features including `cross120s`, realized range bps, two-sided excursion bps, drift/momentum ratios, range percentile, and a `chopScore`.
- Classifies the round regime.
- Generates paired score-based entry intents during the pre-round decision window when the regime is `CHOP`.
- Optionally performs a capped three-stage BUY hedge when one side filled and the other side did not.
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
BINANCE_BTC_WS_URL=wss://stream.binance.com:9443/ws/btcusdt@aggTrade
BINANCE_PRICE_SAMPLE_MS=1000
POLYMARKET_CLOB_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
POLYMARKET_GAMMA_API_URL=https://gamma-api.polymarket.com
POLYMARKET_DATA_API_URL=https://data-api.polymarket.com
BOT_TICK_MS=2000
MAX_ORDERBOOK_AGE_SECONDS=5
RUNTIME_MAX_RECORDS=1000
```

BTC price has no HTTP/manual/simulated fallback. The worker subscribes to the Binance `btcusdt@aggTrade` stream and only accepts `btcusdt` updates. It samples the latest trade into the strategy path every `BINANCE_PRICE_SAMPLE_MS` milliseconds by default, so the CHOP thresholds keep a stable seconds-level meaning instead of scaling with raw trade count. If Binance is not connected or no `btcusdt` trade has arrived, the regime remains `UNKNOWN` and entry orders are blocked.
Orderbook price also has no REST fallback. The worker discovers the next 5-minute BTC Up/Down market from Gamma, maps `Up` to the local `YES` side and `Down` to the local `NO` side, then subscribes to both token IDs over the CLOB market websocket. If discovery fails, the CLOB websocket is not connected, or books are missing/stale, entry orders are blocked.

The round strike is the BTC price at the beginning of the 5-minute Polymarket range. Before the next round starts, the dashboard shows the latest Binance BTC price as an estimate. Once the round starts, the first available sampled Binance BTC price is persisted as that round's opening strike.

The current dynamic BTC path thresholds are intentionally kept unchanged after the Binance switch because the runtime feeds the strategy with sampled Binance prices, not every raw trade. `rangeBps`, two-sided excursion, drift ratio, and momentum ratio are price-path measures and remain comparable. `cross120s` also remains comparable because the 1s sampling prevents high-frequency trade noise from multiplying strike crosses.

`RUNTIME_MAX_RECORDS` bounds retained intents, orders, fills, and settlement records in memory and in `runtime-state.json`. The dashboard paginates long activity and log lists so the UI does not render the full retained history at once.

Strategy thresholds:

```dotenv
DUAL_LIMIT_PRICE=0.45
DYNAMIC_LIMIT_ENABLED=false
MIN_DYNAMIC_LIMIT_PRICE=0.42
MAX_DYNAMIC_LIMIT_PRICE=0.46
MAX_PAIR_COST=0.92
ORDER_SHARES_PER_SIDE=5
DYNAMIC_SHARES_ENABLED=false
MAX_ORDER_SHARES_PER_SIDE=6.25
MIN_ORDER_SHARES=5
MIN_CROSS_120S=2
MAX_ABS_DRIFT_120S=40
MAX_ABS_MOMENTUM_30S=28
MIN_CHOP_SCORE=70
MIN_RANGE_BPS_120S=3
MIN_BI_EXCURSION_BPS_120S=1
MAX_DRIFT_RATIO_120S=0.45
MAX_MOMENTUM_RATIO_30S=0.55
MAX_ENTRY_QUEUE_IMBALANCE=5
MIN_LIVE_CHOP_SCORE=70
BYPASS_ENTRY_SCORE_GATING=true
BYPASS_SINGLE_FILL_COOLDOWN=false
ENTRY_CONFIRM_TICKS=3
PARTICIPATION_ENABLED=true
PARTICIPATION_CACHE_MS=30000
PARTICIPATION_TOP_HOLDERS_PER_SIDE=8
MIN_PARTICIPATION_HOLDERS_PER_SIDE=3
MIN_PARTICIPATION_TOP_HOLDER_SHARES_PER_SIDE=300
MIN_PARTICIPATION_TOP_POSITION_PNL=40
MIN_PARTICIPATION_POSITION_PNL_SUM=100
MAX_PARTICIPATION_HOLDER_CONCENTRATION=0.75
SINGLE_FILL_COOLDOWN_BASE_MS=900000
SINGLE_FILL_COOLDOWN_PRICE_CAP_MS=1800000
SINGLE_FILL_COOLDOWN_EXECUTION_MS=3600000
SINGLE_FILL_COOLDOWN_REPEAT_WINDOW_MS=3600000
SINGLE_FILL_COOLDOWN_SECOND_MS=3600000
SINGLE_FILL_COOLDOWN_THIRD_MS=3600000
SINGLE_FILL_HEDGE_ENABLED=true
SINGLE_FILL_EARLY_HEDGE_WINDOW_SECONDS=60
SINGLE_FILL_EARLY_HEDGE_MAX_PAIR_COST=1.02
SINGLE_FILL_EMERGENCY_HEDGE_WINDOW_SECONDS=15
SINGLE_FILL_EMERGENCY_HEDGE_MAX_PRICE=0.75
SINGLE_FILL_EMERGENCY_HEDGE_MAX_PAIR_COST=1.20
SINGLE_FILL_HEDGE_WINDOW_SECONDS=30
SINGLE_FILL_HEDGE_MIN_SECONDS_TO_END=5
SINGLE_FILL_HEDGE_MAX_PRICE=0.65
SINGLE_FILL_HEDGE_PRICE_OFFSET=0.01
SINGLE_FILL_HEDGE_MAX_PAIR_COST=1.10
```

The worker targets the next BTC 5m round for entry. It posts paired BUY limit orders before round start as GTC orders because short GTD expirations can be rejected by CLOB. After start, it normally only reconciles fills and records settlement estimates unless an explicit single-fill risk path triggers: a profit exit can cancel the missing-side BUY and sell the filled side with a capped FAK SELL limit when the filled side is already profitable; the three-stage hedge can cancel stale missing-side BUY orders and submit a capped aggressive FAK BUY LIMIT for the missing side. It never sends uncapped market orders.

Live entry orders are configured as CLOB limit order `price + size`:

- With `DYNAMIC_LIMIT_ENABLED=true`, CHOP score maps to 42c/44c/45c/46c, capped by `MAX_PAIR_COST`.
- In live mode, `MIN_LIVE_CHOP_SCORE=80` blocks edge-score 42c setups from posting real orders.
- `BYPASS_ENTRY_SCORE_GATING=true` bypasses strategy entry blockers and the entry orderbook quote gate so each round can attempt paired entry, but it does not bypass `SINGLE_FILL_COOLDOWN`. It still leaves execution-level duplicate/open-order, balance, credential, round-start, invalid price/size, and exit/hedge rules in place.
- `BYPASS_SINGLE_FILL_COOLDOWN=true` bypasses only the active single-fill cooldown entry blocker. It does not disable the single-fill hedge/profit-exit logic.
- `ENTRY_CONFIRM_TICKS=3` requires the full entry setup to remain eligible across three consecutive bot ticks before orders are posted.
- `DUAL_LIMIT_PRICE` is the fixed fallback price when dynamic limit pricing is disabled.
- With `DYNAMIC_SHARES_ENABLED=true`, CHOP score maps to `0.5x/1.0x/1.0x/1.25x` of `ORDER_SHARES_PER_SIDE`, capped by `MAX_ORDER_SHARES_PER_SIDE`.
- The resulting shares value becomes the `size` sent to `createOrder` for each YES/NO side.
- `MAX_ENTRY_QUEUE_IMBALANCE` only blocks extreme YES/NO bid-queue imbalance at the entry limit. If full bid levels are unavailable, the check stays diagnostic and does not block.
- `PARTICIPATION_*` adds a conservative PM data-api gate using event `conditionId`, top holders, and limited per-holder positions. It blocks only when fetched data shows clearly weak participation; missing/unavailable data is visible in the dashboard and does not block.
- `SINGLE_FILL_EARLY_HEDGE_*` controls the 60s-to-30s opportunity hedge. It only runs when the combined pair cost is near breakeven.
- `SINGLE_FILL_HEDGE_*` controls the 30s-to-15s final risk hedge. It can accept the wider final pair-cost cap to avoid carrying a single-sided exposure into settlement.
- `SINGLE_FILL_EMERGENCY_HEDGE_*` controls the 15s-to-5s emergency hedge. It can accept a larger locked loss, up to the emergency missing-side price and pair-cost caps, only at the end of the round.
- `SINGLE_FILL_PROFIT_EXIT_*` controls the single-fill take-profit exit. The filled side must have a fresh live bid at or above `SINGLE_FILL_PROFIT_EXIT_MIN_PRICE`, the capped FAK SELL limit must realize at least `SINGLE_FILL_PROFIT_EXIT_MIN_PNL_USD`, and stale quotes above `SINGLE_FILL_PROFIT_EXIT_MAX_ORDERBOOK_AGE_MS` are rejected.
- Final single-fill cooldown is adaptive and only applies to rounds with tracked strategy BUY orders. External/manual fills without local strategy orders are ignored. Base final singles pause entries for 15 minutes, price-cap hedge misses pause for 30 minutes, execution/API/cancel/post failures pause for 1 hour, and repeated final singles inside 1 hour stay capped at 1 hour.

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

- Keep `EXECUTION_MODE=monitor` until Binance price feed, Gamma round discovery, CLOB token subscriptions, balances, and signed-order posting are verified.
- Do not commit `.env`, private keys, or deposit-wallet secrets.
- Do not expose the dashboard publicly without authentication or a private network boundary.
- Treat local `settlement` rows as estimates until validated against Polymarket final resolution data.
