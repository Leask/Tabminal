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

function buildSessionTitle(promptText = '') {
    const source = String(promptText || '').replace(/\s+/g, ' ').trim();
    if (!source) {
        return 'ACP Smoke Session';
    }
    return source.length > 42
        ? `${source.slice(0, 39).trimEnd()}...`
        : source;
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
        this.sessions.set(sessionId, {
            controller: null,
            modeId: 'default',
            modelId: 'gpt-5.4',
            thoughtLevel: 'medium'
        });
        return {
            sessionId,
            modes: {
                currentModeId: 'default',
                availableModes: [
                    {
                        modeId: 'default',
                        id: 'default',
                        name: 'Default',
                        description: 'Balanced test mode'
                    },
                    {
                        modeId: 'review',
                        id: 'review',
                        name: 'Review',
                        description: 'Focus on analysis and review-style output'
                    }
                ]
            },
            availableCommands: [
                {
                    name: 'review',
                    description: 'Review the current project',
                    input: { hint: 'What should be reviewed?' }
                },
                {
                    name: 'explain',
                    description: 'Explain a file or concept',
                    input: { hint: 'What should be explained?' }
                }
            ],
            configOptions: [
                {
                    id: 'model',
                    name: 'Model',
                    category: 'model',
                    type: 'select',
                    currentValue: 'gpt-5.4',
                    options: [
                        { value: 'gpt-5.4', name: 'GPT-5.4' },
                        { value: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' }
                    ]
                },
                {
                    id: 'thought_level',
                    name: 'Thought Level',
                    category: 'thought_level',
                    type: 'select',
                    currentValue: 'medium',
                    options: [
                        { value: 'low', name: 'Low' },
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High' }
                    ]
                }
            ]
        };
    }

    async setSessionMode(params) {
        const session = this.sessions.get(params.sessionId);
        if (!session) {
            throw new Error('Session not found');
        }
        session.modeId = params.modeId;
        await this.connection.sessionUpdate({
            sessionId: params.sessionId,
            update: {
                sessionUpdate: 'current_mode_update',
                currentModeId: params.modeId
            }
        });
        return {
            currentModeId: params.modeId
        };
    }

    async setSessionConfigOption(params) {
        const session = this.sessions.get(params.sessionId);
        if (!session) {
            throw new Error('Session not found');
        }
        if (params.configId === 'model') {
            session.modelId = params.value;
        } else if (params.configId === 'thought_level') {
            session.thoughtLevel = params.value;
        }
        const configOptions = [
            {
                id: 'model',
                name: 'Model',
                category: 'model',
                type: 'select',
                currentValue: session.modelId,
                options: [
                    { value: 'gpt-5.4', name: 'GPT-5.4' },
                    { value: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' }
                ]
            },
            {
                id: 'thought_level',
                name: 'Thought Level',
                category: 'thought_level',
                type: 'select',
                currentValue: session.thoughtLevel,
                options: [
                    { value: 'low', name: 'Low' },
                    { value: 'medium', name: 'Medium' },
                    { value: 'high', name: 'High' }
                ]
            }
        ];
        await this.connection.sessionUpdate({
            sessionId: params.sessionId,
            update: {
                sessionUpdate: 'config_option_update',
                configOptions
            }
        });
        return { configOptions };
    }

    async sendPlan(sessionId, entries) {
        await this.connection.sessionUpdate({
            sessionId,
            update: {
                sessionUpdate: 'plan',
                entries
            }
        });
    }

    async sendUsage(sessionId) {
        const now = Date.now();
        await this.connection.sessionUpdate({
            sessionId,
            update: {
                sessionUpdate: 'usage_update',
                used: 48200,
                size: 262144,
                cost: {
                    amount: 0.12,
                    currency: 'USD'
                },
                _meta: {
                    vendorLabel: 'Tabminal Test Agent',
                    sessionId,
                    summary: 'Synthetic quota view',
                    resetAt: new Date(now + 95 * 60 * 1000).toISOString(),
                    windows: [
                        {
                            label: '5h',
                            used: 32,
                            size: 100,
                            subtitle: 'short-term window',
                            resetAt: new Date(
                                now + 95 * 60 * 1000
                            ).toISOString()
                        },
                        {
                            label: '7d',
                            used: 210,
                            size: 1000,
                            subtitle: 'weekly budget',
                            resetAt: new Date(
                                now + 5 * 24 * 60 * 60 * 1000
                            ).toISOString()
                        }
                    ]
                }
            }
        });
    }

    async createTerminalDemo(sessionId) {
        const terminal = await this.connection.createTerminal({
            sessionId,
            command: 'printf "alpha\\n"; sleep 0.25; '
                + 'printf "beta\\n"; sleep 0.25',
            cwd: process.cwd(),
            outputByteLimit: 4096
        });
        return terminal;
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
        const modePrefix = session.modeId === 'review'
            ? '[review] '
            : '';

        try {
            await this.sendPlan(params.sessionId, [
                {
                    content: 'Inspect the request and summarize the task',
                    priority: 'high',
                    status: 'completed'
                },
                {
                    content: 'Run the necessary tool calls',
                    priority: 'high',
                    status: 'in_progress'
                },
                {
                    content: 'Write the final response',
                    priority: 'medium',
                    status: 'pending'
                }
            ]);
            await this.sendUsage(params.sessionId);
            await this.connection.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: 'agent_message_chunk',
                    messageId: 'intro',
                    content: {
                        type: 'text',
                        text: `${modePrefix}Tabminal ACP smoke agent online. `
                    }
                }
            });
            await this.connection.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: 'session_info_update',
                    title: buildSessionTitle(promptText)
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

            if (/cancel-smoke/i.test(promptText)) {
                for (let index = 0; index < 8; index += 1) {
                    await this.connection.sessionUpdate({
                        sessionId: params.sessionId,
                        update: {
                            sessionUpdate: 'agent_message_chunk',
                            messageId: 'cancel-smoke',
                            content: {
                                type: 'text',
                                text: ` chunk-${index + 1}`
                            }
                        }
                    });
                    await sleep(120, signal);
                }
                return { stopReason: 'end_turn' };
            }

            if (/synthetic-order/i.test(promptText)) {
                await this.connection.sessionUpdate({
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: {
                            type: 'text',
                            text: 'Before tool.'
                        }
                    }
                });
                await this.connection.sessionUpdate({
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'tool_call',
                        toolCallId: 'synthetic-tool',
                        title: 'Synthetic tool call',
                        kind: 'execute',
                        status: 'pending'
                    }
                });
                await this.connection.sessionUpdate({
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'tool_call_update',
                        toolCallId: 'synthetic-tool',
                        status: 'completed'
                    }
                });
                await this.connection.sessionUpdate({
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: {
                            type: 'text',
                            text: 'After tool.'
                        }
                    }
                });
                return { stopReason: 'end_turn' };
            }

            if (/diff-smoke/i.test(promptText)) {
                const terminal = await this.createTerminalDemo(params.sessionId);
                await this.connection.sessionUpdate({
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'tool_call',
                        toolCallId: 'diff-tool',
                        title: 'Update sample.js',
                        kind: 'edit',
                        status: 'pending',
                        locations: [{ path: '/tmp/sample.js' }],
                        rawInput: { path: '/tmp/sample.js' }
                    }
                });
                await sleep(30, signal);
                await this.connection.sessionUpdate({
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'tool_call_update',
                        toolCallId: 'diff-tool',
                        status: 'pending',
                        content: [
                            {
                                type: 'terminal',
                                terminalId: terminal.id
                            }
                        ]
                    }
                });
                await sleep(120, signal);
                await terminal.currentOutput();
                await terminal.waitForExit();
                await terminal.currentOutput();
                await terminal.release();
                await this.connection.sessionUpdate({
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'tool_call_update',
                        toolCallId: 'diff-tool',
                        status: 'completed',
                        content: [
                            {
                                type: 'terminal',
                                terminalId: terminal.id
                            },
                            {
                                type: 'diff',
                                path: '/tmp/sample.js',
                                oldText: 'const answer = 1;\\n',
                                newText: 'const answer = 42;\\n'
                            },
                            {
                                type: 'content',
                                content: {
                                    type: 'resource',
                                    resource: {
                                        uri: 'file:///tmp/sample.js',
                                        mimeType: 'text/javascript',
                                        text: 'const answer = 42;\\n'
                                    }
                                }
                            }
                        ]
                    }
                });
                await this.sendPlan(params.sessionId, [
                    {
                        content: 'Inspect the request and summarize the task',
                        priority: 'high',
                        status: 'completed'
                    },
                    {
                        content: 'Run the necessary tool calls',
                        priority: 'high',
                        status: 'completed'
                    },
                    {
                        content: 'Write the final response',
                        priority: 'medium',
                        status: 'completed'
                    }
                ]);
                await this.connection.sessionUpdate({
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        messageId: 'diff-result',
                        content: {
                            type: 'text',
                            text: 'Rendered diff smoke payload.'
                        }
                    }
                });
                return { stopReason: 'end_turn' };
            }

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
                            : 'failed'
                    }
                });

                await this.connection.sessionUpdate({
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        messageId: 'permission-result',
                        content: {
                            type: 'text',
                            text: permission.outcome.outcome === 'selected'
                                ? 'All set. Permission was granted.'
                                : 'Permission was cancelled.'
                        }
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
