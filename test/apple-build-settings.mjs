import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const helper = fileURLToPath(new URL(
    '../apps/Apple/ghostty-build-settings.sh', import.meta.url
));

test('Apple build settings work with system Bash and explicit Ghostty mode', {
    skip: process.platform === 'win32'
}, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'apple build '));
    const run = (renderer = '') => spawnSync('/bin/bash', [
        '-euc',
        'source "$1"; tabminal_ghostty_xcodebuild_args "$2" iphonesimulator; '
            + 'printf "%s\\n" ${XCODEBUILD_ARGS[@]+"${XCODEBUILD_ARGS[@]}"}',
        'test', helper, root
    ], {
        encoding: 'utf8',
        env: {
            ...process.env,
            TABMINAL_GHOSTTY_XCFRAMEWORK_PATH: '',
            TABMINAL_GHOSTTY_FRAMEWORK_PATH: '',
            TABMINAL_GHOSTTY_REPO_PATH: '',
            TABMINAL_MOBILE_TERMINAL_RENDERER: renderer
        }
    });
    try {
        const fallback = run();
        assert.equal(fallback.status, 0, fallback.stderr);
        assert.equal(fallback.stdout.trim(), '');
        const required = run('ghostty');
        assert.notEqual(required.status, 0);
        assert.match(required.stderr, /no artifact/);

        const xcframework = path.join(root, 'Vendor/Ghostty/GhosttyKit.xcframework');
        await fs.mkdir(xcframework, { recursive: true });
        assert.match(run('ghostty').stderr, /slice is missing/);
        const slice = path.join(xcframework, 'ios-arm64-simulator');
        await fs.mkdir(slice);
        const library = path.join(slice, 'libghostty.a');
        await fs.writeFile(library, '');
        assert.match(run('ghostty').stderr, /does not match the bridge ABI/);
        const expected = path.join(root, 'Sources/CGhosttyShim/include');
        await fs.mkdir(expected, { recursive: true });
        await fs.mkdir(path.join(slice, 'Headers'));
        await fs.writeFile(path.join(expected, 'ghostty.h'), 'matching ABI');
        await fs.writeFile(path.join(slice, 'Headers/ghostty.h'), 'matching ABI');
        const linked = run('ghostty');
        assert.equal(linked.status, 0, linked.stderr);
        assert.ok(linked.stdout.includes(`-force_load "${library}"`));
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('Apple debug runner refuses an occupied port without killing its owner', {
    skip: process.platform === 'win32'
}, async () => {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
    });
    try {
        const helper = fileURLToPath(new URL(
            '../apps/Apple/debug-server.sh', import.meta.url
        ));
        const result = spawnSync('/bin/bash', [
            '-euc',
            'source "$1"; tabminal_start_debug_server "$PWD" "$2" test',
            'test', helper, String(listener.address().port)
        ], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /EADDRINUSE/);
        assert.ok(listener.listening);
        assert.ok(!result.stdout.includes('Isolated server'));
    } finally {
        await new Promise((resolve) => listener.close(resolve));
    }
});
