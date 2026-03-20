#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_PATH="${ROOT_DIR}/TabminalMobileApp.xcodeproj"
SCHEME="TabminalMobileApp"
DEVICE_NAME="${1:-iPhone 17 Pro}"
APP_BUNDLE="${ROOT_DIR}/build/Build/Products/Debug-iphonesimulator/Tabminal Mobile.app"
APP_ID="com.leask.tabminal.mobile"

cd "${ROOT_DIR}"

xcodegen generate >/dev/null

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

xcrun simctl boot "${DEVICE_ID}" >/dev/null 2>&1 || true
xcrun simctl bootstatus "${DEVICE_ID}" -b >/dev/null
open -a Simulator --args -CurrentDeviceUDID "${DEVICE_ID}" \
    >/dev/null 2>&1 || true

xcodebuild \
    -project "${PROJECT_PATH}" \
    -scheme "${SCHEME}" \
    -sdk iphonesimulator \
    -destination "id=${DEVICE_ID}" \
    -derivedDataPath "${ROOT_DIR}/build" \
    build

xcrun simctl boot "${DEVICE_ID}" >/dev/null 2>&1 || true
xcrun simctl bootstatus "${DEVICE_ID}" -b >/dev/null

xcrun simctl install "${DEVICE_ID}" "${APP_BUNDLE}"
xcrun simctl launch "${DEVICE_ID}" "${APP_ID}"
