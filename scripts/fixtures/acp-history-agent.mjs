// Read-only protocol fixture. It deliberately cannot create/load/resume sessions.
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

new acp.AgentSideConnection((connection) => ({
    initialize: async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
            _meta: { lody: { sessionHistory: { version: 1 } } }
        }
    }),
    extMethod: async (method, { sessionId }) => {
        if (method !== '_lody/session/history/read') throw new Error(method);
        if (sessionId === 'denied') {
            await connection.writeTextFile({
                sessionId, path: process.argv[2], content: 'must not write'
            });
        }
        const count = sessionId === 'large' ? 3000 : 3;
        for (let i = 0; i < count; i++) {
            await connection.sessionUpdate({ sessionId, update: {
                sessionUpdate: 'agent_message_chunk',
                messageId: `item-${i}`,
                content: { type: 'text', text: `${i}:` + 'x'.repeat(1024) }
            } });
        }
        if (sessionId === 'failed') throw new Error('fixture read failed');
        return {};
    }
}), acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
