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
    model: null,
    debug: false,
    openrouterKey: null,
    googleKey: null,
    googleCx: null,
    openaiKey: null,
    openaiApi: null,
    cloudflareKey: null,
    shell: null
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
            'openai-key': {
                type: 'string',
                short: 'o'
            },
            'openai-api': {
                type: 'string',
                short: 'u'
            },
            'cloudflare-key': {
                type: 'string',
                short: 'f'
            },
            shell: {
                type: 'string',
                short: 's'
            },
            model: {
                type: 'string',
                short: 'm'
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
  --openai-key, -o      Set OpenAI API Key
  --openai-api, -u      Set OpenAI API Base URL
  --cloudflare-key, -f  Set Cloudflare Tunnel Token
  --shell, -s           Set Default Shell
  --model, -m           Set AI Model
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
    if (finalConfig['openai-key']) finalConfig.openaiKey = finalConfig['openai-key'];
    if (finalConfig['openai-api']) finalConfig.openaiApi = finalConfig['openai-api'];
    if (finalConfig['cloudflare-key']) finalConfig.cloudflareKey = finalConfig['cloudflare-key'];
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
    if (args['openai-key']) {
        finalConfig.openaiKey = args['openai-key'];
    }
    if (args['openai-api']) {
        finalConfig.openaiApi = args['openai-api'];
    }
    if (args['cloudflare-key']) {
        finalConfig.cloudflareKey = args['cloudflare-key'];
    }
    if (args.shell) {
        finalConfig.shell = args.shell;
    }
    if (args.model) {
        finalConfig.model = args.model;
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
    if (process.env.TABMINAL_HOST) finalConfig.host = process.env.TABMINAL_HOST;
    if (process.env.TABMINAL_PORT) finalConfig.port = parseInt(process.env.TABMINAL_PORT, 10);
    if (process.env.TABMINAL_HEARTBEAT) finalConfig.heartbeatInterval = parseInt(process.env.TABMINAL_HEARTBEAT, 10);
    if (process.env.TABMINAL_HISTORY) finalConfig.historyLimit = parseInt(process.env.TABMINAL_HISTORY, 10);
    if (process.env.TABMINAL_PASSWORD) finalConfig.password = process.env.TABMINAL_PASSWORD;
    if (process.env.TABMINAL_OPENROUTER_KEY) finalConfig.openrouterKey = process.env.TABMINAL_OPENROUTER_KEY;
    if (process.env.TABMINAL_OPENAI_KEY) finalConfig.openaiKey = process.env.TABMINAL_OPENAI_KEY;
    if (process.env.TABMINAL_OPENAI_API) finalConfig.openaiApi = process.env.TABMINAL_OPENAI_API;
    if (process.env.TABMINAL_CLOUDFLARE_KEY) finalConfig.cloudflareKey = process.env.TABMINAL_CLOUDFLARE_KEY;
    if (process.env.TABMINAL_SHELL) finalConfig.shell = process.env.TABMINAL_SHELL;
    if (process.env.TABMINAL_MODEL) finalConfig.model = process.env.TABMINAL_MODEL;
    if (process.env.TABMINAL_DEBUG) finalConfig.debug = true;
    if (process.env.TABMINAL_GOOGLE_KEY) finalConfig.googleKey = process.env.TABMINAL_GOOGLE_KEY;
    if (process.env.TABMINAL_GOOGLE_CX) finalConfig.googleCx = process.env.TABMINAL_GOOGLE_CX;

    // Password Logic
    if (!finalConfig.password) {
        finalConfig.password = generateRandomPassword();
        console.log('\n[SECURITY] No password provided. Generated temporary password:');
        console.log(`\x1b[36m${finalConfig.password}\x1b[0m`);
        console.log('Please save this password or set a custom one using -a/--passwd.\n');
    }

    // Validate API Keys (Mutually Exclusive)
    if (finalConfig.openrouterKey && finalConfig.openaiKey) {
        console.error('\n[CONFIG ERROR] You cannot set both OpenRouter API Key and OpenAI API Key.');
        console.error('Please configure only one of them.\n');
        process.exit(1);
    }

    // Default Model Logic
    if (!finalConfig.model) {
        if (finalConfig.openaiKey) {
            finalConfig.model = 'gpt-5.2';
        } else if (finalConfig.openrouterKey) {
            finalConfig.model = 'gemini-3-flash-preview';
        }
    }

    // Store SHA256 hash in memory
    finalConfig.passwordHash = sha256(finalConfig.password);

    return finalConfig;
}

export const config = loadConfig();
