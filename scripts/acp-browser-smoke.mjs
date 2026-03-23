import fs from 'node:fs';

const chromeBaseUrl = process.env.CHROME_DEBUG_URL
    || 'http://127.0.0.1:9222';
const tabminalUrl = process.env.TABMINAL_URL
    || 'http://127.0.0.1:19846/';
const tabminalPassword = process.env.TABMINAL_PASSWORD || 'acp-smoke';
const targetAgentLabel = process.env.TABMINAL_AGENT_LABEL || 'Test Agent';
const agentPrompt = process.env.TABMINAL_AGENT_PROMPT
    || 'Inspect this project briefly and request permission to edit a sample file.';
const screenshotPath = process.env.TABMINAL_SMOKE_SCREENSHOT
    || '/tmp/tabminal-acp-ui-smoke.png';

function log(step, data = '') {
    const suffix = data ? ` ${data}` : '';
    console.log(`[ACP Browser Smoke] ${step}${suffix}`);
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`${url} -> ${response.status}`);
    }
    return await response.json();
}

class CdpClient {
    constructor(url) {
        this.url = url;
        this.ws = new WebSocket(url);
        this.nextId = 1;
        this.pending = new Map();
        this.events = [];
        this.ws.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                const pending = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) {
                    pending.reject(
                        new Error(JSON.stringify(message.error))
                    );
                } else {
                    pending.resolve(message.result);
                }
                return;
            }
            this.events.push(message);
        });
    }

    async open() {
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
        });
    }

    async send(method, params = {}) {
        const id = this.nextId++;
        this.ws.send(JSON.stringify({ id, method, params }));
        return await new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
    }

    close() {
        this.ws.close();
    }
}

async function waitFor(label, fn, timeoutMs = 20000, stepMs = 200) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const value = await fn();
        if (value) {
            log(`ok:${label}`);
            return value;
        }
        await delay(stepMs);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

function toExpression(source) {
    return `(${source})()`;
}

