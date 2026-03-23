#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GHOSTTY_REPO_PATH="${1:-${TABMINAL_GHOSTTY_REPO_PATH:-}}"
IPHONE_DEVICE="${TABMINAL_MOBILE_IPHONE_DEVICE:-iPhone 17 Pro}"
IPAD_DEVICE="${TABMINAL_MOBILE_IPAD_DEVICE:-iPad Pro 11-inch (M5)}"
VISION_DEVICE="${TABMINAL_MOBILE_VISION_DEVICE:-Apple Vision Pro}"

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

echo "[apple-ghostty] iPhone UI suite: ${IPHONE_DEVICE}"
"${ROOT_DIR}/test-local-ui.sh" "${IPHONE_DEVICE}"

echo "[apple-ghostty] iPad UI suite: ${IPAD_DEVICE}"
"${ROOT_DIR}/test-local-ui.sh" "${IPAD_DEVICE}"

echo "[apple-ghostty] macOS smoke"
"${ROOT_DIR}/debug-local-macos.sh"

echo "[apple-ghostty] visionOS smoke: ${VISION_DEVICE}"
"${ROOT_DIR}/debug-local-visionos.sh" "${VISION_DEVICE}"

echo "[apple-ghostty] all checks passed"
