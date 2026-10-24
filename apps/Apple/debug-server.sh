#!/usr/bin/env bash

# Shared by local debug and UI-test runners. Never reuse production storage
# or kill an unrelated service merely because it occupies the desired port.
tabminal_start_debug_server() {
    local repo_root="$1"
    local port="$2"
    local password="$3"
    local attempt

    if ! node --input-type=module - "${port}" <<'JS'
import net from 'node:net';
const server = net.createServer();
server.once('error', (error) => {
    console.error(`Debug port unavailable: ${error.message}`);
    process.exitCode = 1;
});
server.listen({ host: '127.0.0.1', port: Number(process.argv[2]) }, () => {
    server.close();
});
JS
    then
        echo 'Set TABMINAL_MOBILE_DEBUG_PORT to an unused port.' >&2
        return 1
    fi

    DEBUG_STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tabminal-apple.XXXXXX")"
    DEBUG_WORKSPACE_DIR="${DEBUG_STATE_DIR}/workspace"
    mkdir -p "${DEBUG_WORKSPACE_DIR}"
    LOG_FILE="${DEBUG_STATE_DIR}/server.log"
    (
        cd "${DEBUG_STATE_DIR}"
        exec env TABMINAL_DATA_DIR="${DEBUG_STATE_DIR}" \
            TABMINAL_CWD="${DEBUG_WORKSPACE_DIR}" \
            TABMINAL_ACP_DISCOVERY=0 \
            TABMINAL_PASSWORD="${password}" \
            TABMINAL_HOST=127.0.0.1 TABMINAL_PORT="${port}" \
            TABMINAL_CLOUDFLARE_KEY='' TABMINAL_OPENAI_KEY='' \
            TABMINAL_OPENROUTER_KEY='' TABMINAL_GOOGLE_KEY='' \
            TABMINAL_ACP_BUS_DB_PATH="${DEBUG_STATE_DIR}/acp-bus.sqlite" \
            node "${repo_root}/src/server.mjs" \
            --host 127.0.0.1 --port "${port}" \
            --password "${password}" --shell /bin/bash --accept-terms
    ) >"${LOG_FILE}" 2>&1 < /dev/null &
    SERVER_PID=$!

    for attempt in {1..30}; do
        if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
            cat "${LOG_FILE}" >&2
            wait "${SERVER_PID}" || true
            SERVER_PID=''
            return 1
        fi
        if grep -Fq "Tabminal listening on http://127.0.0.1:${port}" \
            "${LOG_FILE}" && curl --max-time 2 -fsS \
            "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
            echo "Isolated server: http://127.0.0.1:${port}"
            echo "Debug data and log: ${DEBUG_STATE_DIR}"
            return 0
        fi
        sleep 1
    done
    echo "Debug server failed to become ready; see ${LOG_FILE}" >&2
    tabminal_stop_debug_server
    return 1
}

tabminal_stop_debug_server() {
    if [[ -n "${SERVER_PID:-}" ]]; then
        kill "${SERVER_PID}" 2>/dev/null || true
        wait "${SERVER_PID}" 2>/dev/null || true
        SERVER_PID=''
    fi
}
