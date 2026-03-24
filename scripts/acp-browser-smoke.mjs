import fs from 'node:fs';

const chromeBaseUrl = process.env.CHROME_DEBUG_URL
    || 'http://127.0.0.1:9222';
const tabminalUrl = process.env.TABMINAL_URL
    || 'http://127.0.0.1:19846/';
const tabminalPassword = process.env.TABMINAL_PASSWORD || 'acp-smoke';
const targetAgentLabel = process.env.TABMINAL_AGENT_LABEL || 'Test Agent';
const agentPrompt = process.env.TABMINAL_AGENT_PROMPT
    || 'Inspect this project briefly and request permission to edit a sample file.';
const finalMessageMode = process.env.TABMINAL_FINAL_MESSAGE_MODE || 'pattern';
const finalMessagePattern = process.env.TABMINAL_FINAL_MESSAGE_PATTERN
    || 'all set';
const screenshotPath = process.env.TABMINAL_SMOKE_SCREENSHOT
    || '/tmp/tabminal-acp-ui-smoke.png';
const expectTool = process.env.TABMINAL_EXPECT_TOOL === '1';
const expectCommandsAfterFinal = process.env.TABMINAL_EXPECT_COMMANDS_AFTER_FINAL
    === '1';
const requireInitialCommands = process.env.TABMINAL_REQUIRE_INITIAL_COMMANDS
    !== '0';

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

    async function hasFinalMessage() {
        return await evaluate(
            toExpression(`
                () => {
                    const bodies = Array.from(
                        document.querySelectorAll('.agent-message-body')
                    ).map((el) => el.textContent);
                    const idle = !Array.from(
                        document.querySelectorAll('.agent-panel-button')
                    ).some((el) => /stop/i.test(el.textContent || ''));
                    if (${
                        JSON.stringify(finalMessageMode)
                    } === 'idle') {
                        return idle && bodies.some((text) =>
                            (text || '').trim().length > 0
                        );
                    }
                    const matcher = new RegExp(
                        ${JSON.stringify(finalMessagePattern)},
                        'i'
                    );
                    return bodies.some((text) => matcher.test(text));
                }
            `)
        );
    }

    async function hasPermissionRequest() {
        return await evaluate(
            toExpression(`
                () => document.querySelectorAll(
                    '.agent-permission-card .agent-permission-option'
                ).length > 0
            `)
        );
    }

    async function readComposerHint() {
        return await evaluate(
            toExpression(`
                () => {
                    const pill = document.querySelector(
                        '.agent-panel-hint .agent-status-pill'
                    );
                    const summary = document.querySelector(
                        '.agent-panel-hint-summary'
                    );
                    const hotkey = document.querySelector(
                        '.agent-panel-hint-hotkey'
                    );
                    return {
                        pill: pill?.textContent?.trim() || '',
                        summary: summary?.textContent?.trim() || '',
                        hotkey: hotkey?.textContent?.trim() || '',
                        visible: !!(
                            document.querySelector('.agent-panel-hint')
                            && getComputedStyle(
                                document.querySelector('.agent-panel-hint')
                            ).display !== 'none'
                        )
                    };
                }
            `)
        );
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

    const initialAuthState = await waitFor('auth-or-session', async () => {
        return await evaluate(
            toExpression(`
                () => {
                    const modal = document.getElementById('login-modal');
                    const hasLogin = Boolean(
                        modal
                        && getComputedStyle(modal).display !== 'none'
                        && document.getElementById('password-input')
                    );
                    const hasSession = document.querySelectorAll(
                        '.tab-item'
                    ).length > 0;
                    if (hasLogin) return 'login';
                    if (
                        hasSession
                        && modal
                        && modal.style.display === 'none'
                    ) {
                        return 'session';
                    }
                    return '';
                }
            `)
        );
    });

    if (initialAuthState === 'login') {
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
    } else {
        log('reused-existing-auth');
    }

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

    const existingAgentTabCount = await evaluate(
        toExpression(`
            () => Array.from(
                document.querySelectorAll('.agent-editor-tab')
            ).filter((tab) => (tab.textContent || '').includes(
                ${JSON.stringify(targetAgentLabel)}
            )).length
        `)
    );

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

    const expectedAgentLabel = existingAgentTabCount === 0
        ? targetAgentLabel
        : `${targetAgentLabel} #${existingAgentTabCount + 1}`;
    await waitFor('agent-tab-created', async () => {
        return await evaluate(
            toExpression(`
                () => {
                    const tabs = Array.from(
                        document.querySelectorAll('.agent-editor-tab')
                    );
                    const active = tabs.find((tab) =>
                        tab.classList.contains('active')
                    );
                    const count = tabs.filter((tab) =>
                        (tab.textContent || '').includes(
                            ${JSON.stringify(targetAgentLabel)}
                        )
                    ).length;
                    return count >= ${
                        existingAgentTabCount + 1
                    } && Boolean(active) && (
                        active.textContent || ''
                    ).includes(${JSON.stringify(expectedAgentLabel)});
                }
            `),
            15000,
            250
        );
    });

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

    const panelDetails = await evaluate(
        toExpression(`
            () => ({
                modeOptions: Array.from(
                    document.querySelectorAll('.agent-panel-mode-select option')
                ).map((option) => option.textContent.trim()),
                commandChips: Array.from(
                    document.querySelectorAll('.agent-command-chip')
                ).map((button) => button.textContent.trim())
            })
        `)
    );
    log('panel-details', JSON.stringify(panelDetails));

    if (requireInitialCommands || panelDetails.commandChips.length > 0) {
        await evaluate(
            toExpression(`
                () => {
                    const input = document.querySelector('.agent-panel-input');
                    input.value = '/re';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                }
            `)
        );

        await waitFor('command-menu', async () => {
            return await evaluate(
                toExpression(`
                    () => document.querySelectorAll(
                        '.agent-command-option'
                    ).length > 0
                `),
                15000,
                250
            );
        });

        const commandMenu = await evaluate(
            toExpression(`
                () => Array.from(
                    document.querySelectorAll('.agent-command-option-name')
                ).map((el) => el.textContent.trim())
            `)
        );
        log('command-menu', JSON.stringify(commandMenu));

        await evaluate(
            toExpression(`
                () => {
                    const option = document.querySelector('.agent-command-option');
                    option?.click();
                    return true;
                }
            `)
        );

        await waitFor('command-menu-apply', async () => {
            return await evaluate(
                toExpression(`
                    () => {
                        const input = document.querySelector('.agent-panel-input');
                        return Boolean(input)
                            && /^\\/review/.test(input.value || '');
                    }
                `),
                15000,
                250
            );
        });
    } else {
        log('command-menu', 'skipped-initially-unavailable');
    }

    await evaluate(
        toExpression(`
            () => {
                const input = document.querySelector('.agent-panel-input');
                input.value = '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            }
        `)
    );

    const switchedMode = await evaluate(
        toExpression(`
            () => {
                const select = document.querySelector('.agent-panel-mode-select');
                if (!select || select.options.length < 2) return '';
                const next = Array.from(select.options).find(
                    (option) => option.value !== select.value
                );
                if (!next) return '';
                select.value = next.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                return next.textContent.trim();
            }
        `)
    );
    log('switched-mode');

    await waitFor('mode-updated', async () => {
        return await evaluate(
            toExpression(`
                () => {
                    const placeholder = document.querySelector(
                        '.agent-panel-input'
                    )?.getAttribute('placeholder') || '';
                    return Array.isArray(window.__fetchLog)
                        && window.__fetchLog.some((entry) =>
                            /\\/api\\/agents\\/tabs\\/[^/]+\\/mode$/.test(
                                entry.url || ''
                            )
                        )
                        || ${
                            JSON.stringify(switchedMode || '')
                        }
                        && placeholder.includes(
                            ${JSON.stringify(switchedMode || '')}
                        );
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
                input.value = ${JSON.stringify(agentPrompt)};
                input.dispatchEvent(new Event('input', { bubbles: true }));
                const sendButton = Array.from(
                    document.querySelectorAll('.agent-panel-button')
                ).find((el) => /send/i.test(el.textContent || ''));
                sendButton?.click();
                return true;
            }
        `)
    );
    log('submitted-agent-prompt');

    await waitFor('active-hint', async () => {
        const hint = await readComposerHint();
        const activeState = /starting|running|responding/i.test(hint.pill)
            || /needs approval/i.test(hint.pill);
        const activeSummary = /working|waiting on|waiting for|drafting|summarizing/i
            .test(hint.summary);
        return activeState
            && activeSummary
            && /Esc stops/i.test(hint.hotkey);
    });

    const fetchLogAfterPrompt = await evaluate(
        toExpression(`
            () => Array.isArray(window.__fetchLog)
                ? window.__fetchLog.slice()
                : []
        `)
    );
    log('fetch-log-after-prompt', JSON.stringify(fetchLogAfterPrompt));

    await waitFor('permission-or-final', async () => {
        return await hasPermissionRequest() || await hasFinalMessage();
    });

    if (await hasPermissionRequest()) {
        await waitFor('permission-hint', async () => {
            const hint = await readComposerHint();
            return /needs approval/i.test(hint.pill)
                && /waiting on/i.test(hint.summary);
        });

        await waitFor('permission-sections-expanded', async () => {
            return await evaluate(
                toExpression(`
                    () => Array.from(document.querySelectorAll(
                        '.agent-permission-card details'
                    )).some((details) => details.open)
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

        await waitFor('post-permission-running-hint', async () => {
            const hint = await readComposerHint();
            return /running|ready/i.test(hint.pill);
        });
    } else {
        log('permission-options', '[]');
        log('resolved-permission', 'not-required');
    }

    await waitFor('final-message', async () => {
        return await hasFinalMessage();
    });

    if (expectTool) {
        await waitFor('tool-call', async () => {
            return await evaluate(
                toExpression(`
                    () => document.querySelectorAll('.agent-tool-call').length > 0
                `)
            );
        }, 20000, 250);
    }

    await waitFor('ready-hint-after-final', async () => {
        const hint = await readComposerHint();
        return /ready/i.test(hint.pill)
            && /next turn/i.test(hint.summary);
    });

    if (expectCommandsAfterFinal) {
        await waitFor('command-chips-after-final', async () => {
            return await evaluate(
                toExpression(`
                    () => Array.from(document.querySelectorAll(
                        '.agent-command-chip'
                    )).some((button) => /review/i.test(button.textContent || ''))
                `)
            );
        }, 15000, 250);
    }

    await evaluate(
        toExpression(`
            () => {
                const input = document.querySelector('.agent-panel-input');
                input.value = 'cancel-smoke';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                const sendButton = Array.from(
                    document.querySelectorAll('.agent-panel-button')
                ).find((el) => /send/i.test(el.textContent || ''));
                sendButton?.click();
                return true;
            }
        `)
    );
    log('submitted-cancel-smoke');

    await waitFor('stop-enabled', async () => {
        return await evaluate(
            toExpression(`
                () => {
                    const button = Array.from(
                        document.querySelectorAll('.agent-panel-button')
                    ).find((el) => /stop/i.test(el.textContent || ''));
                    return Boolean(button)
                        && button.disabled === false
                        && /stop/i.test(button.textContent || '');
                }
            `),
            15000,
            250
        );
    });

    await evaluate(
        toExpression(`
            () => {
                const stopButton = Array.from(
                    document.querySelectorAll('.agent-panel-button')
                ).find((el) => /stop/i.test(el.textContent || ''));
                stopButton?.click();
                return true;
            }
        `)
    );
    log('clicked-stop');

    await waitFor('cancel-settled', async () => {
        return await evaluate(
            toExpression(`
                () => {
                    const sendButton = Array.from(
                        document.querySelectorAll('.agent-panel-button')
                    ).find((el) => /send/i.test(el.textContent || ''));
                    return Boolean(sendButton)
                        && /send/i.test(sendButton.textContent || '')
                        && /ready/i.test(
                            document.querySelector(
                                '.agent-panel-hint .agent-status-pill'
                            )?.textContent || ''
                        );
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

    await evaluate(
        toExpression(`
            () => {
                const button = Array.from(
                    document.querySelectorAll('.agent-panel-button.secondary')
                ).find((el) => /new chat/i.test(el.textContent || ''));
                if (!button) return false;
                button.click();
                return true;
            }
        `)
    );
    log('created-second-agent');

    await waitFor('second-agent-restored', async () => {
        return await evaluate(
            toExpression(`
                () => Array.from(
                    document.querySelectorAll('.agent-editor-tab')
                ).some((tab) => /#2/.test(tab.textContent || ''))
            `),
            15000,
            250
        );
    });

    await waitFor('second-agent-tab', async () => {
        return await evaluate(
            toExpression(`
                () => {
                    const tabs = document.querySelectorAll(
                        '.agent-editor-tab'
                    );
                    const panel = document.querySelector('.agent-panel');
                    return tabs.length >= 2
                        && Boolean(panel)
                        && getComputedStyle(panel).display !== 'none';
                }
            `),
            15000,
            250
        );
    });

    await evaluate(
        toExpression(`
            () => {
                const tabs = Array.from(document.querySelectorAll(
                    '.agent-editor-tab'
                ));
                const target = tabs.find((tab) =>
                    /#1/.test(tab.textContent || '')
                ) || tabs[0];
                target?.click();
                return Boolean(target);
            }
        `)
    );
    log('switched-back-first-agent');

    await waitFor('first-agent-restored', async () => {
        return await evaluate(
            toExpression(`
                () => {
                    const tabs = Array.from(document.querySelectorAll(
                        '.agent-editor-tab'
                    ));
                    const active = tabs.find((el) =>
                        el.classList.contains('active')
                    );
                    const transcript = Array.from(
                        document.querySelectorAll('.agent-message')
                    ).map((el) => el.textContent || '');
                    return Boolean(active)
                        && /#1/.test(active.textContent || '')
                        && transcript.length > 0;
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
