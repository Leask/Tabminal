#!/usr/bin/env bash

tabminal_ghostty_resolve_xcframework() {
    local root_dir="$1"
    local candidate

    for candidate in \
        "${TABMINAL_GHOSTTY_XCFRAMEWORK_PATH:-}" \
        "${TABMINAL_GHOSTTY_FRAMEWORK_PATH:-}" \
        "${root_dir}/Vendor/Ghostty/GhosttyKit.xcframework"; do
        if [[ -n "${candidate}" && -d "${candidate}" ]]; then
            printf '%s\n' "${candidate}"
            return 0
        fi
    done

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
    local -n out_ref="$3"
    local xcframework_path
    local static_lib
    local link_flags

    out_ref=()

    if ! xcframework_path="$(
        tabminal_ghostty_resolve_xcframework "${root_dir}"
    )"; then
        return 0
    fi

    if ! static_lib="$(
        tabminal_ghostty_library_for_sdk "${sdk}" "${xcframework_path}"
    )"; then
        echo "[ghostty] No supported static library slice for ${sdk}; using text fallback." >&2
        return 0
    fi

    if [[ ! -f "${static_lib}" ]]; then
        echo "[ghostty] Missing static library ${static_lib}; using text fallback." >&2
        return 0
    fi

    echo "[ghostty] Linking ${static_lib}" >&2
    link_flags="\$(inherited) -force_load ${static_lib} -lc++"
    if [[ "${sdk}" == "macosx" ]]; then
        link_flags+=" -framework GameController -framework Carbon"
    fi
    out_ref+=("OTHER_LDFLAGS=${link_flags}")
}
