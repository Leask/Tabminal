import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as acp from '@agentclientprotocol/sdk';
import pkg from '../package.json' with { type: 'json' };
import * as persistence from './persistence.mjs';

const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_TERMINAL_OUTPUT_LIMIT = 256 * 1024;
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml',
    'ini', 'env', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'csv',
    'tsv', 'log', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb',
    'go', 'rs', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp',
    'sh', 'bash', 'zsh', 'fish', 'sql', 'graphql', 'gql', 'diff', 'patch'
]);
const NPX_COMMAND = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEST_AGENT_PATH = path.join(CURRENT_DIR, 'acp-test-agent.mjs');
const AGENT_CONFIG_ENV_KEYS = {
    gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    claude: [
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_USE_VERTEX',
        'ANTHROPIC_VERTEX_PROJECT_ID',
        'GCLOUD_PROJECT',
        'GOOGLE_CLOUD_PROJECT',
        'CLOUD_ML_REGION',
        'GOOGLE_APPLICATION_CREDENTIALS'
    ],
    copilot: [
        'COPILOT_GITHUB_TOKEN',
        'GH_TOKEN',
        'GITHUB_TOKEN'
    ]
};

function getAllowedAgentEnvKeys(agentId) {
    return AGENT_CONFIG_ENV_KEYS[agentId] || [];
}

function normalizeConfiguredEnv(agentId, env) {
    const allowedKeys = new Set(getAllowedAgentEnvKeys(agentId));
    if (!allowedKeys.size || !env || typeof env !== 'object') {
        return {};
    }
    const normalized = {};
    for (const [key, value] of Object.entries(env)) {
        if (!allowedKeys.has(key)) continue;
        normalized[key] = typeof value === 'string' ? value : '';
    }
    return normalized;
}

