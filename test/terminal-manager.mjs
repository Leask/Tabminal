import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

const { TerminalManager } = await import('../src/terminal-manager.mjs');

function createWorkspaceState(overrides = {}) {
    return {
        updatedAt: 0,
        updatedBy: '',
        isVisible: false,
        openFiles: [],
        terminalDisplayMode: 'auto',
        expandedPaths: [],
        markdownSplitPath: '',
        activeWorkspaceTabKey: '',
        ...overrides
    };
}

describe('TerminalManager workspace sync', () => {
    it('only accepts newer workspace snapshots', () => {
        const manager = new TerminalManager();
        const session = {
            editorState: createWorkspaceState({
                updatedAt: 10,
                updatedBy: 'device-a',
                openFiles: ['/tmp/a.js']
            }),
            persistent: false
        };
        manager.sessions.set('session-1', session);

        manager.updateSessionState('session-1', {
            workspaceState: createWorkspaceState({
                updatedAt: 5,
                updatedBy: 'device-b',
                openFiles: ['/tmp/older.js']
            })
        });
        assert.deepEqual(session.editorState.openFiles, ['/tmp/a.js']);

        manager.updateSessionState('session-1', {
            workspaceState: createWorkspaceState({
                updatedAt: 11,
                updatedBy: 'device-b',
                isVisible: true,
                openFiles: ['/tmp/newer.js'],
                terminalDisplayMode: 'tab',
                expandedPaths: ['/tmp/src'],
                markdownSplitPath: '/tmp/newer.js',
                activeWorkspaceTabKey: 'file:/tmp/newer.js'
            })
        });

        assert.equal(session.editorState.updatedAt, 11);
        assert.equal(session.editorState.updatedBy, 'device-b');
        assert.equal(session.editorState.isVisible, true);
        assert.deepEqual(session.editorState.openFiles, ['/tmp/newer.js']);
        assert.equal(session.editorState.terminalDisplayMode, 'tab');
        assert.deepEqual(session.editorState.expandedPaths, ['/tmp/src']);
        assert.equal(
            session.editorState.markdownSplitPath,
            '/tmp/newer.js'
        );
        assert.equal(
            session.editorState.activeWorkspaceTabKey,
            'file:/tmp/newer.js'
        );
    });

    it('uses updatedBy as a tie-breaker for equal timestamps', () => {
        const manager = new TerminalManager();
        const session = {
            editorState: createWorkspaceState({
                updatedAt: 20,
                updatedBy: 'device-a',
                openFiles: ['/tmp/a.js']
            }),
            persistent: false
        };
        manager.sessions.set('session-2', session);

        manager.updateSessionState('session-2', {
            workspaceState: createWorkspaceState({
                updatedAt: 20,
                updatedBy: 'device-9',
                openFiles: ['/tmp/ignored.js']
            })
        });
        assert.deepEqual(session.editorState.openFiles, ['/tmp/a.js']);

        manager.updateSessionState('session-2', {
            workspaceState: createWorkspaceState({
                updatedAt: 20,
                updatedBy: 'device-z',
                openFiles: ['/tmp/wins.js']
            })
        });
        assert.deepEqual(session.editorState.openFiles, ['/tmp/wins.js']);
    });

    it('returns canonical workspaceState in session listings', () => {
        const manager = new TerminalManager();
        const workspaceState = createWorkspaceState({
            updatedAt: 30,
            updatedBy: 'device-a',
            isVisible: true,
            openFiles: ['/tmp/file.js']
        });
        manager.sessions.set('session-3', {
            id: 'session-3',
            createdAt: '2026-03-27T00:00:00.000Z',
            shell: '/bin/bash',
            initialCwd: '/tmp',
            title: 'bash',
            cwd: '/tmp',
            env: '',
            pty: { cols: 120, rows: 30 },
            closed: false,
            exitStatus: null,
            managed: null,
            editorState: workspaceState,
            executions: []
        });

        const listed = manager.listSessions();
        assert.equal(listed.length, 1);
        assert.deepEqual(listed[0].workspaceState, workspaceState);
        assert.deepEqual(listed[0].editorState, workspaceState);
    });

    it('preserves markdown split path in shared workspace snapshots', () => {
        const manager = new TerminalManager();
        const session = {
            editorState: createWorkspaceState({
                updatedAt: 10,
                updatedBy: 'device-a',
                openFiles: ['/tmp/readme.md'],
                markdownSplitPath: '/tmp/readme.md',
                activeWorkspaceTabKey: 'preview:/tmp/readme.md'
            }),
            persistent: false
        };
        manager.sessions.set('session-4', session);

        manager.updateSessionState('session-4', {
            workspaceState: createWorkspaceState({
                updatedAt: 11,
                updatedBy: 'device-b',
                openFiles: ['/tmp/readme.md'],
                markdownSplitPath: '/tmp/readme.md',
                activeWorkspaceTabKey: 'preview:/tmp/readme.md'
            })
        });

        assert.equal(
            session.editorState.markdownSplitPath,
            '/tmp/readme.md'
        );
        assert.equal(
            session.editorState.activeWorkspaceTabKey,
            'preview:/tmp/readme.md'
        );
    });

    it('selects the latest workspace cwd for new sessions', () => {
        const manager = new TerminalManager();
        manager.sessions.set('older', {
            cwd: '/tmp/older',
            createdAt: '2026-03-29T10:00:00.000Z',
            updatedAt: '2026-03-29T10:05:00.000Z',
            editorState: createWorkspaceState({
                updatedAt: 10,
                updatedBy: 'device-a'
            })
        });
        manager.sessions.set('newer', {
            cwd: '/tmp/newer',
            createdAt: '2026-03-29T11:00:00.000Z',
            updatedAt: '2026-03-29T11:05:00.000Z',
            editorState: createWorkspaceState({
                updatedAt: 20,
                updatedBy: 'device-b'
            })
        });

        assert.equal(manager.getDefaultSessionCwd(), '/tmp/newer');
    });

    it('prefers explicit cwd over derived cwd when creating sessions', () => {
        const manager = new TerminalManager();
        manager.sessions.set('existing', {
            cwd: '/tmp/from-workspace',
            createdAt: '2026-03-29T11:00:00.000Z',
            updatedAt: '2026-03-29T11:05:00.000Z',
            editorState: createWorkspaceState({
                updatedAt: 20,
                updatedBy: 'device-a'
            })
        });

        let capturedOptions = null;
        manager._createPtySession = (options = {}) => {
            capturedOptions = options;
            return options;
        };

        manager.createSession({});
        assert.equal(capturedOptions.cwd, '/tmp/from-workspace');

        manager.createSession({ cwd: '/tmp/explicit' });
        assert.equal(capturedOptions.cwd, '/tmp/explicit');
    });

    it('falls back to home when no sessions remain', () => {
        const manager = new TerminalManager();
        const previous = process.env.TABMINAL_CWD;
        delete process.env.TABMINAL_CWD;
        try {
            assert.equal(manager.getDefaultSessionCwd(), os.homedir());
        } finally {
            if (typeof previous === 'string') {
                process.env.TABMINAL_CWD = previous;
            } else {
                delete process.env.TABMINAL_CWD;
            }
        }
    });

    it('does not inject a derived cwd when restoring a session snapshot', () => {
        const manager = new TerminalManager();
        manager.sessions.set('existing', {
            cwd: '/tmp/from-workspace',
            createdAt: '2026-03-29T11:00:00.000Z',
            updatedAt: '2026-03-29T11:05:00.000Z',
            editorState: createWorkspaceState({
                updatedAt: 20,
                updatedBy: 'device-a'
            })
        });

        let capturedOptions = null;
        manager._createPtySession = (options = {}) => {
            capturedOptions = options;
            return options;
        };

        manager.createSession({
            id: 'restored-session',
            createdAt: '2026-03-29T12:00:00.000Z',
            editorState: createWorkspaceState()
        });

        assert.equal(capturedOptions.cwd, undefined);
    });
});
