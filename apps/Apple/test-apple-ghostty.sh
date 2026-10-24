#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GHOSTTY_REPO_PATH="${1:-${TABMINAL_GHOSTTY_REPO_PATH:-}}"
IPHONE_DEVICE="${TABMINAL_MOBILE_IPHONE_DEVICE:-iPhone 17 Pro}"
IPAD_DEVICE="${TABMINAL_MOBILE_IPAD_DEVICE:-iPad Pro 11-inch (M5)}"
VENDOR_DIR="${ROOT_DIR}/../ghostty-vendor"

if [[ -z "${GHOSTTY_REPO_PATH}" ]]; then
    cat >&2 <<'EOF'
usage: ./test-apple-ghostty.sh /path/to/ghostty-checkout

You can also provide the checkout through TABMINAL_GHOSTTY_REPO_PATH.
EOF
    exit 1
fi

if [[ ! -d "${GHOSTTY_REPO_PATH}" ]]; then
    echo "missing Ghostty checkout: ${GHOSTTY_REPO_PATH}" >&2
    exit 1
fi

export TABMINAL_GHOSTTY_REPO_PATH="${GHOSTTY_REPO_PATH}"
export TABMINAL_MOBILE_TERMINAL_RENDERER="ghostty"
"${VENDOR_DIR}/scripts/verify-slices.sh" \
    "${GHOSTTY_REPO_PATH}/macos/GhosttyKit.xcframework"

echo "[apple-ghostty] iPhone UI suite: ${IPHONE_DEVICE}"
"${ROOT_DIR}/test-local-ui.sh" "${IPHONE_DEVICE}"

echo "[apple-ghostty] iPad UI suite: ${IPAD_DEVICE}"
"${ROOT_DIR}/test-local-ui.sh" "${IPAD_DEVICE}"

echo "[apple-ghostty] visionOS consumer build (not runtime acceptance)"
"${VENDOR_DIR}/scripts/smoke-tabminal-visionos.sh" \
    "${GHOSTTY_REPO_PATH}/macos/GhosttyKit.xcframework"

echo "[apple-ghostty] macOS consumer build (not runtime acceptance)"
source "${ROOT_DIR}/ghostty-build-settings.sh"
source "${ROOT_DIR}/xcodebuild-lock.sh"
tabminal_acquire_xcodebuild_lock
cd "${ROOT_DIR}"
xcodegen generate
tabminal_ghostty_xcodebuild_args "${ROOT_DIR}" macosx
xcodebuild \
    -project TabminalMobileApp.xcodeproj \
    -scheme TabminalMobileApp \
    -destination 'platform=macOS' \
    -derivedDataPath "${ROOT_DIR}/build-macos" \
    ${XCODEBUILD_ARGS[@]+"${XCODEBUILD_ARGS[@]}"} \
    build

echo '[apple-ghostty] iPhone/iPad UI and macOS/visionOS build checks passed.'
