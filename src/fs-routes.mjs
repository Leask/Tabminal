import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const IMAGE_MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp'
};

const RAW_MIME_TYPES = {
    ...IMAGE_MIME_TYPES,
    '.pdf': 'application/pdf'
};

export function isSupportedTextBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return true;
    }

    let suspiciousControlBytes = 0;
    for (const byte of buffer) {
        if (byte === 0x00) {
            return false;
        }
        if (
            byte < 0x20
            && byte !== 0x09
            && byte !== 0x0a
            && byte !== 0x0d
        ) {
            suspiciousControlBytes += 1;
        }
    }

    if (suspiciousControlBytes > Math.max(1, buffer.length * 0.01)) {
        return false;
    }

    try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        decoder.decode(buffer);
        return true;
    } catch {
        return false;
    }
}

function createFsRouteError(message, status) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function normalizeFsRouteError(error, fallbackMessage = 'File system error') {
    if (error?.status) {
        return error;
    }

    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        const notFoundError = createFsRouteError('File not found', 404);
        notFoundError.code = 'file-not-found';
        return notFoundError;
    }

    if (error?.code === 'EISDIR') {
        return createFsRouteError('Not a file', 400);
    }

    const normalizedError = createFsRouteError(
        error?.message || fallbackMessage,
        500
    );
    if (error?.code) {
        normalizedError.code = error.code;
    }
    return normalizedError;
}

export function buildTextFileVersion(buffer) {
    return crypto
        .createHash('sha256')
        .update(buffer)
        .digest('hex');
}

async function canWriteExistingFile(targetPath) {
    try {
        const handle = await fs.open(targetPath, 'r+');
        await handle.close();
        return true;
    } catch {
        return false;
    }
}

export async function readTextFileSnapshot(fullPath) {
    try {
        const stats = await fs.stat(fullPath);

        if (!stats.isFile()) {
            throw createFsRouteError('Not a file', 400);
        }

        if (stats.size > 1024 * 1024 * 5) {
            throw createFsRouteError('File too large', 400);
        }

        const contentBuffer = await fs.readFile(fullPath);
        if (!isSupportedTextBuffer(contentBuffer)) {
            const error = createFsRouteError('Unsupported file type', 415);
            error.code = 'unsupported-file-type';
            throw error;
        }

        const decoder = new TextDecoder('utf-8', { fatal: true });
        const content = decoder.decode(contentBuffer);

        return {
            content,
            readonly: !(await canWriteExistingFile(fullPath)),
            version: buildTextFileVersion(contentBuffer),
            size: stats.size,
            mtimeMs: stats.mtimeMs
        };
    } catch (error) {
        throw normalizeFsRouteError(error, 'Unable to read file');
    }
}

export async function writeTextFileSnapshot(
    fullPath,
    content,
    expectedVersion = '',
    force = false
) {
    const current = await readTextFileSnapshot(fullPath);
    if (
        !force
        && expectedVersion
        && expectedVersion !== current.version
    ) {
        const error = createFsRouteError('File version conflict', 409);
        error.code = 'file-version-conflict';
        error.snapshot = current;
        throw error;
    }

    await fs.writeFile(fullPath, content, 'utf8');
    return await readTextFileSnapshot(fullPath);
}

function joinRelativePath(basePath, name) {
    if (!basePath || basePath === '.' || basePath === path.sep) {
        return name;
    }
    return path.join(basePath, name);
}

async function canWritePath(targetPath) {
    try {
        await fs.access(targetPath, fsConstants.W_OK);
        return true;
    } catch {
        return false;
    }
}

