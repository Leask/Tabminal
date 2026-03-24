import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import * as acp from '@agentclientprotocol/sdk';
import pkg from '../package.json' with { type: 'json' };
import * as persistence from './persistence.mjs';

const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_TERMINAL_OUTPUT_LIMIT = 256 * 1024;
const NPX_COMMAND = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEST_AGENT_PATH = path.join(CURRENT_DIR, 'acp-test-agent.mjs');

function commandExists(command) {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(checker, [command], {
        stdio: 'ignore'
    });
    return result.status === 0;
}

function makeBuiltInDefinitions() {
    const hasGeminiBinary = commandExists('gemini');
    const definitions = [
        {
            id: 'gemini',
            label: 'Gemini CLI',
            description: 'Google Gemini CLI over ACP',
            command: hasGeminiBinary ? 'gemini' : NPX_COMMAND,
            args: hasGeminiBinary
                ? ['--acp']
                : ['@google/gemini-cli@latest', '--acp'],
            commandLabel: hasGeminiBinary
                ? 'gemini --acp'
                : 'npx @google/gemini-cli@latest --acp'
        },
        {
            id: 'codex',
            label: 'Codex CLI',
            description: 'Codex ACP adapter',
            command: NPX_COMMAND,
            args: ['@zed-industries/codex-acp@latest'],
            commandLabel: 'npx @zed-industries/codex-acp@latest'
        },
        {
            id: 'claude',
            label: 'Claude Agent',
            description: 'Claude Code ACP adapter',
            command: NPX_COMMAND,
            args: ['@zed-industries/claude-code-acp@latest'],
            commandLabel: 'npx @zed-industries/claude-code-acp@latest'
        },
        {
            id: 'copilot',
            label: 'GitHub Copilot',
            description: 'GitHub Copilot CLI ACP server',
            command: 'copilot',
            args: ['--acp', '--stdio'],
            commandLabel: 'copilot --acp --stdio'
        }
    ];
    if (process.env.TABMINAL_ENABLE_TEST_AGENT === '1') {
        definitions.unshift({
            id: 'test-agent',
            label: 'ACP Test Agent',
            description: 'Local ACP smoke-test agent',
            command: process.execPath,
            args: [TEST_AGENT_PATH],
            commandLabel: `${process.execPath} ${TEST_AGENT_PATH}`
        });
    }
    return definitions;
}

function getDefinitionAvailability(definition) {
    if (!commandExists(definition.command)) {
        return {
            available: false,
            reason: 'not installed'
        };
    }

    if (definition.id === 'gemini') {
        const hasApiKey = Boolean(
            process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
        );
        if (!hasApiKey) {
            return {
                available: false,
                reason: 'API key missing'
            };
        }
    }

    return {
        available: true,
        reason: ''
    };
}

function formatAgentStartupError(definition, error) {
    const rawMessage = error?.message || 'Failed to start agent';
    if (
        definition?.id === 'codex'
        && /authentication required/i.test(rawMessage)
    ) {
        return 'Codex is not authenticated on this host. Run `codex login` '
            + 'for the user running Tabminal, or start Tabminal with a HOME '
            + 'that already contains Codex auth.';
    }
    return rawMessage;
}

function makeRuntimeKey(agentId, cwd) {
    return `${agentId}::${path.resolve(cwd)}`;
}

function normalizeEnvList(envList) {
    if (!Array.isArray(envList)) return {};
    const env = {};
    for (const item of envList) {
        if (!item || typeof item.name !== 'string') continue;
        env[item.name] = typeof item.value === 'string' ? item.value : '';
    }
    return env;
}

function truncateUtf8(text, byteLimit) {
    if (!text) return '';
    const buffer = Buffer.from(text, 'utf8');
    if (buffer.length <= byteLimit) return text;

    let slice = buffer.subarray(buffer.length - byteLimit);
    while (slice.length > 0) {
        const decoded = slice.toString('utf8');
        if (!decoded.includes('\uFFFD')) {
            return decoded;
        }
        slice = slice.subarray(1);
    }
    return '';
}

