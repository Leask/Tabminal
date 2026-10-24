// Source identities locate messages. They never determine timeline order.
export function sourceMessageId(update = {}) {
    const value = update.messageId;
    return typeof value === 'string' && value.length ? value : '';
}

export { mergeAgentMessageText } from '../../public/modules/agent-messages.js';

export function messageStreamKey(state, update, role, kind) {
    const sourceId = sourceMessageId(update);
    if (sourceId) return sourceId;
    const bucket = `${update.sessionUpdate}:${role}:${kind}`;
    let key = state.syntheticStreams.get(bucket);
    if (!key) {
        key = `synthetic:${state.syntheticStreamTurn}:${bucket}`;
        state.syntheticStreams.set(bucket, key);
    }
    return key;
}
