#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/../.. && pwd)"
APPLE_DIR="${REPO_ROOT}/apps/Apple"
DEVICE_NAME="${1:-Apple Vision Pro}"
DEBUG_PORT="${TABMINAL_MOBILE_DEBUG_PORT:-19846}"
DEBUG_PASSWORD="${TABMINAL_MOBILE_DEBUG_PASSWORD:-mobile-debug}"
DEBUG_HOST="${TABMINAL_MOBILE_DEBUG_HOST:-Local Debug}"
PID_FILE="${TMPDIR:-/tmp}/tabminal-mobile-visionos-debug.pid"
LOG_FILE="${TMPDIR:-/tmp}/tabminal-mobile-visionos-debug.log"
SCREENSHOT_FILE="${TMPDIR:-/tmp}/tabminal-mobile-visionos-debug.png"

release_debug_port() {
    local existing_pid
    while IFS= read -r existing_pid; do
        [[ -z "${existing_pid}" ]] && continue
        kill "${existing_pid}" >/dev/null 2>&1 || true
    done < <(lsof -ti "tcp:${DEBUG_PORT}" 2>/dev/null | sort -u)
}

if [[ -f "${PID_FILE}" ]]; then
    EXISTING_PID="$(cat "${PID_FILE}")"
    if [[ -n "${EXISTING_PID}" ]] && kill -0 "${EXISTING_PID}" >/dev/null 2>&1; then
        kill "${EXISTING_PID}" >/dev/null 2>&1 || true
    fi
    rm -f "${PID_FILE}"
fi

release_debug_port

nohup node "${REPO_ROOT}/src/server.mjs" \
    --host 127.0.0.1 \
    --port "${DEBUG_PORT}" \
    --password "${DEBUG_PASSWORD}" \
    --accept-terms \
    < /dev/null \
    >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!
disown || true
echo "${SERVER_PID}" >"${PID_FILE}"

for _ in {1..30}; do
    if curl -fsS "http://127.0.0.1:${DEBUG_PORT}/healthz" >/dev/null; then
        break
    fi
    sleep 1
done

curl -fsS "http://127.0.0.1:${DEBUG_PORT}/healthz" >/dev/null

cd "${APPLE_DIR}"
TABMINAL_MOBILE_DEBUG_URL="http://127.0.0.1:${DEBUG_PORT}" \
TABMINAL_MOBILE_DEBUG_PASSWORD="${DEBUG_PASSWORD}" \
TABMINAL_MOBILE_DEBUG_HOST="${DEBUG_HOST}" \
TABMINAL_MOBILE_DEBUG_AUTO_LOGIN=1 \
./run-visionos.sh "${DEVICE_NAME}"

sleep 3
xcrun simctl io booted screenshot "${SCREENSHOT_FILE}" >/dev/null

echo "Server PID: ${SERVER_PID}"
echo "Server log: ${LOG_FILE}"
echo "Screenshot: ${SCREENSHOT_FILE}"