export function mergeAgentMessageText(previousText, chunkText) {
    const previous = String(previousText || '');
    const chunk = String(chunkText || '');
    if (!previous) return chunk;
    if (!chunk) return previous;
    if (/\s$/.test(previous) || /^\s/.test(chunk)) {
        return `${previous}${chunk}`;
    }

    const previousLast = previous.slice(-1);
    const chunkFirst = chunk[0] || '';
    if (
        /[.!?`'")\]]/.test(previousLast)
        && /[A-Z`"'[(]/.test(chunkFirst)
    ) {
        return `${previous}\n\n${chunk}`;
    }

    return `${previous}${chunk}`;
}

class LocalExecTerminal {
    constructor(request) {
        this.id = crypto.randomUUID();
        this.output = '';
        this.outputByteLimit = Math.max(
            1024,
            request.outputByteLimit || DEFAULT_TERMINAL_OUTPUT_LIMIT
        );
        this.exitStatus = null;
        this.closed = false;
        this.waiters = [];

        const env = {
            ...process.env,
            ...normalizeEnvList(request.env)
        };

        this.child = spawn(request.command, request.args || [], {
            cwd: request.cwd || process.cwd(),
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const append = (chunk) => {
            const text = Buffer.isBuffer(chunk)
                ? chunk.toString('utf8')
                : String(chunk);
            this.output = truncateUtf8(
                `${this.output}${text}`,
                this.outputByteLimit
            );
        };

        this.child.stdout?.on('data', append);
        this.child.stderr?.on('data', append);
        this.child.on('exit', (code, signal) => {
            this.closed = true;
            this.exitStatus = {
                exitCode: typeof code === 'number' ? code : null,
                signal: signal || null
            };
            for (const waiter of this.waiters) {
                waiter(this.exitStatus);
            }
            this.waiters.length = 0;
        });
    }

    currentOutput() {
        return {
            output: this.output,
            exitStatus: this.exitStatus
        };
    }

    waitForExit() {
        if (this.exitStatus) {
            return Promise.resolve(this.exitStatus);
        }
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }

    kill() {
        if (!this.closed) {
            this.child.kill('SIGTERM');
        }
        return {};
    }

    async release() {
        if (!this.closed) {
            this.child.kill('SIGTERM');
            await this.waitForExit().catch(() => {});
        }
    }
}

class AcpRuntime extends EventEmitter {
    constructor(definition, options = {}) {
        super();
        this.definition = definition;
        this.cwd = path.resolve(options.cwd || process.cwd());
        this.runtimeId = options.runtimeId || crypto.randomUUID();
        this.runtimeKey = makeRuntimeKey(definition.id, this.cwd);
        this.idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;
        this.connection = null;
        this.process = null;
        this.started = false;
        this.startPromise = null;
        this.idleTimer = null;
        this.agentInfo = null;
        this.agentCapabilities = null;
        this.authMethods = [];
        this.tabs = new Map();
        this.sessionToTabId = new Map();
        this.terminals = new Map();
    }

    #buildTab({
        id,
        acpSessionId,
        terminalSessionId,
        cwd,
        createdAt,
        currentModeId = '',
        availableModes = [],
        availableCommands = []
    }) {
        return {
            id,
            runtimeId: this.runtimeId,
            runtimeKey: this.runtimeKey,
            agentId: this.definition.id,
            agentLabel: this.definition.label,
            commandLabel: this.definition.commandLabel,
            terminalSessionId: terminalSessionId || '',
            cwd,
            acpSessionId,
            createdAt: createdAt || new Date().toISOString(),
            status: 'ready',
            busy: false,
            errorMessage: '',
            messages: [],
            toolCalls: new Map(),
            permissions: new Map(),
            syntheticStreams: new Map(),
            syntheticStreamTurn: 0,
            pendingUserEcho: null,
            currentModeId,
            availableModes,
            availableCommands,
            clients: new Set(),
            messageCounter: 0,
            timelineCounter: 0
        };
    }

    async start() {
        if (this.started) return;
        if (this.startPromise) return this.startPromise;

        this.startPromise = this.#startInternal();
        try {
            await this.startPromise;
        } finally {
            this.startPromise = null;
        }
    }

    async #startInternal() {
        const child = spawn(this.definition.command, this.definition.args, {
            cwd: this.cwd,
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        this.process = child;
        child.stderr?.on('data', (chunk) => {
            const text = Buffer.isBuffer(chunk)
                ? chunk.toString('utf8')
                : String(chunk);
            this.emit('runtime_log', {
                runtimeId: this.runtimeId,
                level: 'warn',
                message: text.trim()
            });
        });
        child.on('exit', (code, signal) => {
            const detail = {
                runtimeId: this.runtimeId,
                code: typeof code === 'number' ? code : null,
                signal: signal || null
            };
            for (const tab of this.tabs.values()) {
                tab.status = 'disconnected';
                tab.busy = false;
                tab.errorMessage = detail.signal
                    ? `Agent runtime exited (${detail.signal}).`
                    : `Agent runtime exited (${detail.code ?? 'unknown'}).`;
            }
            this.emit('runtime_exit', detail);
        });

        const input = Writable.toWeb(child.stdin);
        const output = Readable.toWeb(child.stdout);
        const stream = acp.ndJsonStream(input, output);
        this.connection = new acp.ClientSideConnection(
            () => ({
                sessionUpdate: (params) => this.#handleSessionUpdate(params),
                requestPermission: (params) => this.#requestPermission(params),
                readTextFile: (params) => this.#readTextFile(params),
                writeTextFile: (params) => this.#writeTextFile(params),
                createTerminal: (params) => this.#createTerminal(params)
            }),
            stream
        );

        const result = await this.connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo: {
                name: 'Tabminal',
                version: pkg.version
            },
            clientCapabilities: {
                fs: {
                    readTextFile: true,
                    writeTextFile: true
                },
                terminal: true
            }
        });

        this.agentInfo = result.agentInfo || null;
        this.agentCapabilities = result.agentCapabilities || null;
        this.authMethods = result.authMethods || [];
        this.started = true;
    }

    scheduleIdleShutdown(onIdle) {
        if (this.tabs.size > 0) return;
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            void onIdle();
        }, this.idleTimeoutMs);
    }

    clearIdleShutdown() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    async createTab(meta) {
        await this.start();
        this.clearIdleShutdown();
        const response = await this.connection.newSession({
            cwd: meta.cwd,
            mcpServers: []
        });
        const tab = this.#buildTab({
            id: meta.id,
            acpSessionId: response.sessionId,
            terminalSessionId: meta.terminalSessionId,
            cwd: meta.cwd,
            currentModeId: response.modes?.currentModeId || '',
            availableModes: response.modes?.availableModes || [],
            availableCommands: response.availableCommands || []
        });
        if (meta.modeId && typeof this.connection.setSessionMode === 'function') {
            try {
                const modeResponse = await this.connection.setSessionMode({
                    sessionId: tab.acpSessionId,
                    modeId: meta.modeId
                });
                tab.currentModeId = modeResponse?.currentModeId
                    || modeResponse?.modeId
                    || meta.modeId;
                if (Array.isArray(modeResponse?.availableModes)) {
                    tab.availableModes = modeResponse.availableModes;
                }
            } catch {
                // Ignore unsupported mode changes during initial tab creation.
            }
        }
        this.tabs.set(tab.id, tab);
        this.sessionToTabId.set(tab.acpSessionId, tab.id);
        return this.serializeTab(tab);
    }

    async restoreTab(meta) {
        await this.start();
        this.clearIdleShutdown();

        if (
            !this.agentCapabilities?.loadSession
            || typeof this.connection.loadSession !== 'function'
        ) {
            throw new Error(
                `${this.definition.label} does not support session restore`
            );
        }

        const tab = this.#buildTab({
            id: meta.id,
            acpSessionId: meta.acpSessionId,
            terminalSessionId: meta.terminalSessionId,
            cwd: meta.cwd,
            createdAt: meta.createdAt
        });
        tab.status = 'restoring';
        tab.busy = true;

        this.tabs.set(tab.id, tab);
        this.sessionToTabId.set(tab.acpSessionId, tab.id);

        try {
            const response = await this.connection.loadSession({
                cwd: meta.cwd,
                sessionId: meta.acpSessionId,
                mcpServers: []
            });
            const restoredSessionId = response?.sessionId || meta.acpSessionId;
            if (restoredSessionId !== tab.acpSessionId) {
                this.sessionToTabId.delete(tab.acpSessionId);
                tab.acpSessionId = restoredSessionId;
                this.sessionToTabId.set(tab.acpSessionId, tab.id);
            }
            tab.currentModeId = response?.modes?.currentModeId || '';
            tab.availableModes = response?.modes?.availableModes || [];
            tab.availableCommands = response?.availableCommands || [];
            tab.status = 'ready';
            tab.busy = false;
            tab.errorMessage = '';
            return this.serializeTab(tab);
        } catch (error) {
            this.tabs.delete(tab.id);
            this.sessionToTabId.delete(tab.acpSessionId);
            throw error;
        }
    }

    serializeTab(tab) {
        return {
            id: tab.id,
            runtimeId: tab.runtimeId,
            runtimeKey: tab.runtimeKey,
            acpSessionId: tab.acpSessionId,
            agentId: tab.agentId,
            agentLabel: tab.agentLabel,
            commandLabel: tab.commandLabel,
            terminalSessionId: tab.terminalSessionId,
            cwd: tab.cwd,
            createdAt: tab.createdAt,
            status: tab.status,
            busy: tab.busy,
            errorMessage: tab.errorMessage,
            currentModeId: tab.currentModeId,
            availableModes: tab.availableModes,
            availableCommands: tab.availableCommands,
            messages: tab.messages,
            toolCalls: Array.from(tab.toolCalls.values()),
            permissions: Array.from(tab.permissions.values()).map((item) => ({
                id: item.id,
                sessionId: item.sessionId,
                toolCall: item.toolCall,
                options: item.options,
                status: item.status,
                order: item.order,
                selectedOptionId: item.selectedOptionId || ''
            }))
        };
    }

    attachSocket(tabId, socket) {
        const tab = this.tabs.get(tabId);
        if (!tab) {
            socket.close();
            return false;
        }
        tab.clients.add(socket);
        socket.send(JSON.stringify({
            type: 'snapshot',
            tab: this.serializeTab(tab)
        }));
        socket.on('close', () => {
            tab.clients.delete(socket);
        });
        return true;
    }

    async sendPrompt(tabId, text) {
        const tab = this.tabs.get(tabId);
        if (!tab) {
            throw new Error('Agent tab not found');
        }
        if (tab.busy) {
            throw new Error('Agent tab is already running');
        }
        tab.errorMessage = '';
        tab.busy = true;
        tab.status = 'running';
        tab.syntheticStreamTurn += 1;
        tab.syntheticStreams.clear();
        this.#appendMessage(tab, {
            role: 'user',
            kind: 'message',
            text,
            streamKey: crypto.randomUUID()
        });
        tab.pendingUserEcho = {
            text,
            matched: 0
        };
        this.#broadcast(tab, {
            type: 'status',
            status: tab.status,
            busy: tab.busy,
            errorMessage: ''
        });

        const promptPromise = this.connection.prompt({
            sessionId: tab.acpSessionId,
            prompt: [{
                type: 'text',
                text
            }]
        });

        void promptPromise.then((response) => {
            if (!this.tabs.has(tabId)) return;
            tab.busy = false;
            tab.status = 'ready';
            tab.syntheticStreams.clear();
            tab.pendingUserEcho = null;
            this.#broadcast(tab, {
                type: 'complete',
                stopReason: response.stopReason,
                status: tab.status,
                busy: false
            });
        }).catch((error) => {
            if (!this.tabs.has(tabId)) return;
            tab.busy = false;
            tab.status = 'error';
            tab.errorMessage = error?.message || 'Agent request failed.';
            tab.syntheticStreams.clear();
            tab.pendingUserEcho = null;
            this.#broadcast(tab, {
                type: 'status',
                status: tab.status,
                busy: false,
                errorMessage: tab.errorMessage
            });
        });
    }

    async cancel(tabId) {
        const tab = this.tabs.get(tabId);
        if (!tab) {
            throw new Error('Agent tab not found');
        }
        if (!tab.busy) return;

        for (const permission of tab.permissions.values()) {
            if (permission.status !== 'pending' || !permission.resolve) {
                continue;
            }
            permission.status = 'cancelled';
            permission.resolve({
                outcome: {
                    outcome: 'cancelled'
                }
            });
        }
        await this.connection.cancel({
            sessionId: tab.acpSessionId
        });
    }

    async resolvePermission(tabId, permissionId, optionId) {
        const tab = this.tabs.get(tabId);
        if (!tab) {
            throw new Error('Agent tab not found');
        }
        const permission = tab.permissions.get(permissionId);
        if (!permission) {
            throw new Error('Permission request not found');
        }
        permission.status = optionId ? 'selected' : 'cancelled';
        permission.selectedOptionId = optionId || '';
        if (permission.resolve) {
            permission.resolve({
                outcome: optionId
                    ? { outcome: 'selected', optionId }
                    : { outcome: 'cancelled' }
            });
        }
        permission.resolve = null;
        this.#broadcast(tab, {
            type: 'permission_resolved',
            permissionId,
            status: permission.status,
            selectedOptionId: permission.selectedOptionId
        });
    }

    async setMode(tabId, modeId) {
        const tab = this.tabs.get(tabId);
        if (!tab) {
            throw new Error('Agent tab not found');
        }
        if (!modeId || typeof modeId !== 'string') {
            throw new Error('Mode ID is required');
        }
        if (typeof this.connection.setSessionMode !== 'function') {
            throw new Error('Agent does not support mode switching');
        }

        const response = await this.connection.setSessionMode({
            sessionId: tab.acpSessionId,
            modeId
        });
        tab.currentModeId = response?.currentModeId
            || response?.modeId
            || modeId;
        if (Array.isArray(response?.availableModes)) {
            tab.availableModes = response.availableModes;
        }
        this.#broadcast(tab, {
            type: 'session_update',
            update: {
                sessionUpdate: 'current_mode_update',
                currentModeId: tab.currentModeId
            },
            tab: {
                currentModeId: tab.currentModeId,
                availableModes: tab.availableModes
            }
        });
        return this.serializeTab(tab);
    }

    async closeTab(tabId) {
        const tab = this.tabs.get(tabId);
        if (!tab) return;

        if (tab.busy) {
            try {
                await this.cancel(tabId);
            } catch {
                // Ignore cancellation failures during close.
            }
        }

        if (this.connection.unstable_closeSession) {
            try {
                await this.connection.unstable_closeSession({
                    sessionId: tab.acpSessionId
                });
            } catch {
                // Ignore unsupported or failing close-session behavior.
            }
        }

        for (const permission of tab.permissions.values()) {
            if (permission.resolve) {
                permission.resolve({
                    outcome: {
                        outcome: 'cancelled'
                    }
                });
                permission.resolve = null;
            }
        }

        this.tabs.delete(tabId);
        this.sessionToTabId.delete(tab.acpSessionId);
    }

    async dispose() {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
        for (const terminal of this.terminals.values()) {
            await terminal.release().catch(() => {});
        }
        this.terminals.clear();
        for (const tabId of Array.from(this.tabs.keys())) {
            await this.closeTab(tabId);
        }
        if (this.process && !this.process.killed) {
            this.process.kill('SIGTERM');
        }
        await this.connection?.closed.catch(() => {});
    }

    async #handleSessionUpdate(params) {
        const tab = this.#getTabBySession(params.sessionId);
        if (!tab) return;
        const update = params.update;

        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
                this.#appendContentChunk(tab, update, 'assistant', 'message');
                break;
            case 'agent_thought_chunk':
                this.#appendContentChunk(tab, update, 'assistant', 'thought');
                break;
            case 'user_message_chunk':
                this.#appendContentChunk(tab, update, 'user', 'message');
                break;
            case 'tool_call':
                tab.toolCalls.set(update.toolCallId, {
                    ...update,
                    order: this.#nextTimelineOrder(tab)
                });
                break;
            case 'tool_call_update': {
                const previous = tab.toolCalls.get(update.toolCallId) || {
                    toolCallId: update.toolCallId,
                    title: '',
                    status: 'pending',
                    order: this.#nextTimelineOrder(tab)
                };
                tab.toolCalls.set(update.toolCallId, {
                    ...previous,
                    ...update
                });
                break;
            }
            case 'current_mode_update':
                tab.currentModeId = update.currentModeId || update.modeId || '';
                break;
            case 'available_commands_update':
                tab.availableCommands = Array.isArray(update.availableCommands)
                    ? update.availableCommands
                    : [];
                break;
            default:
                break;
        }

        this.#broadcast(tab, {
            type: 'session_update',
            update,
            tab: {
                currentModeId: tab.currentModeId,
                availableModes: tab.availableModes,
                availableCommands: tab.availableCommands
            }
        });
    }

    #appendContentChunk(tab, update, role, kind) {
        const content = update.content;
        const text = content.type === 'text'
            ? (content.text || '')
            : `[${content.type}]`;
        if (role === 'user' && kind === 'message' && this.#consumeUserEcho(tab, text)) {
            return;
        }
        const streamKey = this.#getStreamKey(tab, update, role, kind);
        const last = tab.messages[tab.messages.length - 1] || null;

        if (
            last
            && last.streamKey === streamKey
            && last.role === role
            && last.kind === kind
        ) {
            const nextText = mergeAgentMessageText(last.text, text);
            const appendedText = nextText.slice(last.text.length);
            last.text = nextText;
            this.#broadcast(tab, {
                type: 'message_chunk',
                streamKey,
                role,
                kind,
                text: appendedText
            });
            return;
        }

        if (!update.messageId) {
            tab.messageCounter += 1;
        }
        const message = {
            id: crypto.randomUUID(),
            streamKey,
            role,
            kind,
            text,
            order: this.#nextTimelineOrder(tab)
        };
        tab.messages.push(message);
        this.#broadcast(tab, {
            type: 'message_open',
            message
        });
    }

    #consumeUserEcho(tab, text) {
        const pending = tab.pendingUserEcho;
        if (!pending || !text) {
            return false;
        }

        const remaining = pending.text.slice(pending.matched);
        if (!remaining.startsWith(text)) {
            tab.pendingUserEcho = null;
            return false;
        }

        pending.matched += text.length;
        if (pending.matched >= pending.text.length) {
            tab.pendingUserEcho = null;
        }
        return true;
    }

    #appendMessage(tab, message) {
        const entry = {
            id: crypto.randomUUID(),
            role: message.role,
            kind: message.kind,
            text: message.text,
            streamKey: message.streamKey || crypto.randomUUID(),
            order: this.#nextTimelineOrder(tab)
        };
        tab.messages.push(entry);
        this.#broadcast(tab, {
            type: 'message_open',
            message: entry
        });
    }

    async #requestPermission(params) {
        const tab = this.#getTabBySession(params.sessionId);
        if (!tab) {
            return {
                outcome: {
                    outcome: 'cancelled'
                }
            };
        }

        const permissionId = crypto.randomUUID();
        const request = {
            id: permissionId,
            sessionId: params.sessionId,
            toolCall: params.toolCall,
            options: params.options,
            status: 'pending',
            order: this.#nextTimelineOrder(tab),
            selectedOptionId: '',
            resolve: null
        };
        tab.permissions.set(permissionId, request);

        this.#broadcast(tab, {
            type: 'permission_request',
            permission: {
                id: request.id,
                sessionId: request.sessionId,
                toolCall: request.toolCall,
                options: request.options,
                status: request.status,
                order: request.order,
                selectedOptionId: request.selectedOptionId
            }
        });

        return new Promise((resolve) => {
            request.resolve = resolve;
        });
    }

    async #readTextFile(params) {
        const content = await fs.readFile(params.path, 'utf8');
        return { content };
    }

    async #writeTextFile(params) {
        await fs.writeFile(params.path, params.content, 'utf8');
        return {};
    }

    async #createTerminal(params) {
        const terminal = new LocalExecTerminal(params);
        this.terminals.set(terminal.id, terminal);
        return { terminalId: terminal.id };
    }

    #getTabBySession(sessionId) {
        const tabId = this.sessionToTabId.get(sessionId);
        return tabId ? this.tabs.get(tabId) || null : null;
    }

    #broadcast(tab, payload) {
        const message = JSON.stringify(payload);
        for (const socket of tab.clients) {
            if (socket.readyState === 1) {
                socket.send(message);
            }
        }
    }

    #getStreamKey(tab, update, role, kind) {
        if (update.messageId) {
            return update.messageId;
        }

        const bucketKey = `${update.sessionUpdate}:${role}:${kind}`;
        let streamKey = tab.syntheticStreams.get(bucketKey) || '';
        if (!streamKey) {
            streamKey = [
                'synthetic',
                tab.syntheticStreamTurn,
                update.sessionUpdate,
                role,
                kind
            ].join(':');
            tab.syntheticStreams.set(bucketKey, streamKey);
        }
        return streamKey;
    }

    #nextTimelineOrder(tab) {
        tab.timelineCounter += 1;
        return tab.timelineCounter;
    }
}

