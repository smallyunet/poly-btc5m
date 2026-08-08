# Paper Trading Runtime

`EXECUTION_MODE=paper` is a first-class execution mode. It consumes live public
market data, never submits a CLOB order, and writes every Paper event to an
uncapped SQLite ledger.

## Safety boundary

Paper mode clears both `OWNER_PRIVATE_KEY` and `POLYMARKET_DEPOSIT_WALLET` while
loading configuration. `docker-compose.paper.yml` also overrides both values to
empty strings. Live fill and open-order reconciliation only runs in `live`.

The Paper Compose file additionally disables the legacy live hedge, profit-exit,
loss-exit, and cross-profile risk actions. Those paths do not yet have Paper
fill models and must not be counted as simulated executions.

## Storage

The default files are:

```text
data/paper-runtime-state.json  bounded current read model
data/paper.sqlite              uncapped append-only event ledger
data/paper.sqlite-wal          active SQLite WAL when present
data/paper.sqlite-shm          active SQLite shared memory when present
```

`RUNTIME_MAX_RECORDS` applies only to the in-memory/dashboard read model. It
does not delete or cap `paper_events`.

The ledger records:

- state snapshots;
- strategy checks;
- intent creation and status changes;
- order lifecycle events;
- simulated fills;
- estimated and final settlements.

Every event includes the Paper run id plus strategy, profile, and round
dimensions when available. `paper_runs` freezes the code SHA, configuration
hash, and fill-model version. Reusing a run id with changed assumptions fails
at startup; choose a new `PAPER_RUN_ID` instead.

## Fill models in this phase

### Dual

`best-ask-touch-full-fill-v1` creates a simulated GTC order. It fills the full
size when a fresh websocket best ask is at or below the limit, using the better
of the observed ask and limit. Unfilled orders remain open until the round ends.

This is an optimistic screening model. It does not yet model queue-ahead,
traded volume, partial fills, or latency.

### Tail

`fak-vwap-immediate-full-fill-v1` uses the already validated fixed-size ask-book
VWAP and records an immediate full fill. Existing Tail depth, freshness,
slippage, band, and summary gates still run before the Paper fill.

## API

Current dashboard state remains available through `/api/state`. Full Paper
history is cursor-paginated:

```text
GET /api/paper/stats
GET /api/paper/events?entityType=order&limit=100
GET /api/paper/events?entityType=fill&strategyId=UPDOWN_DUAL_ENTRY&profileId=btc-5m
GET /api/paper/events?cursor=<nextCursor>&limit=100
```

Supported entity types are `intent`, `order`, `fill`, `settlement`, `snapshot`,
and `strategy_check`. API limits affect only response size.

## Local/container validation

```bash
docker-compose -f docker-compose.paper.yml config
docker-compose -f docker-compose.paper.yml build api
docker-compose -f docker-compose.paper.yml up -d
```

Do not start the long-running server experiment yet. Dual-only, Tail-only, and
combined virtual ledgers are the next phase; the current Tail rule still blocks
same-round allocation when a Dual order exists.

