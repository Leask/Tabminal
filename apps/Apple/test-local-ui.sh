#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_PATH="${ROOT_DIR}/TabminalMobileApp.xcodeproj"
SCHEME="TabminalMobileApp"
DEVICE_NAME="${1:-iPhone 17 Pro}"
APP_ID="com.leask.tabminal.mobile"
DEBUG_PORT="${TABMINAL_MOBILE_DEBUG_PORT:-19846}"
DEBUG_PASSWORD="${TABMINAL_MOBILE_DEBUG_PASSWORD:-mobile-debug}"
PID_FILE="${TMPDIR:-/tmp}/tabminal-mobile-ui.pid"
LOG_FILE="${TMPDIR:-/tmp}/tabminal-mobile-ui.log"
source "${ROOT_DIR}/ghostty-build-settings.sh"
source "${ROOT_DIR}/xcodebuild-lock.sh"

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

nohup node /Users/leask/Documents/Tabminal/src/server.mjs \
    --host 127.0.0.1 \
    --port "${DEBUG_PORT}" \
    --password "${DEBUG_PASSWORD}" \
    --accept-terms \
    >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!
echo "${SERVER_PID}" >"${PID_FILE}"

for _ in {1..30}; do
    if curl -fsS "http://127.0.0.1:${DEBUG_PORT}/healthz" >/dev/null; then
        break
    fi
    sleep 1
done

DEVICE_ID="$(
    xcrun simctl list devices available \
        | awk -v name="${DEVICE_NAME}" '
            index($0, name " (") > 0 {
                id = $0
                sub(/[[:space:]]+$/, "", id)
                sub(/ *\([^()]*\)$/, "", id)
                sub(/^.*\(/, "", id)
                sub(/\)$/, "", id)
                device_id = id
            }
            END {
                print device_id
            }
        '
)"

if [[ -z "${DEVICE_ID}" ]]; then
    echo "No available simulator found for ${DEVICE_NAME}." >&2
    exit 1
fi

cd "${ROOT_DIR}"
tabminal_acquire_xcodebuild_lock
xcodegen generate >/dev/null
xcrun simctl boot "${DEVICE_ID}" >/dev/null 2>&1 || true
xcrun simctl bootstatus "${DEVICE_ID}" -b >/dev/null
open -a Simulator --args -CurrentDeviceUDID "${DEVICE_ID}" \
    >/dev/null 2>&1 || true
xcrun simctl uninstall "${DEVICE_ID}" "${APP_ID}" >/dev/null 2>&1 || true

XCODEBUILD_ARGS=()
tabminal_ghostty_xcodebuild_args "${ROOT_DIR}" "iphonesimulator" XCODEBUILD_ARGS

xcodebuild \
    -project "${PROJECT_PATH}" \
    -scheme "${SCHEME}" \
    -sdk iphonesimulator \
    -destination "id=${DEVICE_ID}" \
    -derivedDataPath "${ROOT_DIR}/build" \
    "${XCODEBUILD_ARGS[@]}" \
    test
