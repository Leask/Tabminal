import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { TerminalManager } = await import('../src/terminal-manager.mjs');

function createWorkspaceState(overrides = {}) {
    return {
        updatedAt: 0,
        updatedBy: '',
        isVisible: false,
        openFiles: [],
        terminalDisplayMode: 'auto',
        expandedPaths: [],
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
                expandedPaths: ['/tmp/src']
            })
        });

        assert.equal(session.editorState.updatedAt, 11);
        assert.equal(session.editorState.updatedBy, 'device-b');
        assert.equal(session.editorState.isVisible, true);
        assert.deepEqual(session.editorState.openFiles, ['/tmp/newer.js']);
        assert.equal(session.editorState.terminalDisplayMode, 'tab');
        assert.deepEqual(session.editorState.expandedPaths, ['/tmp/src']);
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
});
