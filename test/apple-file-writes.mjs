import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { registerSessionRoutes }
    from '../src/controllers/tabminal/session-routes.mjs';
import { setupFsRoutes } from '../src/fs-routes.mjs';

const SESSION_A = 'apple-file-session-a';
const SESSION_B = 'apple-file-session-b';
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

function versionOf(content) {
    return createHash('sha256').update(content).digest('hex');
}

async function createFixture(t) {
    const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'tabminal-apple-file-writes-')
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const routes = new Map();
    const router = Object.fromEntries(
        ['all', 'get', 'post', 'delete'].map((method) => [
            method,
            (route, handler) => {
                const key = `${method.toUpperCase()} ${route}`;
                assert.equal(routes.has(key), false);
                routes.set(key, handler);
            }
        ])
    );
    const sessions = new Map([
        [SESSION_A, { id: SESSION_A }],
        [SESSION_B, { id: SESSION_B }]
    ]);
    const sessionLookups = [];

    registerSessionRoutes(router, {
        terminalManager: {
            getSession(id) {
                sessionLookups.push(id);
                return sessions.get(id);
            },
            listSessions() {
                return [...sessions.values()];
            }
        },
        acpBusManager: { listInventory: async () => [] },
        systemMonitor: { getStats: () => ({}) },
        serverBootId: 'apple-file-test-boot'
    });
    setupFsRoutes(router);

    // Invoke real handlers without a listener, PTY, or production manager.
    async function request(method, route, body = {}, query = {}) {
        const handler = routes.get(`${method} ${route}`)
            || routes.get(`ALL ${route}`);
        assert.equal(typeof handler, 'function');
        const ctx = {
            method,
            status: 200,
            request: { body },
            query
        };
        await handler(ctx);
        assert.ok(Object.hasOwn(ctx, 'body'));
        return ctx;
    }

    return {
        root,
        sessionLookups,
        async file(name, content) {
            const filePath = path.join(root, name);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, content);
            return filePath;
        },
        read(filePath) {
            return request('GET', '/api/fs/read', {}, { path: filePath });
        },
        heartbeat(updates) {
            return request('POST', '/api/heartbeat', {
                updates: { sessions: updates }
            });
        }
    };
}

function assertResults(response, expected) {
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.fileWriteResults, expected);
    assert.deepEqual(response.body.runtime, { bootId: 'apple-file-test-boot' });
}

function saved(filePath, content) {
    return {
        path: filePath,
        status: 'ok',
        version: versionOf(content),
        readonly: false
    };
}

function conflicted(filePath, content) {
    return {
        path: filePath,
        status: 'conflict',
        version: versionOf(content),
        content,
        readonly: false,
        error: 'File version conflict'
    };
}

function assertBufferWrite(writeSpy, filePath, content) {
    assert.equal(writeSpy.mock.callCount(), 1);
    const [writtenPath, encoded] = writeSpy.mock.calls[0].arguments;
    assert.equal(writtenPath, filePath);
    assert.equal(Buffer.isBuffer(encoded), true);
    assert.deepEqual(encoded, Buffer.from(content, 'utf8'));
}

