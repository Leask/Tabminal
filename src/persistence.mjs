import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const HOME_DIR = os.homedir();
const BASE_DIR = path.join(HOME_DIR, '.tabminal');
const SESSIONS_DIR = path.join(BASE_DIR, 'sessions');
const MEMORY_FILE = path.join(BASE_DIR, 'memory.json');
const CLUSTER_FILE = path.join(BASE_DIR, 'cluster.json');
const AGENT_TABS_FILE = path.join(BASE_DIR, 'agent-tabs.json');
const AGENT_CONFIG_FILE = path.join(BASE_DIR, 'agent-config.json');
const AUTH_SESSIONS_FILE = path.join(BASE_DIR, 'auth-sessions.json');
const getSessionSnapshotPath = (id) => path.join(SESSIONS_DIR, `${id}.snapshot`);

// Ensure directories exist
const init = async () => {
    try {
        await fs.mkdir(SESSIONS_DIR, { recursive: true });
    } catch (e) {
        console.error('[Persistence] Failed to create directories:', e);
    }
};

// --- Session Persistence ---

export const saveSession = async (id, data) => {
    await init();
    const filePath = path.join(SESSIONS_DIR, `${id}.json`);
    try {
        // We only save serializable data
        const serializable = {
            id: data.id,
            title: data.title,
            cwd: data.cwd,
            env: data.env,
            cols: data.cols,
            rows: data.rows,
            createdAt: data.createdAt,
            // Editor State
            editorState: data.editorState || {},
            workspaceState: data.editorState || {},
            executions: data.executions || []
        };
        await fs.writeFile(filePath, JSON.stringify(serializable, null, 2));
    } catch (e) {
        console.error(`[Persistence] Failed to save session ${id}:`, e);
    }
};

