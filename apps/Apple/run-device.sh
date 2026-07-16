#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_PATH="${ROOT_DIR}/TabminalMobileApp.xcodeproj"
SCHEME="TabminalMobileApp"
APP_BUNDLE="${ROOT_DIR}/build/Build/Products/Debug-iphoneos/Tabminal Mobile.app"
DEVELOPMENT_TEAM="${TABMINAL_DEVELOPMENT_TEAM:-258X46W652}"
APP_ID="${TABMINAL_BUNDLE_ID:-com.miramiao.tabminal.mobile}"
source "${ROOT_DIR}/xcodebuild-lock.sh"

cd "${ROOT_DIR}"

tabminal_acquire_xcodebuild_lock

xcodegen generate >/dev/null

DEVICE_UDID="${1:-${TABMINAL_DEVICE_UDID:-}}"

if [[ -z "${DEVICE_UDID}" ]]; then
    DEVICE_JSON="$(mktemp -t tabminal-devices)"
    trap 'rm -f "${DEVICE_JSON}"' EXIT
    xcrun devicectl list devices --quiet --json-output "${DEVICE_JSON}"
    DEVICE_UDID="$(
        python3 -c '
import json
import sys

with open(sys.argv[1]) as handle:
    payload = json.load(handle)

for device in payload["result"]["devices"]:
    if device["hardwareProperties"]["platform"] != "iOS":
        continue
    if device["connectionProperties"]["tunnelState"] == "unavailable":
        continue
    print(device["hardwareProperties"]["udid"])
    break
' "${DEVICE_JSON}"
    )"
fi

if [[ -z "${DEVICE_UDID}" ]]; then
    echo "No connected iOS device found." >&2
    exit 1
fi

# ghostty-build-settings.sh needs bash 4 namerefs, so resolve the artifact here
# instead. Without a slice the app falls back to its text renderer.
GHOSTTY_XCFRAMEWORK=""
for candidate in \
    "${TABMINAL_GHOSTTY_XCFRAMEWORK_PATH:-}" \
    "${TABMINAL_GHOSTTY_REPO_PATH:+${TABMINAL_GHOSTTY_REPO_PATH}/macos/GhosttyKit.xcframework}" \
    "${ROOT_DIR}/Vendor/Ghostty/GhosttyKit.xcframework"; do
    if [[ -n "${candidate}" && -d "${candidate}" ]]; then
        GHOSTTY_XCFRAMEWORK="${candidate}"
        break
    fi
done

XCODEBUILD_ARGS=()
if [[ -n "${GHOSTTY_XCFRAMEWORK}" ]]; then
    for lib in \
        "${GHOSTTY_XCFRAMEWORK}/ios-arm64/libghostty-fat.a" \
        "${GHOSTTY_XCFRAMEWORK}/ios-arm64/libghostty.a"; do
        if [[ -f "${lib}" ]]; then
            echo "[ghostty] Linking ${lib}" >&2
            XCODEBUILD_ARGS+=(
                "OTHER_LDFLAGS=\$(inherited) -force_load ${lib} -lc++"
            )
            break
        fi
    done
fi

if [[ ${#XCODEBUILD_ARGS[@]} -eq 0 ]]; then
    echo "[ghostty] No iphoneos slice found; using text fallback." >&2
    XCODEBUILD_ARGS+=("GCC_PREPROCESSOR_DEFINITIONS=\$(inherited)")
fi

xcodebuild \
    -project "${PROJECT_PATH}" \
    -scheme "${SCHEME}" \
    -sdk iphoneos \
    -destination "id=${DEVICE_UDID}" \
    -derivedDataPath "${ROOT_DIR}/build" \
    -allowProvisioningUpdates \
    CODE_SIGNING_ALLOWED=YES \
    CODE_SIGNING_REQUIRED=YES \
    CODE_SIGN_STYLE=Automatic \
    CODE_SIGN_IDENTITY="Apple Development" \
    DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM}" \
    PRODUCT_BUNDLE_IDENTIFIER="${APP_ID}" \
    IPHONEOS_DEPLOYMENT_TARGET=18.0 \
    "${XCODEBUILD_ARGS[@]}" \
    build

xcrun devicectl device install app --device "${DEVICE_UDID}" "${APP_BUNDLE}"
xcrun devicectl device process launch --device "${DEVICE_UDID}" "${APP_ID}"
