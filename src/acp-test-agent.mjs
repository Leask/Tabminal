import crypto from 'node:crypto';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (!signal) return;
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
        }, { once: true });
    });
}

function extractPromptText(prompt = []) {
    return prompt
        .filter((item) => item?.type === 'text')
        .map((item) => item.text || '')
        .join('\n')
        .trim();
}

class TabminalTestAgent {
    constructor(connection) {
        this.connection = connection;
        this.sessions = new Map();
    }

    async initialize() {
        return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentInfo: {
                name: 'Tabminal Test Agent',
                version: '0.1.0'
            },
            agentCapabilities: {
                loadSession: false
            }
        };
    }

    async authenticate() {
        return {};
    }

    async newSession() {
        const sessionId = crypto.randomUUID();
        this.sessions.set(sessionId, { controller: null });
        return {
            sessionId,
            modes: {
                currentModeId: 'default',
                availableModes: [{
                    modeId: 'default',
                    name: 'Default'
                }]
            }
        };
    }

    async setSessionMode() {
        return {};
    }

    async prompt(params) {
        const session = this.sessions.get(params.sessionId);
        if (!session) {
            throw new Error('Session not found');
        }

        session.controller?.abort();
        session.controller = new AbortController();
        const signal = session.controller.signal;
        const promptText = extractPromptText(params.prompt);

        try {
            await this.connection.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: 'agent_message_chunk',
                    messageId: 'intro',
                    content: {
                        type: 'text',
                        text: 'Tabminal ACP smoke agent online. '
                    }
                }
            });
            await sleep(30, signal);
            await this.connection.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: 'agent_message_chunk',
                    messageId: 'intro',
                    content: {
                        type: 'text',
                        text: `Prompt: ${promptText || '(empty)'}`
                    }
                }
            });
            await sleep(30, signal);

            if (/permission/i.test(promptText)) {
                await this.connection.sessionUpdate({
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'tool_call',
                        toolCallId: 'permission-tool',
                        title: 'Write sample file',
                        kind: 'edit',
                        status: 'pending',
                        locations: [{ path: '/tmp/tabminal-acp-test.txt' }],
                        rawInput: { path: '/tmp/tabminal-acp-test.txt' }
                    }
                });
                const permission = await this.connection.requestPermission({
                    sessionId: params.sessionId,
                    toolCall: {
                        toolCallId: 'permission-tool',
                        title: 'Write sample file',
                        kind: 'edit',
                        status: 'pending',
                        locations: [{ path: '/tmp/tabminal-acp-test.txt' }]
                    },
                    options: [{
                        kind: 'allow_once',
                        name: 'Allow once',
                        optionId: 'allow-once'
                    }]
                });

                await this.connection.sessionUpdate({
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'tool_call_update',
                        toolCallId: 'permission-tool',
                        status: permission.outcome.outcome === 'selected'
                            ? 'completed'
                            : 'cancelled'
                    }
                });
            }

            await this.connection.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: 'agent_thought_chunk',
                    messageId: 'thought',
                    content: {
                        type: 'text',
                        text: 'No real model call was made. This is a local test agent.'
                    }
                }
            });
            await sleep(30, signal);
            return { stopReason: 'end_turn' };
        } catch (error) {
            if (signal.aborted) {
                return { stopReason: 'cancelled' };
            }
            throw error;
        } finally {
            session.controller = null;
        }
    }

    async cancel(params) {
        this.sessions.get(params.sessionId)?.controller?.abort();
    }
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);
new acp.AgentSideConnection(
    (connection) => new TabminalTestAgent(connection),
    stream
);
