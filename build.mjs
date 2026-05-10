import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_ICONS_DIR = path.join(__dirname, 'public', 'icons');

// Fallback to PKief's repo which is often stable for raw access, or use material-extensions
const BASE_URL = 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/main/icons';

// Ensure icons directory exists
await fsPromises.mkdir(PUBLIC_ICONS_DIR, { recursive: true });

const downloadFile = (url, dest) => {
    return new Promise((resolve, reject) => {
        const stream = fs.createWriteStream(dest);
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                stream.close();
                fsPromises.unlink(dest).catch(() => {});
                console.warn(`Failed to download: ${url} (${res.statusCode})`);
                resolve(false); 
                return;
            }
            res.pipe(stream);
            stream.on('finish', () => {
                stream.close();
                resolve(true);
            });
        }).on('error', (err) => {
            fsPromises.unlink(dest).catch(() => {});
            reject(err);
        });
    });
};

async function main() {
    console.log('🏗️  Starting build process (Fallback Mode)...');
    
    // Hardcoded map for stability
    const fileMap = {
        extensions: {
            'html': 'html',
            'htm': 'html',
            'css': 'css',
            'js': 'javascript',
            'mjs': 'javascript',
            'cjs': 'javascript',
            'ts': 'typescript',
            'tsx': 'react_ts',
            'jsx': 'react',
            'json': 'json',
            'md': 'markdown',
            'py': 'python',
            'rb': 'ruby',
            'go': 'go',
            'rs': 'rust',
            'php': 'php',
            'java': 'java',
            'c': 'c',
            'cpp': 'cpp',
            'h': 'cpp',
            'png': 'image',
            'jpg': 'image',
            'jpeg': 'image',
            'gif': 'image',
            'svg': 'svg',
            'xml': 'xml',
            'yaml': 'yaml',
            'yml': 'yaml',
            'sh': 'console',
            'bash': 'console',
            'zsh': 'console',
            'txt': 'document',
            'lock': 'lock'
        },
        filenames: {
            'package.json': 'nodejs',
            'package-lock.json': 'nodejs',
            'tsconfig.json': 'tsconfig',
            '.gitignore': 'git',
            '.gitattributes': 'git',
            '.env': 'tune',
            'readme.md': 'readme',
            'license': 'certificate',
            'dockerfile': 'docker',
            'docker-compose.yml': 'docker'
        },
        default: 'document',
        folder: 'folder-src',
        folderOpen: 'folder-src-open'
    };

    const iconsToDownload = new Set([
        'folder-src', 'folder-src-open',
        ...Object.values(fileMap.extensions),
        ...Object.values(fileMap.filenames)
    ]);

    console.log(`🔍 Need ${iconsToDownload.size} icons.`);
    console.log('⬇️  Downloading SVGs...');

    const downloadQueue = Array.from(iconsToDownload);
    const batchSize = 10;
    
    for (let i = 0; i < downloadQueue.length; i += batchSize) {
        const batch = downloadQueue.slice(i, i + batchSize);
        await Promise.all(batch.map(async (iconName) => {
            const fileName = `${iconName}.svg`;
            const dest = path.join(PUBLIC_ICONS_DIR, fileName);
            
            try {
                await fsPromises.access(dest);
                return;
            } catch {}

            const url = `${BASE_URL}/${fileName}`;
            await downloadFile(url, dest);
        }));
        process.stdout.write(`\rProgress: ${Math.min(i + batchSize, downloadQueue.length)}/${downloadQueue.length}`);
    }
    console.log('\n✅ Icons downloaded.');

    await fsPromises.writeFile(path.join(PUBLIC_ICONS_DIR, 'map.json'), JSON.stringify(fileMap, null, 2));
    console.log('✅ Map generated at public/icons/map.json');

    // Copy Fonts
    console.log('⬇️  Copying Fonts...');
    const fontsDir = path.join(__dirname, 'public', 'fonts');
    const fontSourceDir = path.join(__dirname, 'node_modules', '@fontsource', 'monaspace-neon', 'files');
    
    await fsPromises.mkdir(fontsDir, { recursive: true });

    const fontsToCopy = [
        { src: 'monaspace-neon-latin-400-normal.woff2', dest: 'MonaspaceNeon-Regular.woff2' },
        { src: 'monaspace-neon-latin-700-normal.woff2', dest: 'MonaspaceNeon-Bold.woff2' }
    ];

    for (const font of fontsToCopy) {
        const srcPath = path.join(fontSourceDir, font.src);
        const destPath = path.join(fontsDir, font.dest);
        try {
            await fsPromises.copyFile(srcPath, destPath);
            console.log(`   Copied ${font.dest}`);
        } catch (e) {
            console.warn(`   Failed to copy ${font.dest}:`, e.message);
            console.warn('   Make sure you have run "npm install" and @fontsource/monaspace-neon is installed.');
        }
    }
    console.log('✅ Fonts copied.');
}

main().catch(console.error);