export async function createUniqueChild(baseDir, parentPath, kind) {
    const normalizedParentPath = parentPath || '.';
    const fullParentPath = resolvePath(baseDir, normalizedParentPath);
    const parentStats = await fs.stat(fullParentPath);
    if (!parentStats.isDirectory()) {
        const error = new Error('Parent path is not a directory');
        error.status = 400;
        throw error;
    }
    const writable = await canWritePath(fullParentPath);
    if (!writable) {
        const error = new Error('Parent directory is read-only');
        error.status = 403;
        throw error;
    }

    const baseName = kind === 'directory'
        ? 'untitled_folder'
        : 'untitled_file';

    for (let attempt = 0; attempt < 10000; attempt += 1) {
        const name = attempt === 0
            ? baseName
            : `${baseName}_${attempt}`;
        const relativePath = joinRelativePath(normalizedParentPath, name);
        const fullPath = resolvePath(baseDir, relativePath);
        try {
            if (kind === 'directory') {
                await fs.mkdir(fullPath);
            } else {
                const handle = await fs.open(fullPath, 'wx');
                await handle.close();
            }
            return {
                path: relativePath,
                parentPath: normalizedParentPath,
                name,
                isDirectory: kind === 'directory'
            };
        } catch (error) {
            if (error?.code === 'EEXIST') {
                continue;
            }
            throw error;
        }
    }

    const error = new Error('Unable to find an available name');
    error.status = 409;
    throw error;
}

export async function ensureRenameTargetAvailable(baseDir, sourcePath, newName) {
    const nextPath = path.join(path.dirname(sourcePath), newName);
    const fullSourcePath = resolvePath(baseDir, sourcePath);
    const fullNextPath = resolvePath(baseDir, nextPath);

    if (fullSourcePath === fullNextPath) {
        return {
            nextPath,
            fullSourcePath,
            fullNextPath
        };
    }

    try {
        await fs.stat(fullNextPath);
        const error = new Error(
            'A file or folder with that name already exists.'
        );
        error.status = 409;
        throw error;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return {
                nextPath,
                fullSourcePath,
                fullNextPath
            };
        }
        throw error;
    }
}

// Helper to safely resolve path
const resolvePath = (baseDir, targetPath) => {
    return path.resolve(baseDir, targetPath);
};

