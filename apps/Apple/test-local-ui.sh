#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${ROOT_DIR}/../.." && pwd)"
PROJECT_PATH="${ROOT_DIR}/TabminalMobileApp.xcodeproj"
SCHEME="TabminalMobileApp"
DEVICE_NAME="${1:-iPhone 17 Pro}"
if [[ $# -gt 0 ]]; then shift; fi
APP_ID="com.leask.tabminal.mobile"
DEBUG_PORT="${TABMINAL_MOBILE_DEBUG_PORT:-19846}"
DEBUG_PASSWORD="${TABMINAL_MOBILE_DEBUG_PASSWORD:-mobile-debug}"
source "${ROOT_DIR}/ghostty-build-settings.sh"
source "${ROOT_DIR}/xcodebuild-lock.sh"
source "${ROOT_DIR}/debug-server.sh"

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
trap 'tabminal_stop_debug_server; tabminal_release_xcodebuild_lock' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
tabminal_start_debug_server "${REPO_ROOT}" "${DEBUG_PORT}" "${DEBUG_PASSWORD}"
for name in save conflict reload draft; do
    printf 'original %s file\n' "$name" > "${DEBUG_WORKSPACE_DIR}/native-${name}.txt"
done
printf 'long filename test\n' > \
    "${DEBUG_WORKSPACE_DIR}/native-this-is-a-long-file-name-used-to-check-selected-tab-visibility.txt"
xcodegen generate >/dev/null
xcrun simctl boot "${DEVICE_ID}" >/dev/null 2>&1 || true
xcrun simctl bootstatus "${DEVICE_ID}" -b >/dev/null
open -a Simulator --args -CurrentDeviceUDID "${DEVICE_ID}" \
    >/dev/null 2>&1 || true
xcrun simctl uninstall "${DEVICE_ID}" "${APP_ID}" >/dev/null 2>&1 || true

XCODEBUILD_ARGS=()
tabminal_ghostty_xcodebuild_args "${ROOT_DIR}" "iphonesimulator"

TEST_RUNNER_TABMINAL_MOBILE_DEBUG_URL="http://127.0.0.1:${DEBUG_PORT}" \
TEST_RUNNER_TABMINAL_MOBILE_DEBUG_PASSWORD="${DEBUG_PASSWORD}" \
TEST_RUNNER_TABMINAL_MOBILE_TEST_DIRECTORY="${DEBUG_WORKSPACE_DIR}" \
TEST_RUNNER_TABMINAL_MOBILE_TERMINAL_RENDERER="${TABMINAL_MOBILE_TERMINAL_RENDERER:-}" \
xcodebuild \
    -project "${PROJECT_PATH}" \
    -scheme "${SCHEME}" \
    -sdk iphonesimulator \
    -destination "id=${DEVICE_ID}" \
    -derivedDataPath "${ROOT_DIR}/build" \
    -parallel-testing-enabled NO \
    ${XCODEBUILD_ARGS[@]+"${XCODEBUILD_ARGS[@]}"} \
    "$@" \
    test
