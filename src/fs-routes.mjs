import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
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
            
            const files = dirents
                .filter(dirent => dirent.name !== '.DS_Store')
                .map(dirent => {
                    return {
                        name: dirent.name,
                        isDirectory: dirent.isDirectory(),
                        path: path.join(dirPath, dirent.name),
                        renameable,
                        deleteable: renameable
                    };
                });

            // Sort: Directories first, then files
            files.sort((a, b) => {
                if (a.isDirectory === b.isDirectory) {
                    return a.name.localeCompare(b.name);
                }
                return a.isDirectory ? -1 : 1;
            });

            ctx.body = files;
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
            const fullSourcePath = resolvePath(baseDir, sourcePath);
            const stats = await fs.stat(fullSourcePath);
            const nextPath = path.join(path.dirname(sourcePath), newName);
            const fullNextPath = resolvePath(baseDir, nextPath);

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
            ctx.status = err?.code === 'EEXIST' ? 409 : 500;
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
            const stats = await fs.stat(fullPath);

            if (!stats.isFile()) {
                ctx.status = 400;
                ctx.body = { error: 'Not a file' };
                return;
            }

            if (stats.size > 1024 * 1024 * 5) { // 5MB limit for now
                ctx.status = 400;
                ctx.body = { error: 'File too large' };
                return;
            }

            const contentBuffer = await fs.readFile(fullPath);
            if (!isSupportedTextBuffer(contentBuffer)) {
                ctx.status = 415;
                ctx.body = {
                    error: 'Unsupported file type',
                    code: 'unsupported-file-type'
                };
                return;
            }

            const decoder = new TextDecoder('utf-8', { fatal: true });
            const content = decoder.decode(contentBuffer);
            
            let readonly = false;
            try {
                const handle = await fs.open(fullPath, 'r+');
                await handle.close();
            } catch {
                readonly = true;
            }

            ctx.body = { content, readonly };
        } catch (err) {
            console.error('FS Read Error:', err);
            ctx.status = 500;
            ctx.body = { error: err.message };
        }
    });

    // Raw file access (for images)
    router.get('/api/fs/raw', async (ctx) => {
        const filePath = ctx.query.path;
        if (!filePath) {
            ctx.status = 400;
            return;
        }

        try {
            const fullPath = resolvePath(baseDir, filePath);
            const ext = path.extname(fullPath).toLowerCase();

            if (IMAGE_MIME_TYPES[ext]) {
                ctx.type = IMAGE_MIME_TYPES[ext];
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
