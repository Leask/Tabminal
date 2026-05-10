import { writeTextFileSnapshot } from '../../fs-routes.mjs';

export function registerSessionRoutes(
    router,
    {
        terminalManager,
        acpBusManager,
        systemMonitor,
        serverBootId
    }
) {
    router.all('/api/heartbeat', async (ctx) => {
        const fileWriteResults = [];
        if (ctx.method === 'POST') {
            const { updates } = ctx.request.body;
            if (updates && updates.sessions) {
                for (const update of updates.sessions) {
                    const session = terminalManager.getSession(update.id);
                    if (session) {
                        if (update.resize) {
                            const { cols, rows } = update.resize;
                            if (cols && rows) {
                                session.resize(cols, rows);
                            }
                        }
                        if (update.workspaceState || update.editorState) {
                            terminalManager.updateSessionState(session.id, {
                                workspaceState: update.workspaceState,
                                editorState: update.editorState
                            });
                        }
                        if (update.fileWrites) {
                            const sessionResults = [];
                            for (const file of update.fileWrites) {
                                try {
                                    const snapshot = await writeTextFileSnapshot(
                                        file.path,
                                        file.content,
                                        file.expectedVersion,
                                        file.force === true
                                    );
                                    sessionResults.push({
                                        path: file.path,
                                        status: 'ok',
                                        version: snapshot.version,
                                        readonly: snapshot.readonly
                                    });
                                } catch (e) {
                                    if (e?.status === 409) {
                                        sessionResults.push({
                                            path: file.path,
                                            status: 'conflict',
                                            version: e.snapshot?.version || '',
                                            content: e.snapshot?.content || '',
                                            readonly: !!e.snapshot?.readonly,
                                            error: e.message
                                        });
                                        continue;
                                    }
                                    console.error(
                                        `[Heartbeat] Write failed: ${file.path}`,
                                        e
                                    );
                                    sessionResults.push({
                                        path: file.path,
                                        status: 'error',
                                        error: e?.message || 'Write failed'
                                    });
                                }
                            }
                            if (sessionResults.length > 0) {
                                fileWriteResults.push({
                                    id: update.id,
                                    fileWrites: sessionResults
                                });
                            }
                        }
                    }
                }
            }
        }

        ctx.body = {
            sessions: terminalManager.listSessions(),
            agents: await acpBusManager.listInventory(),
            fileWriteResults,
            system: systemMonitor.getStats(),
            runtime: {
                bootId: serverBootId
            }
        };
    });

    router.post('/api/sessions', (ctx) => {
        const options = ctx.request.body || {};
        const session = terminalManager.createSession(options);
        ctx.status = 201;
        ctx.body = {
            id: session.id,
            createdAt: session.createdAt,
            shell: session.shell,
            initialCwd: session.initialCwd,
            title: session.title,
            cwd: session.cwd,
            cols: session.pty.cols,
            rows: session.pty.rows
        };
    });

    router.delete('/api/sessions/:id', async (ctx) => {
        const { id } = ctx.params;
        const session = terminalManager.getSession(id);
        if (session?.managed?.kind === 'agent-terminal') {
            await acpBusManager.releaseManagedTerminalSession(id, {
                destroy: true
            });
            ctx.status = 204;
            return;
        }
        await acpBusManager.closeTabsForTerminalSession(id);
        await terminalManager.removeSession(id);
        ctx.status = 204;
    });

    router.post('/api/sessions/:id/state', async (ctx) => {
        const { id } = ctx.params;
        const data = ctx.request.body;
        terminalManager.updateSessionState(id, data);
        ctx.status = 200;
    });
}