export class AcpManager {
    constructor(options = {}) {
        this.idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;
        this.runtimeFactory = options.runtimeFactory || (
            (definition, runtimeOptions) =>
                new AcpRuntime(definition, runtimeOptions)
        );
        this.definitions = makeBuiltInDefinitions();
        this.runtimes = new Map();
        this.tabs = new Map();
        this.loadTabs = options.loadTabs || persistence.loadAgentTabs;
        this.saveTabs = options.saveTabs || persistence.saveAgentTabs;
        this.persistenceChain = Promise.resolve();
        this.disposing = false;
        this.restoring = false;
    }

    queuePersistence(operation) {
        this.persistenceChain = this.persistenceChain
            .catch(() => {})
            .then(operation);
        return this.persistenceChain;
    }

    getPersistedTabs() {
        return Array.from(this.tabs.values()).map((entry) => {
            const tab = entry.serialize();
            return {
                id: tab.id,
                agentId: tab.agentId,
                cwd: tab.cwd,
                acpSessionId: tab.acpSessionId,
                terminalSessionId: tab.terminalSessionId,
                createdAt: tab.createdAt
            };
        });
    }

    persistTabs() {
        return this.queuePersistence(() => this.saveTabs(this.getPersistedTabs()));
    }

    async listDefinitions() {
        return this.definitions.map((definition) => {
            const availability = getDefinitionAvailability(definition);
            return {
            id: definition.id,
            label: definition.label,
            description: definition.description,
            commandLabel: definition.commandLabel,
            available: availability.available,
            reason: availability.reason
        };
        });
    }