export const deleteSession = async (id) => {
    const jsonPath = path.join(SESSIONS_DIR, `${id}.json`);
    const logPath = path.join(SESSIONS_DIR, `${id}.log`);
    const snapshotPath = getSessionSnapshotPath(id);
    
    try {
        await fs.unlink(jsonPath);
    } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[Persistence] Failed to delete session config ${id}:`, e);
    }

    try {
        await fs.unlink(logPath);
    } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[Persistence] Failed to delete session log ${id}:`, e);
    }

    try {
        await fs.unlink(snapshotPath);
    } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[Persistence] Failed to delete session snapshot ${id}:`, e);
    }
};

export const loadSessions = async () => {
    await init();
    try {
        const files = await fs.readdir(SESSIONS_DIR);
        const sessions = [];
        for (const file of files) {
            if (file.endsWith('.json')) {
                try {
                    const content = await fs.readFile(path.join(SESSIONS_DIR, file), 'utf-8');
                    sessions.push(JSON.parse(content));
                } catch (e) {
                    console.warn(`[Persistence] Failed to parse session file ${file}, deleting it:`, e);
                    try {
                        await fs.unlink(path.join(SESSIONS_DIR, file));
                    } catch (delErr) {
                        console.error(`[Persistence] Failed to delete corrupted file ${file}:`, delErr);
                    }
                }
            }
        }
        // Sort by creation time if possible, or just return
        return sessions.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    } catch (e) {
        console.error('[Persistence] Failed to load sessions:', e);
        return [];
    }
};

// --- Memory Persistence (Global State) ---

const defaultMemory = {
    expandedFolders: [] // Array of { path: string, timestamp: number }
};

export const loadMemory = async () => {
    await init();
    try {
        const content = await fs.readFile(MEMORY_FILE, 'utf-8');
        return { ...defaultMemory, ...JSON.parse(content) };
    } catch {
        return defaultMemory;
    }
};

export const saveMemory = async (memory) => {
    await init();
    try {
        await fs.writeFile(MEMORY_FILE, JSON.stringify(memory, null, 2));
    } catch (e) {
        console.error('[Persistence] Failed to save memory:', e);
    }
};

export const updateExpandedFolder = async (folderPath, isExpanded) => {
    const memory = await loadMemory();
    let list = memory.expandedFolders || [];

    if (isExpanded) {
        // Remove existing if present (to update timestamp/position)
        list = list.filter(item => item.path !== folderPath);
        // Add to top
        list.unshift({ path: folderPath, timestamp: Date.now() });
        // Limit to 100
        if (list.length > 100) {
            list = list.slice(0, 100);
        }
    } else {
        // Remove
        list = list.filter(item => item.path !== folderPath);
    }

    memory.expandedFolders = list;
    await saveMemory(memory);
    return list.map(item => item.path); // Return just paths for frontend
};

export const getExpandedFolders = async () => {
    const memory = await loadMemory();
    return (memory.expandedFolders || []).map(item => item.path);
};

// --- Cluster Persistence (Server Registry) ---

function normalizeClusterServers(servers) {
    if (!Array.isArray(servers)) return [];
    const normalized = [];
    for (const entry of servers) {
        if (!entry || typeof entry !== 'object') continue;
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        const baseUrl = typeof entry.baseUrl === 'string'
            ? entry.baseUrl.trim()
            : '';
        const host = typeof entry.host === 'string' ? entry.host.trim() : '';
        const token = typeof entry.token === 'string' ? entry.token.trim() : '';
        if (!id || !baseUrl) continue;
        normalized.push({ id, baseUrl, host, token });
    }
    return normalized;
}

export const loadCluster = async () => {
    await init();
    try {
        const content = await fs.readFile(CLUSTER_FILE, 'utf-8');
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
            return normalizeClusterServers(parsed);
        }
        return normalizeClusterServers(parsed?.servers);
    } catch {
        return [];
    }
};

export const saveCluster = async (servers) => {
    await init();
    const normalized = normalizeClusterServers(servers);
    const payload = { servers: normalized };
    try {
        await fs.writeFile(CLUSTER_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
        console.error('[Persistence] Failed to save cluster:', e);
        throw e;
    }
};

// --- Auth Session Persistence ---

function normalizeAuthSessions(sessions) {
    if (!Array.isArray(sessions)) return [];
    const normalized = [];
    for (const entry of sessions) {
        if (!entry || typeof entry !== 'object') continue;
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        const passwordFingerprint = typeof entry.passwordFingerprint === 'string'
            ? entry.passwordFingerprint.trim()
            : '';
        const refreshTokenHash = typeof entry.refreshTokenHash === 'string'
            ? entry.refreshTokenHash.trim()
            : '';
        const createdAt = typeof entry.createdAt === 'string'
            ? entry.createdAt.trim()
            : '';
        const lastSeenAt = typeof entry.lastSeenAt === 'string'
            ? entry.lastSeenAt.trim()
            : '';
        const refreshExpiresAt = typeof entry.refreshExpiresAt === 'string'
            ? entry.refreshExpiresAt.trim()
            : '';
        const rotatedAt = typeof entry.rotatedAt === 'string'
            ? entry.rotatedAt.trim()
            : '';
        const revokedAt = typeof entry.revokedAt === 'string'
            ? entry.revokedAt.trim()
            : '';
        const userAgent = typeof entry.userAgent === 'string'
            ? entry.userAgent.trim()
            : '';
        if (!id || !passwordFingerprint || !refreshTokenHash) continue;
        normalized.push({
            id,
            passwordFingerprint,
            refreshTokenHash,
            createdAt,
            lastSeenAt,
            refreshExpiresAt,
            rotatedAt,
            revokedAt,
            userAgent
        });
    }
    return normalized;
}

export const loadAuthSessions = async () => {
    await init();
    try {
        const content = await fs.readFile(AUTH_SESSIONS_FILE, 'utf-8');
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
            return normalizeAuthSessions(parsed);
        }
        return normalizeAuthSessions(parsed?.sessions);
    } catch {
        return [];
    }
};

export const saveAuthSessions = async (sessions) => {
    await init();
    const normalized = normalizeAuthSessions(sessions);
    const payload = { sessions: normalized };
    try {
        await fs.writeFile(AUTH_SESSIONS_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
        console.error('[Persistence] Failed to save auth sessions:', e);
        throw e;
    }
};

// --- ACP Agent Tab Persistence ---

function normalizeAgentTabs(tabs) {
    if (!Array.isArray(tabs)) return [];
    const normalized = [];
    for (const entry of tabs) {
        if (!entry || typeof entry !== 'object') continue;
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        const agentId = typeof entry.agentId === 'string'
            ? entry.agentId.trim()
            : '';
        const cwd = typeof entry.cwd === 'string' ? entry.cwd.trim() : '';
        const acpSessionId = typeof entry.acpSessionId === 'string'
            ? entry.acpSessionId.trim()
            : '';
        const terminalSessionId = typeof entry.terminalSessionId === 'string'
            ? entry.terminalSessionId.trim()
            : '';
        const createdAt = typeof entry.createdAt === 'string'
            ? entry.createdAt.trim()
            : '';
        const title = typeof entry.title === 'string'
            ? entry.title
            : '';
        const currentModeId = typeof entry.currentModeId === 'string'
            ? entry.currentModeId
            : '';
        const availableModes = Array.isArray(entry.availableModes)
            ? entry.availableModes
            : [];
        const availableCommands = Array.isArray(entry.availableCommands)
            ? entry.availableCommands
            : [];
        const configOptions = Array.isArray(entry.configOptions)
            ? entry.configOptions
            : [];
        const messages = Array.isArray(entry.messages)
            ? entry.messages
            : [];
        const toolCalls = Array.isArray(entry.toolCalls)
            ? entry.toolCalls
            : [];
        const permissions = Array.isArray(entry.permissions)
            ? entry.permissions
            : [];
        const plan = Array.isArray(entry.plan)
            ? entry.plan
            : [];
        const usage = entry.usage && typeof entry.usage === 'object'
            ? entry.usage
            : null;
        const terminals = Array.isArray(entry.terminals)
            ? entry.terminals
            : [];
        if (!id || !agentId || !cwd || !acpSessionId) continue;
        normalized.push({
            id,
            agentId,
            cwd,
            acpSessionId,
            terminalSessionId,
            createdAt,
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
    }
    return normalized;
}

export const loadAgentTabs = async () => {
    await init();
    try {
        const content = await fs.readFile(AGENT_TABS_FILE, 'utf-8');
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
            return normalizeAgentTabs(parsed);
        }
        return normalizeAgentTabs(parsed?.tabs);
    } catch {
        return [];
    }
};

export const saveAgentTabs = async (tabs) => {
    await init();
    const normalized = normalizeAgentTabs(tabs);
    const payload = { tabs: normalized };
    try {
        await fs.writeFile(AGENT_TABS_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
        console.error('[Persistence] Failed to save agent tabs:', e);
        throw e;
    }
};

// --- ACP Agent Config Persistence ---

function normalizeAgentEnv(env) {
    if (!env || typeof env !== 'object') return {};
    const normalized = {};
    for (const [key, value] of Object.entries(env)) {
        if (typeof key !== 'string' || !key.trim()) continue;
        normalized[key.trim()] = typeof value === 'string' ? value : '';
    }
    return normalized;
}

function normalizeAgentConfigs(configs) {
    if (!configs || typeof configs !== 'object') return {};
    const normalized = {};
    for (const [agentId, entry] of Object.entries(configs)) {
        if (typeof agentId !== 'string' || !agentId.trim()) continue;
        normalized[agentId.trim()] = {
            env: normalizeAgentEnv(entry?.env)
        };
    }
    return normalized;
}

export const loadAgentConfigs = async () => {
    await init();
    try {
        const content = await fs.readFile(AGENT_CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(content);
        return normalizeAgentConfigs(parsed?.agents || parsed);
    } catch {
        return {};
    }
};

export const saveAgentConfigs = async (configs) => {
    await init();
    const normalized = normalizeAgentConfigs(configs);
    const payload = { agents: normalized };
    try {
        await fs.writeFile(AGENT_CONFIG_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
        console.error('[Persistence] Failed to save agent configs:', e);
        throw e;
    }
};

// --- Raw Log Persistence ---

export const appendSessionLog = async (id, chunk) => {
    await init();
    const filePath = path.join(SESSIONS_DIR, `${id}.log`);
    try {
        await fs.appendFile(filePath, chunk);
    } catch (e) {
        console.error(`[Persistence] Failed to append log for ${id}:`, e);
    }
};

export const saveSessionSnapshot = async (id, snapshot) => {
    await init();
    const filePath = getSessionSnapshotPath(id);
    try {
        await fs.writeFile(filePath, snapshot, 'utf8');
    } catch (e) {
        console.error(`[Persistence] Failed to save snapshot for ${id}:`, e);
    }
};

export const loadSessionLog = async (id, limit = 1024 * 1024) => {
    const filePath = path.join(SESSIONS_DIR, `${id}.log`);
    try {
        const stats = await fs.stat(filePath);
        const size = stats.size;
        const start = Math.max(0, size - limit);
        const length = size - start;
        
        if (length <= 0) return '';

        const handle = await fs.open(filePath, 'r');
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        await handle.close();
        
        return buffer.toString('utf-8');
    } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[Persistence] Failed to load log for ${id}:`, e);
        return '';
    }
};

export const loadSessionSnapshot = async (id) => {
    const filePath = getSessionSnapshotPath(id);
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch (e) {
        if (e.code !== 'ENOENT') {
            console.error(
                `[Persistence] Failed to load snapshot for ${id}:`,
                e
            );
        }
    }

    return loadSessionLog(id);
};
