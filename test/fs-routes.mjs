import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
    buildTextFileVersion,
    createUniqueChild,
    ensureRenameTargetAvailable,
    isSupportedTextBuffer,
    readTextFileSnapshot,
    writeTextFileSnapshot
} from '../src/fs-routes.mjs';

describe('FS read text detection', () => {
    it('accepts utf-8 text content', () => {
        const buffer = Buffer.from('hello\nconst x = 1;\n', 'utf8');
        assert.equal(isSupportedTextBuffer(buffer), true);
    });

    it('rejects buffers containing null bytes', () => {
        const buffer = Buffer.from([0x68, 0x69, 0x00, 0x01, 0x02]);
        assert.equal(isSupportedTextBuffer(buffer), false);
    });

    it('rejects typical binary image headers', () => {
        const pngHeader = Buffer.from([
            0x89, 0x50, 0x4e, 0x47,
            0x0d, 0x0a, 0x1a, 0x0a
        ]);
        assert.equal(isSupportedTextBuffer(pngHeader), false);
    });
});

describe('FS create unique child', () => {
    it('creates incrementing untitled file names', async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'tabminal-fs-routes-')
        );
        try {
            await fs.writeFile(path.join(tempDir, 'untitled_file'), '');

            const created = await createUniqueChild(tempDir, '.', 'file');
            assert.equal(created.name, 'untitled_file_1');
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    it('creates incrementing untitled folder names', async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'tabminal-fs-routes-')
        );
        try {
            await fs.mkdir(path.join(tempDir, 'untitled_folder'));

            const created = await createUniqueChild(
                tempDir,
                '.',
                'directory'
            );
            assert.equal(created.name, 'untitled_folder_1');
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });
});

describe('FS rename target validation', () => {
    it('rejects renaming onto an existing file', async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'tabminal-fs-routes-')
        );
        try {
            await fs.writeFile(path.join(tempDir, 'a'), '');
            await fs.writeFile(path.join(tempDir, 'b'), '');

            await assert.rejects(
                ensureRenameTargetAvailable(tempDir, 'a', 'b'),
                (error) => error?.status === 409
            );
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects renaming onto an existing directory', async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'tabminal-fs-routes-')
        );
        try {
            await fs.writeFile(path.join(tempDir, 'a'), '');
            await fs.mkdir(path.join(tempDir, 'b'));

            await assert.rejects(
                ensureRenameTargetAvailable(tempDir, 'a', 'b'),
                (error) => error?.status === 409
            );
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });
});

describe('FS text snapshot versioning', () => {
    it('returns a stable content hash version', async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'tabminal-fs-routes-')
        );
        try {
            const filePath = path.join(tempDir, 'sample.txt');
            await fs.writeFile(filePath, 'hello\n', 'utf8');

            const snapshot = await readTextFileSnapshot(filePath);

            assert.equal(
                snapshot.version,
                buildTextFileVersion(Buffer.from('hello\n', 'utf8'))
            );
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    it('writes when expected version matches', async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'tabminal-fs-routes-')
        );
        try {
            const filePath = path.join(tempDir, 'sample.txt');
            await fs.writeFile(filePath, 'before\n', 'utf8');
            const before = await readTextFileSnapshot(filePath);

            const after = await writeTextFileSnapshot(
                filePath,
                'after\n',
                before.version
            );

            assert.equal(after.content, 'after\n');
            assert.notEqual(after.version, before.version);
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects writes when expected version is stale', async () => {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'tabminal-fs-routes-')
        );
        try {
            const filePath = path.join(tempDir, 'sample.txt');
            await fs.writeFile(filePath, 'before\n', 'utf8');
            const before = await readTextFileSnapshot(filePath);
            await fs.writeFile(filePath, 'remote\n', 'utf8');

            await assert.rejects(
                writeTextFileSnapshot(filePath, 'local\n', before.version),
                (error) => (
                    error?.status === 409
                    && error?.code === 'file-version-conflict'
                    && error?.snapshot?.content === 'remote\n'
                )
            );
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });
});
