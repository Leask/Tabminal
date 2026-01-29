import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';

const DEFAULT_CONFIG = {
    host: '127.0.0.1',
    port: 9846,
    heartbeatInterval: 10000,
    historyLimit: 524288,
    acceptTerms: false,
    password: null,
    model: 'gemini-2.5-flash-preview-09-2025',
    apiBaseUrl: null, // Custom API base URL (e.g., for self-hosted or proxy)
    debug: false,
    openrouterKey: null,
    googleKey: null,
    googleCx: null
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

function generateRandomPassword(length = 32) {
    return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function sha256(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

function loadConfig() {
    // 1. Load from ~/.tabminal/config.json
    const configDir = path.join(os.homedir(), '.tabminal');
    const homeConfigPath = path.join(configDir, 'config.json');

    try {
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
    } catch (e) {
        console.warn('[Config] Failed to create config directory:', e.message);
    }

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
            password: {
                type: 'string',
                short: 'a'
            },
            'openrouter-key': {
                type: 'string',
                short: 'k'
            },
            model: {
                type: 'string',
                short: 'm'
            },
            'api-base-url': {
                type: 'string',
                short: 'u'
            },
            debug: {
                type: 'boolean',
                short: 'd'
            },
            'google-key': {
                type: 'string',
                short: 'g'
            },
            'google-cx': {
                type: 'string',
                short: 'c'
            },
            help: {
                type: 'boolean'
            },
            'accept-terms': {
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
  --host, -h            Host to bind to (default: 127.0.0.1)
  --port, -p            Port to listen on (default: 9846)
  --password, -a        Set access password
  --openrouter-key, -k  Set OpenRouter API Key
  --model, -m           Set AI Model
  --api-base-url, -u    Set custom API base URL (for self-hosted or proxy)
  --google-key, -g      Set Google Search API Key
  --google-cx, -c       Set Google Search Engine ID
  --debug, -d           Enable debug mode
  --accept-terms, -y    Accept security warning and start server
  --help                Show this help message
        `);
        process.exit(0);
    }

    // Merge configurations: Defaults < Home < Local < CLI
    const finalConfig = {
        ...DEFAULT_CONFIG,
        ...homeConfig,
        ...localConfig
    };

    // Normalize config keys (support kebab-case in JSON)
    if (finalConfig['accept-terms']) finalConfig.acceptTerms = finalConfig['accept-terms'];
    if (finalConfig['openrouter-key']) finalConfig.openrouterKey = finalConfig['openrouter-key'];
    if (finalConfig['ai-key']) finalConfig.openrouterKey = finalConfig['ai-key']; // Backwards compat
    if (finalConfig['api-base-url']) finalConfig.apiBaseUrl = finalConfig['api-base-url'];
    if (finalConfig['google-key']) finalConfig.googleKey = finalConfig['google-key'];
    if (finalConfig['google-cx']) finalConfig.googleCx = finalConfig['google-cx'];

    if (args.host) {
        finalConfig.host = args.host;
    }
    if (args.port) {
        const parsedPort = parseInt(args.port, 10);
        if (!isNaN(parsedPort)) {
            finalConfig.port = parsedPort;
        }
    }
    if (args['accept-terms']) {
        finalConfig.acceptTerms = true;
    }
    if (args.password) {
        finalConfig.password = args.password;
    }
    if (args['openrouter-key']) {
        finalConfig.openrouterKey = args['openrouter-key'];
    }
    if (args.model && args.model.trim() !== '') {
        finalConfig.model = args.model;
    }
    if (args['api-base-url'] && args['api-base-url'].trim() !== '') {
        finalConfig.apiBaseUrl = args['api-base-url'];
    }
    if (args.debug) {
        finalConfig.debug = true;
    }
    if (args['google-key']) {
        finalConfig.googleKey = args['google-key'];
    }
    if (args['google-cx']) {
        finalConfig.googleCx = args['google-cx'];
    }

    // Environment variables override (for backward compatibility/container usage)
    if (process.env.HOST) finalConfig.host = process.env.HOST;
    if (process.env.PORT) finalConfig.port = parseInt(process.env.PORT, 10);
    if (process.env.TABMINAL_HEARTBEAT) finalConfig.heartbeatInterval = parseInt(process.env.TABMINAL_HEARTBEAT, 10);
    if (process.env.TABMINAL_HISTORY) finalConfig.historyLimit = parseInt(process.env.TABMINAL_HISTORY, 10);
    if (process.env.TABMINAL_PASSWORD) finalConfig.password = process.env.TABMINAL_PASSWORD;
    if (process.env.TABMINAL_OPENROUTER_KEY) finalConfig.openrouterKey = process.env.TABMINAL_OPENROUTER_KEY;
    if (process.env.TABMINAL_MODEL && process.env.TABMINAL_MODEL.trim() !== '') {
        finalConfig.model = process.env.TABMINAL_MODEL;
    }
    if (process.env.TABMINAL_API_BASE_URL && process.env.TABMINAL_API_BASE_URL.trim() !== '') {
        finalConfig.apiBaseUrl = process.env.TABMINAL_API_BASE_URL;
    }
    if (process.env.TABMINAL_DEBUG) finalConfig.debug = true;
    if (process.env.TABMINAL_GOOGLE_KEY) finalConfig.googleKey = process.env.TABMINAL_GOOGLE_KEY;
    if (process.env.TABMINAL_GOOGLE_CX) finalConfig.googleCx = process.env.TABMINAL_GOOGLE_CX;

    // Validate model - ensure it's not empty string
    if (finalConfig.model && typeof finalConfig.model === 'string' && finalConfig.model.trim() === '') {
        // Reset to default if empty string
        finalConfig.model = DEFAULT_CONFIG.model;
    }

    // Password Logic
    if (!finalConfig.password) {
        finalConfig.password = generateRandomPassword();
        console.log('\n[SECURITY] No password provided. Generated temporary password:');
        console.log(`\x1b[36m${finalConfig.password}\x1b[0m`);
        console.log('Please save this password or set a custom one using -a/--passwd.\n');
    }

    // Store SHA256 hash in memory
    finalConfig.passwordHash = sha256(finalConfig.password);

    return finalConfig;
}

export const config = loadConfig();
