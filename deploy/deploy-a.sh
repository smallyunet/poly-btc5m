#!/usr/bin/env bash
set -euo pipefail

SERVER="${SERVER:-a}"
APP_DIR="${APP_DIR:-~/apps/poly-btc5m}"
COMPOSE_FILE="docker-compose.prod.yml"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

remote_compose() {
  local compose_args="$1"
  ssh "${SERVER}" "cd ${APP_DIR} && if docker compose version >/dev/null 2>&1; then docker compose ${compose_args}; elif command -v docker-compose >/dev/null 2>&1; then docker-compose ${compose_args}; else echo 'Docker Compose is not installed' >&2; exit 1; fi"
}

echo "[deploy] server=${SERVER} app_dir=${APP_DIR}"

ssh "${SERVER}" "mkdir -p ${APP_DIR}"

rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  "${ROOT_DIR}/" "${SERVER}:${APP_DIR}/"

ssh "${SERVER}" "cd ${APP_DIR} && if [ ! -f .env ]; then cp .env.example .env; echo '[deploy] created .env from .env.example; edit it before enabling real trading'; fi"
ssh "${SERVER}" "cd ${APP_DIR} && chmod 600 .env"
remote_compose "-f ${COMPOSE_FILE} up -d --build --remove-orphans"
remote_compose "-f ${COMPOSE_FILE} ps"

echo "[deploy] done. Dashboard/API should be on https://\$SITE_DOMAIN when SITE_DOMAIN is configured, otherwise http://<server>/."