async function main() {
    log('chrome', chromeBaseUrl);
    log('tabminal', tabminalUrl);

    const version = await getJson(`${chromeBaseUrl}/json/version`);
    const browser = new CdpClient(version.webSocketDebuggerUrl);
    await browser.open();

    const { targetId } = await browser.send('Target.createTarget', {
        url: tabminalUrl
    });
    log('target-created', targetId);

    const pageTarget = await waitFor('page-target', async () => {
        const list = await getJson(`${chromeBaseUrl}/json/list`);
        return list.find((item) => item.id === targetId);
    });

    const page = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await page.open();
    await page.send('Page.enable');
    await page.send('Runtime.enable');

    async function evaluate(expression) {
        const result = await page.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true
        });
        if (result.exceptionDetails) {
            throw new Error(JSON.stringify(result.exceptionDetails));
        }
        return result.result.value;
    }

    await evaluate(
        toExpression(`
            () => {
                if (!window.__tabminalSmokeProbeInstalled) {
                    window.__tabminalSmokeProbeInstalled = true;
                    window.__fetchLog = [];
                    window.__alertLog = [];
                    window.__wsLog = [];
                    const originalFetch = window.fetch.bind(window);
                    const originalAlert = window.alert.bind(window);
                    const OriginalWebSocket = window.WebSocket;
                    window.fetch = async (...args) => {
                        const [input, init] = args;
                        const url = typeof input === 'string'
                            ? input
                            : input.url;
                        window.__fetchLog.push({
                            url,
                            method: init?.method || 'GET'
                        });
                        return await originalFetch(...args);
                    };
                    window.alert = (...args) => {
                        window.__alertLog.push(args);
                        return originalAlert(...args);
                    };
                    window.WebSocket = class extends OriginalWebSocket {
                        constructor(url, protocols) {
                            super(url, protocols);
                            window.__wsLog.push({
                                type: 'create',
                                url: String(url)
                            });
                            this.addEventListener('open', () => {
                                window.__wsLog.push({
                                    type: 'open',
                                    url: String(url)
                                });
                            });
                            this.addEventListener('close', (event) => {
                                window.__wsLog.push({
                                    type: 'close',
                                    url: String(url),
                                    code: event.code
                                });
                            });
                            this.addEventListener('error', () => {
                                window.__wsLog.push({
                                    type: 'error',
                                    url: String(url)
                                });
                            });
                        }
                    };
                }
                return true;
            }
        `)
    );

    await waitFor('document-ready', async () => {
        const readyState = await evaluate('document.readyState');
        return readyState === 'complete';
    });

    await waitFor('login-input', async () => {
        return await evaluate(
            toExpression(`
                () => Boolean(document.getElementById('password-input'))
            `)
        );
    });

    await evaluate(
        toExpression(`
            () => {
                const input = document.getElementById('password-input');
                input.value = ${JSON.stringify(tabminalPassword)};
                input.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('login-form').requestSubmit();
                return true;
            }
        `)
    );
    log('submitted-login');

    await waitFor('session-ready', async () => {
        return await evaluate(
            toExpression(`
                () => {
                    const modal = document.getElementById('login-modal');
                    return document.querySelectorAll('.tab-item').length > 0
                        && modal
                        && modal.style.display === 'none';
                }
            `),
        );
    });

    await waitFor('agent-button', async () => {
        return await evaluate(
            toExpression(`
                () => document.querySelectorAll('.toggle-agent-btn').length > 0
            `),
        );
    });

    await evaluate(
        toExpression(`
            () => {
                document.querySelector('.toggle-agent-btn')?.click();
                return true;
            }
        `)
    );
    log('opened-agent-dropdown');

    await waitFor('agent-dropdown-items', async () => {
        return await evaluate(
            toExpression(`
                () => document.querySelectorAll('.agent-dropdown-item').length > 0
            `),
        );
    });

    const labels = await evaluate(
        toExpression(`
            () => Array.from(
                document.querySelectorAll('.agent-dropdown-item')
            ).map((el) => ({
                text: el.textContent.trim(),
                disabled: el.disabled
            }))
        `)
    );
    log('agent-options', JSON.stringify(labels));

    const picked = await evaluate(
        toExpression(`
            () => {
                const items = Array.from(
                    document.querySelectorAll('.agent-dropdown-item')
                );
                const target = items.find((el) =>
                    el.textContent.includes(
                        ${JSON.stringify(targetAgentLabel)}
                    )
                ) || items.find((el) => !el.disabled);
                if (!target) return '';
                const text = target.textContent.trim();
                target.click();
                return text;
            }
        `)
    );
    if (!picked) {
        throw new Error('No selectable ACP agent was found in the dropdown');
    }
    log('picked-agent', picked);

    await waitFor('agent-panel', async () => {
        return await evaluate(
            toExpression(`
                () => {
                    const tab = document.querySelector(
                        '.agent-editor-tab.active'
                    );
                    const panel = document.querySelector('.agent-panel');
                    return Boolean(tab)
                        && Boolean(panel)
                        && getComputedStyle(panel).display !== 'none';
                }
            `),
        );
    });

    await evaluate(
        toExpression(`
            () => {
                const input = document.querySelector('.agent-panel-input');
                input.value = ${JSON.stringify(agentPrompt)};
                input.dispatchEvent(new Event('input', { bubbles: true }));
                document.querySelector(
                    '.agent-panel-button:not(.secondary)'
                )?.click();
                return true;
            }
        `)
    );
    log('submitted-agent-prompt');

    const fetchLogAfterPrompt = await evaluate(
        toExpression(`
            () => window.__fetchLog.slice()
        `)
    );
    log('fetch-log-after-prompt', JSON.stringify(fetchLogAfterPrompt));

    await waitFor('permission-request', async () => {
        return await evaluate(
            toExpression(`
                () => document.querySelectorAll(
                    '.agent-permission-card .agent-permission-option'
                ).length > 0
            `),
            15000,
            250
        );
    });

    const permissionOptions = await evaluate(
        toExpression(`
            () => Array.from(document.querySelectorAll(
                '.agent-permission-card .agent-permission-option'
            )).map((el) => el.textContent.trim())
        `)
    );
    log('permission-options', JSON.stringify(permissionOptions));

    await evaluate(
        toExpression(`
            () => {
                const button = Array.from(document.querySelectorAll(
                    '.agent-permission-card .agent-permission-option'
                )).find((el) => !/cancel/i.test(el.textContent));
                if (!button) return false;
                button.click();
                return true;
            }
        `)
    );
    log('resolved-permission');

    await waitFor('final-message', async () => {
        return await evaluate(
            toExpression(`
                () => {
                    const bodies = Array.from(
                        document.querySelectorAll('.agent-message-body')
                    ).map((el) => el.textContent);
                    return bodies.some((text) => /all set/i.test(text));
                }
            `),
            15000,
            250
        );
    });

    await evaluate(
        toExpression(`
            () => {
                const input = document.querySelector('.agent-panel-input');
                input.value = 'cancel-smoke';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                document.querySelector(
                    '.agent-panel-button:not(.secondary)'
                )?.click();
                return true;
            }
        `)
    );
    log('submitted-cancel-smoke');

    await waitFor('cancel-enabled', async () => {
        return await evaluate(
            toExpression(`
                () => {
                    const button = document.querySelector(
                        '.agent-panel-button.secondary'
                    );
                    return Boolean(button) && button.disabled === false;
                }
            `),
            15000,
            250
        );
    });

    await evaluate(
        toExpression(`
            () => {
                document.querySelector(
                    '.agent-panel-button.secondary'
                )?.click();
                return true;
            }
        `)
    );
    log('clicked-cancel');

    await waitFor('cancel-settled', async () => {
        return await evaluate(
            toExpression(`
                () => {
                    const cancelButton = document.querySelector(
                        '.agent-panel-button.secondary'
                    );
                    const sendButton = document.querySelector(
                        '.agent-panel-button:not(.secondary)'
                    );
                    const meta = document.querySelector(
                        '.agent-panel-meta'
                    )?.textContent || '';
                    return Boolean(cancelButton)
                        && Boolean(sendButton)
                        && cancelButton.disabled === true
                        && sendButton.disabled === false
                        && /STATUS ready/i.test(meta);
                }
            `),
            15000,
            250
        );
    });

    await page.send('Page.reload', { ignoreCache: true });
    log('reloaded-page');

    await waitFor('document-ready-after-reload', async () => {
        const readyState = await evaluate('document.readyState');
        return readyState === 'complete';
    });

    await waitFor('restored-session', async () => {
        return await evaluate(
            toExpression(`
                () => document.querySelectorAll('.tab-item').length > 0
            `),
            15000,
            250
        );
    });

    await waitFor('restored-agent-tab', async () => {
        return await evaluate(
            toExpression(`
                () => {
                    const tab = document.querySelector(
                        '.agent-editor-tab.active'
                    );
                    const panel = document.querySelector('.agent-panel');
                    const messages = document.querySelectorAll(
                        '.agent-message'
                    ).length;
                    return Boolean(tab)
                        && Boolean(panel)
                        && getComputedStyle(panel).display !== 'none'
                        && messages > 0;
                }
            `),
            15000,
            250
        );
    });

    const finalState = await evaluate(
        toExpression(`
            () => ({
                tabs: Array.from(document.querySelectorAll('.editor-tab'))
                    .map((el) => el.textContent.trim()),
                agentHeader:
                    document.querySelector('.agent-panel-title')
                        ?.textContent || '',
                messages: Array.from(document.querySelectorAll('.agent-message'))
                    .map((el) => el.textContent.trim()),
                tools: Array.from(document.querySelectorAll('.agent-tool-call'))
                    .map((el) => el.textContent.trim()),
                permissionsPending: document.querySelectorAll(
                    '.agent-permission-card'
                ).length,
                wsLog: window.__wsLog || [],
                alerts: window.__alertLog || [],
                fetchLog: window.__fetchLog || [],
                activeSessionTitle:
                    document.querySelector('.tab-item.active .tab-command')
                        ?.textContent || ''
            })
        `)
    );

    const screenshot = await page.send('Page.captureScreenshot', {
        format: 'png'
    });
    fs.writeFileSync(
        screenshotPath,
        Buffer.from(screenshot.data, 'base64')
    );

    console.log(JSON.stringify({
        chromeBaseUrl,
        tabminalUrl,
        picked,
        finalState,
        screenshotPath
    }, null, 2));

    page.close();
    browser.close();
}

main().catch((error) => {
    console.error(error.stack || String(error));
    process.exit(1);
});
