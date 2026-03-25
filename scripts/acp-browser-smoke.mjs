import crypto from 'node:crypto';
import fs from 'node:fs';

const chromeBaseUrl = process.env.CHROME_DEBUG_URL
    || 'http://127.0.0.1:9222';
const tabminalUrl = process.env.TABMINAL_URL
    || 'http://127.0.0.1:19846/';
const tabminalPassword = process.env.TABMINAL_PASSWORD || 'acp-smoke';
const targetAgentLabel = process.env.TABMINAL_AGENT_LABEL || 'Test Agent';
const agentPrompt = process.env.TABMINAL_AGENT_PROMPT
    || `Read ${process.cwd()}/package.json and ${process.cwd()}/README.md, `
        + 'then summarize this project briefly.';
const finalMessageMode = process.env.TABMINAL_FINAL_MESSAGE_MODE || 'pattern';
const finalMessagePattern = process.env.TABMINAL_FINAL_MESSAGE_PATTERN
    || 'all set';
const screenshotPath = process.env.TABMINAL_SMOKE_SCREENSHOT
    || '/tmp/tabminal-acp-ui-smoke.png';
const expectTool = process.env.TABMINAL_EXPECT_TOOL === '1';
const expectCommandsAfterFinal = process.env.TABMINAL_EXPECT_COMMANDS_AFTER_FINAL
    === '1';
const requireInitialCommands = process.env.TABMINAL_REQUIRE_INITIAL_COMMANDS
    ? process.env.TABMINAL_REQUIRE_INITIAL_COMMANDS !== '0'
    : /codex/i.test(targetAgentLabel);
const expectPathLink = process.env.TABMINAL_EXPECT_PATH_LINK === '1';
const targetMode = process.env.TABMINAL_TARGET_MODE || '';
const expectToolCount = Math.max(
    0,
    Number.parseInt(process.env.TABMINAL_EXPECT_TOOL_COUNT || '0', 10) || 0
);
const skipRestoreTail = process.env.TABMINAL_SKIP_RESTORE_TAIL === '1';
const setupGeminiApiKey = process.env.TABMINAL_SETUP_GEMINI_API_KEY || '';
const setupGoogleApiKey = process.env.TABMINAL_SETUP_GOOGLE_API_KEY || '';
const setupClaudeApiKey = process.env.TABMINAL_SETUP_CLAUDE_API_KEY || '';
const setupClaudeUseVertex = process.env.TABMINAL_SETUP_CLAUDE_USE_VERTEX
    === '1';
const setupClaudeVertexProject = process.env.TABMINAL_SETUP_CLAUDE_VERTEX_PROJECT
    || '';
const setupClaudeRegion = process.env.TABMINAL_SETUP_CLAUDE_REGION || '';
const setupClaudeCredentials =
    process.env.TABMINAL_SETUP_CLAUDE_CREDENTIALS || '';
const setupCopilotToken = process.env.TABMINAL_SETUP_COPILOT_TOKEN || '';

function log(step, data = '') {
    const suffix = data ? ` ${data}` : '';
    console.log(`[ACP Browser Smoke] ${step}${suffix}`);
}

function hasSetupConfig() {
    return Boolean(
        setupGeminiApiKey
        || setupGoogleApiKey
        || setupClaudeApiKey
        || setupClaudeUseVertex
        || setupClaudeVertexProject
        || setupClaudeRegion
        || setupClaudeCredentials
        || setupCopilotToken
    );
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

let apiTokenPromise = null;

async function getApiToken() {
    if (apiTokenPromise) {
        return await apiTokenPromise;
    }
    apiTokenPromise = (async () => {
        return crypto.createHash('sha256')
            .update(tabminalPassword)
            .digest('hex');
    })();
    return await apiTokenPromise;
}

async function createSessionViaNodeApi(label = 'create-session-via-node-api') {
    try {
        const token = await getApiToken();
        const response = await fetch(new URL('/api/sessions', tabminalUrl), {
            method: 'POST',
            headers: {
                authorization: token || '',
                'content-type': 'application/json'
            },
            body: '{}'
        });
        const created = response.ok;
        log(label, created ? 'ok' : `failed:${response.status}`);
        return created;
    } catch (error) {
        log(label, `failed:${error.message}`);
        return false;
    }
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

    async send(method, params = {}, timeoutMs = 10000) {
        const id = this.nextId++;
        this.ws.send(JSON.stringify({ id, method, params }));
        return await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject });
            const pending = this.pending.get(id);
            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timeout);
                    pending.resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    pending.reject(error);
                }
            });
        });
    }

    close() {
        this.ws.close();
    }
}

