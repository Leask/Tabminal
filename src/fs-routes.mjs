import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// Helper to safely resolve path and prevent directory traversal
const resolvePath = (baseDir, targetPath) => {
    const resolvedPath = path.resolve(baseDir, targetPath);
    if (!resolvedPath.startsWith(baseDir)) {
        throw new Error('Access denied');
    }
    return resolvedPath;
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

            const dirents = await fs.readdir(fullPath, { withFileTypes: true });
            
            const files = dirents.map(dirent => {
                return {
                    name: dirent.name,
                    isDirectory: dirent.isDirectory(),
                    path: path.join(dirPath, dirent.name),
                    // Add basic icon/type hint logic here if needed later
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

            if (stats.size > 1024 * 1024 * 5) { // 5MB limit for now
                ctx.status = 400;
                ctx.body = { error: 'File too large' };
                return;
            }

            // Check if it's a text file or binary (simple check)
            // For now, we assume text unless we want to support images via base64 here
            // But usually images are loaded via src="/api/fs/raw?path=..."
            
            const content = await fs.readFile(fullPath, 'utf-8');
            ctx.body = { content };
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
            // Basic mime type handling could be added here
            const ext = path.extname(fullPath).toLowerCase();
            const mimeTypes = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.svg': 'image/svg+xml',
                '.webp': 'image/webp'
            };

            if (mimeTypes[ext]) {
                ctx.type = mimeTypes[ext];
                ctx.body = await fs.readFile(fullPath);
            } else {
                ctx.status = 400;
                ctx.body = 'Unsupported file type for raw access';
            }
        } catch (err) {
            ctx.status = 404;
        }
    });
};
