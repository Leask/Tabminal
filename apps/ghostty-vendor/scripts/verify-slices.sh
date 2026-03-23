#!/usr/bin/env bash
set -euo pipefail

xcframework=${1:-}
if [[ -z ${xcframework} ]]; then
    echo 'usage: verify-slices.sh /path/to/GhosttyKit.xcframework' >&2
    exit 1
fi

plist="${xcframework}/Info.plist"
if [[ ! -f ${plist} ]]; then
    echo "missing Info.plist: ${plist}" >&2
    exit 1
fi

required=(
    ios-arm64
    ios-arm64-simulator
    macos-arm64_x86_64
    xros-arm64
    xros-arm64-simulator
)

for slice in "${required[@]}"; do
    if ! plutil -p "${plist}" | rg -q "LibraryIdentifier\" => \"${slice}\""; then
        echo "missing slice: ${slice}" >&2
        exit 1
    fi
    echo "ok: ${slice}"
done