async function waitFor(label, fn, timeoutMs = 20000, stepMs = 200) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            const value = await fn();
            if (value) {
                log(`ok:${label}`);
                return value;
            }
        } catch {
            // Ignore transient CDP/runtime errors during reloads.
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

    let { targetId } = await browser.send('Target.createTarget', {
        url: tabminalUrl
    });
    log('target-created', targetId);
    let page = null;

    try {
        async function connectToTarget(label = 'page-target') {
            const pageTarget = await waitFor(label, async () => {
                const list = await getJson(`${chromeBaseUrl}/json/list`);
                return list.find((item) => item.id === targetId);
            });

            page = new CdpClient(pageTarget.webSocketDebuggerUrl);
            await page.open();
            await page.send('Page.enable');
            await page.send('Runtime.enable');
        }

        async function recreateTarget(label = 'recreated-target') {
            if (page) {
                page.close();
                page = null;
            }
            if (targetId) {
                try {
                    await browser.send('Target.closeTarget', { targetId });
                } catch {
                    // Ignore already-gone targets.
                }
            }
            ({ targetId } = await browser.send('Target.createTarget', {
                url: tabminalUrl
            }));
            log(label, targetId);
            await connectToTarget(`${label}-page-target`);
        }

        await connectToTarget();

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

        async function waitForDocumentReady(label = 'document-ready') {
            await waitFor(label, async () => {
                const readyState = await evaluate('document.readyState');
                return readyState === 'complete';
            });
        }

        async function createSessionViaPageApi(label = 'create-session-via-api') {
            let created = false;
            try {
                created = await evaluate(
                    toExpression(`
                        async () => {
                            const token = localStorage.getItem(
                                'tabminal_auth_token:main'
                            ) || '';
                            try {
                                const response = await fetch('/api/sessions', {
                                    method: 'POST',
                                    headers: {
                                        authorization: token || '',
                                        'content-type': 'application/json'
                                    },
                                    body: '{}'
                                });
                                return response.ok;
                            } catch {
                                return false;
                            }
                        }
                    `)
                );
            } catch {
                created = false;
            }
            log(label, created ? 'ok' : 'failed');
            return created;
        }

        async function ensureAuthedSession({
            authLabel = 'auth-or-session',
            sessionLabel = 'session-ready'
        } = {}) {
            const hasVisibleSession = async () => {
                return await evaluate(
                    toExpression(`
                        () => {
                            const modal = document.getElementById('login-modal');
                            return document.querySelectorAll('.tab-item').length > 0
                                && modal
                                && getComputedStyle(modal).display === 'none';
                        }
                    `)
                );
            };

            let authState = '';
            try {
                authState = await waitFor(authLabel, async () => {
                    return await evaluate(
                        toExpression(`
                            () => {
                                const modal = document.getElementById(
                                    'login-modal'
                                );
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
                                    && getComputedStyle(modal).display === 'none'
                                ) {
                                    return 'session';
                                }
                                return '';
                            }
                        `)
                    );
                });
            } catch {
                const token = await getApiToken();
                await evaluate(
                    toExpression(`
                        () => {
                            localStorage.setItem(
                                'tabminal_auth_token:main',
                                ${JSON.stringify(token)}
                            );
                            return true;
                        }
                    `)
                );
                log('forced-auth-token');
                await page.send('Page.reload', { ignoreCache: true });
                await waitForDocumentReady(
                    'document-ready-after-forced-auth'
                );
                authState = 'session';
            }

            if (authState === 'login') {
                await evaluate(
                    toExpression(`
                        () => {
                            const input = document.getElementById('password-input');
                            input.value = ${JSON.stringify(tabminalPassword)};
                            input.dispatchEvent(new Event('input', {
                                bubbles: true
                            }));
                            document.getElementById('login-form').requestSubmit();
                            return true;
                        }
                    `)
                );
                log('submitted-login');
            } else {
                log('reused-existing-auth');
            }

            try {
                await waitFor(sessionLabel, hasVisibleSession);
            } catch (_error) {
                await createSessionViaPageApi(
                    'retry-session-create-via-api'
                );
                await createSessionViaNodeApi(
                    'retry-session-create-via-node-api'
                );
                try {
                    await waitFor(
                        `${sessionLabel}-after-api-create`,
                        hasVisibleSession,
                        10000,
                        250
                    );
                    return;
                } catch {
                    // Fall through to a full target recreate.
                }
                log('retry-session-recreate-target');
                await recreateTarget('session-retry-target');
                await waitForDocumentReady(
                    'document-ready-after-session-recreate-target'
                );
                await createSessionViaPageApi(
                    'retry-session-create-via-api-post-recreate'
                );
                await createSessionViaNodeApi(
                    'retry-session-create-via-node-api-post-recreate'
                );
                await waitFor(
                    `${sessionLabel}-after-recreate-target`,
                    hasVisibleSession
                );
            }
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
                    const assistantBodies = Array.from(
                        document.querySelectorAll(
                            '.agent-message.assistant .agent-message-body'
                        )
                    ).map((el) => el.textContent);
                    const hasAssistantContent = assistantBodies.some((text) =>
                        (text || '').trim().length > 0
                    );
                    const hasToolCall = document.querySelectorAll(
                        '.agent-tool-call'
                    ).length > 0;
                    if (${
                        JSON.stringify(finalMessageMode)
                    } === 'idle') {
                        return idle && bodies.some((text) =>
                            (text || '').trim().length > 0
                        );
                    }
                    if (${
                        JSON.stringify(finalMessageMode)
                    } === 'state') {
                        return idle && (hasAssistantContent || hasToolCall);
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

        async function hasSetupAction() {
            return await evaluate(
                toExpression(`
                () => Array.from(
                    document.querySelectorAll('.agent-panel-button')
                ).some((el) => {
                    const text = (el.textContent || '').trim();
                    return /setup/i.test(text)
                        && getComputedStyle(el).display !== 'none';
                })
                `)
            );
        }

        async function readComposerHint() {
            return await evaluate(
                toExpression(`
                () => {
                    const input = document.querySelector('.agent-panel-input');
                    const placeholderLines = (
                        input?.getAttribute('placeholder') || ''
                    ).split('\\n');
                    const summary = placeholderLines[0]?.trim() || '';
                    const metaLine = placeholderLines[1]
                        ?.replace(/^\\/\\/\\s*/, '')
                        .trim() || '';
                    const pill = metaLine.split('·').pop()?.trim() || '';
                    const hotkey = placeholderLines[2]
                        ?.replace(/^\\/\\/\\s*/, '')
                        .trim() || '';
                    const activity = document.querySelector(
                        '.agent-panel-activity'
                    );
                    const activityVisible = Boolean(
                        activity
                        && getComputedStyle(activity).display !== 'none'
                    );
                    return {
                        pill,
                        summary,
                        hotkey,
                        placeholder: placeholderLines.join('\\n'),
                        visible: activityVisible,
                        activity: activityVisible
                            ? activity.textContent?.trim() || ''
                            : '',
                        activityClass: activityVisible
                            ? activity.className || ''
                            : ''
                    };
                }
                `)
            );
        }

        async function waitForPromptOutcome(
            label = 'permission-final-or-setup',
            timeoutMs = 45000
        ) {
            return await waitFor(label, async () => {
                if (await hasPermissionRequest()) {
                    return 'permission';
                }
                if (await hasFinalMessage()) {
                    return 'final';
                }
                if (hasSetupConfig() && await hasSetupAction()) {
                    return 'setup';
                }
                return '';
            }, timeoutMs, 250);
        }

        async function handleRuntimeSetup() {
            const currentAgentTabCount = await evaluate(
                toExpression(`
                    () => Array.from(
                        document.querySelectorAll('.agent-editor-tab')
                    ).filter((tab) => (tab.textContent || '').includes(
                        ${JSON.stringify(targetAgentLabel)}
                    )).length
                `)
            );
            await evaluate(
                toExpression(`
                    () => {
                        const button = Array.from(
                            document.querySelectorAll('.agent-panel-button')
                        ).find((el) => /setup/i.test(el.textContent || ''));
                        button?.click();
                        return true;
                    }
                `)
            );
            log('opened-runtime-agent-setup');

            await waitFor('agent-setup-modal', async () => {
                return await evaluate(
                    toExpression(`
                        () => {
                            const modal = document.getElementById(
                                'agent-setup-modal'
                            );
                            return Boolean(
                                modal
                                && getComputedStyle(modal).display !== 'none'
                            );
                        }
                    `)
                );
            });

            await submitSetupModal();
            log('submitted-runtime-agent-setup');

            const setupOutcome = await waitForSetupOutcome(currentAgentTabCount);
            log('runtime-agent-setup-outcome', setupOutcome);
            if (setupOutcome !== 'created') {
                throw new Error(
                    `Runtime setup did not create a retry tab (${setupOutcome})`
                );
            }

            await waitFor('active-hint-after-setup', async () => {
                const hint = await readComposerHint();
                const activeState = /starting|running|responding/i.test(hint.pill)
                    || /needs approval/i.test(hint.pill);
                const activeSummary = /working|waiting on|waiting for|drafting|summarizing|choose an approval option/i
                    .test(hint.summary);
                return activeState
                    && activeSummary
                    && /Esc stops/i.test(hint.hotkey);
            }, 30000, 250);
        }

        async function submitSetupModal() {
            await evaluate(
                toExpression(`
                    () => {
                        const setValue = (id, value) => {
                            const input = document.getElementById(id);
                            if (!input) return;
                            input.value = value;
                            input.dispatchEvent(new Event('input', {
                                bubbles: true
                            }));
                        };
                        setValue(
                            'agent-setup-gemini-key',
                            ${JSON.stringify(setupGeminiApiKey)}
                        );
                        setValue(
                            'agent-setup-google-key',
                            ${JSON.stringify(setupGoogleApiKey)}
                        );
                        setValue(
                            'agent-setup-claude-key',
                            ${JSON.stringify(setupClaudeApiKey)}
                        );
                        const useVertex = document.getElementById(
                            'agent-setup-claude-use-vertex'
                        );
                        if (useVertex) {
                            useVertex.checked = ${JSON.stringify(setupClaudeUseVertex)};
                            useVertex.dispatchEvent(new Event('change', {
                                bubbles: true
                            }));
                        }
                        setValue(
                            'agent-setup-claude-project',
                            ${JSON.stringify(setupClaudeVertexProject)}
                        );
                        setValue(
                            'agent-setup-claude-region',
                            ${JSON.stringify(setupClaudeRegion)}
                        );
                        setValue(
                            'agent-setup-claude-credentials',
                            ${JSON.stringify(setupClaudeCredentials)}
                        );
                        setValue(
                            'agent-setup-copilot-token',
                            ${JSON.stringify(setupCopilotToken)}
                        );
                        document.getElementById('agent-setup-form')?.requestSubmit();
                        return true;
                    }
                `)
            );
        }

        async function waitForSetupOutcome(existingCount) {
            return await waitFor('agent-setup-outcome', async () => {
                return await evaluate(
                    toExpression(`
                        () => {
                            const modal = document.getElementById(
                                'agent-setup-modal'
                            );
                            const isOpen = Boolean(
                                modal
                                && getComputedStyle(modal).display !== 'none'
                            );
                            const feedback = document.getElementById(
                                'agent-setup-feedback'
                            );
                            const count = Array.from(
                                document.querySelectorAll('.agent-editor-tab')
                            ).filter((tab) => (tab.textContent || '').includes(
                                ${JSON.stringify(targetAgentLabel)}
                            )).length;
                            if (count > ${JSON.stringify(existingCount)}) {
                                return 'created';
                            }
                            if (
                                isOpen
                                && feedback
                                && !feedback.hidden
                                && /saved/i.test(feedback.textContent || '')
                            ) {
                                return 'saved';
                            }
                            if (!isOpen) {
                                return 'closed';
                            }
                            return '';
                        }
                    `),
                    20000,
                    250
                );
            });
        }

        async function waitForAgentTabCreationOrSetup(
            existingCount,
            expectedLabel,
            label = 'agent-tab-created'
        ) {
            return await waitFor(label, async () => {
                return await evaluate(
                    toExpression(`
                        () => {
                            const modal = document.getElementById(
                                'agent-setup-modal'
                            );
                            const isSetupOpen = Boolean(
                                modal
                                && getComputedStyle(modal).display !== 'none'
                            );
                            if (isSetupOpen) {
                                return 'setup';
                            }
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
                            const hasExpectedActive = Boolean(active)
                                && (
                                    active.textContent || ''
                                ).includes(${JSON.stringify(expectedLabel)});
                            if (
                                count >= ${JSON.stringify(existingCount + 1)}
                                && hasExpectedActive
                            ) {
                                return 'created';
                            }
                            return '';
                        }
                    `),
                    15000,
                    250
                );
            });
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

        await waitForDocumentReady();
        await ensureAuthedSession();

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
                disabled: el.disabled,
                unavailable: el.classList.contains('unavailable')
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

    const targetInitiallyUnavailable = await evaluate(
        toExpression(`
            () => {
                const items = Array.from(
                    document.querySelectorAll('.agent-dropdown-item')
                );
                const target = items.find((el) =>
                    el.textContent.includes(
                        ${JSON.stringify(targetAgentLabel)}
                    )
                );
                return Boolean(
                    target && target.classList.contains('unavailable')
                );
            }
        `)
    );

    let picked = '';
    let agentTabCreatedFromSetup = false;

    if (targetInitiallyUnavailable && hasSetupConfig()) {
        await evaluate(
            toExpression(`
                () => {
                    const items = Array.from(
                        document.querySelectorAll('.agent-dropdown-item')
                    );
                    const target = items.find((el) =>
                        el.textContent.includes(
                            ${JSON.stringify(targetAgentLabel)}
                        )
                    );
                    target?.click();
                    return true;
                }
            `)
        );
        log('opened-agent-setup');

        await waitFor('agent-setup-modal', async () => {
            return await evaluate(
                toExpression(`
                    () => {
                        const modal = document.getElementById(
                            'agent-setup-modal'
                        );
                        return Boolean(
                            modal
                            && getComputedStyle(modal).display !== 'none'
                        );
                    }
                `)
            );
        });

        await submitSetupModal();
        log('submitted-agent-setup');

        const setupOutcome = await waitForSetupOutcome(existingAgentTabCount);
        log('agent-setup-outcome', setupOutcome);
        if (setupOutcome === 'created') {
            agentTabCreatedFromSetup = true;
            picked = targetAgentLabel;
        } else {
            await evaluate(
                toExpression(`
                    () => {
                        document.getElementById('agent-setup-cancel')?.click();
                        document.querySelector('.toggle-agent-btn')?.click();
                        return true;
                    }
                `)
            );
            log('reopened-agent-dropdown-after-setup');

            await waitFor('agent-dropdown-refreshed', async () => {
                return await evaluate(
                    toExpression(`
                        () => document.querySelectorAll('.agent-dropdown-item').length > 0
                    `)
                );
            });
        }
    }

    if (!agentTabCreatedFromSetup) {
        picked = await evaluate(
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
    }
    log('picked-agent', picked);

    const expectedAgentLabel = existingAgentTabCount === 0
        ? targetAgentLabel
        : `${targetAgentLabel} #${existingAgentTabCount + 1}`;
    const expectedSecondAgentLabel = existingAgentTabCount === 0
        ? `${targetAgentLabel} #2`
        : `${targetAgentLabel} #${existingAgentTabCount + 2}`;
    const createOutcome = await waitForAgentTabCreationOrSetup(
        existingAgentTabCount,
        expectedAgentLabel
    );
    if (createOutcome === 'setup') {
        if (!hasSetupConfig()) {
            throw new Error('Agent creation fell back to setup without config');
        }
        await submitSetupModal();
        log('submitted-runtime-agent-setup-before-tab');
        const setupOutcome = await waitForSetupOutcome(existingAgentTabCount);
        log('runtime-agent-setup-before-tab-outcome', setupOutcome);
        if (setupOutcome !== 'created') {
            throw new Error(
                `Runtime setup did not create the initial agent tab (${setupOutcome})`
            );
        }
        await waitForAgentTabCreationOrSetup(
            existingAgentTabCount,
            expectedAgentLabel,
            'agent-tab-created-after-setup'
        );
    }

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

        const selectedCommandName = await evaluate(
            toExpression(`
                () => {
                    const option = document.querySelector('.agent-command-option');
                    const name = option?.querySelector(
                        '.agent-command-option-name'
                    )?.textContent?.trim() || '';
                    option?.click();
                    return name;
                }
            `)
        );

        await waitFor('command-menu-apply', async () => {
            return await evaluate(
                toExpression(`
                    () => {
                        const input = document.querySelector('.agent-panel-input');
                        const value = (input?.value || '').trimStart();
                        return Boolean(input)
                            && value.startsWith(${JSON.stringify(
                                selectedCommandName || ''
                            )});
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
                const options = Array.from(select.options);
                const requestedMode = ${JSON.stringify(targetMode)};
                const next = requestedMode
                    ? options.find((option) => (
                        option.textContent.toLowerCase().includes(
                            requestedMode.toLowerCase()
                        )
                        || option.value.toLowerCase() === requestedMode
                            .toLowerCase()
                    ))
                    : options.find((option) => option.value !== select.value);
                if (!next) return '';
                if (next.value === select.value) {
                    return '';
                }
                select.value = next.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                return next.textContent.trim();
            }
        `)
    );
    log('switched-mode', switchedMode || 'unchanged');

    if (switchedMode) {
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
    }

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

    const postPromptState = await waitFor('active-or-setup-or-final', async () => {
        const hint = await readComposerHint();
        const activeState = /starting|running|responding/i.test(hint.pill)
            || /needs approval/i.test(hint.pill);
        const activeSummary = /working|waiting on|waiting for|drafting|summarizing|choose an approval option/i
            .test(hint.summary);
        if (
            activeState
            && activeSummary
            && /Esc stops/i.test(hint.hotkey)
        ) {
            return 'active';
        }
        if (hasSetupConfig() && await hasSetupAction()) {
            return 'setup';
        }
        if (await hasPermissionRequest() || await hasFinalMessage()) {
            return 'final';
        }
        return '';
    });

    if (postPromptState === 'setup') {
        await handleRuntimeSetup();
    }

    const fetchLogAfterPrompt = await evaluate(
        toExpression(`
            () => Array.isArray(window.__fetchLog)
                ? window.__fetchLog.slice()
                : []
        `)
    );
    log('fetch-log-after-prompt', JSON.stringify(fetchLogAfterPrompt));

    let promptOutcome = await waitForPromptOutcome();
    if (promptOutcome === 'setup') {
        await handleRuntimeSetup();
        promptOutcome = await waitForPromptOutcome('permission-final-after-setup');
    }

    if (promptOutcome === 'permission') {
        await waitFor('permission-hint', async () => {
            const hint = await readComposerHint();
            return /needs approval/i.test(hint.pill)
                && /waiting on|choose an approval option/i.test(hint.summary);
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

    if (expectToolCount > 0) {
        await waitFor('tool-call-count', async () => {
            return await evaluate(
                toExpression(`
                    () => document.querySelectorAll('.agent-tool-call').length
                `)
            ) >= expectToolCount;
        }, 20000, 250);
    }

    if (expectPathLink) {
        await waitFor('path-link', async () => {
            return await evaluate(
                toExpression(`
                    () => document.querySelectorAll(
                        '.agent-path-link[href^="/"]'
                    ).length > 0
                `)
            );
        }, 20000, 250);
    }

    const finalHint = await readComposerHint();
    log('composer-hint-after-final', JSON.stringify(finalHint));

    if (/needs approval/i.test(finalHint.pill)) {
        await waitFor('late-permission-controls', async () => {
            return await evaluate(
                toExpression(`
                    () => document.querySelectorAll(
                        '.agent-permission-card .agent-permission-option'
                    ).length > 0
                `),
                10000,
                250
            );
        });

        const latePermissionOptions = await evaluate(
            toExpression(`
                () => Array.from(document.querySelectorAll(
                    '.agent-permission-card .agent-permission-option'
                )).map((el) => el.textContent.trim())
            `)
        );
        log(
            'late-permission-options',
            JSON.stringify(latePermissionOptions)
        );

        await evaluate(
            toExpression(`
                () => {
                    const buttons = Array.from(document.querySelectorAll(
                        '.agent-permission-card .agent-permission-option'
                    ));
                    const target = buttons.find((el) =>
                        !/cancel/i.test(el.textContent || '')
                    ) || buttons[0];
                    target?.click();
                    return Boolean(target);
                }
            `)
        );
        log('resolved-late-permission');
    }

    await waitFor('idle-after-final', async () => {
        const hint = await readComposerHint();
        const readyHint = /ready/i.test(hint.pill)
            && /next turn|start a new task/i.test(hint.summary);
        const sendState = await evaluate(
            toExpression(`
                () => {
                    const button = Array.from(
                        document.querySelectorAll('.agent-panel-button')
                    ).find((el) => /send/i.test(el.textContent || ''));
                    return Boolean(button)
                        && !/stop/i.test(button.textContent || '');
                }
            `)
        );
        return readyHint || sendState;
    });

    if (expectCommandsAfterFinal) {
        await waitFor('command-chips-after-final', async () => {
            return await evaluate(
                toExpression(`
                    () => document.querySelectorAll(
                        '.agent-command-chip'
                    ).length > 0
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
                    const placeholder = (
                        document.querySelector('.agent-panel-input')
                            ?.getAttribute('placeholder') || ''
                    ).split('\\n');
                    return Boolean(sendButton)
                        && /send/i.test(sendButton.textContent || '')
                        && /ready/i.test(
                            placeholder[1] || ''
                        );
                }
            `),
            15000,
            250
        );
    });

    if (!skipRestoreTail) {
        await page.send('Page.reload', { ignoreCache: true });
        log('reloaded-page');

        await waitForDocumentReady('document-ready-after-reload');

        let restoreViaRecreatedTarget = false;
        try {
            await waitFor('restored-session', async () => {
                return await evaluate(
                    toExpression(`
                        () => document.querySelectorAll('.tab-item').length > 0
                    `)
                );
            }, 30000, 500);
        } catch {
            restoreViaRecreatedTarget = true;
        }

        if (restoreViaRecreatedTarget) {
            log('restore-tail', 'reopen-target');
            await recreateTarget('restored-target');
            await waitForDocumentReady('document-ready-reopened');
            await ensureAuthedSession({
                authLabel: 'auth-or-session-reopened',
                sessionLabel: 'session-ready-reopened'
            });
        }

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
                `)
            );
        }, 30000, 500);

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
                    ).some((tab) => (
                        tab.textContent || ''
                    ).includes(${JSON.stringify(expectedSecondAgentLabel)}))
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
                        (tab.textContent || '').includes(
                            ${JSON.stringify(expectedAgentLabel)}
                        )
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
                            && (active.textContent || '').includes(
                                ${JSON.stringify(expectedAgentLabel)}
                            )
                            && transcript.length > 0;
                    }
                `),
                15000,
                250
            );
        });
    } else {
        log('restore-tail', 'skipped');
    }

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
    } finally {
        if (page) {
            page.close();
        }
        try {
            await browser.send('Target.closeTarget', { targetId });
            await waitFor('target-closed', async () => {
                const list = await getJson(`${chromeBaseUrl}/json/list`);
                return !list.some((item) => item.id === targetId);
            }, 5000, 100);
        } catch {}
        browser.close();
    }
}

main().catch((error) => {
    console.error(error.stack || String(error));
    process.exit(1);
});
