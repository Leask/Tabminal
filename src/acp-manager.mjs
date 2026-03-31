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
const DEFAULT_AVAILABILITY_OVERRIDE_TTL_MS = 30 * 1000;
const DEFAULT_PROBE_CACHE_TTL_MS = 15 * 1000;
const DEFAULT_TRANSCRIPT_PERSIST_DELAY_MS = 250;
const ALL_SESSION_AGENT_IDS = new Set([
    'claude',
    'codex',
    'copilot'
]);
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

function normalizeAgentSessionCapabilities(
    agentCapabilities = null,
    connection = null,
    definitionId = ''
) {
    const sessionCapabilities = (
        agentCapabilities?.sessionCapabilities
        && typeof agentCapabilities.sessionCapabilities === 'object'
    )
        ? agentCapabilities.sessionCapabilities
        : {};
    return {
        load: !!(
            agentCapabilities?.loadSession
            && typeof connection?.loadSession === 'function'
        ),
        list: !!(
            sessionCapabilities?.list
            && typeof connection?.listSessions === 'function'
        ),
        listAll: !!(
            sessionCapabilities?.list
            && typeof connection?.listSessions === 'function'
            && ALL_SESSION_AGENT_IDS.has(String(definitionId || '').trim())
        ),
        resume: !!(
            sessionCapabilities?.resume
            && typeof connection?.unstable_resumeSession === 'function'
        ),
        fork: !!(
            sessionCapabilities?.fork
            && typeof connection?.unstable_forkSession === 'function'
        )
    };
}

function normalizeListedSessionInfo(session) {
    const normalized = session && typeof session === 'object' ? session : {};
    return {
        sessionId: String(normalized.sessionId || '').trim(),
        cwd: String(normalized.cwd || '').trim(),
        title: typeof normalized.title === 'string' ? normalized.title : '',
        updatedAt: typeof normalized.updatedAt === 'string'
            ? normalized.updatedAt
            : ''
    };
}

function parseGeminiListedSessions(output) {
    const text = String(output || '');
    const lines = text.split(/\r?\n/);
    const sessions = [];
    for (const line of lines) {
        const match = line.match(
            /^\s*\d+\.\s+(.*?)\s+\((.*?)\)\s+\[([0-9a-f-]{8,})\]\s*$/i
        );
        if (!match) continue;
        sessions.push({
            title: match[1]?.trim() || '',
            relativeUpdatedAt: match[2]?.trim() || '',
            sessionId: match[3]?.trim() || ''
        });
    }
    return sessions.filter((session) => session.sessionId);
}

let ghCopilotCliInstalledCache = null;
let ghAuthTokenCache = null;
const availabilityProbeCache = new Map();

function getCachedProbeValue(key) {
    if (!key) return null;
    const entry = availabilityProbeCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        availabilityProbeCache.delete(key);
        return null;
    }
    return entry.value;
}

function setCachedProbeValue(key, value) {
    if (!key) return value;
    availabilityProbeCache.set(key, {
        value,
        expiresAt: Date.now() + DEFAULT_PROBE_CACHE_TTL_MS
    });
    return value;
}

function getAvailabilityCacheScopeKey(runtimeEnv = {}) {
    return String(
        runtimeEnv.HOME
        || process.env.HOME
        || process.cwd()
    );
}

function probeCodexAuth(runtimeEnv = {}) {
    if (!commandExists('codex', runtimeEnv)) {
        return { available: true, reason: '' };
    }

    const cacheKey = `codex-auth:${getAvailabilityCacheScopeKey(runtimeEnv)}`;
    const cached = getCachedProbeValue(cacheKey);
    if (cached) {
        return cached;
    }

    const result = spawnSync('codex', ['login', 'status'], {
        encoding: 'utf8',
        timeout: 1500,
        env: withAgentPath(runtimeEnv)
    });
    if (result.status === 0) {
        return setCachedProbeValue(cacheKey, {
            available: true,
            reason: ''
        });
    }
    const output = [
        result.stdout,
        result.stderr,
        result.error?.message
    ].filter(Boolean).join('\n');
    if (/not logged in|authentication required|login/i.test(output)) {
        return setCachedProbeValue(cacheKey, {
            available: false,
            reason: 'Run `codex login` on this host'
        });
    }
    return setCachedProbeValue(cacheKey, {
        available: true,
        reason: ''
    });
}

function probeGhAuth(runtimeEnv = {}) {
    const explicitToken = String(
        runtimeEnv.COPILOT_GITHUB_TOKEN
        || runtimeEnv.GH_TOKEN
        || runtimeEnv.GITHUB_TOKEN
        || ''
    ).trim();
    if (explicitToken) {
        return { available: true, reason: '' };
    }
    if (!commandExists('gh', runtimeEnv)) {
        return {
            available: false,
            reason: 'Run `gh auth login` or set `COPILOT_GITHUB_TOKEN`'
        };
    }

    const cacheKey = `gh-auth:${getAvailabilityCacheScopeKey(runtimeEnv)}`;
    const cached = getCachedProbeValue(cacheKey);
    if (cached) {
        return cached;
    }

    const result = spawnSync('gh', ['auth', 'status'], {
        encoding: 'utf8',
        timeout: 1500,
        env: withAgentPath(runtimeEnv)
    });
    if (result.status === 0) {
        return setCachedProbeValue(cacheKey, {
            available: true,
            reason: ''
        });
    }
    const output = [
        result.stdout,
        result.stderr,
        result.error?.message
    ].filter(Boolean).join('\n');
    if (/not logged|not logged into any github hosts/i.test(output)) {
        return setCachedProbeValue(cacheKey, {
            available: false,
            reason: 'Run `gh auth login` or set `COPILOT_GITHUB_TOKEN`'
        });
    }
    return setCachedProbeValue(cacheKey, {
        available: true,
        reason: ''
    });
}

const DEFAULT_AVAILABILITY_PROBES = {
    commandExists,
    hasGhCopilotWrapper,
    hasGhCopilotCliInstalled,
    probeCodexAuth,
    probeGhAuth
};

function hasGhCopilotCliInstalled() {
    if (typeof ghCopilotCliInstalledCache === 'boolean') {
        return ghCopilotCliInstalledCache;
    }
    if (!commandExists('gh')) {
        ghCopilotCliInstalledCache = false;
        return ghCopilotCliInstalledCache;
    }
    const result = spawnSync('gh', ['copilot', '--', '--version'], {
        encoding: 'utf8',
        env: withAgentPath(process.env)
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
        encoding: 'utf8',
        env: withAgentPath(process.env)
    });
    ghAuthTokenCache = result.status === 0
        ? String(result.stdout || '').trim()
        : '';
    return ghAuthTokenCache;
}

function buildAugmentedPath(env = {}) {
    const delimiter = path.delimiter;
    const home = String(
        env.HOME
        || process.env.HOME
        || ''
    ).trim();
    const existingEntries = String(
        env.PATH
        || process.env.PATH
        || ''
    )
        .split(delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean);
    const extraEntries = [
        home ? path.join(home, '.local', 'bin') : '',
        home ? path.join(home, 'bin') : '',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/local/bin'
    ].filter(Boolean);
    const seen = new Set();
    return [...existingEntries, ...extraEntries]
        .filter((entry) => {
            if (seen.has(entry)) return false;
            seen.add(entry);
            return true;
        })
        .join(delimiter);
}

function withAgentPath(env = {}) {
    return {
        ...env,
        PATH: buildAugmentedPath(env)
    };
}

function mergeDefinitionEnv(definition, agentConfig = {}) {
    const env = withAgentPath({
        ...process.env,
        ...normalizeConfiguredEnv(definition.id, agentConfig.env)
    });
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
        encoding: 'utf8',
        env: withAgentPath(process.env)
    });
    return result.status === 0
        && typeof result.stdout === 'string'
        && result.stdout.includes('gh-copilot');
}

