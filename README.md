# poly-btc5m

Polymarket recurring-crypto strategy research runtime. The current `main`
branch is Paper-only: it consumes public market data, simulates orders and
fills, settles completed rounds, and retains the complete event history in
SQLite for later edge analysis.

The archived pre-Paper implementation is preserved by the
`archive/research-v1-shutdown-2026-07-16` branch and `research-v1-final` tag.

## Safety boundary

- There is no monitor or live execution mode.
- Market profiles are only `enabled` or `disabled`.
- The runtime does not load wallet addresses or private keys.
- Signing, authenticated CLOB order submission, real cancellation, balances,
  and real positions are not dependencies of the application.
- Public Binance, Gamma, Polymarket Data API, and CLOB websocket reads remain.

## Paper fill models

- Dual entry: simulated resting GTC order; full fill when a public websocket
  best ask touches the limit (`best-ask-touch-full-fill-v1`).
- Tail entry: immediate full fill at the evaluated ask-band VWAP
  (`fak-vwap-immediate-full-fill-v1`).

These are assumptions, not claims about real queue position or execution
quality. Every run records its config hash, code SHA, and fill-model version.

## Local development

Requires Node.js 22 or newer.

```bash
cp .env.example .env.paper
npm install
npm test
npm run typecheck
npm run build
npm run dev:api
```

The API/dashboard defaults to `http://localhost:8788`.

## Durable data

- SQLite ledger: `data/paper.sqlite`
- Read-model checkpoint: `data/paper-runtime-state.json`
- Run identity: `PAPER_RUN_ID`
- Paginated history: `/api/paper/events` and `/api/paper/stats`

The SQLite ledger is append-only and uncapped. `RUNTIME_MAX_RECORDS` only caps
the dashboard read model; it does not truncate research history. Back up the
database together with `-wal` and `-shm` files, or use SQLite's online backup
mechanism while the service is running.

See [docs/paper-trading.md](docs/paper-trading.md) for experiment and retention
details.

## Server deployment

```bash
./deploy/deploy-a.sh
```

The deployment uses `docker-compose.prod.yml`; despite the historical filename,
the stack contains only the Paper API, public-data research recorders, and
Caddy. The API mounts `data-lab` read-only and persists `data/` on the host.
