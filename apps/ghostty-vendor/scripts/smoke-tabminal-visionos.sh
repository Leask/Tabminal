#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "${script_dir}/../../.." && pwd)
xcframework=${1:-}

if [[ -z ${xcframework} ]]; then
    echo 'usage: smoke-tabminal-visionos.sh /path/to/GhosttyKit.xcframework' >&2
    exit 1
fi

if [[ ! -d ${xcframework} ]]; then
    echo "xcframework not found: ${xcframework}" >&2
    exit 1
fi

xcframework=$(cd -- "${xcframework}" && pwd)
apple_root="${repo_root}/apps/Apple"
"${script_dir}/verify-slices.sh" "${xcframework}"

source "${apple_root}/xcodebuild-lock.sh"
source "${apple_root}/ghostty-build-settings.sh"

export TABMINAL_GHOSTTY_XCFRAMEWORK_PATH="${xcframework}"
export TABMINAL_MOBILE_TERMINAL_RENDERER=ghostty
XCODEBUILD_ARGS=()
tabminal_ghostty_xcodebuild_args "${apple_root}" xros

tmp_root=''
lock_acquired=false
cleanup() {
    local status=$?
    trap - EXIT
    if [[ ${lock_acquired} == true ]]; then
        tabminal_release_xcodebuild_lock || true
    fi
    if [[ -n ${tmp_root} ]]; then
        rm -rf -- "${tmp_root}" || true
    fi
    exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

tabminal_acquire_xcodebuild_lock
lock_acquired=true
# The lock helper installs its own EXIT trap; retain both cleanup duties.
trap cleanup EXIT
tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/tabminal-visionos-smoke.XXXXXX")

cd "${apple_root}"
xcodegen generate

CLANG_MODULE_CACHE_PATH="${tmp_root}/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="${tmp_root}/module-cache" \
xcodebuild \
    -project TabminalMobileApp.xcodeproj \
    -scheme TabminalMobileApp \
    -sdk xros \
    -destination 'generic/platform=visionOS' \
    -derivedDataPath "${tmp_root}/DerivedData" \
    ${XCODEBUILD_ARGS[@]+"${XCODEBUILD_ARGS[@]}"} \
    CODE_SIGNING_ALLOWED=NO \
    build

echo 'visionOS Ghostty consumer build passed; runtime rendering was not tested.'
