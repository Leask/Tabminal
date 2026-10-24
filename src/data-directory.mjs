import os from 'node:os';
import path from 'node:path';

// Isolate an instance without changing HOME or the user's agent credentials.
export function getDataDirectory(env = process.env) {
    const override = env.TABMINAL_DATA_DIR?.trim();
    return override
        ? path.resolve(override)
        : path.join(os.homedir(), '.tabminal');
}
