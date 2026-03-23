#!/usr/bin/env bash
set -euo pipefail

repo_root=${1:-${GHOSTTY_REPO:-}}
if [[ -z ${repo_root} ]]; then
    echo 'usage: build-xcframework.sh <ghostty-repo>' >&2
    echo 'or set GHOSTTY_REPO=/path/to/ghostty-custom-io' >&2
    exit 1
fi

if [[ ! -d ${repo_root} ]]; then
    echo "repo not found: ${repo_root}" >&2
    exit 1
fi

cache_root=${TABMINAL_GHOSTTY_ZIG_CACHE_ROOT:-${repo_root}/.tabminal-zig-cache}
local_cache_dir=${cache_root}/local
global_cache_dir=${cache_root}/global
mkdir -p "${local_cache_dir}" "${global_cache_dir}"

pushd "${repo_root}" >/dev/null
zig build \
    --cache-dir "${local_cache_dir}" \
    --global-cache-dir "${global_cache_dir}" \
    -Dapp-runtime=none \
    -Demit-xcframework=true \
    -Demit-macos-app=false \
    -Demit-exe=false \
    -Demit-docs=false \
    -Demit-webdata=false \
    -Demit-helpgen=false \
    -Demit-terminfo=false \
    -Demit-termcap=false \
    -Demit-themes=false \
    -Doptimize=ReleaseFast \
    -Dstrip \
    -Dxcframework-target=universal
popd >/dev/null

echo "built: ${repo_root}/macos/GhosttyKit.xcframework"
