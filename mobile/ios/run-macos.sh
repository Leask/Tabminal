#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_PATH="${ROOT_DIR}/TabminalMobileApp.xcodeproj"
SCHEME="TabminalMobileApp"
DERIVED_DATA_PATH="${ROOT_DIR}/build-macos"
APP_BUNDLE="${DERIVED_DATA_PATH}/Build/Products/Debug/Tabminal Mobile.app"
APP_EXECUTABLE="${APP_BUNDLE}/Contents/MacOS/Tabminal Mobile"
APP_NAME="Tabminal Mobile"
LOG_FILE="${TMPDIR:-/tmp}/tabminal-mobile-macos.log"
source "${ROOT_DIR}/ghostty-build-settings.sh"

cd "${ROOT_DIR}"

xcodegen generate >/dev/null

XCODEBUILD_ARGS=()
tabminal_ghostty_xcodebuild_args "${ROOT_DIR}" "macosx" XCODEBUILD_ARGS

xcodebuild \
    -project "${PROJECT_PATH}" \
    -scheme "${SCHEME}" \
    -destination "platform=macOS" \
    -derivedDataPath "${DERIVED_DATA_PATH}" \
    "${XCODEBUILD_ARGS[@]}" \
    build

osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 \
    || true
pkill -f "${APP_EXECUTABLE}" >/dev/null 2>&1 || true

LAUNCH_ENV=()

if [[ -n "${TABMINAL_MOBILE_DEBUG_URL:-}" ]]; then
    LAUNCH_ENV+=("TABMINAL_MOBILE_DEBUG_URL=${TABMINAL_MOBILE_DEBUG_URL}")
fi
if [[ -n "${TABMINAL_MOBILE_DEBUG_PASSWORD:-}" ]]; then
    LAUNCH_ENV+=(
        "TABMINAL_MOBILE_DEBUG_PASSWORD=${TABMINAL_MOBILE_DEBUG_PASSWORD}"
    )
fi
if [[ -n "${TABMINAL_MOBILE_DEBUG_HOST:-}" ]]; then
    LAUNCH_ENV+=("TABMINAL_MOBILE_DEBUG_HOST=${TABMINAL_MOBILE_DEBUG_HOST}")
fi
if [[ -n "${TABMINAL_MOBILE_DEBUG_AUTO_LOGIN:-}" ]]; then
    LAUNCH_ENV+=(
        "TABMINAL_MOBILE_DEBUG_AUTO_LOGIN=${TABMINAL_MOBILE_DEBUG_AUTO_LOGIN}"
    )
fi
if [[ -n "${TABMINAL_MOBILE_DEBUG_PRESENT_SIDEBAR:-}" ]]; then
    LAUNCH_ENV+=(
        "TABMINAL_MOBILE_DEBUG_PRESENT_SIDEBAR=${TABMINAL_MOBILE_DEBUG_PRESENT_SIDEBAR}"
    )
fi
if [[ -n "${TABMINAL_MOBILE_DEBUG_PRESENT_WORKSPACE:-}" ]]; then
    LAUNCH_ENV+=(
        "TABMINAL_MOBILE_DEBUG_PRESENT_WORKSPACE=${TABMINAL_MOBILE_DEBUG_PRESENT_WORKSPACE}"
    )
fi
if [[ -n "${TABMINAL_MOBILE_TERMINAL_RENDERER:-}" ]]; then
    LAUNCH_ENV+=(
        "TABMINAL_MOBILE_TERMINAL_RENDERER=${TABMINAL_MOBILE_TERMINAL_RENDERER}"
    )
fi
if [[ -n "${TABMINAL_MOBILE_ALLOW_UNSTABLE_GHOSTTY:-}" ]]; then
    LAUNCH_ENV+=(
        "TABMINAL_MOBILE_ALLOW_UNSTABLE_GHOSTTY=${TABMINAL_MOBILE_ALLOW_UNSTABLE_GHOSTTY}"
    )
fi

env "${LAUNCH_ENV[@]}" "${APP_EXECUTABLE}" >"${LOG_FILE}" 2>&1 &
APP_PID=$!

sleep 2
osascript -e "tell application \"${APP_NAME}\" to activate" >/dev/null 2>&1 \
    || true

echo "App PID: ${APP_PID}"
echo "App bundle: ${APP_BUNDLE}"
echo "App log: ${LOG_FILE}"
