import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isSupportedTextBuffer } from '../src/fs-routes.mjs';

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