    async listState() {
        return {
            restoring: this.restoring,
            definitions: await this.listDefinitions(),
            tabs: Array.from(this.tabs.values()).map((entry) => entry.serialize())
        };
    }

    async createTab(options) {
        const definition = this.definitions.find(
            (entry) => entry.id === options.agentId
        );
        if (!definition) {
            throw new Error('Unknown agent');
        }

        const cwd = path.resolve(options.cwd || process.cwd());
        const runtimeKey = makeRuntimeKey(definition.id, cwd);
        let runtimeEntry = this.runtimes.get(runtimeKey);
        let createdRuntime = false;
        if (!runtimeEntry) {
            const runtime = this.runtimeFactory(definition, {
                cwd,
                idleTimeoutMs: this.idleTimeoutMs
            });
            runtimeEntry = {
                runtime,
                definition,
                runtimeKey
            };
            this.runtimes.set(runtimeKey, runtimeEntry);
            createdRuntime = true;
            runtime.on('runtime_exit', () => {
                if (this.disposing) return;
                for (const [tabId, tabEntry] of this.tabs.entries()) {
                    if (tabEntry.runtime !== runtime) continue;
                    this.tabs.delete(tabId);
                }
                this.runtimes.delete(runtimeKey);
                void this.persistTabs();
            });
        }

        const tabId = crypto.randomUUID();
        try {
            const serialized = await runtimeEntry.runtime.createTab({
                id: tabId,
                cwd,
                terminalSessionId: options.terminalSessionId || '',
                modeId: options.modeId || ''
            });
            const tabEntry = {
                runtime: runtimeEntry.runtime,
                serialize: () => {
                    const tab = runtimeEntry.runtime.tabs.get(tabId);
                    return tab
                        ? runtimeEntry.runtime.serializeTab(tab)
                        : serialized;
                }
            };
            this.tabs.set(tabId, tabEntry);
            await this.persistTabs();
            return tabEntry.serialize();
        } catch (error) {
            const shouldDisposeRuntime = createdRuntime
                || runtimeEntry.runtime.tabs.size === 0;
            if (shouldDisposeRuntime) {
                this.runtimes.delete(runtimeKey);
                await runtimeEntry.runtime.dispose().catch(() => {});
            }
            throw new Error(formatAgentStartupError(definition, error));
        }
    }

