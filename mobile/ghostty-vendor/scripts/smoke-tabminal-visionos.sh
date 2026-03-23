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

cd "${repo_root}/mobile/ios"
./xcodebuild-lock.sh xcodegen generate >/dev/null

tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/tabminal-visionos-smoke.XXXXXX")
trap 'rm -rf "${tmp_root}"' EXIT

HOME="${tmp_root}/home" \
CLANG_MODULE_CACHE_PATH="${tmp_root}/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="${tmp_root}/module-cache" \
TABMINAL_GHOSTTY_XCFRAMEWORK_PATH="${xcframework}" \
./xcodebuild-lock.sh \
    xcodebuild \
    -project TabminalMobileApp.xcodeproj \
    -scheme TabminalMobileApp \
    -sdk xros \
    -destination 'generic/platform=visionOS' \
    -derivedDataPath "${tmp_root}/DerivedData" \
    CODE_SIGNING_ALLOWED=NO \
    build
