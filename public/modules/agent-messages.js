// Delta and snapshot are different protocol operations, never text heuristics.
export function mergeAgentMessageText(previous, delta) {
    return String(previous ?? '') + String(delta ?? '');
}

export function selectAgentMessageText(previous, snapshot) {
    return typeof snapshot === 'string' ? snapshot : String(previous ?? '');
}