    async restoreTabs(validTerminalSessionIds = new Set()) {
        const entries = await this.loadTabs();
        let changed = false;

        for (const meta of entries) {
            if (
                meta.terminalSessionId
                && !validTerminalSessionIds.has(meta.terminalSessionId)
            ) {
                changed = true;
                continue;
            }

            const definition = this.definitions.find(
                (entry) => entry.id === meta.agentId
            );
            if (!definition) {
                changed = true;
                continue;
            }

            const availability = getDefinitionAvailability(definition);
            if (!availability.available) {
                changed = true;
                continue;
            }

            const cwd = path.resolve(meta.cwd || process.cwd());
            const runtimeKey = makeRuntimeKey(definition.id, cwd);
            let runtimeEntry = this.runtimes.get(runtimeKey);
            if (!runtimeEntry) {
                const runtime = this.runtimeFactory(definition, {
                    cwd,
                    idleTimeoutMs: this.idleTimeoutMs
                });
                runtimeEntry = {
                    runtime,
                    definition,
                    runtimeKey
                };
                this.runtimes.set(runtimeKey, runtimeEntry);
                runtime.on('runtime_exit', () => {
                    if (this.disposing) return;
                    for (const [tabId, tabEntry] of this.tabs.entries()) {
                        if (tabEntry.runtime !== runtime) continue;
                        this.tabs.delete(tabId);
                    }
                    this.runtimes.delete(runtimeKey);
                    void this.persistTabs();
                });
            }

            try {
                const serialized = await runtimeEntry.runtime.restoreTab({
                    ...meta,
                    cwd
                });
                this.tabs.set(meta.id, {
                    runtime: runtimeEntry.runtime,
                    serialize: () => {
                        const tab = runtimeEntry.runtime.tabs.get(meta.id);
                        return tab
                            ? runtimeEntry.runtime.serializeTab(tab)
                            : serialized;
                    }
                });
            } catch (error) {
                changed = true;
                console.warn(
                    `[ACP] Failed to restore agent tab ${meta.id}:`,
                    error?.message || error
                );
            }
        }

        if (changed) {
            await this.persistTabs();
        }
    }

