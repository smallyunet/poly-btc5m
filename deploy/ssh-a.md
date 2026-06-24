# Server deployment on `ssh a`

The default deploy target is:

```bash
SERVER=a
APP_DIR=~/apps/poly-btc5m
```

Run:

```bash
./deploy/deploy-a.sh
```

The script syncs this repository to the server, creates `.env` from `.env.example` if missing, builds the Docker image, and starts `docker-compose.prod.yml`.

Before enabling live trading, edit the remote `.env`:

```bash
ssh a
cd ~/apps/poly-btc5m
nano .env
```

Keep `EXECUTION_MODE=monitor` until RTDS, CLOB token IDs, balances, and signed-order posting have been verified.
