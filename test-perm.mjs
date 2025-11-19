import fs from 'node:fs/promises';
import path from 'node:path';

const filePath = path.resolve('1');
console.log('Testing file:', filePath);

try {
    const handle = await fs.open(filePath, 'r+');
    console.log('SUCCESS: File opened for r+ (Writable)');
    await handle.close();
} catch (e) {
    console.log('FAILURE: File cannot be opened for r+ (Readonly). Error:', e.code);
}