describe('Native heartbeat file-write contract', { concurrency: false }, () => {
    it('saves the read version and re-reads identical UTF-8 bytes', async (t) => {
        const fixture = await createFixture(t);
        const filePath = await fixture.file('notes with spaces.txt', 'before\n');
        const before = await fixture.read(filePath);
        assert.equal(before.status, 200);
        assert.equal(before.body.version, versionOf('before\n'));
        assert.equal(before.body.readonly, false);

        const draft = 'after\n\u4e2d\u6587 \ud83d\udcbb\n';
        const writeSpy = t.mock.method(fs, 'writeFile');
        const response = await fixture.heartbeat([{
            id: SESSION_A,
            fileWrites: [{
                path: filePath,
                content: draft,
                expectedVersion: before.body.version
            }]
        }]);
        assertResults(response, [{
            id: SESSION_A,
            fileWrites: [saved(filePath, draft)]
        }]);
        assert.deepEqual(fixture.sessionLookups, [SESSION_A]);
        assertBufferWrite(writeSpy, filePath, draft);

        const after = await fixture.read(filePath);
        assert.equal(after.status, 200);
        assert.equal(after.body.content, draft);
        assert.equal(after.body.version, versionOf(draft));
        assert.notEqual(after.body.version, before.body.version);
        assert.equal(after.body.size, Buffer.byteLength(draft));
        assert.equal(after.body.readonly, false);
        assert.deepEqual(await fs.readFile(filePath), Buffer.from(draft));
    });

    it('returns the external snapshot on conflict without changing disk',
        async (t) => {
            const fixture = await createFixture(t);
            const filePath = await fixture.file('conflict.txt', 'original\n');
            const before = await fixture.read(filePath);
            const external = 'external\n';
            await fs.writeFile(filePath, external);

            const response = await fixture.heartbeat([{
                id: SESSION_B,
                fileWrites: [{
                    path: filePath,
                    content: 'local draft\n',
                    expectedVersion: before.body.version
                }]
            }]);
            assertResults(response, [{
                id: SESSION_B,
                fileWrites: [conflicted(filePath, external)]
            }]);
            assert.deepEqual(await fs.readFile(filePath), Buffer.from(external));
            const after = await fixture.read(filePath);
            assert.equal(after.body.content, external);
            assert.equal(after.body.version, versionOf(external));
        });

    it('only boolean true forces a stale version, including an empty save',
        async (t) => {
            const fixture = await createFixture(t);
            const filePath = await fixture.file('force.txt', 'original\n');
            const before = await fixture.read(filePath);
            const external = 'external\n';
            await fs.writeFile(filePath, external);
            const writeSpy = t.mock.method(fs, 'writeFile');

            for (const force of [false, 'true', 1]) {
                const response = await fixture.heartbeat([{
                    id: SESSION_A,
                    fileWrites: [{
                        path: filePath,
                        content: '',
                        expectedVersion: before.body.version,
                        force
                    }]
                }]);
                assertResults(response, [{
                    id: SESSION_A,
                    fileWrites: [conflicted(filePath, external)]
                }]);
                assert.equal(writeSpy.mock.callCount(), 0);
                assert.equal(await fs.readFile(filePath, 'utf8'), external);
            }

            const response = await fixture.heartbeat([{
                id: SESSION_A,
                fileWrites: [{
                    path: filePath,
                    content: '',
                    expectedVersion: before.body.version,
                    force: true
                }]
            }]);
            assertResults(response, [{
                id: SESSION_A,
                fileWrites: [saved(filePath, '')]
            }]);
            assertBufferWrite(writeSpy, filePath, '');
            const after = await fixture.read(filePath);
            assert.equal(after.body.content, '');
            assert.equal(after.body.version, versionOf(''));
            assert.equal((await fs.stat(filePath)).size, 0);
        });

    it('omits missing-session results and leaves their files unchanged',
        async (t) => {
            const fixture = await createFixture(t);
            const filePath = await fixture.file('orphan.txt', 'unchanged\n');
            const response = await fixture.heartbeat([{
                id: 'missing-session',
                fileWrites: [{
                    path: filePath,
                    content: 'must not write\n',
                    expectedVersion: versionOf('unchanged\n'),
                    force: true
                }]
            }]);
            assertResults(response, []);
            assert.deepEqual(fixture.sessionLookups, ['missing-session']);
            assert.equal(await fs.readFile(filePath, 'utf8'), 'unchanged\n');
            assert.deepEqual(response.body.sessions.map(({ id }) => id), [
                SESSION_A, SESSION_B
            ]);
        });

    it('correlates mixed results by exact session ID and full file path',
        async (t) => {
            const fixture = await createFixture(t);
            const aPath = await fixture.file('a/shared.txt', 'a original\n');
            const bPath = await fixture.file('b/shared.txt', 'b original\n');
            const nextPath = await fixture.file('b/next.txt', 'next original\n');
            const missingPath = path.join(fixture.root, 'missing.txt');
            const errorLog = t.mock.method(console, 'error', () => {});
            await fs.writeFile(bPath, 'b external\n');

            const response = await fixture.heartbeat([
                {
                    id: SESSION_B,
                    fileWrites: [
                        {
                            path: bPath,
                            content: 'b draft\n',
                            expectedVersion: versionOf('b original\n')
                        },
                        { path: missingPath, content: 'no new file\n' },
                        {
                            path: nextPath,
                            content: 'next saved\n',
                            expectedVersion: versionOf('next original\n')
                        }
                    ]
                },
                {
                    id: 'missing-session',
                    fileWrites: [{ path: aPath, content: 'wrong session\n' }]
                },
                {
                    id: SESSION_A,
                    fileWrites: [{
                        path: aPath,
                        content: 'a saved\n',
                        expectedVersion: versionOf('a original\n')
                    }]
                }
            ]);
            assertResults(response, [
                {
                    id: SESSION_B,
                    fileWrites: [
                        conflicted(bPath, 'b external\n'),
                        {
                            path: missingPath,
                            status: 'error',
                            error: 'File not found'
                        },
                        saved(nextPath, 'next saved\n')
                    ]
                },
                { id: SESSION_A, fileWrites: [saved(aPath, 'a saved\n')] }
            ]);
            assert.deepEqual(fixture.sessionLookups, [
                SESSION_B, 'missing-session', SESSION_A
            ]);
            assert.equal(errorLog.mock.callCount(), 1);
            assert.equal(await fs.readFile(aPath, 'utf8'), 'a saved\n');
            assert.equal(await fs.readFile(bPath, 'utf8'), 'b external\n');
            assert.equal(await fs.readFile(nextPath, 'utf8'), 'next saved\n');
            await assert.rejects(fs.stat(missingPath), { code: 'ENOENT' });
        });

    it('documents that an omitted or empty expectedVersion is unguarded',
        async (t) => {
            const fixture = await createFixture(t);
            for (const expectedVersion of [undefined, '']) {
                const filePath = await fixture.file('unguarded.txt', 'remote\n');
                const file = { path: filePath, content: 'unguarded save\n' };
                if (expectedVersion !== undefined) {
                    file.expectedVersion = expectedVersion;
                }
                const response = await fixture.heartbeat([{
                    id: SESSION_A,
                    fileWrites: [file]
                }]);
                assertResults(response, [{
                    id: SESSION_A,
                    fileWrites: [saved(filePath, file.content)]
                }]);
                assert.equal(await fs.readFile(filePath, 'utf8'), file.content);
            }
        });

    const unreadableCases = [
        {
            name: 'missing',
            content: () => null,
            status: 404,
            body: { error: 'File not found', code: 'file-not-found' }
        },
        {
            name: 'binary',
            content: () => Buffer.from([0x68, 0x69, 0x00, 0x01]),
            status: 415,
            body: {
                error: 'Unsupported file type',
                code: 'unsupported-file-type'
            }
        },
        {
            name: 'oversized',
            content: () => Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61),
            status: 400,
            body: { error: 'File too large' }
        }
    ];

    for (const spec of unreadableCases) {
        it(`rejects ${spec.name} files without mutation, even with force`,
            async (t) => {
                const fixture = await createFixture(t);
                const original = spec.content();
                const filePath = original === null
                    ? path.join(fixture.root, `${spec.name}.txt`)
                    : await fixture.file(`${spec.name}.txt`, original);
                const read = await fixture.read(filePath);
                assert.equal(read.status, spec.status);
                assert.deepEqual(read.body, spec.body);
                const errorLog = t.mock.method(console, 'error', () => {});

                for (const force of [false, true]) {
                    const response = await fixture.heartbeat([{
                        id: SESSION_B,
                        fileWrites: [{
                            path: filePath,
                            content: 'replacement\n',
                            expectedVersion: versionOf(original || ''),
                            force
                        }]
                    }]);
                    assertResults(response, [{
                        id: SESSION_B,
                        fileWrites: [{
                            path: filePath,
                            status: 'error',
                            error: spec.body.error
                        }]
                    }]);
                    if (original === null) {
                        await assert.rejects(fs.stat(filePath), {
                            code: 'ENOENT'
                        });
                    } else {
                        assert.deepEqual(await fs.readFile(filePath), original);
                    }
                }
                assert.equal(errorLog.mock.callCount(), 2);
                for (const call of errorLog.mock.calls) {
                    assert.equal(call.arguments[0],
                        `[Heartbeat] Write failed: ${filePath}`);
                }
            });
    }

    it('accepts an existing file at the exact five-MiB read limit', async (t) => {
        const fixture = await createFixture(t);
        const original = Buffer.alloc(MAX_TEXT_BYTES, 0x61);
        const filePath = await fixture.file('limit.txt', original);
        const read = await fixture.read(filePath);
        assert.equal(read.status, 200);
        assert.equal(read.body.size, MAX_TEXT_BYTES);
        assert.equal(read.body.version, versionOf(original));
        const response = await fixture.heartbeat([{
            id: SESSION_A,
            fileWrites: [{
                path: filePath,
                content: 'smaller\n',
                expectedVersion: read.body.version
            }]
        }]);
        assertResults(response, [{
            id: SESSION_A,
            fileWrites: [saved(filePath, 'smaller\n')]
        }]);
        assert.equal(await fs.readFile(filePath, 'utf8'), 'smaller\n');
    });

    it('reports read-only metadata and per-file permission errors', async (t) => {
        const fixture = await createFixture(t);
        const original = 'read-only original\n';
        const filePath = await fixture.file('readonly.txt', original);
        await fs.chmod(filePath, 0o444);
        try {
            // Probe independently: root and some filesystems ignore chmod.
            let writable = true;
            try {
                const handle = await fs.open(filePath, 'r+');
                await handle.close();
            } catch (error) {
                assert.ok(['EACCES', 'EPERM'].includes(error.code));
                writable = false;
            }
            if (writable) {
                t.skip('Current user/filesystem permits writes after chmod 0444');
                return;
            }

            const read = await fixture.read(filePath);
            assert.equal(read.status, 200);
            assert.equal(read.body.readonly, true);
            assert.equal(read.body.version, versionOf(original));
            const errorLog = t.mock.method(console, 'error', () => {});
            for (const force of [false, true]) {
                const response = await fixture.heartbeat([{
                    id: SESSION_A,
                    fileWrites: [{
                        path: filePath,
                        content: 'must not write\n',
                        expectedVersion: read.body.version,
                        force
                    }]
                }]);
                const result = response.body.fileWriteResults[0].fileWrites[0];
                assertResults(response, [{
                    id: SESSION_A,
                    fileWrites: [{
                        path: filePath,
                        status: 'error',
                        error: result.error
                    }]
                }]);
                assert.match(result.error, /EACCES|EPERM|permission|permitted/i);
                assert.equal(await fs.readFile(filePath, 'utf8'), original);
            }
            assert.equal(errorLog.mock.callCount(), 2);
        } finally {
            await fs.chmod(filePath, 0o600);
        }
    });

    const invalidReplacements = [
        {
            name: 'NUL-containing',
            content: () => 'draft\u0000text',
            error: 'Unsupported file type',
            checkConflictPriority: true
        },
        {
            name: 'control-heavy',
            content: () => 'draft\u0001\u0002\u0003text',
            error: 'Unsupported file type'
        },
        {
            name: 'oversized ASCII',
            content: () => 'a'.repeat(MAX_TEXT_BYTES + 1),
            error: 'File too large',
            expectedBytes: MAX_TEXT_BYTES + 1
        },
        {
            name: 'UTF-8 one-byte overflow',
            content: () => '\u00e9'.repeat(MAX_TEXT_BYTES / 2) + 'a',
            error: 'File too large',
            expectedBytes: MAX_TEXT_BYTES + 1,
            shortString: true,
            checkConflictPriority: true
        },
        {
            name: 'UTF-8 three-byte overflow',
            content: () => '\u00e9'.repeat(MAX_TEXT_BYTES / 2) + '\u4e2d',
            error: 'File too large',
            expectedBytes: MAX_TEXT_BYTES + 3,
            shortString: true
        }
    ];

    for (const spec of invalidReplacements) {
        it(`rejects ${spec.name} replacements before writes, even forced`,
            async (t) => {
                const fixture = await createFixture(t);
                const original = Buffer.from('original\r\n\u4e2d\u6587\r\n');
                const filePath = await fixture.file('replacement.txt', original);
                const before = await fixture.read(filePath);
                assert.equal(before.status, 200);
                assert.equal(before.body.version, versionOf(original));
                assert.equal(before.body.content, original.toString('utf8'));
                const draft = spec.content();
                if (spec.expectedBytes) {
                    assert.equal(Buffer.byteLength(draft), spec.expectedBytes);
                }
                if (spec.shortString) {
                    assert.ok(draft.length < MAX_TEXT_BYTES);
                }
                t.mock.method(console, 'error', () => {});
                // Call through so a write-and-rollback implementation fails too.
                const writeSpy = t.mock.method(fs, 'writeFile');

                for (const force of [false, true]) {
                    const response = await fixture.heartbeat([{
                        id: SESSION_B,
                        fileWrites: [{
                            path: filePath,
                            content: draft,
                            expectedVersion: force
                                ? versionOf('stale snapshot')
                                : before.body.version,
                            force
                        }]
                    }]);
                    assertResults(response, [{
                        id: SESSION_B,
                        fileWrites: [{
                            path: filePath,
                            status: 'error',
                            error: spec.error
                        }]
                    }]);
                    assert.equal(writeSpy.mock.callCount(), 0);
                    assert.deepEqual(await fs.readFile(filePath), original);
                    const after = await fixture.read(filePath);
                    assert.equal(after.status, 200);
                    assert.deepEqual(after.body, before.body);
                }
                assert.deepEqual(fixture.sessionLookups, [SESSION_B, SESSION_B]);
            });
    }

    for (const spec of invalidReplacements.filter(
        (candidate) => candidate.checkConflictPriority
    )) {
        it(`prioritizes stale-version conflict over ${spec.name} validation`,
            async (t) => {
                const fixture = await createFixture(t);
                const filePath = await fixture.file('priority.txt', 'before\n');
                const stale = await fixture.read(filePath);
                const original = Buffer.from('external\r\n\u4e2d\u6587\r\n');
                await fs.writeFile(filePath, original);
                const before = await fixture.read(filePath);
                assert.notEqual(before.body.version, stale.body.version);
                const draft = spec.content();
                const errorLog = t.mock.method(console, 'error', () => {});
                const writeSpy = t.mock.method(fs, 'writeFile');

                for (const force of [false, 'true', 1]) {
                    const response = await fixture.heartbeat([{
                        id: SESSION_A,
                        fileWrites: [{
                            path: filePath,
                            content: draft,
                            expectedVersion: stale.body.version,
                            force
                        }]
                    }]);
                    assertResults(response, [{
                        id: SESSION_A,
                        fileWrites: [conflicted(
                            filePath,
                            original.toString('utf8')
                        )]
                    }]);
                    assert.equal(writeSpy.mock.callCount(), 0);
                    assert.equal(errorLog.mock.callCount(), 0);
                    assert.deepEqual(await fs.readFile(filePath), original);
                    const after = await fixture.read(filePath);
                    assert.equal(after.status, 200);
                    assert.deepEqual(after.body, before.body);
                }
            });
    }

    for (const force of [false, true]) {
        it(`saves exactly five MiB of UTF-8 replacement bytes, force=${force}`,
            async (t) => {
                const fixture = await createFixture(t);
                const filePath = await fixture.file('write-limit.txt', 'before');
                const before = await fixture.read(filePath);
                const draft = '\u00e9'.repeat(MAX_TEXT_BYTES / 2);
                assert.equal(Buffer.byteLength(draft), MAX_TEXT_BYTES);
                assert.ok(draft.length < MAX_TEXT_BYTES);
                const writeSpy = t.mock.method(fs, 'writeFile');
                const response = await fixture.heartbeat([{
                    id: SESSION_B,
                    fileWrites: [{
                        path: filePath,
                        content: draft,
                        expectedVersion: force
                            ? versionOf('stale snapshot')
                            : before.body.version,
                        force
                    }]
                }]);
                assertResults(response, [{
                    id: SESSION_B,
                    fileWrites: [saved(filePath, draft)]
                }]);
                assertBufferWrite(writeSpy, filePath, draft);
                assert.deepEqual(await fs.readFile(filePath), Buffer.from(draft));
                const after = await fixture.read(filePath);
                assert.equal(after.status, 200);
                assert.equal(after.body.content, draft);
                assert.equal(after.body.version, versionOf(draft));
                assert.equal(after.body.size, MAX_TEXT_BYTES);
                assert.equal(after.body.readonly, false);
            });
    }
});
