import fsPromises from 'node:fs/promises';

import * as persistence from '../../persistence.mjs';
import { debugLog } from './utils.mjs';

export function registerPersistenceRoutes(router) {
    router.post('/api/fs/write', async (ctx) => {
        const { path: filePath, content } = ctx.request.body;
        if (!filePath || content === undefined) {
            ctx.status = 400;
            return;
        }
        try {
            await fsPromises.writeFile(filePath, content, 'utf-8');
            ctx.status = 200;
        } catch (err) {
            console.error('FS Write Error:', err);
            ctx.status = 500;
            ctx.body = { error: err.message };
        }
    });

    router.post('/api/memory/expand', async (ctx) => {
        const { path: folderPath, expanded } = ctx.request.body;
        debugLog('[API] Expand:', folderPath, expanded);
        if (!folderPath) {
            ctx.status = 400;
            return;
        }
        const list = await persistence.updateExpandedFolder(
            folderPath,
            expanded
        );
        ctx.body = list;
    });

    router.get('/api/memory/expanded', async (ctx) => {
        const list = await persistence.getExpandedFolders();
        ctx.body = list;
    });

    router.get('/api/cluster', async (ctx) => {
        const servers = await persistence.loadCluster();
        ctx.body = { servers };
    });

    router.put('/api/cluster', async (ctx) => {
        const body = ctx.request.body;
        const servers = Array.isArray(body) ? body : body?.servers;
        if (!Array.isArray(servers)) {
            ctx.status = 400;
            ctx.body = { error: 'servers must be an array' };
            return;
        }
        try {
            await persistence.saveCluster(servers);
            ctx.body = { servers: await persistence.loadCluster() };
        } catch (err) {
            console.error('[API] Failed to save cluster:', err);
            ctx.status = 500;
            ctx.body = { error: 'Failed to save cluster config' };
        }
    });
}
