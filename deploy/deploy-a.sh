#!/usr/bin/env bash
set -euo pipefail

SERVER="${SERVER:-a}"
APP_DIR="${APP_DIR:-~/apps/poly-btc5m}"
COMPOSE_FILE="docker-compose.prod.yml"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"
GIT_SHA="$(git -C "${ROOT_DIR}" rev-parse --short HEAD)"
if ! git -C "${ROOT_DIR}" diff --quiet || ! git -C "${ROOT_DIR}" diff --cached --quiet; then
  GIT_SHA="${GIT_SHA}-dirty"
fi
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export APP_VERSION GIT_SHA BUILD_TIME

remote_compose() {
  local compose_args="$1"
  ssh "${SERVER}" "cd ${APP_DIR} && APP_VERSION='${APP_VERSION}' GIT_SHA='${GIT_SHA}' BUILD_TIME='${BUILD_TIME}' && export APP_VERSION GIT_SHA BUILD_TIME && if docker compose version >/dev/null 2>&1; then docker compose ${compose_args}; elif command -v docker-compose >/dev/null 2>&1; then docker-compose ${compose_args}; else echo 'Docker Compose is not installed' >&2; exit 1; fi"
}

echo "[deploy] server=${SERVER} app_dir=${APP_DIR}"
echo "[deploy] version=${APP_VERSION} git_sha=${GIT_SHA} build_time=${BUILD_TIME}"

ssh "${SERVER}" "mkdir -p ${APP_DIR}/data ${APP_DIR}/data-lab"

rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.env' \
  --exclude 'data' \
  --exclude 'data-lab' \
  "${ROOT_DIR}/" "${SERVER}:${APP_DIR}/"

ssh "${SERVER}" "cd ${APP_DIR} && if [ ! -f .env ]; then cp .env.example .env; echo '[deploy] created .env from .env.example; edit it before enabling real trading'; fi"
ssh "${SERVER}" "cd ${APP_DIR} && chmod 600 .env"
ssh "${SERVER}" "cd ${APP_DIR} && api_container=\$(if docker compose version >/dev/null 2>&1; then docker compose -f ${COMPOSE_FILE} ps -q api; elif command -v docker-compose >/dev/null 2>&1; then docker-compose -f ${COMPOSE_FILE} ps -q api; else true; fi) && if [ -n \"\$api_container\" ] && [ ! -s data/runtime-state.json ]; then docker cp \"\$api_container:/app/data/runtime-state.json\" data/runtime-state.json >/dev/null 2>&1 && echo '[deploy] preserved runtime state from existing API container' || true; fi"
remote_compose "-f ${COMPOSE_FILE} up -d --build --remove-orphans"
remote_compose "-f ${COMPOSE_FILE} ps"

echo "[deploy] done. Dashboard/API should be on https://\$SITE_DOMAIN when SITE_DOMAIN is configured, otherwise http://<server>/."
