# BTC 5m Deploy

Use this guide for production-style server deployment with Docker Compose and
Caddy.

## When To Use

- You are deploying to a server rather than running locally.
- You want persistent runtime state under `data/runtime-state.json`.
- You want the API and dashboard behind Caddy.

## Standard Deploy Path

If `ssh a` reaches the target server:

```bash
./deploy/deploy-a.sh
```

The deploy script copies the repo, preserves `data/`, creates `.env` from
`.env.example` if missing, and starts `docker-compose.prod.yml`.

## Server Environment

On the server, review:

```text
~/apps/poly-btc5m/.env
~/apps/poly-btc5m/data/runtime-state.json
```

Keep monitor mode until the server runtime is verified:

```dotenv
EXECUTION_MODE=monitor
```

For live mode, set wallet credentials only on the server `.env`.

## Ports

Production defaults:

```dotenv
HTTP_PORT=8088
HTTPS_PORT=8444
PORT=8788
```

These avoid occupying 80/443 directly on hosts that run multiple services.

## Dashboard Access

Do not expose the dashboard publicly without a private network boundary or an
API key:

```dotenv
DASHBOARD_INTERNAL_API_KEY=replace-with-a-long-random-value
```

When this key is set, API requests must include:

```text
x-dashboard-internal-key: <key>
```

## Runtime State

`docker-compose.prod.yml` bind-mounts:

```text
./data:/app/data
```

The API uses:

```dotenv
RUNTIME_STATE_PATH=/app/data/runtime-state.json
```

This preserves intents, orders, fills, settlements, and captured round strikes
across rebuilds.

## Verify

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f api
```

Then check:

```text
/health
/api/status
/api/state
```
