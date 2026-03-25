if [[ -z "${TABMINAL_SESSION_ID:-}" ]]; then
    return 0
fi

if [[ -n "${TABMINAL_BASH_HOOKS_LOADED:-}" ]]; then
    return 0
fi

TABMINAL_BASH_HOOKS_LOADED=1

_tabminal_bash_preexec() {
    if [[ "${BASH_COMMAND:-}" == *"_tabminal_"* ]]; then
        return
    fi
    if [[ "${BASH_COMMAND:-}" == "${PROMPT_COMMAND:-}" ]]; then
        return
    fi
    if [[ -n "${_tabminal_command_running:-}" ]]; then
        return
    fi
    _tabminal_command_running=1
    _tabminal_last_command="$BASH_COMMAND"
    local command_b64
    command_b64=$(
        echo -n "$_tabminal_last_command" | base64 | tr -d '\n'
    )
    printf '\x1b]1337;CommandStartB64=%s\x07' "$command_b64"
}

_tabminal_bash_postexec() {
    local exit_code="$?"
    if [[ -n "${_tabminal_last_command:-}" ]]; then
        local command_b64
        command_b64=$(
            echo -n "$_tabminal_last_command" | base64 | tr -d '\n'
        )
        printf '\x1b]1337;ExitCode=%s;CommandB64=%s\x07' \
            "$exit_code" "$command_b64"
        _tabminal_last_command=''
    fi
}

_tabminal_apply_prompt_marker() {
    local marker=$'\[\e]1337;TabminalPrompt\a\]'
    _tabminal_command_running=''
    if [[ "${PS1:-}" != *'TabminalPrompt'* ]]; then
        PS1="${PS1}${marker}"
    fi
}

_tabminal_prompt_contains() {
    local needle="$1"
    local current="${PROMPT_COMMAND:-}"
    [[ "$current" == *"$needle"* ]]
}

_tabminal_install_prompt_command() {
    if ! _tabminal_prompt_contains '_tabminal_bash_postexec'; then
        if [[ -n "${PROMPT_COMMAND:-}" ]]; then
            printf -v PROMPT_COMMAND '_tabminal_bash_postexec; %s' \
                "$PROMPT_COMMAND"
        else
            PROMPT_COMMAND='_tabminal_bash_postexec'
        fi
    fi

    if ! _tabminal_prompt_contains '_tabminal_apply_prompt_marker'; then
        if [[ -n "${PROMPT_COMMAND:-}" ]]; then
            PROMPT_COMMAND="${PROMPT_COMMAND}; _tabminal_apply_prompt_marker"
        else
            PROMPT_COMMAND='_tabminal_apply_prompt_marker'
        fi
    fi
}

_tabminal_install_tmux_wrapper() {
    if ! command -v tmux >/dev/null 2>&1; then
        return 0
    fi

    tmux() {
        command tmux -u "$@"
    }
}

trap '_tabminal_bash_preexec' DEBUG
_tabminal_install_prompt_command
_tabminal_install_tmux_wrapper
