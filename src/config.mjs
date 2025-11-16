import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';

const DEFAULT_CONFIG = {
    host: '127.0.0.1',
    port: 9846,
    heartbeatInterval: 30000,
    historyLimit: 524288,
    acceptedSecurityWarning: false
};

function loadJson(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(content);
        }
    } catch (error) {
        console.warn(`[Config] Failed to load config from ${filePath}:`, error.message);
    }
    return {};
}

function loadConfig() {
    // 1. Load from ~/.tabminal.json
    const homeConfigPath = path.join(os.homedir(), '.tabminal.json');
    const homeConfig = loadJson(homeConfigPath);

    // 2. Load from ./config.json
    const localConfigPath = path.join(process.cwd(), 'config.json');
    const localConfig = loadJson(localConfigPath);

    // 3. Parse CLI arguments
    const { values: args } = parseArgs({
        options: {
            host: {
                type: 'string',
                short: 'h'
            },
            port: {
                type: 'string', // Parse as string first to handle potential non-numeric input safely
                short: 'p'
            },
            help: {
                type: 'boolean'
            },
            yes: {
                type: 'boolean',
                short: 'y'
            }
        },
        strict: false // Allow other args if necessary
    });

    if (args.help) {
        console.log(`
Tabminal - A modern web terminal

Usage:
  node src/server.mjs [options]

Options:
  --host, -h      Host to bind to (default: 127.0.0.1)
  --port, -p      Port to listen on (default: 9846)
  --yes, -y       Accept security warning and start server
  --help          Show this help message
        `);
        process.exit(0);
    }

    // Merge configurations: Defaults < Home < Local < CLI
    const finalConfig = {
        ...DEFAULT_CONFIG,
        ...homeConfig,
        ...localConfig
    };

    if (args.host) {
        finalConfig.host = args.host;
    }
    if (args.port) {
        const parsedPort = parseInt(args.port, 10);
        if (!isNaN(parsedPort)) {
            finalConfig.port = parsedPort;
        }
    }
    if (args.yes) {
        finalConfig.acceptedSecurityWarning = true;
    }

    // Environment variables override (for backward compatibility/container usage)
    if (process.env.HOST) finalConfig.host = process.env.HOST;
    if (process.env.PORT) finalConfig.port = parseInt(process.env.PORT, 10);
    if (process.env.TABMINAL_HEARTBEAT) finalConfig.heartbeatInterval = parseInt(process.env.TABMINAL_HEARTBEAT, 10);
    if (process.env.TABMINAL_HISTORY) finalConfig.historyLimit = parseInt(process.env.TABMINAL_HISTORY, 10);

    return finalConfig;
}

export const config = loadConfig();