function hasConfiguredValue(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function buildAgentConfigSummary(agentId, config = {}) {
    const env = normalizeConfiguredEnv(agentId, config.env);
    switch (agentId) {
        case 'gemini':
            return {
                hasGeminiApiKey: hasConfiguredValue(env.GEMINI_API_KEY),
                hasGoogleApiKey: hasConfiguredValue(env.GOOGLE_API_KEY)
            };
        case 'claude':
            return {
                hasAnthropicApiKey: hasConfiguredValue(env.ANTHROPIC_API_KEY),
                useVertex: env.CLAUDE_CODE_USE_VERTEX === '1',
                hasVertexProjectId: hasConfiguredValue(
                    env.ANTHROPIC_VERTEX_PROJECT_ID
                ),
                vertexProjectId:
                    env.ANTHROPIC_VERTEX_PROJECT_ID || '',
                gcloudProject:
                    env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || '',
                cloudMlRegion: env.CLOUD_ML_REGION || '',
                hasGoogleCredentials: hasConfiguredValue(
                    env.GOOGLE_APPLICATION_CREDENTIALS
                )
            };
        case 'copilot':
            return {
                hasCopilotToken: hasConfiguredValue(
                    env.COPILOT_GITHUB_TOKEN
                        || env.GH_TOKEN
                        || env.GITHUB_TOKEN
                )
            };
        default:
            return {};
    }
}

let ghCopilotCliInstalledCache = null;
let ghAuthTokenCache = null;

function hasGhCopilotCliInstalled() {
    if (typeof ghCopilotCliInstalledCache === 'boolean') {
        return ghCopilotCliInstalledCache;
    }
    if (!commandExists('gh')) {
        ghCopilotCliInstalledCache = false;
        return ghCopilotCliInstalledCache;
    }
    const result = spawnSync('gh', ['copilot', '--', '--version'], {
        encoding: 'utf8'
    });
    ghCopilotCliInstalledCache = result.status === 0;
    return ghCopilotCliInstalledCache;
}

function readGhAuthToken() {
    if (typeof ghAuthTokenCache === 'string') {
        return ghAuthTokenCache;
    }
    if (!commandExists('gh')) {
        ghAuthTokenCache = '';
        return ghAuthTokenCache;
    }
    const result = spawnSync('gh', ['auth', 'token'], {
        encoding: 'utf8'
    });
    ghAuthTokenCache = result.status === 0
        ? String(result.stdout || '').trim()
        : '';
    return ghAuthTokenCache;
}

function mergeDefinitionEnv(definition, agentConfig = {}) {
    const env = {
        ...process.env,
        ...normalizeConfiguredEnv(definition.id, agentConfig.env)
    };
    if (definition.id === 'copilot') {
        const hasToken = Boolean(
            env.COPILOT_GITHUB_TOKEN
            || env.GH_TOKEN
            || env.GITHUB_TOKEN
        );
        if (!hasToken) {
            const ghToken = readGhAuthToken();
            if (ghToken) {
                env.GH_TOKEN = ghToken;
            }
        }
    }
    return env;
}

function hasGhCopilotWrapper() {
    if (!commandExists('gh')) return false;
    const result = spawnSync('gh', ['extension', 'list'], {
        encoding: 'utf8'
    });
    return result.status === 0
        && typeof result.stdout === 'string'
        && result.stdout.includes('gh-copilot');
}

function commandExists(command) {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(checker, [command], {
        stdio: 'ignore'
    });
    return result.status === 0;
}

function getAttachmentExtension(name = '') {
    const extension = path.extname(String(name || '')).toLowerCase();
    return extension.startsWith('.') ? extension.slice(1) : extension;
}

function normalizeAttachmentMimeType(mimeType = '') {
    const value = String(mimeType || '').trim();
    return value || 'application/octet-stream';
}

function getAttachmentKind(attachment = {}) {
    const mimeType = normalizeAttachmentMimeType(attachment.mimeType);
    if (mimeType.startsWith('image/')) {
        return 'image';
    }
    if (
        mimeType.startsWith('text/')
        || mimeType.includes('json')
        || mimeType.includes('xml')
        || mimeType.includes('yaml')
        || mimeType.includes('javascript')
        || mimeType.includes('typescript')
    ) {
        return 'text';
    }
    const extension = getAttachmentExtension(attachment.name);
    if (TEXT_ATTACHMENT_EXTENSIONS.has(extension)) {
        return 'text';
    }
    return 'binary';
}

function normalizePromptAttachment(attachment = {}) {
    const name = String(attachment.name || 'attachment').trim() || 'attachment';
    const mimeType = normalizeAttachmentMimeType(attachment.mimeType);
    const size = Number.isFinite(attachment.size) ? attachment.size : 0;
    const tempPath = String(attachment.tempPath || '').trim();
    return {
        id: String(attachment.id || crypto.randomUUID()),
        name,
        mimeType,
        size,
        tempPath,
        kind: getAttachmentKind({ name, mimeType })
    };
}

function serializePromptAttachment(attachment = {}) {
    const normalized = normalizePromptAttachment(attachment);
    return {
        id: normalized.id,
        name: normalized.name,
        mimeType: normalized.mimeType,
        size: normalized.size,
        kind: normalized.kind
    };
}

function makeBuiltInDefinitions() {
    const hasGeminiBinary = commandExists('gemini');
    const hasCopilotBinary = commandExists('copilot');
    const hasGhCopilot = hasGhCopilotWrapper();
    const definitions = [
        {
            id: 'gemini',
            label: 'Gemini CLI',
            description: 'Google Gemini CLI over ACP',
            websiteUrl: 'https://github.com/google-gemini/gemini-cli',
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
            websiteUrl: 'https://openai.com/codex/',
            command: NPX_COMMAND,
            args: ['@zed-industries/codex-acp@latest'],
            commandLabel: 'npx @zed-industries/codex-acp@latest'
        },
        {
            id: 'claude',
            label: 'Claude Agent',
            description: 'Claude Code ACP adapter',
            websiteUrl: 'https://www.anthropic.com/claude-code',
            command: NPX_COMMAND,
            args: ['@zed-industries/claude-code-acp@latest'],
            commandLabel: 'npx @zed-industries/claude-code-acp@latest'
        },
        {
            id: 'copilot',
            label: 'GitHub Copilot',
            description: 'GitHub Copilot CLI ACP server',
            websiteUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli',
            command: hasCopilotBinary ? 'copilot' : 'gh',
            args: hasCopilotBinary
                ? ['--acp', '--stdio']
                : ['copilot', '--', '--acp', '--stdio'],
            commandLabel: hasCopilotBinary
                ? 'copilot --acp --stdio'
                : 'gh copilot -- --acp --stdio',
            setupCommandLabel: hasGhCopilot
                ? 'gh copilot'
                : 'Install GitHub Copilot CLI'
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

function getDefinitionAvailability(definition, agentConfig = {}) {
    if (!commandExists(definition.command)) {
        return {
            available: false,
            reason: 'not installed'
        };
    }

    const runtimeEnv = mergeDefinitionEnv(definition, agentConfig);

    if (definition.id === 'gemini') {
        const hasApiKey = Boolean(
            runtimeEnv.GEMINI_API_KEY || runtimeEnv.GOOGLE_API_KEY
        );
        if (!hasApiKey) {
            return {
                available: false,
                reason: 'API key missing'
            };
        }
    }

    if (
        definition.id === 'copilot'
        && definition.command === 'gh'
    ) {
        if (!hasGhCopilotWrapper()) {
            return {
                available: false,
                reason: 'Install the gh-copilot extension first'
            };
        }
        if (!hasGhCopilotCliInstalled()) {
            return {
                available: false,
                reason: 'Run gh copilot once to install Copilot CLI'
            };
        }
        return {
            available: true,
            reason: ''
        };
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
    if (
        definition?.id === 'claude'
        && /auth|login|credential|api key|unauthorized/i.test(rawMessage)
    ) {
        return 'Claude is not authenticated on this host. Use an existing '
            + 'Claude login, set ANTHROPIC_API_KEY, or configure Vertex '
            + 'with CLAUDE_CODE_USE_VERTEX=1, ANTHROPIC_VERTEX_PROJECT_ID, '
            + 'CLOUD_ML_REGION, and Google Cloud credentials before '
            + 'starting Tabminal.';
    }
    if (definition?.id === 'copilot' && /not installed/i.test(rawMessage)) {
        return 'GitHub Copilot CLI is not installed on this host yet. Run '
            + '`gh copilot` once to download it, or install a standalone '
            + '`copilot` binary and restart Tabminal.';
    }
    if (
        definition?.id === 'copilot'
        && /auth|login|token|unauthorized|forbidden/i.test(rawMessage)
    ) {
        return 'GitHub Copilot is not authenticated on this host. If this '
            + 'backend can already see a `copilot login` or `gh auth` token '
            + 'it may reuse them, but `COPILOT_GITHUB_TOKEN` is the reliable '
            + 'headless fix in Tabminal setup.';
    }
    return rawMessage;
}

function makeRuntimeKey(agentId, cwd) {
    return `${agentId}::${path.resolve(cwd)}`;
}

function makeRuntimeStoreKey(agentId, cwd, configVersion = 0) {
    return `${makeRuntimeKey(agentId, cwd)}::cfg:${configVersion}`;
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

export function buildTerminalSpawnRequest(request = {}) {
    const command = String(request.command || '').trim();
    const args = Array.isArray(request.args)
        ? request.args.filter((value) => typeof value === 'string')
        : [];
    if (!command) {
        throw new Error('Terminal command is required');
    }
    if (args.length > 0) {
        return {
            command,
            args,
            shell: false
        };
    }

    const requiresShell = /[\s|&;<>()$`*?[\]{}~]/.test(command);
    if (!requiresShell) {
        return {
            command,
            args: [],
            shell: false
        };
    }

    const shell = process.platform === 'win32'
        ? process.env.ComSpec || 'cmd.exe'
        : process.env.SHELL || '/bin/sh';
    const shellArgs = process.platform === 'win32'
        ? ['/d', '/s', '/c', command]
        : ['-lc', command];

    return {
        command: shell,
        args: shellArgs,
        shell: true
    };
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

function formatTerminalDisplayCommand(request = {}, spawnRequest = {}) {
    const explicitArgs = Array.isArray(request.args)
        ? request.args.filter((value) => typeof value === 'string')
        : [];
    if (explicitArgs.length > 0) {
        return [request.command, ...explicitArgs].join(' ').trim();
    }
    if (typeof request.command === 'string' && request.command.trim()) {
        return request.command.trim();
    }
    return [spawnRequest.command, ...(spawnRequest.args || [])]
        .filter(Boolean)
        .join(' ')
        .trim();
}

function normalizePlanEntries(entries = []) {
    if (!Array.isArray(entries)) return [];
    return entries
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => ({
            content: typeof entry.content === 'string' ? entry.content : '',
            priority: typeof entry.priority === 'string'
                ? entry.priority
                : 'medium',
            status: typeof entry.status === 'string'
                ? entry.status
                : 'pending'
        }))
        .filter((entry) => entry.content);
}

function extractUsageResetHints(meta = {}) {
    if (!meta || typeof meta !== 'object') {
        return { resetAt: '', windows: [] };
    }
    const windows = Array.isArray(meta.windows)
        ? meta.windows
            .filter((item) => item && typeof item === 'object')
            .map((item) => ({
                label: typeof item.label === 'string' ? item.label : '',
                used: Number.isFinite(item.used) ? item.used : null,
                size: Number.isFinite(item.size) ? item.size : null,
                resetAt: typeof item.resetAt === 'string' ? item.resetAt : ''
            }))
            .filter((item) => item.label || item.resetAt)
        : [];
    const resetCandidates = [
        meta.resetAt,
        meta.resetsAt,
        meta.nextResetAt,
        meta.resetTime,
        meta.resetDate
    ];
    const resetAt = resetCandidates.find(
        (value) => typeof value === 'string' && value.trim()
    ) || '';
    return { resetAt, windows };
}

function mergeUsageState(previous = {}, update = {}) {
    const meta = extractUsageResetHints(update?._meta);
    const next = {
        used: Number.isFinite(update?.used)
            ? update.used
            : Number.isFinite(previous?.used)
                ? previous.used
                : null,
        size: Number.isFinite(update?.size)
            ? update.size
            : Number.isFinite(previous?.size)
                ? previous.size
                : null,
        cost: update?.cost || previous?.cost || null,
        totals: update?.totals || previous?.totals || null,
        updatedAt: new Date().toISOString(),
        resetAt: meta.resetAt || previous?.resetAt || '',
        windows: meta.windows.length > 0 ? meta.windows : previous?.windows || []
    };
    return next;
}

function serializeUsageState(usage) {
    if (!usage) return null;
    return {
        used: Number.isFinite(usage.used) ? usage.used : null,
        size: Number.isFinite(usage.size) ? usage.size : null,
        cost: usage.cost || null,
        totals: usage.totals || null,
        updatedAt: typeof usage.updatedAt === 'string' ? usage.updatedAt : '',
        resetAt: typeof usage.resetAt === 'string' ? usage.resetAt : '',
        windows: Array.isArray(usage.windows) ? usage.windows : []
    };
}

class LocalExecTerminal extends EventEmitter {
    constructor(request) {
        super();
        this.id = crypto.randomUUID();
        this.sessionId = String(request.sessionId || '');
        this.cwd = request.cwd || process.cwd();
        this.output = '';
        this.outputByteLimit = Math.max(
            1024,
            request.outputByteLimit || DEFAULT_TERMINAL_OUTPUT_LIMIT
        );
        this.exitStatus = null;
        this.closed = false;
        this.waiters = [];
        this.createdAt = new Date().toISOString();
        this.updatedAt = this.createdAt;

        const env = {
            ...process.env,
            ...normalizeEnvList(request.env)
        };

        const spawnRequest = buildTerminalSpawnRequest(request);
        this.command = formatTerminalDisplayCommand(request, spawnRequest);

        this.child = spawn(spawnRequest.command, spawnRequest.args, {
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
            this.updatedAt = new Date().toISOString();
            this.emit('update', this.currentSummary());
        };

        this.child.stdout?.on('data', append);
        this.child.stderr?.on('data', append);
        this.child.on('error', (error) => {
            if (this.closed) return;
            append(error?.message || 'Terminal command failed.');
            this.closed = true;
            this.exitStatus = {
                exitCode: null,
                signal: null
            };
            this.updatedAt = new Date().toISOString();
            this.emit('update', this.currentSummary());
            for (const waiter of this.waiters) {
                waiter(this.exitStatus);
            }
            this.waiters.length = 0;
        });
        this.child.on('exit', (code, signal) => {
            this.closed = true;
            this.exitStatus = {
                exitCode: typeof code === 'number' ? code : null,
                signal: signal || null
            };
            this.updatedAt = new Date().toISOString();
            this.emit('update', this.currentSummary());
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

    currentSummary() {
        return {
            terminalId: this.id,
            sessionId: this.sessionId,
            command: this.command,
            cwd: this.cwd,
            output: this.output,
            exitStatus: this.exitStatus,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            running: !this.exitStatus
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
        this.runtimeStoreKey = options.runtimeStoreKey || this.runtimeKey;
        this.env = options.env || process.env;
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
        this.cachedAvailableModes = [];
        this.cachedAvailableCommands = [];
        this.cachedConfigOptions = [];
        this.cachedModelState = null;
    }

    #resolveAvailableModes(availableModes, existingModes = []) {
        if (Array.isArray(availableModes) && availableModes.length > 0) {
            this.cachedAvailableModes = availableModes;
            return availableModes;
        }
        if (Array.isArray(existingModes) && existingModes.length > 0) {
            return existingModes;
        }
        return this.cachedAvailableModes;
    }

    #resolveAvailableCommands(availableCommands, existingCommands = []) {
        if (
            Array.isArray(availableCommands)
            && availableCommands.length > 0
        ) {
            this.cachedAvailableCommands = availableCommands;
            return availableCommands;
        }
        if (
            Array.isArray(existingCommands)
            && existingCommands.length > 0
        ) {
            return existingCommands;
        }
        return this.cachedAvailableCommands;
    }

    #buildSyntheticModelConfigOption(modelState) {
        const availableModels = Array.isArray(modelState?.availableModels)
            ? modelState.availableModels
            : [];
        const currentModelId = typeof modelState?.currentModelId === 'string'
            ? modelState.currentModelId
            : '';
        if (!currentModelId || availableModels.length === 0) {
            return null;
        }
        return {
            id: '__tabminal_model__',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: currentModelId,
            options: availableModels.map((model) => ({
                value: model?.modelId || model?.id || '',
                name: model?.name || model?.modelId || model?.id || '',
                description: model?.description || ''
            })).filter((option) => option.value && option.name)
        };
    }

    #resolveConfigOptions(
        configOptions,
        existingConfigOptions = [],
        modelState = null
    ) {
        let nextOptions = Array.isArray(configOptions) && configOptions.length > 0
            ? configOptions
            : Array.isArray(existingConfigOptions)
                && existingConfigOptions.length > 0
                ? existingConfigOptions
                : this.cachedConfigOptions;

        if (modelState?.currentModelId && Array.isArray(modelState.availableModels)) {
            this.cachedModelState = modelState;
        }
        const syntheticModel = this.#buildSyntheticModelConfigOption(
            modelState || this.cachedModelState
        );
        if (syntheticModel) {
            const hasModelOption = Array.isArray(nextOptions) && nextOptions.some(
                (option) => option?.category === 'model'
            );
            if (!hasModelOption) {
                nextOptions = [
                    ...nextOptions.filter(
                        (option) => option?.id !== syntheticModel.id
                    ),
                    syntheticModel
                ];
            }
        }
        if (Array.isArray(nextOptions) && nextOptions.length > 0) {
            this.cachedConfigOptions = nextOptions;
        }
        return nextOptions;
    }

    #buildTab({
        id,
        acpSessionId,
        terminalSessionId,
        cwd,
        createdAt,
        title = '',
        currentModeId = '',
        availableModes = [],
        availableCommands = [],
        configOptions = []
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
            title: typeof title === 'string' ? title : '',
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
            configOptions,
            plan: [],
            usage: null,
            terminals: new Map(),
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
            env: this.env,
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
                createTerminal: (params) => this.#createTerminal(params),
                terminalOutput: (params) => this.#terminalOutput(params),
                releaseTerminal: (params) => this.#releaseTerminal(params),
                waitForTerminalExit: (params) =>
                    this.#waitForTerminalExit(params),
                killTerminal: (params) => this.#killTerminal(params)
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
        const availableModes = this.#resolveAvailableModes(
            response.modes?.availableModes
        );
        const availableCommands = this.#resolveAvailableCommands(
            response.availableCommands
        );
        const configOptions = this.#resolveConfigOptions(
            response.configOptions,
            [],
            response.models
        );
        const tab = this.#buildTab({
            id: meta.id,
            acpSessionId: response.sessionId,
            terminalSessionId: meta.terminalSessionId,
            cwd: meta.cwd,
            title: response.title || '',
            currentModeId: response.modes?.currentModeId || '',
            availableModes,
            availableCommands,
            configOptions
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
        await this.#hydrateFreshSessionMetadata(tab);
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
            createdAt: meta.createdAt,
            title: meta.title || ''
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
            if (typeof response?.title === 'string') {
                tab.title = response.title;
            }
            tab.currentModeId = response?.modes?.currentModeId || '';
            tab.availableModes = this.#resolveAvailableModes(
                response?.modes?.availableModes,
                tab.availableModes
            );
            tab.availableCommands = this.#resolveAvailableCommands(
                response?.availableCommands,
                tab.availableCommands
            );
            tab.configOptions = this.#resolveConfigOptions(
                response?.configOptions,
                tab.configOptions,
                response?.models
            );
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
            title: tab.title || '',
            terminalSessionId: tab.terminalSessionId,
            cwd: tab.cwd,
            createdAt: tab.createdAt,
            status: tab.status,
            busy: tab.busy,
            errorMessage: tab.errorMessage,
            currentModeId: tab.currentModeId,
            availableModes: tab.availableModes,
            availableCommands: tab.availableCommands,
            configOptions: tab.configOptions,
            messages: tab.messages,
            toolCalls: Array.from(tab.toolCalls.values()),
            permissions: Array.from(tab.permissions.values()).map((item) => ({
                id: item.id,
                sessionId: item.sessionId,
                toolCall: item.toolCall,
                options: item.options,
                status: item.status,
                createdAt: item.createdAt || '',
                order: item.order,
                selectedOptionId: item.selectedOptionId || ''
            })),
            plan: Array.isArray(tab.plan) ? tab.plan : [],
            usage: serializeUsageState(tab.usage),
            terminals: Array.from(tab.terminals.values())
        };
    }

    #getPromptCapabilities() {
        return this.agentCapabilities?.promptCapabilities || {};
    }

    async #buildAttachmentPromptBlock(attachment) {
        const normalized = normalizePromptAttachment(attachment);
        const fileUri = pathToFileURL(normalized.tempPath).toString();
        const capabilities = this.#getPromptCapabilities();

        if (normalized.kind === 'image' && capabilities.image) {
            const data = await fs.readFile(normalized.tempPath);
            return {
                type: 'image',
                data: data.toString('base64'),
                mimeType: normalized.mimeType,
                uri: fileUri
            };
        }

        if (capabilities.embeddedContext) {
            if (normalized.kind === 'text') {
                const text = await fs.readFile(normalized.tempPath, 'utf8');
                return {
                    type: 'resource',
                    resource: {
                        text,
                        uri: fileUri,
                        mimeType: normalized.mimeType
                    }
                };
            }

            const data = await fs.readFile(normalized.tempPath);
            return {
                type: 'resource',
                resource: {
                    blob: data.toString('base64'),
                    uri: fileUri,
                    mimeType: normalized.mimeType
                }
            };
        }

        return {
            type: 'resource_link',
            name: normalized.name,
            title: normalized.name,
            uri: fileUri,
            mimeType: normalized.mimeType,
            size: normalized.size || null
        };
    }

    async #buildPromptBlocks(text, attachments = []) {
        const blocks = [];
        for (const attachment of attachments) {
            blocks.push(await this.#buildAttachmentPromptBlock(attachment));
        }
        if (text) {
            blocks.push({
                type: 'text',
                text
            });
        }
        return blocks;
    }

    async #cleanupPromptAttachments(attachments = []) {
        const paths = attachments
            .map((attachment) => String(attachment?.tempPath || '').trim())
            .filter(Boolean);
        await Promise.allSettled(paths.map((filePath) =>
            fs.rm(filePath, { force: true })
        ));
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

    async sendPrompt(tabId, text, attachments = []) {
        const tab = this.tabs.get(tabId);
        if (!tab) {
            throw new Error('Agent tab not found');
        }
        if (tab.busy) {
            throw new Error('Agent tab is already running');
        }
        const promptText = typeof text === 'string' ? text : '';
        const promptAttachments = Array.isArray(attachments)
            ? attachments.map((attachment) => normalizePromptAttachment(attachment))
            : [];
        const promptBlocks = await this.#buildPromptBlocks(
            promptText,
            promptAttachments
        );
        tab.errorMessage = '';
        tab.busy = true;
        tab.status = 'running';
        this.#advanceSyntheticStreamTurn(tab);
        this.#appendMessage(tab, {
            role: 'user',
            kind: 'message',
            text: promptText,
            streamKey: crypto.randomUUID(),
            attachments: promptAttachments.map((attachment) =>
                serializePromptAttachment(attachment)
            )
        });
        tab.pendingUserEcho = promptText
            ? {
                text: promptText,
                matched: 0
            }
            : null;
        this.#broadcast(tab, {
            type: 'status',
            status: tab.status,
            busy: tab.busy,
            errorMessage: ''
        });

        const promptPromise = this.connection.prompt({
            sessionId: tab.acpSessionId,
            prompt: promptBlocks
        });

        void promptPromise.then(async (response) => {
            if (!this.tabs.has(tabId)) return;
            tab.busy = false;
            tab.status = 'ready';
            if (response?.usage) {
                tab.usage = mergeUsageState(tab.usage, {
                    totals: response.usage
                });
                this.#broadcast(tab, {
                    type: 'usage_state',
                    usage: serializeUsageState(tab.usage)
                });
            }
            tab.syntheticStreams.clear();
            tab.pendingUserEcho = null;
            const previousCommandsLength = Array.isArray(tab.availableCommands)
                ? tab.availableCommands.length
                : 0;
            await this.#hydrateFreshSessionMetadata(tab);
            if (
                Array.isArray(tab.availableCommands)
                && tab.availableCommands.length > previousCommandsLength
            ) {
                this.#broadcast(tab, {
                    type: 'session_update',
                    update: {
                        sessionUpdate: 'available_commands_update',
                        availableCommands: tab.availableCommands
                    },
                    tab: {
                        title: tab.title,
                        currentModeId: tab.currentModeId,
                        availableModes: tab.availableModes,
                        availableCommands: tab.availableCommands,
                        configOptions: tab.configOptions
                    }
                });
            }
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
        }).finally(() => {
            void this.#cleanupPromptAttachments(promptAttachments);
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
        tab.availableModes = this.#resolveAvailableModes(
            response?.availableModes,
            tab.availableModes
        );
        this.#broadcast(tab, {
            type: 'session_update',
            update: {
                sessionUpdate: 'current_mode_update',
                currentModeId: tab.currentModeId
            },
            tab: {
                title: tab.title,
                currentModeId: tab.currentModeId,
                availableModes: tab.availableModes,
                availableCommands: tab.availableCommands,
                configOptions: tab.configOptions
            }
        });
        return this.serializeTab(tab);
    }

    async setConfigOption(tabId, configId, valueId) {
        const tab = this.tabs.get(tabId);
        if (!tab) {
            throw new Error('Agent tab not found');
        }
        if (!configId || typeof configId !== 'string') {
            throw new Error('Config ID is required');
        }
        if (!valueId || typeof valueId !== 'string') {
            throw new Error('Config value is required');
        }

        if (
            configId === '__tabminal_model__'
            && typeof this.connection.unstable_setSessionModel === 'function'
        ) {
            await this.connection.unstable_setSessionModel({
                sessionId: tab.acpSessionId,
                modelId: valueId
            });
            tab.configOptions = this.#resolveConfigOptions(
                tab.configOptions.map((option) => (
                    option?.id === configId
                        ? { ...option, currentValue: valueId }
                        : option
                )),
                tab.configOptions
            );
        } else {
            if (typeof this.connection.setSessionConfigOption !== 'function') {
                throw new Error(
                    'Agent does not support session configuration changes'
                );
            }
            const response = await this.connection.setSessionConfigOption({
                sessionId: tab.acpSessionId,
                configId,
                value: valueId
            });
            tab.configOptions = this.#resolveConfigOptions(
                response?.configOptions,
                tab.configOptions
            );
        }

        this.#broadcast(tab, {
            type: 'session_update',
            update: {
                sessionUpdate: 'config_option_update',
                configOptions: tab.configOptions
            },
            tab: {
                title: tab.title,
                currentModeId: tab.currentModeId,
                availableModes: tab.availableModes,
                availableCommands: tab.availableCommands,
                configOptions: tab.configOptions
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
        let broadcastUpdate = update;

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
            case 'tool_call': {
                this.#advanceSyntheticStreamTurn(tab);
                const nextToolCall = {
                    ...update,
                    createdAt: new Date().toISOString(),
                    order: this.#nextTimelineOrder(tab)
                };
                tab.toolCalls.set(update.toolCallId, nextToolCall);
                broadcastUpdate = nextToolCall;
                break;
            }
            case 'tool_call_update': {
                this.#advanceSyntheticStreamTurn(tab);
                const previous = tab.toolCalls.get(update.toolCallId) || {
                    toolCallId: update.toolCallId,
                    title: '',
                    status: 'pending',
                    createdAt: new Date().toISOString(),
                    order: this.#nextTimelineOrder(tab)
                };
                const nextToolCall = {
                    ...previous,
                    ...update
                };
                tab.toolCalls.set(update.toolCallId, nextToolCall);
                broadcastUpdate = nextToolCall;
                break;
            }
            case 'current_mode_update':
                tab.currentModeId = update.currentModeId || update.modeId || '';
                break;
            case 'available_commands_update':
                tab.availableCommands = this.#resolveAvailableCommands(
                    update.availableCommands,
                    tab.availableCommands
                );
                break;
            case 'config_option_update':
                tab.configOptions = this.#resolveConfigOptions(
                    update.configOptions,
                    tab.configOptions
                );
                break;
            case 'session_info_update':
                if (typeof update.title === 'string') {
                    tab.title = update.title;
                } else if (update.title === null) {
                    tab.title = '';
                }
                break;
            case 'plan':
                tab.plan = normalizePlanEntries(update.entries);
                break;
            case 'usage_update':
                tab.usage = mergeUsageState(tab.usage, update);
                break;
            default:
                break;
        }

        this.#broadcast(tab, {
            type: 'session_update',
            update: broadcastUpdate,
            tab: {
                title: tab.title,
                currentModeId: tab.currentModeId,
                availableModes: tab.availableModes,
                availableCommands: tab.availableCommands,
                configOptions: tab.configOptions
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
            createdAt: new Date().toISOString(),
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
            createdAt: new Date().toISOString(),
            order: this.#nextTimelineOrder(tab),
            attachments: Array.isArray(message.attachments)
                ? message.attachments.map((attachment) =>
                    serializePromptAttachment(attachment)
                )
                : []
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
        this.#advanceSyntheticStreamTurn(tab);

        const permissionId = crypto.randomUUID();
        const request = {
            id: permissionId,
            sessionId: params.sessionId,
            toolCall: params.toolCall,
            options: params.options,
            status: 'pending',
            createdAt: new Date().toISOString(),
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
                createdAt: request.createdAt,
                order: request.order,
                selectedOptionId: request.selectedOptionId
            }
        });

        return new Promise((resolve) => {
            request.resolve = resolve;
        });
    }

    async #hydrateFreshSessionMetadata(tab) {
        const needsHydration = (
            !Array.isArray(tab.availableCommands)
            || tab.availableCommands.length === 0
            || !Array.isArray(tab.configOptions)
            || tab.configOptions.length === 0
        );
        if (
            !needsHydration
            || !this.agentCapabilities?.loadSession
            || typeof this.connection.loadSession !== 'function'
        ) {
            return;
        }

        try {
            const response = await this.connection.loadSession({
                cwd: tab.cwd,
                sessionId: tab.acpSessionId,
                mcpServers: []
            });
            const restoredSessionId = response?.sessionId || tab.acpSessionId;
            if (restoredSessionId !== tab.acpSessionId) {
                this.sessionToTabId.delete(tab.acpSessionId);
                tab.acpSessionId = restoredSessionId;
                this.sessionToTabId.set(tab.acpSessionId, tab.id);
            }
            if (typeof response?.title === 'string') {
                tab.title = response.title;
            }
            if (response?.modes?.currentModeId) {
                tab.currentModeId = response.modes.currentModeId;
            }
            tab.availableModes = this.#resolveAvailableModes(
                response?.modes?.availableModes,
                tab.availableModes
            );
            tab.availableCommands = this.#resolveAvailableCommands(
                response?.availableCommands,
                tab.availableCommands
            );
            tab.configOptions = this.#resolveConfigOptions(
                response?.configOptions,
                tab.configOptions,
                response?.models
            );
        } catch {
            // Ignore metadata hydration failures for fresh sessions.
        }
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
        const tab = this.#getTabBySession(params.sessionId);
        if (tab) {
            const syncSummary = (summary) => {
                tab.terminals.set(terminal.id, {
                    ...summary,
                    terminalId: terminal.id
                });
                this.#broadcast(tab, {
                    type: 'terminal_update',
                    terminal: tab.terminals.get(terminal.id)
                });
            };
            syncSummary(terminal.currentSummary());
            terminal.on('update', syncSummary);
        }
        return { terminalId: terminal.id };
    }

    async #terminalOutput(params) {
        const terminal = this.terminals.get(params.terminalId);
        if (!terminal) {
            throw new Error('Terminal not found');
        }
        const response = terminal.currentOutput();
        this.#syncTerminalSummary(params.sessionId, terminal);
        return response;
    }

    async #waitForTerminalExit(params) {
        const terminal = this.terminals.get(params.terminalId);
        if (!terminal) {
            throw new Error('Terminal not found');
        }
        const response = await terminal.waitForExit();
        this.#syncTerminalSummary(params.sessionId, terminal);
        return response;
    }

    async #killTerminal(params) {
        const terminal = this.terminals.get(params.terminalId);
        if (!terminal) {
            throw new Error('Terminal not found');
        }
        const response = await terminal.kill();
        this.#syncTerminalSummary(params.sessionId, terminal);
        return response;
    }

    async #releaseTerminal(params) {
        const terminal = this.terminals.get(params.terminalId);
        if (!terminal) {
            return {};
        }
        await terminal.release();
        this.#syncTerminalSummary(params.sessionId, terminal, { released: true });
        this.terminals.delete(params.terminalId);
        return {};
    }

    #syncTerminalSummary(sessionId, terminal, overrides = {}) {
        const tab = this.#getTabBySession(sessionId || terminal.sessionId);
        if (!tab) return;
        tab.terminals.set(terminal.id, {
            ...terminal.currentSummary(),
            ...overrides,
            terminalId: terminal.id
        });
        this.#broadcast(tab, {
            type: 'terminal_update',
            terminal: tab.terminals.get(terminal.id)
        });
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

    #advanceSyntheticStreamTurn(tab) {
        tab.syntheticStreamTurn += 1;
        tab.syntheticStreams.clear();
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
        this.loadConfigs = options.loadConfigs || persistence.loadAgentConfigs;
        this.saveConfigs = options.saveConfigs || persistence.saveAgentConfigs;
        this.persistenceChain = Promise.resolve();
        this.disposing = false;
        this.restoring = false;
        this.agentConfigs = {};
        this.agentConfigVersions = new Map();
        this.configLoaded = false;
    }

    getAgentConfigVersion(agentId) {
        return this.agentConfigVersions.get(agentId) || 0;
    }

    async ensureConfigsLoaded() {
        if (this.configLoaded) {
            return this.agentConfigs;
        }
        this.agentConfigs = await this.loadConfigs();
        this.configLoaded = true;
        return this.agentConfigs;
    }

    getAgentConfig(agentId) {
        return this.agentConfigs?.[agentId] || { env: {} };
    }

    getSerializedAgentConfig(agentId) {
        return buildAgentConfigSummary(
            agentId,
            this.getAgentConfig(agentId)
        );
    }

    async listAgentConfigs() {
        await this.ensureConfigsLoaded();
        const configs = {};
        for (const definition of this.definitions) {
            configs[definition.id] = this.getSerializedAgentConfig(
                definition.id
            );
        }
        return configs;
    }

    async updateAgentConfig(agentId, nextConfig = {}) {
        await this.ensureConfigsLoaded();
        const definition = this.definitions.find((entry) => entry.id === agentId);
        if (!definition) {
            throw new Error('Unknown agent');
        }
        const currentConfig = this.getAgentConfig(agentId);
        const currentEnv = normalizeConfiguredEnv(agentId, currentConfig.env);
        const nextEnv = normalizeConfiguredEnv(agentId, nextConfig.env);
        const clearEnvKeys = Array.isArray(nextConfig.clearEnvKeys)
            ? nextConfig.clearEnvKeys.filter((key) =>
                getAllowedAgentEnvKeys(agentId).includes(key)
            )
            : [];
        const mergedEnv = {
            ...currentEnv,
            ...nextEnv
        };
        for (const key of clearEnvKeys) {
            delete mergedEnv[key];
        }
        this.agentConfigs = {
            ...this.agentConfigs,
            [agentId]: {
                env: mergedEnv
            }
        };
        this.agentConfigVersions.set(
            agentId,
            this.getAgentConfigVersion(agentId) + 1
        );
        await this.queuePersistence(() => this.saveConfigs(this.agentConfigs));
        return this.getSerializedAgentConfig(agentId);
    }

    async clearAgentConfig(agentId) {
        await this.ensureConfigsLoaded();
        const nextConfigs = { ...this.agentConfigs };
        delete nextConfigs[agentId];
        this.agentConfigs = nextConfigs;
        this.agentConfigVersions.set(
            agentId,
            this.getAgentConfigVersion(agentId) + 1
        );
        await this.queuePersistence(() => this.saveConfigs(this.agentConfigs));
        return this.getSerializedAgentConfig(agentId);
    }

    #applyRuntimeMetadataFallback(runtime, serialized) {
        if (!serialized || typeof serialized !== 'object') {
            return serialized;
        }

        let availableModes = Array.isArray(serialized.availableModes)
            ? serialized.availableModes
            : [];
        let availableCommands = Array.isArray(serialized.availableCommands)
            ? serialized.availableCommands
            : [];
        let configOptions = Array.isArray(serialized.configOptions)
            ? serialized.configOptions
            : [];

        if (
            (
                availableModes.length > 0
                && availableCommands.length > 0
                && configOptions.length > 0
            )
            || !(runtime?.tabs instanceof Map)
        ) {
            return serialized;
        }

        for (const runtimeTab of runtime.tabs.values()) {
            if (!runtimeTab || typeof runtimeTab !== 'object') continue;
            if (
                availableModes.length === 0
                && Array.isArray(runtimeTab.availableModes)
                && runtimeTab.availableModes.length > 0
            ) {
                availableModes = runtimeTab.availableModes;
            }
            if (
                availableCommands.length === 0
                && Array.isArray(runtimeTab.availableCommands)
                && runtimeTab.availableCommands.length > 0
            ) {
                availableCommands = runtimeTab.availableCommands;
            }
            if (
                configOptions.length === 0
                && Array.isArray(runtimeTab.configOptions)
                && runtimeTab.configOptions.length > 0
            ) {
                configOptions = runtimeTab.configOptions;
            }
            if (
                availableModes.length > 0
                && availableCommands.length > 0
                && configOptions.length > 0
            ) {
                break;
            }
        }

        if (
            availableModes === serialized.availableModes
            && availableCommands === serialized.availableCommands
            && configOptions === serialized.configOptions
        ) {
            return serialized;
        }

        return {
            ...serialized,
            availableModes,
            availableCommands,
            configOptions
        };
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
        await this.ensureConfigsLoaded();
        return this.definitions.map((definition) => {
            const availability = getDefinitionAvailability(
                definition,
                this.getAgentConfig(definition.id)
            );
            return {
                id: definition.id,
                label: definition.label,
                description: definition.description,
                websiteUrl: definition.websiteUrl || '',
                commandLabel: definition.commandLabel,
                setupCommandLabel: definition.setupCommandLabel || '',
                available: availability.available,
                reason: availability.reason,
                config: this.getSerializedAgentConfig(definition.id)
            };
        });
    }

    async listState() {
        await this.ensureConfigsLoaded();
        return {
            restoring: this.restoring,
            definitions: await this.listDefinitions(),
            configs: await this.listAgentConfigs(),
            tabs: Array.from(this.tabs.values()).map((entry) => entry.serialize())
        };
    }

    async createTab(options) {
        await this.ensureConfigsLoaded();
        const definition = this.definitions.find(
            (entry) => entry.id === options.agentId
        );
        if (!definition) {
            throw new Error('Unknown agent');
        }

        const cwd = path.resolve(options.cwd || process.cwd());
        const runtimeKey = makeRuntimeKey(definition.id, cwd);
        const runtimeStoreKey = makeRuntimeStoreKey(
            definition.id,
            cwd,
            this.getAgentConfigVersion(definition.id)
        );
        let runtimeEntry = this.runtimes.get(runtimeStoreKey);
        let createdRuntime = false;
        if (!runtimeEntry) {
            const runtime = this.runtimeFactory(definition, {
                cwd,
                idleTimeoutMs: this.idleTimeoutMs,
                runtimeStoreKey,
                env: mergeDefinitionEnv(
                    definition,
                    this.getAgentConfig(definition.id)
                )
            });
            runtimeEntry = {
                runtime,
                definition,
                runtimeKey,
                runtimeStoreKey
            };
            this.runtimes.set(runtimeStoreKey, runtimeEntry);
            createdRuntime = true;
            runtime.on('runtime_exit', () => {
                if (this.disposing) return;
                for (const [tabId, tabEntry] of this.tabs.entries()) {
                    if (tabEntry.runtime !== runtime) continue;
                    this.tabs.delete(tabId);
                }
                this.runtimes.delete(runtimeStoreKey);
                void this.persistTabs();
            });
        }

        const tabId = crypto.randomUUID();
        try {
            const rawSerialized = await runtimeEntry.runtime.createTab({
                id: tabId,
                cwd,
                terminalSessionId: options.terminalSessionId || '',
                modeId: options.modeId || ''
            });
            const serialized = this.#applyRuntimeMetadataFallback(
                runtimeEntry.runtime,
                rawSerialized
            );
            const tabEntry = {
                runtime: runtimeEntry.runtime,
                serialize: () => {
                    const tab = runtimeEntry.runtime.tabs.get(tabId);
                    const nextSerialized = tab
                        ? runtimeEntry.runtime.serializeTab(tab)
                        : serialized;
                    return this.#applyRuntimeMetadataFallback(
                        runtimeEntry.runtime,
                        nextSerialized
                    );
                }
            };
            this.tabs.set(tabId, tabEntry);
            await this.persistTabs();
            return tabEntry.serialize();
        } catch (error) {
            const shouldDisposeRuntime = createdRuntime
                || runtimeEntry.runtime.tabs.size === 0;
            if (shouldDisposeRuntime) {
                this.runtimes.delete(runtimeStoreKey);
                await runtimeEntry.runtime.dispose().catch(() => {});
            }
            throw new Error(formatAgentStartupError(definition, error));
        }
    }

    async restoreTabs(validTerminalSessionIds = new Set()) {
        await this.ensureConfigsLoaded();
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

            const agentConfig = this.getAgentConfig(definition.id);
            const availability = getDefinitionAvailability(
                definition,
                agentConfig
            );
            if (!availability.available) {
                changed = true;
                continue;
            }

            const cwd = path.resolve(meta.cwd || process.cwd());
            const runtimeKey = makeRuntimeKey(definition.id, cwd);
            const runtimeStoreKey = makeRuntimeStoreKey(
                definition.id,
                cwd,
                this.getAgentConfigVersion(definition.id)
            );
            let runtimeEntry = this.runtimes.get(runtimeStoreKey);
            if (!runtimeEntry) {
                const runtime = this.runtimeFactory(definition, {
                    cwd,
                    idleTimeoutMs: this.idleTimeoutMs,
                    runtimeStoreKey,
                    env: mergeDefinitionEnv(definition, agentConfig)
                });
                runtimeEntry = {
                    runtime,
                    definition,
                    runtimeKey,
                    runtimeStoreKey
                };
                this.runtimes.set(runtimeStoreKey, runtimeEntry);
                runtime.on('runtime_exit', () => {
                    if (this.disposing) return;
                    for (const [tabId, tabEntry] of this.tabs.entries()) {
                        if (tabEntry.runtime !== runtime) continue;
                        this.tabs.delete(tabId);
                    }
                    this.runtimes.delete(runtimeStoreKey);
                    void this.persistTabs();
                });
            }

            try {
                const rawSerialized = await runtimeEntry.runtime.restoreTab({
                    ...meta,
                    cwd
                });
                const serialized = this.#applyRuntimeMetadataFallback(
                    runtimeEntry.runtime,
                    rawSerialized
                );
                this.tabs.set(meta.id, {
                    runtime: runtimeEntry.runtime,
                    serialize: () => {
                        const tab = runtimeEntry.runtime.tabs.get(meta.id);
                        const nextSerialized = tab
                            ? runtimeEntry.runtime.serializeTab(tab)
                            : serialized;
                        return this.#applyRuntimeMetadataFallback(
                            runtimeEntry.runtime,
                            nextSerialized
                        );
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

    async sendPrompt(tabId, text, attachments = []) {
        const tabEntry = this.tabs.get(tabId);
        if (!tabEntry) {
            throw new Error('Agent tab not found');
        }
        await tabEntry.runtime.sendPrompt(tabId, text, attachments);
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

    async setConfigOption(tabId, configId, valueId) {
        const tabEntry = this.tabs.get(tabId);
        if (!tabEntry) {
            throw new Error('Agent tab not found');
        }
        return await tabEntry.runtime.setConfigOption(tabId, configId, valueId);
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
            this.runtimes.delete(
                tabEntry.runtime.runtimeStoreKey || tabEntry.runtime.runtimeKey
            );
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