function commandExists(command, env = process.env) {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(checker, [command], {
        stdio: 'ignore',
        env: withAgentPath(env)
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

function getDefinitionAvailability(
    definition,
    agentConfig = {},
    probes = DEFAULT_AVAILABILITY_PROBES
) {
    const commandExistsFn = probes.commandExists || commandExists;
    const runtimeEnv = mergeDefinitionEnv(definition, agentConfig);
    if (!commandExistsFn(definition.command, runtimeEnv)) {
        return {
            available: false,
            reason: 'not installed'
        };
    }

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

    if (definition.id === 'codex') {
        const codexAvailability = (
            probes.probeCodexAuth || probeCodexAuth
        )(runtimeEnv);
        if (!codexAvailability.available) {
            return codexAvailability;
        }
    }

    if (
        definition.id === 'copilot'
        && definition.command === 'gh'
    ) {
        const hasWrapper = (
            probes.hasGhCopilotWrapper || hasGhCopilotWrapper
        )();
        if (!hasWrapper) {
            return {
                available: false,
                reason: 'Install the gh-copilot extension first'
            };
        }
        const hasCli = (
            probes.hasGhCopilotCliInstalled || hasGhCopilotCliInstalled
        )();
        if (!hasCli) {
            return {
                available: false,
                reason: 'Run gh copilot once to install Copilot CLI'
            };
        }
        const ghAvailability = (probes.probeGhAuth || probeGhAuth)(runtimeEnv);
        if (!ghAvailability.available) {
            return ghAvailability;
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
    if (/ENOENT|not found/i.test(rawMessage)) {
        const label = definition?.label || 'Agent';
        const command = definition?.commandLabel || definition?.command || '';
        return command
            ? `${label} is not installed or not found on this host. `
                + `Install \`${command}\` and retry.`
            : `${label} is not installed or not found on this host.`;
    }
    if (
        definition?.id === 'claude'
        && /not servable in region|not available on your vertex deployment/i
            .test(rawMessage)
    ) {
        return 'Claude Vertex is configured with a region that cannot serve '
            + 'the current model. Use a supported region such as `global`, '
            + '`us-east5`, or `europe-west1`, then retry.';
    }
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
    if (previous === chunk) return previous;
    if (chunk.startsWith(previous)) {
        return chunk;
    }
    if (previous.startsWith(chunk)) {
        return previous;
    }

    const maxOverlap = Math.min(previous.length, chunk.length, 2048);
    for (let overlap = maxOverlap; overlap >= 2; overlap -= 1) {
        if (previous.slice(-overlap) === chunk.slice(0, overlap)) {
            return `${previous}${chunk.slice(overlap)}`;
        }
    }

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

function normalizeUsageWindow(item = {}) {
    if (!item || typeof item !== 'object') return null;
    const label = String(
        item.label
        || item.name
        || item.window
        || item.bucket
        || ''
    ).trim();
    const used = Number.isFinite(item.used)
        ? item.used
        : Number.isFinite(item.consumed)
            ? item.consumed
            : Number.isFinite(item.spent)
                ? item.spent
                : null;
    const size = Number.isFinite(item.size)
        ? item.size
        : Number.isFinite(item.limit)
            ? item.limit
            : Number.isFinite(item.max)
                ? item.max
                : Number.isFinite(item.total)
                    ? item.total
                    : null;
    const remaining = Number.isFinite(item.remaining)
        ? item.remaining
        : Number.isFinite(size) && Number.isFinite(used)
            ? Math.max(size - used, 0)
            : null;
    const resetAt = [
        item.resetAt,
        item.resetsAt,
        item.nextResetAt,
        item.resetTime,
        item.resetDate
    ].find((value) => typeof value === 'string' && value.trim()) || '';
    const resetDisplay = String(
        item.resetDisplay
        || item.resetLabel
        || item.resetText
        || ''
    ).trim();
    const subtitle = String(item.subtitle || item.description || '').trim();
    if (!label && !resetAt && !resetDisplay && !subtitle) {
        return null;
    }
    return {
        label: label || 'Window',
        used,
        size,
        remaining,
        resetAt,
        resetDisplay,
        subtitle
    };
}

function extractUsageResetHints(meta = {}) {
    if (!meta || typeof meta !== 'object') {
        return {
            resetAt: '',
            windows: [],
            vendorLabel: '',
            sessionId: '',
            summary: ''
        };
    }
    const rawWindows = Array.isArray(meta.windows)
        ? meta.windows
        : Array.isArray(meta.limits)
            ? meta.limits
            : Array.isArray(meta.quotas)
                ? meta.quotas
                : [];
    const windows = rawWindows
        .map((item) => normalizeUsageWindow(item))
        .filter(Boolean);
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
    return {
        resetAt,
        windows,
        vendorLabel: String(
            meta.vendorLabel
            || meta.provider
            || meta.providerLabel
            || meta.agent
            || ''
        ).trim(),
        sessionId: String(
            meta.sessionId
            || meta.session
            || meta.conversationId
            || ''
        ).trim(),
        summary: String(
            meta.summary
            || meta.status
            || meta.contextLabel
            || ''
        ).trim()
    };
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
        windows: meta.windows.length > 0 ? meta.windows : previous?.windows || [],
        vendorLabel: meta.vendorLabel || previous?.vendorLabel || '',
        sessionId: meta.sessionId || previous?.sessionId || '',
        summary: meta.summary || previous?.summary || ''
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
        windows: Array.isArray(usage.windows) ? usage.windows : [],
        vendorLabel: typeof usage.vendorLabel === 'string'
            ? usage.vendorLabel
            : '',
        sessionId: typeof usage.sessionId === 'string'
            ? usage.sessionId
            : '',
        summary: typeof usage.summary === 'string'
            ? usage.summary
            : ''
    };
}

function normalizeToolStatusClass(status = '') {
    const value = String(status || 'pending').toLowerCase();
    if (value.includes('ready')) {
        return 'ready';
    }
    if (value.includes('restore')) {
        return 'running';
    }
    if (value.includes('disconnect')) {
        return 'error';
    }
    if (
        value.includes('complete')
        || value.includes('success')
        || value.includes('select')
        || value.includes('approve')
    ) {
        return 'completed';
    }
    if (value.includes('cancel')) {
        return 'cancelled';
    }
    if (value.includes('error') || value.includes('fail')) {
        return 'error';
    }
    if (value.includes('run') || value.includes('progress')) {
        return 'running';
    }
    return 'pending';
}

function getToolCallTerminalIds(toolCall) {
    if (!Array.isArray(toolCall?.content)) {
        return [];
    }
    const ids = new Set();
    for (const item of toolCall.content) {
        const terminalId = String(item?.terminalId || '').trim();
        if (item?.type === 'terminal' && terminalId) {
            ids.add(terminalId);
        }
    }
    return Array.from(ids);
}

function cloneSerializable(value, fallback) {
    try {
        const cloned = structuredClone(value);
        return cloned === undefined ? fallback : cloned;
    } catch {
        return fallback;
    }
}

function parseIsoTimestamp(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return 0;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function getSerializedTabContentScore(tab = {}) {
    const messages = Array.isArray(tab.messages) ? tab.messages : [];
    const toolCalls = Array.isArray(tab.toolCalls) ? tab.toolCalls : [];
    const permissions = Array.isArray(tab.permissions) ? tab.permissions : [];
    const plan = Array.isArray(tab.plan) ? tab.plan : [];
    const terminals = Array.isArray(tab.terminals) ? tab.terminals : [];
    return (
        messages.length * 10000
        + toolCalls.length * 100
        + permissions.length * 10
        + plan.length
        + terminals.length
    );
}

function getSerializedTabActivity(tab = {}) {
    let maxSyntheticTurn = -1;
    let maxTimestamp = parseIsoTimestamp(tab.createdAt);
    let maxOrder = 0;
    const visit = (item) => {
        maxTimestamp = Math.max(
            maxTimestamp,
            parseIsoTimestamp(item?.createdAt),
            parseIsoTimestamp(item?.updatedAt)
        );
        const order = Number(item?.order || 0);
        if (Number.isFinite(order) && order > maxOrder) {
            maxOrder = order;
        }
        const syntheticTurnKey = getSyntheticTurnKey(item?.streamKey || '');
        const turn = syntheticTurnKey ? Number(syntheticTurnKey) : -1;
        if (Number.isFinite(turn) && turn > maxSyntheticTurn) {
            maxSyntheticTurn = turn;
        }
    };
    for (const message of Array.isArray(tab.messages) ? tab.messages : []) {
        visit(message);
    }
    for (const toolCall of Array.isArray(tab.toolCalls) ? tab.toolCalls : []) {
        visit(toolCall);
    }
    for (
        const permission of Array.isArray(tab.permissions) ? tab.permissions : []
    ) {
        visit(permission);
    }
    if (tab.usage && typeof tab.usage === 'object') {
        visit(tab.usage);
    }
    return {
        maxSyntheticTurn,
        maxTimestamp,
        maxOrder,
        contentScore: getSerializedTabContentScore(tab)
    };
}

function compareSerializedTabActivity(left = {}, right = {}) {
    const leftActivity = getSerializedTabActivity(left);
    const rightActivity = getSerializedTabActivity(right);
    if (leftActivity.maxSyntheticTurn !== rightActivity.maxSyntheticTurn) {
        return rightActivity.maxSyntheticTurn - leftActivity.maxSyntheticTurn;
    }
    if (leftActivity.maxTimestamp !== rightActivity.maxTimestamp) {
        return rightActivity.maxTimestamp - leftActivity.maxTimestamp;
    }
    if (leftActivity.maxOrder !== rightActivity.maxOrder) {
        return rightActivity.maxOrder - leftActivity.maxOrder;
    }
    if (leftActivity.contentScore !== rightActivity.contentScore) {
        return rightActivity.contentScore - leftActivity.contentScore;
    }
    return 0;
}

function compareSerializedTabBase(left = {}, right = {}) {
    const leftLinked = !!String(left.terminalSessionId || '').trim();
    const rightLinked = !!String(right.terminalSessionId || '').trim();
    if (leftLinked !== rightLinked) {
        return Number(rightLinked) - Number(leftLinked);
    }
    const leftCreatedAt = parseIsoTimestamp(left.createdAt);
    const rightCreatedAt = parseIsoTimestamp(right.createdAt);
    if (leftCreatedAt !== rightCreatedAt) {
        return rightCreatedAt - leftCreatedAt;
    }
    const leftTitleLength = String(left.title || '').trim().length;
    const rightTitleLength = String(right.title || '').trim().length;
    if (leftTitleLength !== rightTitleLength) {
        return rightTitleLength - leftTitleLength;
    }
    return compareSerializedTabActivity(left, right);
}

function pickBestTitle(values = []) {
    let best = '';
    for (const value of values) {
        const text = String(value || '').trim();
        if (text.length > best.length) {
            best = text;
        }
    }
    return best;
}

function pickLongerArray(left, right) {
    const leftItems = Array.isArray(left) ? left : [];
    const rightItems = Array.isArray(right) ? right : [];
    return rightItems.length > leftItems.length ? rightItems : leftItems;
}

function mergeSerializedTabGroup(group = []) {
    if (!Array.isArray(group) || group.length === 0) {
        return null;
    }
    if (group.length === 1) {
        const only = cloneSerializable(group[0], null);
        if (only && Array.isArray(only.messages)) {
            only.messages = normalizeAgentTranscriptMessages(only.messages);
        }
        return only;
    }

    const base = [...group].sort(compareSerializedTabBase)[0];
    const content = [...group].sort(compareSerializedTabActivity)[0];
    const merged = cloneSerializable(base, null);
    if (!merged) {
        return null;
    }

    const bestTitle = pickBestTitle(group.map((entry) => entry?.title));
    merged.title = String(merged.title || '').trim()
        || String(content.title || '').trim()
        || bestTitle;
    merged.cwd = String(merged.cwd || content.cwd || '');
    merged.terminalSessionId = String(
        merged.terminalSessionId || content.terminalSessionId || ''
    );
    merged.currentModeId = String(
        merged.currentModeId || content.currentModeId || ''
    );
    merged.availableModes = cloneSerializable(
        pickLongerArray(merged.availableModes, content.availableModes),
        []
    );
    merged.availableCommands = cloneSerializable(
        pickLongerArray(merged.availableCommands, content.availableCommands),
        []
    );
    merged.configOptions = cloneSerializable(
        pickLongerArray(merged.configOptions, content.configOptions),
        []
    );
    merged.messages = normalizeAgentTranscriptMessages(
        cloneSerializable(content.messages, [])
    );
    merged.toolCalls = cloneSerializable(content.toolCalls, []);
    merged.permissions = cloneSerializable(content.permissions, []);
    merged.plan = cloneSerializable(content.plan, []);
    merged.usage = cloneSerializable(content.usage, null);
    merged.terminals = cloneSerializable(
        pickLongerArray(merged.terminals, content.terminals),
        []
    );
    return merged;
}

function dedupeSerializedTabs(entries = []) {
    const groups = new Map();
    const order = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const acpSessionId = String(entry.acpSessionId || '').trim();
        const key = acpSessionId || `id:${String(entry.id || '').trim()}`;
        if (!groups.has(key)) {
            groups.set(key, []);
            order.push(key);
        }
        groups.get(key).push(entry);
    }
    const deduped = [];
    let changed = false;
    for (const key of order) {
        const group = groups.get(key) || [];
        const merged = mergeSerializedTabGroup(group);
        if (merged) {
            deduped.push(merged);
        }
        if (group.length > 1) {
            changed = true;
        }
    }
    return { tabs: deduped, changed };
}

function normalizePersistedTimelineOrder(value, fallback = 0) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getSyntheticTurnKey(streamKey = '') {
    const match = /^synthetic:(\d+):/.exec(String(streamKey || ''));
    return match ? match[1] : '';
}

function buildMessageReplaySignature(message = {}) {
    return [
        String(message?.role || ''),
        String(message?.kind || ''),
        String(message?.streamKey || ''),
        String(message?.text || '')
    ].join('\u0000');
}

export function normalizeAgentTranscriptMessages(messages = []) {
    const normalized = Array.isArray(messages)
        ? messages.map((message, index) =>
            normalizePersistedMessage(message, index + 1)
        )
        : [];
    if (normalized.length <= 1) {
        return normalized;
    }

    const blocks = [];
    let index = 0;
    while (index < normalized.length) {
        const first = normalized[index];
        const syntheticTurnKey = getSyntheticTurnKey(first.streamKey);
        const block = [first];
        index += 1;
        if (!syntheticTurnKey) {
            blocks.push(block);
            continue;
        }
        while (index < normalized.length) {
            const next = normalized[index];
            if (getSyntheticTurnKey(next.streamKey) !== syntheticTurnKey) {
                break;
            }
            block.push(next);
            index += 1;
        }
        const dedupedBlock = [];
        const dedupedIndexes = new Map();
        for (const message of block) {
            const signature = buildMessageReplaySignature(message);
            const existingIndex = dedupedIndexes.get(signature);
            if (existingIndex === undefined) {
                dedupedIndexes.set(signature, dedupedBlock.length);
                dedupedBlock.push(message);
                continue;
            }
            if (String(message.role || '') === 'assistant') {
                dedupedBlock[existingIndex] = message;
            }
        }
        blocks.push(dedupedBlock);
    }

    const dedupedBlocks = [];
    let previousSignature = '';
    for (const block of blocks) {
        const signature = block
            .map((message) => buildMessageReplaySignature(message))
            .join('\u0001');
        if (signature && signature === previousSignature) {
            continue;
        }
        dedupedBlocks.push(block);
        previousSignature = signature;
    }

    return dedupedBlocks.flat();
}

export function createRestoreCaptureState(messages = [], options = {}) {
    const toolCalls = Array.isArray(options.toolCalls)
        ? options.toolCalls
        : [];
    return {
        baselineMessages: normalizeAgentTranscriptMessages(messages),
        baselineToolCalls: new Map(
            toolCalls
                .map((entry) => normalizePersistedTimelineEntry(entry, 0))
                .filter((entry) => typeof entry.toolCallId === 'string')
                .map((entry) => [entry.toolCallId, entry])
        ),
        messages: [],
        syntheticStreams: new Map(),
        syntheticStreamTurn: getNextSyntheticStreamTurn(messages),
        messageCounter: 0,
        nextTimelineOrder: null
    };
}

function getRestoreComparableAttachment(attachment = {}) {
    return [
        String(attachment?.kind || ''),
        String(attachment?.name || ''),
        String(attachment?.path || ''),
        String(attachment?.url || ''),
        Number.isFinite(attachment?.size) ? attachment.size : 0,
        Number.isFinite(attachment?.lastModified)
            ? attachment.lastModified
            : 0
    ];
}

function buildRestoreComparableMessage(message = {}) {
    return JSON.stringify({
        role: String(message?.role || ''),
        kind: String(message?.kind || ''),
        text: String(message?.text || ''),
        attachments: Array.isArray(message?.attachments)
            ? message.attachments.map(getRestoreComparableAttachment)
            : []
    });
}

function areRestoreMessagesEquivalent(left = {}, right = {}) {
    return buildRestoreComparableMessage(left)
        === buildRestoreComparableMessage(right);
}

function isRestoreMessageContinuation(previousText = '', chunkText = '') {
    const previous = String(previousText || '');
    const chunk = String(chunkText || '');
    if (!previous || !chunk || previous === chunk) {
        return false;
    }
    if (chunk.startsWith(previous) || previous.startsWith(chunk)) {
        return true;
    }
    const maxOverlap = Math.min(previous.length, chunk.length, 2048);
    for (let overlap = maxOverlap; overlap >= 2; overlap -= 1) {
        if (previous.slice(-overlap) === chunk.slice(0, overlap)) {
            return true;
        }
    }
    return false;
}

function maybeAdvanceRestoreCaptureTurn(capture, update, role, kind, text) {
    if (
        !capture
        || update?.messageId
        || role !== 'user'
        || kind !== 'message'
    ) {
        return;
    }
    const last = capture.messages[capture.messages.length - 1] || null;
    if (!last) {
        return;
    }
    if (last.role !== 'user' || last.kind !== 'message') {
        capture.syntheticStreamTurn += 1;
        capture.syntheticStreams.clear();
        return;
    }
    if (!isRestoreMessageContinuation(last.text, text)) {
        capture.syntheticStreamTurn += 1;
        capture.syntheticStreams.clear();
    }
}

function getRestoreCaptureStreamKey(capture, update, role, kind, text = '') {
    maybeAdvanceRestoreCaptureTurn(capture, update, role, kind, text);
    if (update?.messageId) {
        return update.messageId;
    }
    const bucketKey = `${update?.sessionUpdate}:${role}:${kind}`;
    let streamKey = capture.syntheticStreams.get(bucketKey) || '';
    if (!streamKey) {
        streamKey = [
            'synthetic',
            capture.syntheticStreamTurn,
            update?.sessionUpdate || 'message_chunk',
            role,
            kind
        ].join(':');
        capture.syntheticStreams.set(bucketKey, streamKey);
    }
    return streamKey;
}

export function captureRestoreReplayChunk(capture, update, role, kind, text) {
    if (!capture) return false;
    const chunk = String(text || '');
    if (!chunk) return true;
    const streamKey = getRestoreCaptureStreamKey(
        capture,
        update,
        role,
        kind,
        chunk
    );
    const last = capture.messages[capture.messages.length - 1] || null;
    if (
        last
        && last.streamKey === streamKey
        && last.role === role
        && last.kind === kind
    ) {
        last.text = mergeAgentMessageText(last.text, chunk);
        return true;
    }
    if (!update?.messageId) {
        capture.messageCounter += 1;
    }
    const baselineMessage = capture.baselineMessages[capture.messages.length] || null;
    const canReuseBaseline = !!(
        baselineMessage
        && baselineMessage.role === role
        && baselineMessage.kind === kind
    );
    capture.messages.push({
        id: canReuseBaseline
            ? (baselineMessage.id || crypto.randomUUID())
            : crypto.randomUUID(),
        streamKey: canReuseBaseline
            ? (baselineMessage.streamKey || streamKey)
            : streamKey,
        role,
        kind,
        text: chunk,
        createdAt: canReuseBaseline
            ? (baselineMessage.createdAt || '')
            : '',
        order: typeof capture.nextTimelineOrder === 'function'
            ? capture.nextTimelineOrder()
            : capture.messages.length + 1,
        attachments: canReuseBaseline
            && Array.isArray(baselineMessage.attachments)
            ? cloneSerializable(baselineMessage.attachments, [])
            : []
    });
    return true;
}

export function finalizeRestoreCaptureMessages(tab) {
    const capture = tab?.restoreCapture;
    if (!capture) {
        return false;
    }
    const baselineMessages = Array.isArray(capture.baselineMessages)
        ? capture.baselineMessages
        : [];
    const replayMessages = Array.isArray(capture.messages)
        ? capture.messages
        : [];
    const nextMessages = replayMessages.length > 0
        ? normalizeAgentTranscriptMessages(replayMessages)
        : baselineMessages;
    const replacedMessages = !(
        baselineMessages.length === nextMessages.length
        && baselineMessages.every((message, index) =>
            areRestoreMessagesEquivalent(message, nextMessages[index] || {})
        )
    );
    tab.messages = nextMessages;
    const maxMessageOrder = tab.messages.reduce(
        (maxOrder, message) => Math.max(
            maxOrder,
            normalizePersistedTimelineOrder(message.order, 0)
        ),
        0
    );
    const maxToolCallOrder = Array.from(tab.toolCalls.values()).reduce(
        (maxOrder, toolCall) => Math.max(
            maxOrder,
            normalizePersistedTimelineOrder(toolCall?.order, 0)
        ),
        0
    );
    const maxPermissionOrder = Array.from(tab.permissions.values()).reduce(
        (maxOrder, permission) => Math.max(
            maxOrder,
            normalizePersistedTimelineOrder(permission?.order, 0)
        ),
        0
    );
    tab.timelineCounter = Math.max(
        maxMessageOrder,
        maxToolCallOrder,
        maxPermissionOrder
    );
    tab.messageCounter = Math.max(tab.messageCounter, tab.messages.length);
    tab.restoreCapture = null;
    return replacedMessages;
}

export function buildRestoredToolCall(
    previous = null,
    baseline = null,
    update = {},
    nextTimelineOrder = null
) {
    const persisted = cloneSerializable(baseline, {}) || {};
    const current = cloneSerializable(previous, {}) || {};
    const nextOrder = normalizePersistedTimelineOrder(current.order, 0)
        || (
            typeof nextTimelineOrder === 'function'
                ? nextTimelineOrder()
                : normalizePersistedTimelineOrder(persisted.order, 0)
        )
        || 1;
    const createdAt = String(
        current.createdAt || persisted.createdAt || ''
    ).trim() || new Date().toISOString();
    const nextToolCall = {
        ...persisted,
        ...current,
        ...update,
        createdAt,
        order: nextOrder
    };
    if (!nextToolCall.toolCallId) {
        nextToolCall.toolCallId = String(update.toolCallId || '');
    }
    if (typeof nextToolCall.title !== 'string') {
        nextToolCall.title = '';
    }
    if (typeof nextToolCall.status !== 'string') {
        nextToolCall.status = 'pending';
    }
    return nextToolCall;
}

function normalizePersistedMessage(message = {}, fallbackOrder = 0) {
    const nextMessage = cloneSerializable(message, {}) || {};
    nextMessage.id = typeof nextMessage.id === 'string'
        ? nextMessage.id
        : crypto.randomUUID();
    nextMessage.streamKey = typeof nextMessage.streamKey === 'string'
        ? nextMessage.streamKey
        : nextMessage.id;
    nextMessage.role = typeof nextMessage.role === 'string'
        ? nextMessage.role
        : 'assistant';
    nextMessage.kind = typeof nextMessage.kind === 'string'
        ? nextMessage.kind
        : 'message';
    nextMessage.text = typeof nextMessage.text === 'string'
        ? nextMessage.text
        : '';
    nextMessage.createdAt = typeof nextMessage.createdAt === 'string'
        ? nextMessage.createdAt
        : '';
    nextMessage.order = normalizePersistedTimelineOrder(
        nextMessage.order,
        fallbackOrder
    );
    nextMessage.attachments = Array.isArray(nextMessage.attachments)
        ? cloneSerializable(nextMessage.attachments, [])
        : [];
    return nextMessage;
}

function normalizePersistedTimelineEntry(entry = {}, fallbackOrder = 0) {
    const nextEntry = cloneSerializable(entry, {}) || {};
    nextEntry.createdAt = typeof nextEntry.createdAt === 'string'
        ? nextEntry.createdAt
        : '';
    nextEntry.order = normalizePersistedTimelineOrder(
        nextEntry.order,
        fallbackOrder
    );
    return nextEntry;
}

function normalizePersistedTerminalSummary(summary = {}) {
    const nextSummary = cloneSerializable(summary, {}) || {};
    return {
        terminalId: typeof nextSummary.terminalId === 'string'
            ? nextSummary.terminalId
            : '',
        terminalSessionId: typeof nextSummary.terminalSessionId === 'string'
            ? nextSummary.terminalSessionId
            : '',
        command: typeof nextSummary.command === 'string'
            ? nextSummary.command
            : '',
        cwd: typeof nextSummary.cwd === 'string' ? nextSummary.cwd : '',
        output: typeof nextSummary.output === 'string'
            ? nextSummary.output
            : '',
        createdAt: typeof nextSummary.createdAt === 'string'
            ? nextSummary.createdAt
            : '',
        updatedAt: typeof nextSummary.updatedAt === 'string'
            ? nextSummary.updatedAt
            : '',
        released: !!nextSummary.released,
        running: !!nextSummary.running,
        exitStatus: nextSummary.exitStatus
            && typeof nextSummary.exitStatus === 'object'
            ? {
                exitCode: Number.isFinite(nextSummary.exitStatus.exitCode)
                    ? nextSummary.exitStatus.exitCode
                    : null,
                signal: typeof nextSummary.exitStatus.signal === 'string'
                    ? nextSummary.exitStatus.signal
                    : null
            }
            : null
    };
}

export function getNextSyntheticStreamTurn(messages = []) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return 0;
    }
    return messages.reduce((maxTurn, entry) => {
        const streamKey = String(entry?.streamKey || '');
        const match = /^synthetic:(\d+):/.exec(streamKey);
        if (!match) {
            return maxTurn;
        }
        const turn = Number.parseInt(match[1], 10);
        if (!Number.isFinite(turn)) {
            return maxTurn;
        }
        return Math.max(maxTurn, turn + 1);
    }, 0);
}

function restorePersistedTabSnapshot(tab, snapshot = {}) {
    const messages = normalizeAgentTranscriptMessages(snapshot.messages);
    const toolCalls = Array.isArray(snapshot.toolCalls)
        ? snapshot.toolCalls.map((entry, index) =>
            normalizePersistedTimelineEntry(
                entry,
                messages.length + index + 1
            )
        )
        : [];
    const permissions = Array.isArray(snapshot.permissions)
        ? snapshot.permissions.map((entry, index) =>
            normalizePersistedTimelineEntry(
                entry,
                messages.length + toolCalls.length + index + 1
            )
        )
        : [];
    const terminals = Array.isArray(snapshot.terminals)
        ? snapshot.terminals.map((entry) =>
            normalizePersistedTerminalSummary(entry)
        ).filter((entry) => entry.terminalId)
        : [];

    tab.messages = messages;
    tab.toolCalls = new Map(
        toolCalls
            .filter((entry) => typeof entry.toolCallId === 'string')
            .map((entry) => [entry.toolCallId, entry])
    );
    tab.permissions = new Map(
        permissions
            .filter((entry) => typeof entry.id === 'string')
            .map((entry) => [
                entry.id,
                {
                    ...entry,
                    resolve: null
                }
            ])
    );
    tab.plan = normalizePlanEntries(snapshot.plan);
    tab.usage = serializeUsageState(snapshot.usage)
        ? mergeUsageState(null, snapshot.usage)
        : null;
    tab.terminals = new Map(
        terminals.map((entry) => [entry.terminalId, entry])
    );
    tab.title = typeof snapshot.title === 'string'
        ? snapshot.title
        : tab.title;
    tab.currentModeId = typeof snapshot.currentModeId === 'string'
        ? snapshot.currentModeId
        : tab.currentModeId;
    tab.availableModes = Array.isArray(snapshot.availableModes)
        ? cloneSerializable(snapshot.availableModes, [])
        : tab.availableModes;
    tab.availableCommands = Array.isArray(snapshot.availableCommands)
        ? cloneSerializable(snapshot.availableCommands, [])
        : tab.availableCommands;
    tab.configOptions = Array.isArray(snapshot.configOptions)
        ? cloneSerializable(snapshot.configOptions, [])
        : tab.configOptions;

    const maxMessageOrder = messages.reduce(
        (maxOrder, entry) => Math.max(maxOrder, entry.order || 0),
        0
    );
    const maxToolOrder = toolCalls.reduce(
        (maxOrder, entry) => Math.max(maxOrder, entry.order || 0),
        0
    );
    const maxPermissionOrder = permissions.reduce(
        (maxOrder, entry) => Math.max(maxOrder, entry.order || 0),
        0
    );
    tab.timelineCounter = Math.max(
        tab.timelineCounter,
        maxMessageOrder,
        maxToolOrder,
        maxPermissionOrder
    );
    tab.messageCounter = Math.max(tab.messageCounter, messages.length);
    const maxSyntheticTurn = getNextSyntheticStreamTurn(messages);
    tab.syntheticStreamTurn = Math.max(
        Number.isFinite(tab.syntheticStreamTurn)
            ? tab.syntheticStreamTurn
            : 0,
        maxSyntheticTurn
    );
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

class ManagedTerminalSession extends EventEmitter {
    constructor(request, terminalManager, agentMeta = {}) {
        super();
        this.id = crypto.randomUUID();
        this.sessionId = String(request.sessionId || '');
        this.cwd = request.cwd || process.cwd();
        this.outputByteLimit = Math.max(
            1024,
            request.outputByteLimit || DEFAULT_TERMINAL_OUTPUT_LIMIT
        );
        const env = normalizeEnvList(request.env);
        this.spawnRequest = buildTerminalSpawnRequest(request);
        this.command = formatTerminalDisplayCommand(request, this.spawnRequest);
        this.released = false;
        this.managedBy = {
            kind: 'agent-terminal',
            agentId: String(agentMeta.agentId || '').trim(),
            agentLabel: String(agentMeta.agentLabel || 'Agent').trim(),
            acpSessionId: this.sessionId,
            terminalId: this.id
        };
        this.terminalSession = terminalManager.createManagedSession({
            cwd: this.cwd,
            env,
            spawnRequest: this.spawnRequest,
            title: path.basename(this.spawnRequest.command || '') || 'Terminal',
            managed: this.managedBy
        });
        this.terminalSessionId = this.terminalSession.id;
        this.unsubscribe = this.terminalSession.onStateChange(() => {
            this.emit('update', this.currentSummary());
        });
    }

    currentOutput() {
        return {
            output: truncateUtf8(
                this.terminalSession.history || '',
                this.outputByteLimit
            ),
            exitStatus: this.terminalSession.exitStatus
        };
    }

    currentSummary() {
        return {
            terminalId: this.id,
            sessionId: this.sessionId,
            terminalSessionId: this.terminalSessionId,
            command: this.command,
            cwd: this.terminalSession.cwd || this.cwd,
            output: truncateUtf8(
                this.terminalSession.history || '',
                this.outputByteLimit
            ),
            exitStatus: this.terminalSession.exitStatus,
            createdAt: this.terminalSession.createdAt instanceof Date
                ? this.terminalSession.createdAt.toISOString()
                : new Date(this.terminalSession.createdAt || Date.now())
                    .toISOString(),
            updatedAt: this.terminalSession.updatedAt instanceof Date
                ? this.terminalSession.updatedAt.toISOString()
                : new Date(this.terminalSession.updatedAt || Date.now())
                    .toISOString(),
            running: !this.terminalSession.exitStatus,
            released: this.released
        };
    }

    waitForExit() {
        return this.terminalSession.waitForExit();
    }

    kill() {
        if (!this.terminalSession.closed) {
            this.terminalSession.pty.kill('SIGTERM');
        }
        return {};
    }

    async release({ destroy = true } = {}) {
        this.released = true;
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (destroy) {
            await this.terminalSession.manager?.removeSession?.(
                this.terminalSession.id
            );
            this.terminalSessionId = '';
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
        this.terminalManager = options.terminalManager || null;
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

    #getSessionCapabilities() {
        const capabilities = normalizeAgentSessionCapabilities(
            this.agentCapabilities,
            this.connection,
            this.definition?.id
        );
        if (
            this.definition?.id === 'gemini'
            && this.#supportsGeminiCliSessionListing()
        ) {
            capabilities.list = true;
            capabilities.listAll = false;
        }
        return capabilities;
    }

    getSessionCapabilities() {
        return { ...this.#getSessionCapabilities() };
    }

    #supportsGeminiCliSessionListing() {
        if (this.definition?.id !== 'gemini') return false;
        const command = this.definition.command;
        return Boolean(
            command === 'gemini'
            || (
                command === NPX_COMMAND
                && Array.isArray(this.definition.args)
                && this.definition.args[0] === '@google/gemini-cli@latest'
            )
        );
    }

    #buildGeminiSessionListArgs() {
        const baseArgs = Array.isArray(this.definition.args)
            ? this.definition.args.filter((arg) => arg !== '--acp')
            : [];
        return [
            ...baseArgs,
            '--list-sessions'
        ];
    }

    async #listSessionsViaGeminiCli() {
        const args = this.#buildGeminiSessionListArgs();
        const result = spawnSync(this.definition.command, args, {
            encoding: 'utf8',
            timeout: 5000,
            cwd: this.cwd,
            env: withAgentPath(this.env)
        });
        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            const detail = [
                result.stdout,
                result.stderr
            ].filter(Boolean).join('\n').trim();
            throw new Error(
                detail || 'Gemini session listing failed'
            );
        }
        return parseGeminiListedSessions(result.stdout).map((session) => ({
            sessionId: session.sessionId,
            cwd: this.cwd,
            title: session.title,
            updatedAt: '',
            relativeUpdatedAt: session.relativeUpdatedAt
        }));
    }

    #supportsAllSessionListing() {
        return !!(
            this.#getSessionCapabilities().listAll
            && typeof this.connection?.listSessions === 'function'
        );
    }

    async #listSessionsViaConnection(options = {}) {
        const response = await this.connection.listSessions({
            cwd: options.all ? null : (options.cwd || this.cwd),
            cursor: options.cursor || null
        });
        return {
            sessions: Array.isArray(response?.sessions)
                ? response.sessions
                    .map(normalizeListedSessionInfo)
                    .filter(
                        (session) => session.sessionId && session.cwd
                    )
                : [],
            nextCursor: typeof response?.nextCursor === 'string'
                ? response.nextCursor
                : ''
        };
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
        configOptions = [],
        messages = [],
        toolCalls = [],
        permissions = [],
        plan = [],
        usage = null,
        terminals = []
    }) {
        const tab = {
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
            restoreCapture: null,
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
        restorePersistedTabSnapshot(tab, {
            title,
            currentModeId,
            availableModes,
            availableCommands,
            configOptions,
            messages,
            toolCalls,
            permissions,
            plan,
            usage,
            terminals
        });
        return tab;
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
        let startupSettled = false;
        let rejectStartup = null;
        const startupError = new Promise((_, reject) => {
            rejectStartup = reject;
        });
        const spawned = new Promise((resolve) => {
            child.once('spawn', resolve);
        });
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
        child.on('error', (error) => {
            if (!startupSettled) {
                startupSettled = true;
                rejectStartup?.(error);
                return;
            }
            const detail = {
                runtimeId: this.runtimeId,
                code: null,
                signal: null,
                error: error?.message || String(error)
            };
            for (const tab of this.tabs.values()) {
                tab.status = 'disconnected';
                tab.busy = false;
                tab.errorMessage = formatAgentStartupError(
                    this.definition,
                    error
                );
            }
            this.emit('runtime_exit', detail);
        });
        child.on('exit', (code, signal) => {
            if (!startupSettled) {
                startupSettled = true;
                rejectStartup?.(
                    new Error(
                        signal
                            ? `Agent runtime exited (${signal}) before `
                                + 'initialization completed.'
                            : `Agent runtime exited (${code ?? 'unknown'}) `
                                + 'before initialization completed.'
                    )
                );
            }
            startupSettled = true;
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

        await Promise.race([
            spawned,
            startupError
        ]);

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

        const result = await Promise.race([
            this.connection.initialize({
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
            }),
            startupError
        ]);
        startupSettled = true;

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
            title: meta.title || '',
            currentModeId: meta.currentModeId || '',
            availableModes: meta.availableModes || [],
            availableCommands: meta.availableCommands || [],
            configOptions: meta.configOptions || [],
            messages: [],
            toolCalls: [],
            permissions: [],
            plan: [],
            usage: meta.usage || null,
            terminals: meta.terminals || []
        });
        // For loadSession-capable runtimes, transcript ordering comes from the
        // authoritative replay stream, not the persisted snapshot.
        tab.restoreCapture = createRestoreCaptureState(meta.messages || [], {
            toolCalls: meta.toolCalls || []
        });
        tab.restoreCapture.nextTimelineOrder = () =>
            this.#nextTimelineOrder(tab);
        tab.status = 'restoring';
        tab.busy = true;

        this.tabs.set(tab.id, tab);
        this.sessionToTabId.set(tab.acpSessionId, tab.id);

        try {
            await this.#loadSessionIntoTab(tab, meta);
            this.#broadcast(tab, {
                type: 'snapshot',
                tab: this.serializeTab(tab)
            });
            return this.serializeTab(tab);
        } catch (error) {
            tab.restoreCapture = null;
            this.tabs.delete(tab.id);
            this.sessionToTabId.delete(tab.acpSessionId);
            throw error;
        }
    }

    async listSessions(options = {}) {
        await this.start();
        this.clearIdleShutdown();

        const sessionCapabilities = this.#getSessionCapabilities();
        const wantsAll = !!options.all;
        if (
            sessionCapabilities.list
            && typeof this.connection?.listSessions === 'function'
        ) {
            if (wantsAll && this.#supportsAllSessionListing()) {
                return await this.#listSessionsViaConnection({
                    cwd: options.cwd || this.cwd,
                    cursor: options.cursor || '',
                    all: true
                });
            }
            try {
                return await this.#listSessionsViaConnection({
                    cwd: options.cwd || this.cwd,
                    cursor: options.cursor || '',
                    all: false
                });
            } catch (error) {
                const message = String(error?.message || '');
                const canFallbackToCli = this.#supportsGeminiCliSessionListing();
                const unsupportedListMethod =
                    /method not found/i.test(message)
                    || /session\/list/i.test(message);
                if (!canFallbackToCli || !unsupportedListMethod) {
                    throw error;
                }
            }
        }
        if (this.#supportsGeminiCliSessionListing()) {
            return {
                sessions: await this.#listSessionsViaGeminiCli(),
                nextCursor: ''
            };
        }
        if (!sessionCapabilities.list) {
            throw new Error(
                `${this.definition.label} does not support session history`
            );
        }
        throw new Error(`${this.definition.label} session history unavailable`);
    }

    async resumeTab(meta) {
        await this.start();
        this.clearIdleShutdown();

        const sessionCapabilities = this.#getSessionCapabilities();
        if (!sessionCapabilities.load) {
            throw new Error(
                `${this.definition.label} does not support session restore`
            );
        }
        if (this.sessionToTabId.has(meta.acpSessionId)) {
            throw new Error('Session is already open');
        }

        const tab = this.#buildTab({
            id: meta.id,
            acpSessionId: meta.acpSessionId,
            terminalSessionId: meta.terminalSessionId,
            cwd: meta.cwd,
            createdAt: new Date().toISOString(),
            title: meta.title || ''
        });
        // Resume rebuilds transcript ordering from the runtime replay stream.
        tab.restoreCapture = createRestoreCaptureState([]);
        tab.restoreCapture.nextTimelineOrder = () =>
            this.#nextTimelineOrder(tab);
        tab.status = 'restoring';
        tab.busy = true;

        this.tabs.set(tab.id, tab);
        this.sessionToTabId.set(tab.acpSessionId, tab.id);

        try {
            await this.#loadSessionIntoTab(tab, meta);
            return this.serializeTab(tab);
        } catch (error) {
            this.tabs.delete(tab.id);
            this.sessionToTabId.delete(tab.acpSessionId);
            throw error;
        }
    }

    async #loadSessionIntoTab(tab, meta) {
        try {
            const response = await this.connection.loadSession({
                cwd: meta.cwd,
                sessionId: tab.acpSessionId,
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
            const replacedMessages = finalizeRestoreCaptureMessages(tab);
            tab.status = 'ready';
            tab.busy = false;
            tab.errorMessage = '';
            if (replacedMessages) {
                this.#markTabDirty(tab);
            }
            return replacedMessages;
        } catch (error) {
            tab.restoreCapture = null;
            throw error;
        }
    }

    #markTabDirty(tab) {
        if (!tab) return;
        this.emit('tab_dirty', {
            tabId: tab.id,
            sessionId: tab.acpSessionId
        });
    }

    serializeTab(tab) {
        tab.messages = normalizeAgentTranscriptMessages(tab.messages);
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
            sessionCapabilities: this.#getSessionCapabilities(),
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
        this.#markTabDirty(tab);

        const promptPromise = this.connection.prompt({
            sessionId: tab.acpSessionId,
            prompt: promptBlocks
        });

        void promptPromise.then(async (response) => {
            if (!this.tabs.has(tabId)) return;
            tab.busy = false;
            tab.status = 'ready';
            this.#settleStaleToolCalls(
                tab,
                response?.stopReason === 'cancelled'
                    ? 'cancelled'
                    : 'completed'
            );
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
            const hydratedChanges = await this.#hydrateFreshSessionMetadata(tab);
            this.#broadcastHydratedSessionMetadata(tab, hydratedChanges);
            this.#broadcast(tab, {
                type: 'complete',
                stopReason: response.stopReason,
                status: tab.status,
                busy: false
            });
            this.#markTabDirty(tab);
        }).catch((error) => {
            if (!this.tabs.has(tabId)) return;
            tab.busy = false;
            tab.status = 'error';
            this.#settleStaleToolCalls(tab, 'error');
            tab.errorMessage = formatAgentStartupError(
                tab.definition,
                error
            );
            tab.syntheticStreams.clear();
            tab.pendingUserEcho = null;
            this.#broadcast(tab, {
                type: 'status',
                status: tab.status,
                busy: false,
                errorMessage: tab.errorMessage
            });
            this.#markTabDirty(tab);
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
        this.#markTabDirty(tab);
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
        this.#markTabDirty(tab);
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
        this.#markTabDirty(tab);
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
        this.#markTabDirty(tab);
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
            await terminal.release({ destroy: true }).catch(() => {});
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
        const update = params.update;
        const tab = this.#getTabBySession(params.sessionId);
        if (!tab) return;
        let broadcastUpdate = update;
        let didChange = false;
        let suppressSessionUpdateBroadcast = false;

        switch (update.sessionUpdate) {
            case 'agent_message_chunk': {
                const result = this.#appendContentChunk(
                    tab,
                    update,
                    'assistant',
                    'message'
                );
                didChange = !!result.didChange;
                suppressSessionUpdateBroadcast = !!result.suppressBroadcast;
                break;
            }
            case 'agent_thought_chunk': {
                const result = this.#appendContentChunk(
                    tab,
                    update,
                    'assistant',
                    'thought'
                );
                didChange = !!result.didChange;
                suppressSessionUpdateBroadcast = !!result.suppressBroadcast;
                break;
            }
            case 'user_message_chunk': {
                const result = this.#appendContentChunk(
                    tab,
                    update,
                    'user',
                    'message'
                );
                didChange = !!result.didChange;
                suppressSessionUpdateBroadcast = !!result.suppressBroadcast;
                break;
            }
            case 'tool_call': {
                this.#advanceSyntheticStreamTurn(tab);
                const baseline = tab.restoreCapture?.baselineToolCalls?.get(
                    update.toolCallId
                ) || null;
                const previous = tab.toolCalls.get(update.toolCallId) || null;
                const nextToolCall = buildRestoredToolCall(
                    previous,
                    baseline,
                    update,
                    () => this.#nextTimelineOrder(tab)
                );
                tab.toolCalls.set(update.toolCallId, nextToolCall);
                broadcastUpdate = nextToolCall;
                didChange = true;
                break;
            }
            case 'tool_call_update': {
                this.#advanceSyntheticStreamTurn(tab);
                const previous = tab.toolCalls.get(update.toolCallId) || null;
                const baseline = tab.restoreCapture?.baselineToolCalls?.get(
                    update.toolCallId
                ) || null;
                const nextToolCall = buildRestoredToolCall(
                    previous,
                    baseline,
                    update,
                    () => this.#nextTimelineOrder(tab)
                );
                tab.toolCalls.set(update.toolCallId, nextToolCall);
                broadcastUpdate = nextToolCall;
                didChange = true;
                break;
            }
            case 'current_mode_update':
                tab.currentModeId = update.currentModeId || update.modeId || '';
                didChange = true;
                break;
            case 'available_commands_update':
                tab.availableCommands = this.#resolveAvailableCommands(
                    update.availableCommands,
                    tab.availableCommands
                );
                didChange = true;
                break;
            case 'config_option_update':
                tab.configOptions = this.#resolveConfigOptions(
                    update.configOptions,
                    tab.configOptions
                );
                didChange = true;
                break;
            case 'session_info_update':
                if (typeof update.title === 'string') {
                    tab.title = update.title;
                } else if (update.title === null) {
                    tab.title = '';
                }
                didChange = true;
                break;
            case 'plan':
                tab.plan = normalizePlanEntries(update.entries);
                didChange = true;
                break;
            case 'usage_update':
                tab.usage = mergeUsageState(tab.usage, update);
                didChange = true;
                break;
            default:
                break;
        }

        if (!suppressSessionUpdateBroadcast) {
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
        if (didChange) {
            this.#markTabDirty(tab);
        }
    }

    #appendContentChunk(tab, update, role, kind) {
        const content = update.content;
        const text = content.type === 'text'
            ? (content.text || '')
            : `[${content.type}]`;
        if (role === 'user' && kind === 'message' && this.#consumeUserEcho(tab, text)) {
            return {
                didChange: false,
                suppressBroadcast: false
            };
        }
        if (tab.restoreCapture) {
            captureRestoreReplayChunk(tab.restoreCapture, update, role, kind, text);
            return {
                didChange: false,
                suppressBroadcast: true
            };
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
            return {
                didChange: true,
                suppressBroadcast: false
            };
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
        return {
            didChange: true,
            suppressBroadcast: false
        };
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
        this.#markTabDirty(tab);

        return new Promise((resolve) => {
            request.resolve = resolve;
        });
    }

    async #hydrateFreshSessionMetadata(tab) {
        const previous = {
            title: tab.title || '',
            currentModeId: tab.currentModeId || '',
            availableModes: JSON.stringify(tab.availableModes || []),
            availableCommands: JSON.stringify(tab.availableCommands || []),
            configOptions: JSON.stringify(tab.configOptions || [])
        };
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
            return null;
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
            return {
                titleChanged: previous.title !== (tab.title || ''),
                modeChanged: previous.currentModeId !== (tab.currentModeId || ''),
                modesChanged: previous.availableModes
                    !== JSON.stringify(tab.availableModes || []),
                commandsChanged: previous.availableCommands
                    !== JSON.stringify(tab.availableCommands || []),
                configChanged: previous.configOptions
                    !== JSON.stringify(tab.configOptions || [])
            };
        } catch {
            // Ignore metadata hydration failures for fresh sessions.
            return null;
        }
    }

    #broadcastHydratedSessionMetadata(tab, changes) {
        if (!changes) return;
        const tabMeta = {
            title: tab.title,
            currentModeId: tab.currentModeId,
            availableModes: tab.availableModes,
            availableCommands: tab.availableCommands,
            configOptions: tab.configOptions
        };
        if (changes.titleChanged) {
            this.#broadcast(tab, {
                type: 'session_update',
                update: {
                    sessionUpdate: 'session_info_update',
                    title: tab.title || null
                },
                tab: tabMeta
            });
        }
        if (changes.modeChanged || changes.modesChanged) {
            this.#broadcast(tab, {
                type: 'session_update',
                update: {
                    sessionUpdate: 'current_mode_update',
                    currentModeId: tab.currentModeId || '',
                    availableModes: tab.availableModes
                },
                tab: tabMeta
            });
        }
        if (changes.commandsChanged) {
            this.#broadcast(tab, {
                type: 'session_update',
                update: {
                    sessionUpdate: 'available_commands_update',
                    availableCommands: tab.availableCommands
                },
                tab: tabMeta
            });
        }
        if (changes.configChanged) {
            this.#broadcast(tab, {
                type: 'session_update',
                update: {
                    sessionUpdate: 'config_option_update',
                    configOptions: tab.configOptions
                },
                tab: tabMeta
            });
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
        const tab = this.#getTabBySession(params.sessionId);
        const terminal = this.terminalManager
            ? new ManagedTerminalSession(params, this.terminalManager, {
                agentId: tab?.agentId || this.definition.id,
                agentLabel: tab?.agentLabel || this.definition.label
            })
            : new LocalExecTerminal(params);
        this.terminals.set(terminal.id, terminal);
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

    async releaseManagedTerminalSession(
        terminalSessionId,
        options = {}
    ) {
        const targetSessionId = String(terminalSessionId || '').trim();
        if (!targetSessionId) return false;
        for (const [terminalId, terminal] of this.terminals.entries()) {
            if (terminal?.terminalSessionId !== targetSessionId) continue;
            await terminal.release({ destroy: options.destroy !== false });
            if (options.destroy !== false) {
                this.terminals.delete(terminalId);
            }
            this.#syncTerminalSummary(terminal.sessionId, terminal, {
                released: true
            });
            return true;
        }
        return false;
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
        await terminal.release({ destroy: true });
        this.terminals.delete(params.terminalId);
        this.#syncTerminalSummary(params.sessionId, terminal, {
            released: true,
            terminalSessionId: ''
        });
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
        if (!tab.busy) {
            this.#settleStaleToolCalls(
                tab,
                tab.status === 'error' ? 'error' : 'completed'
            );
        }
        this.#broadcast(tab, {
            type: 'terminal_update',
            terminal: tab.terminals.get(terminal.id)
        });
        this.#markTabDirty(tab);
    }

    #toolCallHasRunningTerminal(tab, toolCall) {
        for (const terminalId of getToolCallTerminalIds(toolCall)) {
            const terminal = tab.terminals.get(terminalId);
            if (terminal?.running) {
                return true;
            }
        }
        return false;
    }

    #settleStaleToolCalls(tab, nextStatus = 'completed') {
        let didChange = false;
        for (const [toolCallId, toolCall] of tab.toolCalls.entries()) {
            const statusClass = normalizeToolStatusClass(toolCall?.status);
            if (
                statusClass !== 'pending'
                && statusClass !== 'running'
            ) {
                continue;
            }
            if (this.#toolCallHasRunningTerminal(tab, toolCall)) {
                continue;
            }
            const nextToolCall = {
                ...toolCall,
                status: nextStatus
            };
            tab.toolCalls.set(toolCallId, nextToolCall);
            this.#broadcast(tab, {
                type: 'session_update',
                update: {
                    sessionUpdate: 'tool_call_update',
                    ...nextToolCall
                },
                tab: {
                    title: tab.title,
                    currentModeId: tab.currentModeId,
                    availableModes: tab.availableModes,
                    availableCommands: tab.availableCommands,
                    configOptions: tab.configOptions
                }
            });
            didChange = true;
        }
        if (didChange) {
            this.#markTabDirty(tab);
        }
        return didChange;
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
        this.terminalManager = options.terminalManager || null;
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
        this.transcriptPersistDelayMs = options.transcriptPersistDelayMs
            || DEFAULT_TRANSCRIPT_PERSIST_DELAY_MS;
        this.persistTabsTimer = null;
        this.disposing = false;
        this.restoring = false;
        this.agentConfigs = {};
        this.agentConfigVersions = new Map();
        this.definitionAvailabilityOverrides = new Map();
        this.availabilityOverrideTtlMs =
            options.availabilityOverrideTtlMs
            || DEFAULT_AVAILABILITY_OVERRIDE_TTL_MS;
        this.availabilityProbes = options.availabilityProbes
            || DEFAULT_AVAILABILITY_PROBES;
        this.configLoaded = false;
    }

    #getDefinitionAvailabilityOverride(agentId) {
        const entry = this.definitionAvailabilityOverrides.get(agentId);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now()) {
            this.definitionAvailabilityOverrides.delete(agentId);
            return null;
        }
        return entry;
    }

    #setDefinitionAvailabilityOverride(agentId, availability = {}) {
        this.definitionAvailabilityOverrides.set(agentId, {
            available: Boolean(availability.available),
            reason: String(availability.reason || ''),
            expiresAt: Date.now() + this.availabilityOverrideTtlMs
        });
    }

    #clearDefinitionAvailabilityOverride(agentId) {
        this.definitionAvailabilityOverrides.delete(agentId);
    }

    #recordDefinitionStartupFailure(definition, error) {
        const reason = formatAgentStartupError(definition, error);
        if (!reason) return;
        this.#setDefinitionAvailabilityOverride(definition.id, {
            available: false,
            reason
        });
    }

    getDefinitionAvailability(definition) {
        const baseAvailability = getDefinitionAvailability(
            definition,
            this.getAgentConfig(definition.id),
            this.availabilityProbes
        );
        if (!baseAvailability.available) {
            this.#clearDefinitionAvailabilityOverride(definition.id);
            return baseAvailability;
        }
        return this.#getDefinitionAvailabilityOverride(definition.id)
            || baseAvailability;
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
        this.#clearDefinitionAvailabilityOverride(agentId);
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
        this.#clearDefinitionAvailabilityOverride(agentId);
        this.agentConfigVersions.set(
            agentId,
            this.getAgentConfigVersion(agentId) + 1
        );
        await this.queuePersistence(() => this.saveConfigs(this.agentConfigs));
        return this.getSerializedAgentConfig(agentId);
    }

    #ensureRuntimeEntry(definition, cwd) {
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
                terminalManager: this.terminalManager,
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
            runtime.on('tab_dirty', () => {
                this.schedulePersistTabs();
            });
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

        return {
            runtimeEntry,
            createdRuntime,
            runtimeStoreKey
        };
    }

    async #disposeRuntimeEntry(runtimeStoreKey, runtimeEntry) {
        if (!runtimeEntry) return;
        this.runtimes.delete(runtimeStoreKey);
        await runtimeEntry.runtime.dispose().catch(() => {});
    }

    #applyRuntimeMetadataFallback(runtime, serialized) {
        if (!serialized || typeof serialized !== 'object') {
            return serialized;
        }

        const sessionCapabilities = normalizeAgentSessionCapabilities(
            runtime?.agentCapabilities,
            runtime?.connection,
            runtime?.definition?.id
        );
        const hasSessionCapabilities = serialized.sessionCapabilities
            && typeof serialized.sessionCapabilities === 'object';

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
            if (hasSessionCapabilities) {
                return serialized;
            }
            return {
                ...serialized,
                sessionCapabilities
            };
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
            && hasSessionCapabilities
        ) {
            return serialized;
        }

        return {
            ...serialized,
            availableModes,
            availableCommands,
            configOptions,
            sessionCapabilities
        };
    }

    queuePersistence(operation) {
        this.persistenceChain = this.persistenceChain
            .catch(() => {})
            .then(operation);
        return this.persistenceChain;
    }

    clearPendingTabPersistence() {
        if (this.persistTabsTimer) {
            clearTimeout(this.persistTabsTimer);
            this.persistTabsTimer = null;
        }
    }

    schedulePersistTabs() {
        if (this.disposing || this.persistTabsTimer) {
            return;
        }
        this.persistTabsTimer = setTimeout(() => {
            this.persistTabsTimer = null;
            void this.persistTabs();
        }, this.transcriptPersistDelayMs);
    }

    #getSerializedTabs() {
        const serializedTabs = Array.from(this.tabs.values()).map((entry) => {
            const tab = entry.serialize();
            return {
                id: tab.id,
                agentId: tab.agentId,
                cwd: tab.cwd,
                acpSessionId: tab.acpSessionId,
                terminalSessionId: tab.terminalSessionId,
                createdAt: tab.createdAt,
                title: tab.title || '',
                currentModeId: tab.currentModeId || '',
                availableModes: Array.isArray(tab.availableModes)
                    ? cloneSerializable(tab.availableModes, [])
                    : [],
                availableCommands: Array.isArray(tab.availableCommands)
                    ? cloneSerializable(tab.availableCommands, [])
                    : [],
                configOptions: Array.isArray(tab.configOptions)
                    ? cloneSerializable(tab.configOptions, [])
                    : [],
                messages: Array.isArray(tab.messages)
                    ? cloneSerializable(tab.messages, [])
                    : [],
                toolCalls: Array.isArray(tab.toolCalls)
                    ? cloneSerializable(tab.toolCalls, [])
                    : [],
                permissions: Array.isArray(tab.permissions)
                    ? cloneSerializable(tab.permissions, [])
                    : [],
                plan: Array.isArray(tab.plan)
                    ? cloneSerializable(tab.plan, [])
                    : [],
                usage: tab.usage ? cloneSerializable(tab.usage, null) : null,
                terminals: Array.isArray(tab.terminals)
                    ? cloneSerializable(tab.terminals, [])
                    : []
            };
        });
        return dedupeSerializedTabs(serializedTabs).tabs;
    }

    #findOpenSerializedTabBySessionId(sessionId) {
        const targetSessionId = String(sessionId || '').trim();
        if (!targetSessionId) {
            return null;
        }
        return this.#getSerializedTabs().find(
            (tab) => String(tab?.acpSessionId || '').trim() === targetSessionId
        ) || null;
    }

    getPersistedTabs() {
        return this.#getSerializedTabs();
    }

    persistTabs() {
        this.clearPendingTabPersistence();
        return this.queuePersistence(() => this.saveTabs(this.getPersistedTabs()));
    }

    async listDefinitions() {
        await this.ensureConfigsLoaded();
        return this.definitions.map((definition) => {
            const availability = this.getDefinitionAvailability(definition);
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
            tabs: this.#getSerializedTabs()
        };
    }

    async listInventory() {
        const tabs = this.#getSerializedTabs();
        return {
            restoring: this.restoring,
            tabs: tabs.map((serialized) => {
                return {
                    id: serialized.id,
                    runtimeId: serialized.runtimeId,
                    runtimeKey: serialized.runtimeKey,
                    acpSessionId: serialized.acpSessionId,
                    agentId: serialized.agentId,
                    agentLabel: serialized.agentLabel,
                    commandLabel: serialized.commandLabel,
                    title: serialized.title,
                    terminalSessionId: serialized.terminalSessionId,
                    cwd: serialized.cwd,
                    createdAt: serialized.createdAt,
                    status: serialized.status,
                    busy: serialized.busy,
                    errorMessage: serialized.errorMessage,
                    currentModeId: serialized.currentModeId,
                    sessionCapabilities: serialized.sessionCapabilities
                };
            })
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
        const availability = this.getDefinitionAvailability(definition);
        if (!availability.available) {
            throw new Error(availability.reason || 'Agent unavailable');
        }

        const cwd = path.resolve(options.cwd || process.cwd());
        const { runtimeEntry, createdRuntime, runtimeStoreKey } =
            this.#ensureRuntimeEntry(definition, cwd);

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
            this.#clearDefinitionAvailabilityOverride(definition.id);
            await this.persistTabs();
            return tabEntry.serialize();
        } catch (error) {
            const shouldDisposeRuntime = createdRuntime
                || runtimeEntry.runtime.tabs.size === 0;
            if (shouldDisposeRuntime) {
                await this.#disposeRuntimeEntry(runtimeStoreKey, runtimeEntry);
            }
            this.#recordDefinitionStartupFailure(definition, error);
            throw new Error(formatAgentStartupError(definition, error));
        }
    }

    async listSessions(options) {
        await this.ensureConfigsLoaded();
        const definition = this.definitions.find(
            (entry) => entry.id === options.agentId
        );
        if (!definition) {
            throw new Error('Unknown agent');
        }
        const availability = this.getDefinitionAvailability(definition);
        if (!availability.available) {
            throw new Error(availability.reason || 'Agent unavailable');
        }

        const cwd = path.resolve(options.cwd || process.cwd());
        const { runtimeEntry, createdRuntime, runtimeStoreKey } =
            this.#ensureRuntimeEntry(definition, cwd);
        const cursor = typeof options.cursor === 'string' ? options.cursor : '';
        const sessionCapabilities = (
            typeof runtimeEntry.runtime.getSessionCapabilities === 'function'
                ? runtimeEntry.runtime.getSessionCapabilities()
                : {}
        );
        const canListAll = !!(options.all && sessionCapabilities.listAll);

        try {
            const result = await runtimeEntry.runtime.listSessions({
                cwd,
                all: canListAll,
                cursor
            });
            this.#clearDefinitionAvailabilityOverride(definition.id);
            if (runtimeEntry.runtime.tabs.size === 0) {
                runtimeEntry.runtime.scheduleIdleShutdown(async () => {
                    if (runtimeEntry.runtime.tabs.size > 0) return;
                    await this.#disposeRuntimeEntry(
                        runtimeStoreKey,
                        runtimeEntry
                    );
                });
            }
            return result;
        } catch (error) {
            if (createdRuntime && runtimeEntry.runtime.tabs.size === 0) {
                await this.#disposeRuntimeEntry(runtimeStoreKey, runtimeEntry);
            }
            throw error;
        }
    }

    async listResumeSessions(options) {
        await this.ensureConfigsLoaded();
        const definition = this.definitions.find(
            (entry) => entry.id === options.agentId
        );
        if (!definition) {
            throw new Error('Unknown agent');
        }
        const availability = this.getDefinitionAvailability(definition);
        if (!availability.available) {
            throw new Error(availability.reason || 'Agent unavailable');
        }

        const cwd = path.resolve(options.cwd || process.cwd());
        const { runtimeEntry, createdRuntime, runtimeStoreKey } =
            this.#ensureRuntimeEntry(definition, cwd);
        const branchLimit = 500;
        const mergedLimit = 300;

        const listBranch = async (all) => {
            const sessions = [];
            let nextCursor = '';
            const seenCursors = new Set();
            for (;;) {
                const result = await runtimeEntry.runtime.listSessions({
                    cwd,
                    all,
                    cursor: nextCursor
                });
                sessions.push(...(Array.isArray(result?.sessions)
                    ? result.sessions
                    : []));
                if (sessions.length >= branchLimit) {
                    return sessions.slice(0, branchLimit);
                }
                const previousCursor = nextCursor;
                nextCursor = typeof result?.nextCursor === 'string'
                    ? result.nextCursor
                    : '';
                if (!nextCursor) {
                    break;
                }
                if (nextCursor === previousCursor || seenCursors.has(nextCursor)) {
                    break;
                }
                seenCursors.add(nextCursor);
            }
            return sessions;
        };

        const cwdPromise = listBranch(false);
        const allPromise = listBranch(true);

        try {
            const settled = await Promise.allSettled([
                cwdPromise,
                allPromise
            ]);
            const cwdResult = settled[0];
            const allResult = settled[1] || null;
            const cwdSessions = cwdResult?.status === 'fulfilled'
                ? cwdResult.value
                : [];
            const allSessions = allResult?.status === 'fulfilled'
                && Array.isArray(allResult.value)
                ? allResult.value
                : [];

            if (cwdSessions.length === 0 && allSessions.length === 0) {
                throw (
                    cwdResult?.reason
                    || allResult?.reason
                    || new Error('Failed to list agent sessions')
                );
            }

            const merged = [];
            const seen = new Set();
            for (const session of [...cwdSessions, ...allSessions]) {
                const sessionId = String(session?.sessionId || '').trim();
                if (!sessionId || seen.has(sessionId)) continue;
                seen.add(sessionId);
                merged.push(session);
                if (merged.length >= mergedLimit) {
                    break;
                }
            }

            this.#clearDefinitionAvailabilityOverride(definition.id);
            if (runtimeEntry.runtime.tabs.size === 0) {
                runtimeEntry.runtime.scheduleIdleShutdown(async () => {
                    if (runtimeEntry.runtime.tabs.size > 0) return;
                    await this.#disposeRuntimeEntry(
                        runtimeStoreKey,
                        runtimeEntry
                    );
                });
            }

            return {
                sessions: merged,
                scope: allResult?.status === 'fulfilled'
                    ? 'merged'
                    : 'cwd'
            };
        } catch (error) {
            if (createdRuntime && runtimeEntry.runtime.tabs.size === 0) {
                await this.#disposeRuntimeEntry(runtimeStoreKey, runtimeEntry);
            }
            throw error;
        }
    }

    async resumeTab(options) {
        await this.ensureConfigsLoaded();
        const definition = this.definitions.find(
            (entry) => entry.id === options.agentId
        );
        if (!definition) {
            throw new Error('Unknown agent');
        }
        const availability = this.getDefinitionAvailability(definition);
        if (!availability.available) {
            throw new Error(availability.reason || 'Agent unavailable');
        }

        const existingTab = this.#findOpenSerializedTabBySessionId(
            options.sessionId
        );
        if (existingTab) {
            return existingTab;
        }

        const cwd = path.resolve(options.cwd || process.cwd());
        const { runtimeEntry, createdRuntime, runtimeStoreKey } =
            this.#ensureRuntimeEntry(definition, cwd);
        const tabId = crypto.randomUUID();

        try {
            const rawSerialized = await runtimeEntry.runtime.resumeTab({
                id: tabId,
                acpSessionId: options.sessionId,
                cwd,
                terminalSessionId: options.terminalSessionId || '',
                title: options.title || ''
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
            this.#clearDefinitionAvailabilityOverride(definition.id);
            await this.persistTabs();
            return tabEntry.serialize();
        } catch (error) {
            const shouldDisposeRuntime = createdRuntime
                || runtimeEntry.runtime.tabs.size === 0;
            if (shouldDisposeRuntime) {
                await this.#disposeRuntimeEntry(runtimeStoreKey, runtimeEntry);
            }
            throw error;
        }
    }

    async restoreTabs(validTerminalSessionIds = new Set()) {
        await this.ensureConfigsLoaded();
        const dedupedTabs = dedupeSerializedTabs(await this.loadTabs());
        const entries = dedupedTabs.tabs;
        let changed = false;
        if (dedupedTabs.changed) {
            changed = true;
        }

        for (const meta of entries) {
            const existingTab = this.#findOpenSerializedTabBySessionId(
                meta.acpSessionId
            );
            if (existingTab) {
                changed = true;
                continue;
            }
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

            const availability = this.getDefinitionAvailability(definition);
            if (!availability.available) {
                changed = true;
                continue;
            }

            const cwd = path.resolve(meta.cwd || process.cwd());
            const { runtimeEntry } = this.#ensureRuntimeEntry(definition, cwd);

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
                this.#clearDefinitionAvailabilityOverride(definition.id);
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

    async releaseManagedTerminalSession(
        terminalSessionId,
        options = {}
    ) {
        const targetSessionId = String(terminalSessionId || '').trim();
        if (!targetSessionId) return false;
        for (const runtimeEntry of this.runtimes.values()) {
            if (
                typeof runtimeEntry.runtime.releaseManagedTerminalSession
                !== 'function'
            ) {
                continue;
            }
            const released = await runtimeEntry.runtime
                .releaseManagedTerminalSession(targetSessionId, options);
            if (released) {
                return true;
            }
        }
        return false;
    }

    async dispose({ preserveTabs = true } = {}) {
        this.disposing = true;
        this.clearPendingTabPersistence();
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
