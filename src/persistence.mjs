import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const HOME_DIR = os.homedir();
const BASE_DIR = path.join(HOME_DIR, '.tabminal');
const SESSIONS_DIR = path.join(BASE_DIR, 'sessions');
const MEMORY_FILE = path.join(BASE_DIR, 'memory.json');

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
            editorState: data.editorState || {}
        };
        await fs.writeFile(filePath, JSON.stringify(serializable, null, 2));
    } catch (e) {
        console.error(`[Persistence] Failed to save session ${id}:`, e);
    }
};

export const deleteSession = async (id) => {
    const filePath = path.join(SESSIONS_DIR, `${id}.json`);
    try {
        await fs.unlink(filePath);
    } catch (e) {
        // Ignore if file doesn't exist
        if (e.code !== 'ENOENT') console.error(`[Persistence] Failed to delete session ${id}:`, e);
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
    } catch (e) {
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
