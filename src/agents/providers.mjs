import { fileURLToPath } from 'node:url';

// Resolve installed, lockfile-pinned adapters. Never fetch @latest on spawn.
export function lodyProvider(id) {
    const names = {
        codex: 'acp-extension-codex',
        claude: 'acp-extension-claude'
    };
    const name = names[id];
    if (!name) throw new Error(`No Lody adapter for ${id}`);
    const entry = id === 'claude'
        ? import.meta.resolve(`${name}/dist/index.js`)
        : import.meta.resolve(name);
    return {
        command: process.execPath,
        args: [fileURLToPath(entry)],
        commandLabel: name
    };
}
