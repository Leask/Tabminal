import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getDataDirectory } from '../src/data-directory.mjs';

test('instance storage defaults to the existing user directory', () => {
    assert.equal(getDataDirectory({}), path.join(os.homedir(), '.tabminal'));
    assert.equal(getDataDirectory({ TABMINAL_DATA_DIR: '  ' }),
        path.join(os.homedir(), '.tabminal'));
});

test('instance storage accepts an explicit path without changing HOME', () => {
    const home = process.env.HOME;
    assert.equal(getDataDirectory({ TABMINAL_DATA_DIR: './isolated-test' }),
        path.resolve('isolated-test'));
    assert.equal(process.env.HOME, home);
});