export const setupFsRoutes = (router) => {
    const baseDir = process.cwd(); // Or config.homeDir if you want to restrict/change it

    // List directory
    router.get('/api/fs/list', async (ctx) => {
        const dirPath = ctx.query.path || '.';
        try {
            const fullPath = resolvePath(baseDir, dirPath);
            const stats = await fs.stat(fullPath);

            if (!stats.isDirectory()) {
                ctx.status = 400;
                ctx.body = { error: 'Not a directory' };
                return;
            }

            let renameable = false;
            try {
                await fs.access(fullPath, fsConstants.W_OK);
                renameable = true;
            } catch {
                renameable = false;
            }

            const dirents = await fs.readdir(fullPath, { withFileTypes: true });
            
            const items = await Promise.all(
                dirents
                    .filter(dirent => dirent.name !== '.DS_Store')
                    .map(async (dirent) => {
                        const entryPath = path.join(dirPath, dirent.name);
                        return {
                            name: dirent.name,
                            isDirectory: dirent.isDirectory(),
                            path: entryPath,
                            renameable,
                            deleteable: renameable
                        };
                    })
            );

            // Sort: Directories first, then files
            items.sort((a, b) => {
                if (a.isDirectory === b.isDirectory) {
                    return a.name.localeCompare(b.name);
                }
                return a.isDirectory ? -1 : 1;
            });

            ctx.body = {
                items,
                creatable: renameable
            };
        } catch (err) {
            console.error('FS List Error:', err);
            ctx.status = 500;
            ctx.body = { error: err.message };
        }
    });

    router.post('/api/fs/rename', async (ctx) => {
        const sourcePath = ctx.request.body?.path;
        const newName = ctx.request.body?.newName;
        if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
            ctx.status = 400;
            ctx.body = { error: 'Path required' };
            return;
        }
        if (typeof newName !== 'string' || newName.length === 0) {
            ctx.status = 400;
            ctx.body = { error: 'New name required' };
            return;
        }
        if (newName === '.' || newName === '..') {
            ctx.status = 400;
            ctx.body = { error: 'Invalid name' };
            return;
        }
        if (/[\\/]/.test(newName)) {
            ctx.status = 400;
            ctx.body = { error: 'Name must not contain path separators' };
            return;
        }

        try {
            const {
                nextPath,
                fullSourcePath,
                fullNextPath
            } = await ensureRenameTargetAvailable(baseDir, sourcePath, newName);
            const stats = await fs.stat(fullSourcePath);

            if (fullSourcePath !== fullNextPath) {
                await fs.rename(fullSourcePath, fullNextPath);
            }

            ctx.body = {
                path: sourcePath,
                newPath: nextPath,
                isDirectory: stats.isDirectory()
            };
        } catch (err) {
            console.error('FS Rename Error:', err);
            ctx.status = err?.status || (err?.code === 'EEXIST' ? 409 : 500);
            ctx.body = { error: err.message };
        }
    });

    router.post('/api/fs/delete', async (ctx) => {
        const targetPath = ctx.request.body?.path;
        if (typeof targetPath !== 'string' || targetPath.length === 0) {
            ctx.status = 400;
            ctx.body = { error: 'Path required' };
            return;
        }

        try {
            const fullTargetPath = resolvePath(baseDir, targetPath);
            const stats = await fs.stat(fullTargetPath);
            await fs.rm(fullTargetPath, {
                recursive: stats.isDirectory(),
                force: false
            });

            ctx.body = {
                path: targetPath,
                isDirectory: stats.isDirectory()
            };
        } catch (err) {
            console.error('FS Delete Error:', err);
            ctx.status = 500;
            ctx.body = { error: err.message };
        }
    });

    router.post('/api/fs/create', async (ctx) => {
        const parentPath = ctx.request.body?.parentPath;
        const kind = ctx.request.body?.kind;

        if (typeof parentPath !== 'string' || parentPath.length === 0) {
            ctx.status = 400;
            ctx.body = { error: 'Parent path required' };
            return;
        }
        if (kind !== 'file' && kind !== 'directory') {
            ctx.status = 400;
            ctx.body = { error: 'Invalid create kind' };
            return;
        }

        try {
            const created = await createUniqueChild(
                baseDir,
                parentPath,
                kind
            );
            ctx.body = created;
        } catch (err) {
            console.error('FS Create Error:', err);
            ctx.status = err?.status || 500;
            ctx.body = { error: err.message };
        }
    });

    // Read file
    router.get('/api/fs/read', async (ctx) => {
        const filePath = ctx.query.path;
        if (!filePath) {
            ctx.status = 400;
            ctx.body = { error: 'Path required' };
            return;
        }

        try {
            const fullPath = resolvePath(baseDir, filePath);
            ctx.body = await readTextFileSnapshot(fullPath);
        } catch (err) {
            if ((err?.status || 500) >= 500) {
                console.error('FS Read Error:', err);
            }
            ctx.status = err?.status || 500;
            ctx.body = {
                error: err.message,
                ...(err?.code ? { code: err.code } : {})
            };
        }
    });

    router.get('/api/fs/info', async (ctx) => {
        const filePath = ctx.query.path;
        if (!filePath) {
            ctx.status = 400;
            ctx.body = { error: 'Path required' };
            return;
        }

        try {
            const fullPath = resolvePath(baseDir, filePath);
            const snapshot = await readTextFileSnapshot(fullPath);
            ctx.body = {
                readonly: snapshot.readonly,
                version: snapshot.version,
                size: snapshot.size,
                mtimeMs: snapshot.mtimeMs
            };
        } catch (err) {
            if ((err?.status || 500) >= 500) {
                console.error('FS Info Error:', err);
            }
            ctx.status = err?.status || 500;
            ctx.body = {
                error: err.message,
                ...(err?.code ? { code: err.code } : {})
            };
        }
    });

    // Raw file access (for previews like images and PDFs)
    router.get('/api/fs/raw', async (ctx) => {
        const filePath = ctx.query.path;
        if (!filePath) {
            ctx.status = 400;
            return;
        }

        try {
            const fullPath = resolvePath(baseDir, filePath);
            const ext = path.extname(fullPath).toLowerCase();

            if (RAW_MIME_TYPES[ext]) {
                ctx.type = RAW_MIME_TYPES[ext];
                ctx.body = await fs.readFile(fullPath);
            } else {
                ctx.status = 400;
                ctx.body = 'Unsupported file type for raw access';
            }
        } catch {
            ctx.status = 404;
        }
    });
};
