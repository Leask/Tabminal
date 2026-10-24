#!/usr/bin/env bash

tabminal_ghostty_candidate_paths() {
    local root_dir="$1"
    local repo_path="${TABMINAL_GHOSTTY_REPO_PATH:-}"
    local candidates=()

    if [[ -n "${TABMINAL_GHOSTTY_XCFRAMEWORK_PATH:-}" ]]; then
        candidates+=("${TABMINAL_GHOSTTY_XCFRAMEWORK_PATH}")
    fi

    if [[ -n "${TABMINAL_GHOSTTY_FRAMEWORK_PATH:-}" ]]; then
        candidates+=("${TABMINAL_GHOSTTY_FRAMEWORK_PATH}")
    fi

    if [[ -n "${repo_path}" ]]; then
        candidates+=("${repo_path}/macos/GhosttyKit.xcframework")
    fi

    candidates+=("${root_dir}/Vendor/Ghostty/GhosttyKit.xcframework")

    printf '%s\n' "${candidates[@]}"
}

tabminal_ghostty_resolve_xcframework() {
    local root_dir="$1"
    local candidate

    while IFS= read -r candidate; do
        if [[ -n "${candidate}" && -d "${candidate}" ]]; then
            printf '%s\n' "${candidate}"
            return 0
        fi
    done < <(tabminal_ghostty_candidate_paths "${root_dir}")

    return 1
}

tabminal_ghostty_library_for_sdk() {
    local sdk="$1"
    local xcframework_path="$2"
    local candidate

    case "${sdk}" in
        iphonesimulator)
            for candidate in \
                "${xcframework_path}/ios-arm64-simulator/libghostty-fat.a" \
                "${xcframework_path}/ios-arm64-simulator/libghostty.a"; do
                if [[ -f "${candidate}" ]]; then
                    printf '%s\n' "${candidate}"
                    return 0
                fi
            done
            ;;
        iphoneos)
            for candidate in \
                "${xcframework_path}/ios-arm64/libghostty-fat.a" \
                "${xcframework_path}/ios-arm64/libghostty.a"; do
                if [[ -f "${candidate}" ]]; then
                    printf '%s\n' "${candidate}"
                    return 0
                fi
            done
            ;;
        macosx)
            for candidate in \
                "${xcframework_path}/macos-arm64_x86_64/libghostty.a" \
                "${xcframework_path}/macos-arm64_x86_64/libghostty-fat.a"; do
                if [[ -f "${candidate}" ]]; then
                    printf '%s\n' "${candidate}"
                    return 0
                fi
            done
            ;;
        xros)
            for candidate in \
                "${xcframework_path}/xros-arm64/libghostty.a" \
                "${xcframework_path}/xros-arm64/libghostty-fat.a"; do
                if [[ -f "${candidate}" ]]; then
                    printf '%s\n' "${candidate}"
                    return 0
                fi
            done
            ;;
        xrsimulator)
            for candidate in \
                "${xcframework_path}/xros-arm64-simulator/libghostty-fat.a" \
                "${xcframework_path}/xros-arm64-simulator/libghostty.a" \
                "${xcframework_path}/xrsimulator-arm64/libghostty.a" \
                "${xcframework_path}/xrsimulator-arm64/libghostty-fat.a" \
                "${xcframework_path}/xrsimulator-arm64_x86_64/libghostty.a" \
                "${xcframework_path}/xrsimulator-arm64_x86_64/libghostty-fat.a"; do
                if [[ -f "${candidate}" ]]; then
                    printf '%s\n' "${candidate}"
                    return 0
                fi
            done
            ;;
        *)
            return 1
            ;;
    esac

    return 1
}

tabminal_ghostty_xcodebuild_args() {
    local root_dir="$1"
    local sdk="$2"
    local xcframework_path
    local static_lib
    local link_flags

    # A shared array keeps this helper compatible with macOS Bash 3.2.
    XCODEBUILD_ARGS=()

    if ! xcframework_path="$(
        tabminal_ghostty_resolve_xcframework "${root_dir}"
    )"; then
        if [[ "${TABMINAL_MOBILE_TERMINAL_RENDERER:-}" == "ghostty" ]]; then
            echo '[ghostty] Ghostty requested but no artifact was found.' >&2
            return 1
        fi
        return 0
    fi

    if ! static_lib="$(
        tabminal_ghostty_library_for_sdk "${sdk}" "${xcframework_path}"
    )"; then
        if [[ "${TABMINAL_MOBILE_TERMINAL_RENDERER:-}" == "ghostty" ]]; then
            echo "[ghostty] Ghostty requested but ${sdk} slice is missing." >&2
            return 1
        fi
        echo "[ghostty] No supported static library slice for ${sdk}; using text fallback." >&2
        return 0
    fi

    if [[ ! -f "${static_lib}" ]]; then
        echo "[ghostty] Missing static library ${static_lib}; using text fallback." >&2
        return 0
    fi

    if ! cmp -s \
        "${root_dir}/Sources/CGhosttyShim/include/ghostty.h" \
        "$(dirname "${static_lib}")/Headers/ghostty.h"; then
        echo '[ghostty] Artifact header does not match the bridge ABI.' >&2
        return 1
    fi

    echo "[ghostty] Linking ${static_lib}" >&2
    link_flags="\$(inherited) -force_load \"${static_lib}\" -lc++"
    if [[ "${sdk}" == "macosx" ]]; then
        link_flags+=" -framework GameController -framework Carbon"
    fi
    XCODEBUILD_ARGS+=("OTHER_LDFLAGS=${link_flags}")
}
