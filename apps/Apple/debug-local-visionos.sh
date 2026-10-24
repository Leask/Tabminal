#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/../.. && pwd)"
APPLE_DIR="${REPO_ROOT}/apps/Apple"
DEVICE_NAME="${1:-Apple Vision Pro}"
DEBUG_PORT="${TABMINAL_MOBILE_DEBUG_PORT:-19846}"
DEBUG_PASSWORD="${TABMINAL_MOBILE_DEBUG_PASSWORD:-mobile-debug}"
DEBUG_HOST="${TABMINAL_MOBILE_DEBUG_HOST:-Local Debug}"
SCREENSHOT_FILE="${TMPDIR:-/tmp}/tabminal-mobile-visionos-debug.png"
source "${APPLE_DIR}/debug-server.sh"
trap tabminal_stop_debug_server EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
tabminal_start_debug_server "${REPO_ROOT}" "${DEBUG_PORT}" "${DEBUG_PASSWORD}"

cd "${APPLE_DIR}"
TABMINAL_MOBILE_DEBUG_URL="http://127.0.0.1:${DEBUG_PORT}" \
TABMINAL_MOBILE_DEBUG_PASSWORD="${DEBUG_PASSWORD}" \
TABMINAL_MOBILE_DEBUG_HOST="${DEBUG_HOST}" \
TABMINAL_MOBILE_DEBUG_AUTO_LOGIN=1 \
./run-visionos.sh "${DEVICE_NAME}"

sleep 3
xcrun simctl io "${DEVICE_NAME}" screenshot "${SCREENSHOT_FILE}" >/dev/null

echo "Server PID: ${SERVER_PID}"
echo "Server log: ${LOG_FILE}"
echo "Screenshot: ${SCREENSHOT_FILE}"

echo "Debug server stays running until Ctrl-C. Data is retained for inspection."
wait "${SERVER_PID}"