    attachSocket(tabId, socket) {
        const tabEntry = this.tabs.get(tabId);
        if (!tabEntry) {
            socket.close();
            return false;
        }
        return tabEntry.runtime.attachSocket(tabId, socket);
    }

    async sendPrompt(tabId, text) {
        const tabEntry = this.tabs.get(tabId);
        if (!tabEntry) {
            throw new Error('Agent tab not found');
        }
        await tabEntry.runtime.sendPrompt(tabId, text);
    }

    async cancel(tabId) {
        const tabEntry = this.tabs.get(tabId);
        if (!tabEntry) {
            throw new Error('Agent tab not found');
        }
        await tabEntry.runtime.cancel(tabId);
    }

    async setMode(tabId, modeId) {
        const tabEntry = this.tabs.get(tabId);
        if (!tabEntry) {
            throw new Error('Agent tab not found');
        }
        return await tabEntry.runtime.setMode(tabId, modeId);
    }

    async resolvePermission(tabId, permissionId, optionId) {
        const tabEntry = this.tabs.get(tabId);
        if (!tabEntry) {
            throw new Error('Agent tab not found');
        }
        await tabEntry.runtime.resolvePermission(tabId, permissionId, optionId);
    }

    async closeTab(tabId) {
        const tabEntry = this.tabs.get(tabId);
        if (!tabEntry) return;
        await tabEntry.runtime.closeTab(tabId);
        this.tabs.delete(tabId);
        await this.persistTabs();
        tabEntry.runtime.scheduleIdleShutdown(async () => {
            if (
                Array.from(this.tabs.values()).some(
                    (entry) => entry.runtime === tabEntry.runtime
                )
            ) {
                return;
            }
            await tabEntry.runtime.dispose();
            this.runtimes.delete(tabEntry.runtime.runtimeKey);
        });
    }

    async closeTabsForTerminalSession(terminalSessionId) {
        const ids = [];
        for (const [tabId, entry] of this.tabs.entries()) {
            const tab = entry.runtime.tabs.get(tabId);
            if (!tab) continue;
            if (tab.terminalSessionId === terminalSessionId) {
                ids.push(tabId);
            }
        }
        for (const id of ids) {
            await this.closeTab(id);
        }
    }

    async dispose({ preserveTabs = true } = {}) {
        this.disposing = true;
        if (preserveTabs) {
            await this.persistTabs();
        } else {
            await this.saveTabs([]);
        }
        for (const runtimeEntry of this.runtimes.values()) {
            await runtimeEntry.runtime.dispose();
        }
        this.runtimes.clear();
        this.tabs.clear();
    }
}
