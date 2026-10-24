#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "${script_dir}/../../.." && pwd)
expected_header="${repo_root}/apps/Apple/Sources/CGhosttyShim/include/ghostty.h"
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

fail() {
    echo "${1}" >&2
    exit 1
}

plist_value() {
    /usr/libexec/PlistBuddy \
        -c "Print :AvailableLibraries:${entry}:${1}" "${plist}"
}

relative_path() {
    case "${1}" in
        ''|/*|..|../*|*/../*|*/..)
            fail "invalid relative path in ${slice}: ${1}"
            ;;
    esac
}

plutil -lint "${plist}" >/dev/null
[[ -f ${expected_header} ]] || fail "missing ABI header: ${expected_header}"

required=(
    ios-arm64
    ios-arm64-simulator
    macos-arm64_x86_64
    xros-arm64
    xros-arm64-simulator
)

# Keep aligned with GhosttyRuntimeStatus's surface and remote-I/O probes.
required_symbols=(
    ghostty_init
    ghostty_config_new
    ghostty_config_finalize
    ghostty_config_free
    ghostty_app_new
    ghostty_app_free
    ghostty_app_tick
    ghostty_surface_config_new
    ghostty_surface_new
    ghostty_surface_free
    ghostty_surface_refresh
    ghostty_surface_draw
    ghostty_surface_set_size
    ghostty_surface_set_content_scale
    ghostty_surface_set_focus
    ghostty_surface_set_occlusion
    ghostty_surface_size
    ghostty_surface_text
    ghostty_surface_feed_data
    ghostty_surface_set_write_callback
)

for slice in "${required[@]}"; do
    entry=0
    match=''
    while /usr/libexec/PlistBuddy \
        -c "Print :AvailableLibraries:${entry}" "${plist}" >/dev/null 2>&1; do
        identifier=$(plist_value LibraryIdentifier)
        if [[ ${identifier} == "${slice}" ]]; then
            [[ -z ${match} ]] || fail "duplicate slice: ${slice}"
            match=${entry}
        fi
        entry=$((entry + 1))
    done
    [[ -n ${match} ]] || fail "missing slice: ${slice}"
    entry=${match}

    platform=${slice%%-*}
    variant=''
    if [[ ${slice} == *-simulator ]]; then
        variant=simulator
    fi
    [[ $(plist_value SupportedPlatform) == "${platform}" ]] ||
        fail "wrong platform for ${slice}"
    actual_variant=$(plist_value SupportedPlatformVariant 2>/dev/null || true)
    [[ ${actual_variant} == "${variant}" ]] ||
        fail "wrong platform variant for ${slice}"

    library_path=$(plist_value LibraryPath)
    headers_path=$(plist_value HeadersPath)
    relative_path "${library_path}"
    relative_path "${headers_path}"
    library="${xcframework}/${slice}/${library_path}"
    header="${xcframework}/${slice}/${headers_path}/ghostty.h"
    [[ ${library} == *.a && -s ${library} ]] ||
        fail "missing static archive: ${library}"
    [[ -f ${header} ]] || fail "missing header: ${header}"
    cmp -s "${expected_header}" "${header}" ||
        fail "Ghostty header ABI mismatch: ${header}"

    architectures=(arm64)
    if [[ ${platform} == macos ]]; then
        architectures+=(x86_64)
    fi
    declared_archs=''
    arch_index=0
    while arch=$(plist_value "SupportedArchitectures:${arch_index}" \
        2>/dev/null); do
        declared_archs+=" ${arch}"
        arch_index=$((arch_index + 1))
    done
    [[ ${arch_index} -eq ${#architectures[@]} ]] ||
        fail "wrong architecture count in plist for ${slice}"
    binary_archs=$(lipo -archs "${library}") ||
        fail "cannot inspect archive architectures: ${library}"

    for arch in "${architectures[@]}"; do
        [[ "${declared_archs} " == *" ${arch} "* ]] ||
            fail "plist missing ${arch} for ${slice}"
        [[ " ${binary_archs} " == *" ${arch} "* ]] ||
            fail "archive missing ${arch}: ${library}"

        # Defined external symbols only; undefined references are not exports.
        symbols=$(nm -arch "${arch}" -g -U -j "${library}") ||
            fail "cannot inspect ${arch} symbols: ${library}"
        for symbol in "${required_symbols[@]}"; do
            grep -Fxq "_${symbol}" <<<"${symbols}" ||
                fail "missing ${arch} renderer symbol ${symbol}: ${library}"
        done
    done
    echo "ok: ${slice} (header, architectures, renderer and custom I/O)"
done
