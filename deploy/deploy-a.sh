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
DEPLOY_PAPER_RUN_ID="${DEPLOY_PAPER_RUN_ID:-paper-$(date -u +%Y%m%d-%H%M%S)-${GIT_SHA%%-*}}"
export APP_VERSION GIT_SHA BUILD_TIME

remote_compose() {
  local compose_args="$1"
  ssh "${SERVER}" "cd ${APP_DIR} && APP_VERSION='${APP_VERSION}' GIT_SHA='${GIT_SHA}' BUILD_TIME='${BUILD_TIME}' && export APP_VERSION GIT_SHA BUILD_TIME && if docker compose version >/dev/null 2>&1; then docker compose ${compose_args}; elif command -v docker-compose >/dev/null 2>&1; then docker-compose ${compose_args}; else echo 'Docker Compose is not installed' >&2; exit 1; fi"
}

echo "[deploy] server=${SERVER} app_dir=${APP_DIR}"
echo "[deploy] version=${APP_VERSION} git_sha=${GIT_SHA} build_time=${BUILD_TIME}"
echo "[deploy] paper_run_id=${DEPLOY_PAPER_RUN_ID}"

ssh "${SERVER}" "mkdir -p ${APP_DIR}/data ${APP_DIR}/data-lab ${APP_DIR}/certs && chmod 700 ${APP_DIR}/certs"

rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.env' \
  --exclude '.env.paper' \
  --exclude 'certs' \
  --exclude 'data' \
  --exclude 'data-lab' \
  --exclude 'analysis' \
  "${ROOT_DIR}/" "${SERVER}:${APP_DIR}/"

ssh "${SERVER}" "cd ${APP_DIR} && if [ ! -f .env.paper ]; then cp .env.example .env.paper; echo '[deploy] created clean Paper config at .env.paper'; fi"
if ! ssh "${SERVER}" "test -s ${APP_DIR}/certs/b.dark20.xyz.pem && test -s ${APP_DIR}/certs/b.dark20.xyz.key"; then
  if [[ ! -s "${ROOT_DIR}/certs/b.dark20.xyz.pem" || ! -s "${ROOT_DIR}/certs/b.dark20.xyz.key" ]]; then
    echo "[deploy] missing TLS certificate locally and on ${SERVER}" >&2
    exit 1
  fi
  echo "[deploy] restoring missing TLS certificate"
  rsync -az \
    "${ROOT_DIR}/certs/b.dark20.xyz.pem" \
    "${ROOT_DIR}/certs/b.dark20.xyz.key" \
    "${SERVER}:${APP_DIR}/certs/"
fi
ssh "${SERVER}" "cd ${APP_DIR} && chmod 600 .env.paper certs/b.dark20.xyz.key && chmod 644 certs/b.dark20.xyz.pem && if grep -q '^PAPER_RUN_ID=' .env.paper; then sed -i 's/^PAPER_RUN_ID=.*/PAPER_RUN_ID=${DEPLOY_PAPER_RUN_ID}/' .env.paper; else printf '\nPAPER_RUN_ID=%s\n' '${DEPLOY_PAPER_RUN_ID}' >> .env.paper; fi"
ssh "${SERVER}" "cd ${APP_DIR} && api_container=\$(if docker compose version >/dev/null 2>&1; then docker compose --env-file .env.paper -f ${COMPOSE_FILE} ps -q api; elif command -v docker-compose >/dev/null 2>&1; then docker-compose --env-file .env.paper -f ${COMPOSE_FILE} ps -q api; else true; fi) && if [ -n \"\$api_container\" ] && [ ! -s data/paper-runtime-state.json ]; then docker cp \"\$api_container:/app/data/paper-runtime-state.json\" data/paper-runtime-state.json >/dev/null 2>&1 && echo '[deploy] preserved Paper runtime state from existing API container' || true; fi"
remote_compose "--env-file .env.paper -f ${COMPOSE_FILE} up -d --build --remove-orphans"
remote_compose "--env-file .env.paper -f ${COMPOSE_FILE} ps"

ssh "${SERVER}" "cd ${APP_DIR} && for attempt in \$(seq 1 45); do api_container=\$(docker compose --env-file .env.paper -f ${COMPOSE_FILE} ps -q api); caddy_container=\$(docker compose --env-file .env.paper -f ${COMPOSE_FILE} ps -q caddy); if [ -n \"\$api_container\" ] && [ -n \"\$caddy_container\" ] && [ \"\$(docker inspect -f '{{.State.Running}}' \"\$api_container\" 2>/dev/null)\" = true ] && [ \"\$(docker inspect -f '{{.State.Running}}' \"\$caddy_container\" 2>/dev/null)\" = true ] && docker exec \"\$api_container\" node -e \"fetch('http://127.0.0.1:8788/health').then(response => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))\"; then echo '[deploy] API and Caddy are ready'; exit 0; fi; sleep 2; done; docker compose --env-file .env.paper -f ${COMPOSE_FILE} logs --tail=100 api caddy; echo '[deploy] readiness check failed' >&2; exit 1"

echo "[deploy] done. Dashboard/API should be on https://\$SITE_DOMAIN when SITE_DOMAIN is configured, otherwise http://<server>/."
