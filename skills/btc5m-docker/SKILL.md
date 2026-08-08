# BTC 5m Docker

Use this guide to run the worker and dashboard without installing Node packages
directly on the host.

## When To Use

- You want a repeatable local runtime.
- You do not want to manage a local Node 20 environment.
- You want to test monitor or Paper mode in an isolated container.

## Setup

```bash
cp .env.example .env
```

For the first run, keep:

```dotenv
EXECUTION_MODE=monitor
```

## Run API And Dashboard

```bash
docker compose up --build api
```

Open:

```text
http://localhost:8788
```

## Optional Standalone Web Container

```bash
docker compose up --build api web
```

Standalone web container:

```text
http://localhost:4174
```

The API container also serves the built dashboard when `WEB_DIST_DIR` points to
the built web output.

## Paper Mode

Use the dedicated Compose file so credentials are forcibly cleared and Paper
state does not reuse the historical live runtime file:

```bash
docker-compose -f docker-compose.paper.yml config
docker-compose -f docker-compose.paper.yml up --build api
```

It bind-mounts `data/`, writes the uncapped ledger to `data/paper.sqlite`, and
mounts `data-lab/` read-only in the API container. Do not substitute the normal
production Compose file for this safety boundary.

## Logs

```bash
docker compose logs -f api
```

## Stop

```bash
docker compose down
```

## Runtime State

The local development compose file does not bind-mount `data/` by default. The
dedicated Paper Compose file does. For historical live operation, use the
production compose path only after deliberate live authorization.
