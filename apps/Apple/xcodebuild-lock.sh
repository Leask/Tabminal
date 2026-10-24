#!/usr/bin/env bash

set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    echo 'Source this helper and call tabminal_acquire_xcodebuild_lock.' >&2
    exit 1
fi

TABMINAL_XCODEBUILD_LOCK_FILE="${TMPDIR:-/tmp}/tabminal-mobile-xcodebuild.lock"

tabminal_acquire_xcodebuild_lock() {
    while ! shlock -p "$$" -f "${TABMINAL_XCODEBUILD_LOCK_FILE}"; do
        if [[ -f "${TABMINAL_XCODEBUILD_LOCK_FILE}" ]]; then
            local lock_pid
            lock_pid="$(cat "${TABMINAL_XCODEBUILD_LOCK_FILE}" 2>/dev/null || true)"
            if [[ -n "${lock_pid}" ]] && ! kill -0 "${lock_pid}" >/dev/null 2>&1; then
                rm -f "${TABMINAL_XCODEBUILD_LOCK_FILE}"
                continue
            fi
        fi

        sleep 0.2
    done

    trap tabminal_release_xcodebuild_lock EXIT
}

tabminal_release_xcodebuild_lock() {
    rm -f "${TABMINAL_XCODEBUILD_LOCK_FILE}"
}
