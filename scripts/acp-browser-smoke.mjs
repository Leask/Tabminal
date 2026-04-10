import fs from 'node:fs';

const chromeBaseUrl = process.env.CHROME_DEBUG_URL
    || 'http://127.0.0.1:9222';
const tabminalUrl = process.env.TABMINAL_URL
    || 'http://127.0.0.1:19846/';
const tabminalPassword = process.env.TABMINAL_PASSWORD || 'acp-smoke';
const targetAgentLabel = process.env.TABMINAL_AGENT_LABEL || 'Test Agent';
const targetAgentDisplayLabel = targetAgentLabel.replace(
    /\s+(CLI|Agent|Adapter)$/i,
    ''
).trim() || targetAgentLabel;
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
const expectDiffEditor = process.env.TABMINAL_EXPECT_DIFF_EDITOR === '1';
const expectCodeEditor = process.env.TABMINAL_EXPECT_CODE_EDITOR === '1';
const expectPlanPanel = process.env.TABMINAL_EXPECT_PLAN_PANEL === '1';
const expectUsageHud = process.env.TABMINAL_EXPECT_USAGE_HUD === '1';
const expectTerminalSection = process.env.TABMINAL_EXPECT_TERMINAL_SECTION
    === '1';
const expectTerminalLive = process.env.TABMINAL_EXPECT_TERMINAL_LIVE === '1';
const expectManagedTerminalUi =
    process.env.TABMINAL_EXPECT_MANAGED_TERMINAL_UI === '1';
const requireResumeCoverage = process.env.TABMINAL_REQUIRE_RESUME === '1';
const expectTitlePattern = process.env.TABMINAL_EXPECT_TITLE_PATTERN || '';
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
const skipConfigSwitch = process.env.TABMINAL_SKIP_CONFIG_SWITCH === '1';
const attachmentFiles = String(
    process.env.TABMINAL_ATTACHMENT_FILES || ''
)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
const debugKeepTarget = process.env.TABMINAL_DEBUG_KEEP_TARGET === '1';
const agentPrompt = process.env.TABMINAL_AGENT_PROMPT
    || (
        /test agent/i.test(targetAgentLabel)
        && (expectDiffEditor || expectCodeEditor)
            ? '/diff'
            : `Read ${process.cwd()}/package.json `
                + `and ${process.cwd()}/README.md, `
                + 'then summarize this project briefly.'
    );

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

async function getJsonWithAuth(url, token) {
    const response = await fetch(url, {
        headers: {
            authorization: token || ''
        }
    });
    if (!response.ok) {
        throw new Error(`${url} -> ${response.status}`);
    }
    return await response.json();
}

async function postJsonWithAuth(url, token, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            authorization: token || '',
            'content-type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    if (!response.ok) {
        throw new Error(`${url} -> ${response.status}`);
    }
    return await response.json();
}

let authStatePromise = null;

async function getAuthState() {
    if (authStatePromise) {
        return await authStatePromise;
    }
    authStatePromise = (async () => {
        const response = await fetch(new URL('/api/auth/login', tabminalUrl), {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                password: tabminalPassword
            })
        });
        if (!response.ok) {
            throw new Error(`/api/auth/login -> ${response.status}`);
        }
        return await response.json();
    })();
    return await authStatePromise;
}

async function getApiToken() {
    const authState = await getAuthState();
    return authState?.accessToken || '';
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

async function dumpPageState(page) {
    const result = await page.send('Runtime.evaluate', {
        expression: toExpression(`
            () => ({
                activeAgentTab:
                    document.querySelector('.agent-editor-tab.active')
                        ?.textContent || '',
                activeWorkspaceTab:
                    document.querySelector('.editor-tab.active')
                        ?.textContent || '',
                toolCount: document.querySelectorAll('.agent-tool-call').length,
                permissionCount:
                    document.querySelectorAll('.agent-permission-card').length,
                planVisible: Boolean(document.querySelector(
                    '.agent-plan-panel'
                )) && getComputedStyle(document.querySelector(
                    '.agent-plan-panel'
                )).display !== 'none',
                usageVisible: Boolean(document.querySelector(
                    '.agent-usage-hud'
                )) && getComputedStyle(document.querySelector(
                    '.agent-usage-hud'
                )).display !== 'none',
                activityText:
                    document.querySelector('.agent-activity-text')
                        ?.textContent || '',
                transcriptPreview:
                    (document.querySelector('.agent-transcript')?.innerText
                        || '').slice(0, 2000)
            })
        `),
        awaitPromise: true,
        returnByValue: true
    });
    return result.result?.value || null;
}

async function main() {
    log('chrome', chromeBaseUrl);
    log('tabminal', tabminalUrl);

    const version = await getJson(`${chromeBaseUrl}/json/version`);
    const browser = new CdpClient(version.webSocketDebuggerUrl);
    await browser.open();

    let { targetId } = await browser.send('Target.createTarget', {
        url: 'about:blank'
    });
    log('target-created', targetId);
    let page = null;

    try {
        async function connectToTarget(label = 'page-target') {
            const pageTarget = await waitFor(label, async () => {
                const list = await getJson(`${chromeBaseUrl}/json/list`);
                return list.find((item) => item.id === targetId);
            });

            await browser.send('Target.activateTarget', { targetId });
            page = new CdpClient(pageTarget.webSocketDebuggerUrl);
            await page.open();
            await page.send('Page.enable');
            await page.send('Runtime.enable');
            await page.send('DOM.enable');
            await page.send('Page.bringToFront');
        }

        async function waitForTargetUrl(
            expectedUrl,
            label = 'target-url-ready'
        ) {
            await waitFor(label, async () => {
                const list = await getJson(`${chromeBaseUrl}/json/list`);
                const target = list.find((item) => item.id === targetId);
                return Boolean(target && target.url === expectedUrl);
            });
        }

        async function primeTargetAuthAndNavigate() {
            const authState = await getAuthState();
            await page.send('Page.addScriptToEvaluateOnNewDocument', {
                source: `
                    try {
                        localStorage.setItem(
                            'tabminal_auth_state:main',
                            ${JSON.stringify(JSON.stringify(authState))}
                        );
                    } catch {}
                `
            });
            await page.send('Page.navigate', {
                url: tabminalUrl
            });
            await waitForTargetUrl(tabminalUrl, 'tabminal-target-url');
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
                url: 'about:blank'
            }));
            log(label, targetId);
            await connectToTarget(`${label}-page-target`);
            await primeTargetAuthAndNavigate();
        }

        await connectToTarget();
        await primeTargetAuthAndNavigate();

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

        async function setFileInputFiles(selector, files) {
            const { root } = await page.send('DOM.getDocument');
            const { nodeId } = await page.send('DOM.querySelector', {
                nodeId: root.nodeId,
                selector
            });
            if (!nodeId) {
                throw new Error(`Unable to find file input: ${selector}`);
            }
            await page.send('DOM.setFileInputFiles', {
                nodeId,
                files
            });
            await evaluate(
                toExpression(`
                    () => {
                        const input = document.querySelector(
                            ${JSON.stringify(selector)}
                        );
                        input?.dispatchEvent(new Event('change', {
                            bubbles: true
                        }));
                        return true;
                    }
                `)
            );
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
                            let token = '';
                            try {
                                const raw = localStorage.getItem(
                                    'tabminal_auth_state:main'
                                ) || '';
                                const parsed = raw ? JSON.parse(raw) : null;
                                token = typeof parsed?.accessToken === 'string'
                                    ? parsed.accessToken
                                    : '';
                            } catch {}
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
                const authState = await getAuthState();
                await evaluate(
                    toExpression(`
                        () => {
                            localStorage.setItem(
                                'tabminal_auth_state:main',
                                ${JSON.stringify(JSON.stringify(authState))}
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
                try {
                    const authState = await getAuthState();
                    await evaluate(
                        toExpression(`
                            () => {
                                localStorage.setItem(
                                    'tabminal_auth_state:main',
                                    ${JSON.stringify(JSON.stringify(authState))}
                                );
                                return true;
                            }
                        `)
                    );
                    log('forced-auth-token-before-login');
                    await page.send('Page.reload', { ignoreCache: true });
                    await waitForDocumentReady(
                        'document-ready-after-forced-auth-login'
                    );
                } catch {
                    await evaluate(
                        toExpression(`
                            () => {
                                const input = document.getElementById(
                                    'password-input'
                                );
                                input.value =
                                    ${JSON.stringify(tabminalPassword)};
                                input.dispatchEvent(new Event('input', {
                                    bubbles: true
                                }));
                                document.getElementById(
                                    'login-form'
                                ).requestSubmit();
                                return true;
                            }
                        `)
                    );
                    log('submitted-login');
                }
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
                try {
                    const authState = await getAuthState();
                    await evaluate(
                        toExpression(`
                            () => {
                                localStorage.setItem(
                                    'tabminal_auth_state:main',
                                    ${JSON.stringify(JSON.stringify(authState))}
                                );
                                return true;
                            }
                        `)
                    );
                    log('forced-auth-token-after-session-recreate');
                    await page.send('Page.reload', { ignoreCache: true });
                    await waitForDocumentReady(
                        'document-ready-after-forced-auth-recreate'
                    );
                } catch {
                    // Fall back to the create-session probes below.
                }
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
                    const activity = document.querySelector(
                        '.agent-panel-activity'
                    );
                    const idle = !activity
                        || getComputedStyle(activity).display === 'none';
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
                        ?.replace(/^(?:#|\\/\\/)\\s*/, '')
                        .trim() || '';
                    const pill = metaLine.split('·').pop()?.trim() || '';
                    const hotkey = placeholderLines[2]
                        ?.replace(/^(?:#|\\/\\/)\\s*/, '')
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
                try {
                    const token = await getApiToken();
                    const data = await getJsonWithAuth(
                        new URL('/api/agents', tabminalUrl),
                        token
                    );
                    const matchingTabs = Array.isArray(data?.tabs)
                        ? data.tabs.filter((tab) => {
                            const labelText = String(
                                tab?.agentLabel || ''
                            ).toLowerCase();
                            const display = targetAgentDisplayLabel
                                .toLowerCase();
                            const raw = targetAgentLabel.toLowerCase();
                            return labelText.includes(display)
                                || labelText.includes(raw);
                        })
                        : [];
                    matchingTabs.sort((left, right) => (
                        String(right?.createdAt || '').localeCompare(
                            String(left?.createdAt || '')
                        )
                    ));
                    const latest = matchingTabs[0];
                    if (
                        latest
                        && !latest.busy
                        && (
                            (latest.messages || []).length > 1
                            || (latest.toolCalls || []).length > 0
                        )
                    ) {
                        return 'backend-ready';
                    }
                } catch {
                    // Ignore transient backend polling issues.
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
                        ${JSON.stringify(targetAgentDisplayLabel)}
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
                const activeActivity = /thinking|running|starting|waiting for approval|restoring/i
                    .test(hint.activity);
                return activeState
                    && (activeActivity || hint.visible)
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
                                ${JSON.stringify(targetAgentDisplayLabel)}
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
                                    ${JSON.stringify(targetAgentDisplayLabel)}
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
                ${JSON.stringify(targetAgentDisplayLabel)}
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
            picked = targetAgentDisplayLabel;
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
        ? targetAgentDisplayLabel
        : `${targetAgentDisplayLabel} #${existingAgentTabCount + 1}`;
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
                    document.querySelectorAll(
                        '.agent-panel-mode-select[data-selector-role="mode"] option'
                    )
                ).map((option) => option.textContent.trim()),
                modelOptions: Array.from(
                    document.querySelectorAll(
                        '.agent-panel-mode-select[data-selector-role="model"] option'
                    )
                ).map((option) => option.textContent.trim()),
                thoughtOptions: Array.from(
                    document.querySelectorAll(
                        '.agent-panel-mode-select[data-selector-role="thought_level"] option'
                    )
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
                    input.value = '/';
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

    async function exerciseResumeFlowIfSupported() {
        await evaluate(
            toExpression(`
                () => {
                    const input = document.querySelector('.agent-panel-input');
                    input.value = '/resume';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                }
            `)
        );

        await waitFor('resume-menu-ready', async () => {
            return await evaluate(
                toExpression(`
                    () => {
                        const options = Array.from(document.querySelectorAll(
                            '.agent-command-option'
                        )).map((el) => ({
                            name: el.querySelector(
                                '.agent-command-option-name'
                            )?.textContent?.trim() || '',
                            meta: el.querySelector(
                                '.agent-command-option-meta'
                            )?.textContent?.trim() || ''
                        }));
                        if (options.length === 0) {
                            return false;
                        }
                        return !options.some((option) =>
                            /loading previous sessions/i.test(option.name)
                        );
                    }
                `),
                20000,
                250
            );
        });

        const resumeOptions = await evaluate(
            toExpression(`
                () => Array.from(document.querySelectorAll(
                    '.agent-command-option'
                )).map((el, index) => ({
                    index,
                    name: el.querySelector(
                        '.agent-command-option-name'
                    )?.textContent?.trim() || '',
                    meta: el.querySelector(
                        '.agent-command-option-meta'
                    )?.textContent?.trim() || ''
                }))
            `)
        );
        log('resume-options', JSON.stringify(resumeOptions));

        const invalidResumeState = resumeOptions.length === 0
            || resumeOptions.every((option) => (
                /no previous sessions found/i.test(option.name)
                || /unable to load previous sessions/i.test(option.name)
            ));
        if (invalidResumeState) {
            if (requireResumeCoverage) {
                throw new Error('Resume command is available but no history was listed');
            }
            log('resume-flow', 'no-history');
            await evaluate(
                toExpression(`
                    () => {
                        const input = document.querySelector('.agent-panel-input');
                        input.value = '';
                        input.dispatchEvent(new Event('input', {
                            bubbles: true
                        }));
                        return true;
                    }
                `)
            );
            return;
        }

        const beforeResume = await evaluate(
            toExpression(`
                () => ({
                    activeTabText:
                        document.querySelector('.agent-editor-tab.active')
                            ?.textContent?.trim() || '',
                    tabCount: document.querySelectorAll(
                        '.agent-editor-tab'
                    ).length
                })
            `)
        );

        const selectedResume = resumeOptions.find((option) => (
            !/already open/i.test(option.meta)
        )) || resumeOptions.find((option) => (
            option.name !== beforeResume.activeTabText
        )) || resumeOptions[0];
        log('selected-resume-option', JSON.stringify(selectedResume));

        await evaluate(
            toExpression(`
                () => {
                    const options = Array.from(document.querySelectorAll(
                        '.agent-command-option'
                    ));
                    const target = options[${Number(selectedResume?.index ?? -1)}];
                    target?.click();
                    return Boolean(target);
                }
            `)
        );

        const expectNewResumeTab = !/already open/i.test(
            selectedResume?.meta || ''
        );

        await waitFor(
            expectNewResumeTab
                ? 'resume-tab-created'
                : 'resume-open-tab-activated',
            async () => {
                return await evaluate(
                    toExpression(`
                        () => {
                            const active = document.querySelector(
                                '.agent-editor-tab.active'
                            );
                            const tabCount = document.querySelectorAll(
                                '.agent-editor-tab'
                            ).length;
                            const messages = document.querySelectorAll(
                                '.agent-message'
                            ).length;
                            if (!active || messages === 0) {
                                return false;
                            }
                            const activeText = active.textContent?.trim() || '';
                            if (${JSON.stringify(expectNewResumeTab)}) {
                                return activeText === ${
                                    JSON.stringify(selectedResume?.name || '')
                                } && tabCount > ${
                                    Number(beforeResume.tabCount || 0)
                                };
                            }
                            return activeText === ${
                                JSON.stringify(selectedResume?.name || '')
                            };
                        }
                    `),
                    30000,
                    250
                );
            }
        );

        log(
            'resume-flow',
            expectNewResumeTab ? 'resumed-history' : 'activated-open-session'
        );
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
                const select = document.querySelector(
                    '.agent-panel-mode-select[data-selector-role="mode"]'
                );
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

    if (!skipConfigSwitch) {
        for (const [selectorRole, label] of [
            ['model', 'model'],
            ['thought_level', 'thought']
        ]) {
            const switchedConfig = await evaluate(
                toExpression(`
                    () => {
                        const select = document.querySelector(
                            '.agent-panel-mode-select[data-selector-role="${selectorRole}"]'
                        );
                        if (!select || select.options.length < 2) return '';
                        const options = Array.from(select.options);
                        const next = options.find(
                            (option) => option.value !== select.value
                        );
                        if (!next) return '';
                        select.value = next.value;
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                        return next.textContent.trim();
                    }
                `)
            );
            log(`switched-${label}`, switchedConfig || 'unchanged');
            if (switchedConfig) {
                await waitFor(`${label}-updated`, async () => {
                    return await evaluate(
                        toExpression(`
                            () => {
                                const select = document.querySelector(
                                    '.agent-panel-mode-select[data-selector-role="${selectorRole}"]'
                                );
                                const selectedText = select
                                    ? select.options[select.selectedIndex]
                                        ?.textContent?.trim() || ''
                                    : '';
                                const sawConfigFetch = Array.isArray(
                                    window.__fetchLog
                                ) && window.__fetchLog.some((entry) =>
                                    /\\/api\\/agents\\/tabs\\/[^/]+\\/config$/.test(
                                        entry.url || ''
                                    )
                                );
                                return sawConfigFetch
                                    || selectedText === ${JSON.stringify(switchedConfig)};
                            }
                        `),
                        15000,
                        250
                    );
                });
            }
        }
    }

    if (attachmentFiles.length > 0) {
        await setFileInputFiles('.agent-panel-file-input', attachmentFiles);
        await waitFor('attachment-chips-added', async () => {
            return await evaluate(
                toExpression(`
                    () => document.querySelectorAll(
                        '.agent-attachment-chip'
                    ).length === ${attachmentFiles.length}
                `),
                15000,
                250
            );
        });

        if (attachmentFiles.length > 1) {
            await evaluate(
                toExpression(`
                    () => {
                        document.querySelector(
                            '.agent-attachment-chip-remove'
                        )?.click();
                        return true;
                    }
                `)
            );
            await waitFor('attachment-chip-removed', async () => {
                return await evaluate(
                    toExpression(`
                        () => document.querySelectorAll(
                            '.agent-attachment-chip'
                        ).length === ${attachmentFiles.length - 1}
                    `),
                    15000,
                    250
                );
            });
            await setFileInputFiles(
                '.agent-panel-file-input',
                [attachmentFiles[0]]
            );
            await waitFor('attachment-chip-restored', async () => {
                return await evaluate(
                    toExpression(`
                        () => document.querySelectorAll(
                            '.agent-attachment-chip'
                        ).length === ${attachmentFiles.length}
                    `),
                    15000,
                    250
                );
            });
        }
    }

    const baselineLiveUi = await evaluate(
        toExpression(`
            () => ({
                toolCallCount: document.querySelectorAll(
                    '.agent-tool-call'
                ).length,
                terminalOutputCount: document.querySelectorAll(
                    '.agent-tool-call-terminal-output'
                ).length,
                managedSessionCount: document.querySelectorAll(
                    '.tab-item.agent-managed-session'
                ).length
            })
        `)
    );

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

    let postPromptState = '';
    const requireLivePromptStart = expectTerminalLive
        || expectManagedTerminalUi;
    try {
        postPromptState = await waitFor(
            requireLivePromptStart
                ? 'active-or-setup-or-permission'
                : 'active-or-setup-or-final',
            async () => {
                const hint = await readComposerHint();
                const activeState = /starting|running|responding/i
                    .test(hint.pill)
                    || /needs approval/i.test(hint.pill);
                const activeActivity = /thinking|running|starting|waiting for approval|restoring/i
                    .test(hint.activity);
                if (
                    activeState
                    && (activeActivity || hint.visible)
                    && /Esc stops/i.test(hint.hotkey)
                ) {
                    return 'active';
                }
                if (hasSetupConfig() && await hasSetupAction()) {
                    return 'setup';
                }
                if (await hasPermissionRequest()) {
                    return requireLivePromptStart ? 'permission' : 'final';
                }
                if (!requireLivePromptStart && await hasFinalMessage()) {
                    return 'final';
                }
                return '';
            },
            20000,
            250
        );
    } catch (error) {
        log(
            'warn:active-or-setup-or-final',
            error?.message || String(error)
        );
    }

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

    let promptOutcome = '';
    if (expectTerminalLive) {
        promptOutcome = postPromptState === 'permission'
            ? 'permission'
            : '';
        if (postPromptState === 'setup') {
            await handleRuntimeSetup();
        }
    } else {
        promptOutcome = await waitForPromptOutcome();
        if (promptOutcome === 'setup') {
            await handleRuntimeSetup();
            promptOutcome = await waitForPromptOutcome(
                'permission-final-after-setup'
            );
        }
        if (promptOutcome === 'backend-ready') {
            if (skipRestoreTail) {
                log('backend-ready-skip-restore-tail');
            } else {
                log('backend-ready-fallback');
                await page.send('Page.reload', { ignoreCache: true });
                await waitForDocumentReady('document-ready-after-backend-ready');
                await ensureAuthedSession({
                    authLabel: 'auth-after-backend-ready',
                    sessionLabel: 'session-after-backend-ready'
                });
                await waitFor('agent-panel-after-backend-ready', async () => {
                    return await evaluate(
                        toExpression(`
                            () => {
                                const tabs = Array.from(document.querySelectorAll(
                                    '.agent-editor-tab'
                                ));
                                const active = tabs.find((tab) =>
                                    tab.classList.contains('active')
                                );
                                const panel = document.querySelector('.agent-panel');
                                return Boolean(active)
                                    && active.classList.contains('agent-editor-tab')
                                    && Boolean(panel)
                                    && getComputedStyle(panel).display !== 'none';
                            }
                        `)
                    );
                }, 20000, 250);
            }
        }
    }

    if (attachmentFiles.length > 0) {
        const attachmentNamesVisible = await waitFor(
            'message-attachments-visible',
            async () => {
                return await evaluate(
                    toExpression(`
                        () => {
                            const names = Array.from(document.querySelectorAll(
                                '.agent-message-attachment-name'
                            )).map((node) => node.textContent?.trim() || '');
                            const expected = ${JSON.stringify(
                                attachmentFiles.map((filePath) =>
                                    filePath.split('/').pop()
                                )
                            )};
                            return expected.every((name) => names.includes(name))
                                ? names
                                : null;
                        }
                    `),
                    15000,
                    250
                );
            }
        );
        log(
            'message-attachments',
            JSON.stringify(attachmentNamesVisible)
        );
    }

    if (promptOutcome === 'permission') {
        await waitFor('permission-hint', async () => {
            const hint = await readComposerHint();
            return /needs approval/i.test(hint.pill)
                && /waiting for approval/i.test(hint.activity || '');
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

    const resumeCommandAvailable = await evaluate(
        toExpression(`
            () => {
                const input = document.querySelector('.agent-panel-input');
                input.value = '/resume';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            }
        `)
    );
    if (resumeCommandAvailable) {
        await waitFor('resume-command-probe', async () => {
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
        const hasResumeCommand = await evaluate(
            toExpression(`
                () => Array.from(
                    document.querySelectorAll('.agent-command-option-name')
                ).some((el) => (el.textContent || '').trim().length > 0)
            `)
        );
        if (hasResumeCommand) {
            await exerciseResumeFlowIfSupported();
        } else if (requireResumeCoverage) {
            throw new Error('Resume coverage required but command menu stayed empty');
        } else {
            log('resume-flow', 'command-unavailable');
        }
    }

    if (expectTerminalLive) {
        if (expectManagedTerminalUi) {
            let lastManagedTerminalLiveState = null;
            await waitFor('managed-terminal-session-live', async () => {
                let heartbeatSessions = [];
                let managedHeartbeatCount = 0;
                try {
                    const heartbeat = await postJsonWithAuth(
                        new URL('/api/heartbeat', tabminalUrl),
                        tabminalAuthToken,
                        { updates: { sessions: [] } }
                    );
                    heartbeatSessions = Array.isArray(heartbeat?.sessions)
                        ? heartbeat.sessions
                        : [];
                    managedHeartbeatCount = heartbeatSessions.filter(
                        (session) => session?.managed?.kind === 'agent-terminal'
                    ).length;
                } catch {
                    heartbeatSessions = [];
                    managedHeartbeatCount = 0;
                }
                const liveUiState = await evaluate(
                    toExpression(`
                        async () => {
                            const heartbeatSessions = ${JSON.stringify(
                                heartbeatSessions
                            )};
                            if (
                                window.__tabminalSmoke
                                && typeof window.__tabminalSmoke
                                    .applyMainServerSessions
                                    === 'function'
                            ) {
                                try {
                                    const result = await window.__tabminalSmoke
                                        .applyMainServerSessions(
                                            heartbeatSessions
                                        );
                                    if (result && typeof result === 'object') {
                                        const managedTabs = Array.from(
                                            document.querySelectorAll(
                                                '.tab-item.agent-managed-session'
                                            )
                                        );
                                        return {
                                            hasManagedSessionState:
                                                Array.isArray(
                                                    result.managedSessionKeys
                                                ) && result.managedSessionKeys
                                                    .length > 0,
                                            hasMatchingManagedSession:
                                                managedTabs.length > 0,
                                            hasManagedBadge: managedTabs.some(
                                                (node) => /MANAGED:/i.test(
                                                    node.textContent || ''
                                                )
                                            ),
                                            managedSessionCount: managedTabs
                                                .length,
                                            hasOpenButton: Boolean(
                                                document.querySelector(
                                                    '.agent-tool-call-terminal-open'
                                                )
                                            )
                                        };
                                    }
                        } catch {
                            // Ignore in-page sync failures during polling.
                        }
                    }
                            const managedSessionKeys = (
                                window.__tabminalSmoke
                                && typeof window.__tabminalSmoke
                                    .getManagedSessionKeys === 'function'
                            )
                                ? window.__tabminalSmoke
                                    .getManagedSessionKeys()
                                : [];
                            const managedTabs = Array.from(
                                document.querySelectorAll(
                                    '.tab-item.agent-managed-session'
                                )
                            );
                            return {
                                hasManagedSessionState:
                                    managedSessionKeys.length > 0,
                                hasMatchingManagedSession:
                                    managedTabs.length > 0,
                                hasManagedBadge: managedTabs.some(
                                    (node) => /MANAGED:/i.test(
                                        node.textContent || ''
                                    )
                                ),
                                managedSessionCount: managedTabs.length,
                                hasOpenButton: Boolean(
                                    document.querySelector(
                                        '.agent-tool-call-terminal-open'
                                    )
                                )
                            };
                        }
                    `)
                );
                lastManagedTerminalLiveState = {
                    managedHeartbeatCount,
                    liveUiState
                };
                return managedHeartbeatCount > 0
                    && liveUiState?.hasManagedSessionState
                    && liveUiState?.hasMatchingManagedSession
                    && liveUiState?.hasManagedBadge
                    && Number(liveUiState?.managedSessionCount || 0) > 0;
            }, 20000, 250).catch((error) => {
                throw new Error(
                    `${error.message}: ${JSON.stringify(
                        lastManagedTerminalLiveState
                    )}`
                );
            });
        }

        await waitFor('live-tool-call', async () => {
            return await evaluate(
                toExpression(`
                    () => document.querySelectorAll(
                        '.agent-tool-call'
                    ).length > ${Number(
                        baselineLiveUi?.toolCallCount || 0
                    )}
                `)
            );
        }, 20000, 250);

        if (expectManagedTerminalUi) {
            await waitFor('managed-terminal-jump-in-live', async () => {
                return await evaluate(
                    toExpression(`
                        () => Boolean(
                            document.querySelector(
                                '.agent-tool-call-terminal-open'
                            )
                        )
                    `)
                );
            }, 20000, 250);
        }

        await waitFor('live-tool-sections-expanded', async () => {
            return await evaluate(
                toExpression(`
                    () => {
                        const sections = Array.from(document.querySelectorAll(
                            '.agent-tool-call-section'
                        ));
                        if (sections.length === 0) return false;
                        for (const section of sections) {
                            section.open = true;
                        }
                        return sections.every((section) => section.open);
                    }
                `)
            );
        }, 20000, 250);

        await waitFor('terminal-live-alpha', async () => {
            return await evaluate(
                toExpression(`
                    () => Array.from(document.querySelectorAll(
                        '.agent-tool-call-terminal-output'
                    )).slice(${Number(
                        baselineLiveUi?.terminalOutputCount || 0
                    )}).some((node) => {
                        const text = node.dataset.outputPreview
                            || node.getAttribute('aria-label')
                            || '';
                        return /alpha/.test(text);
                    })
                `)
            );
        }, 20000, 150);

        await waitFor('terminal-live-beta', async () => {
            return await evaluate(
                toExpression(`
                    () => Array.from(document.querySelectorAll(
                        '.agent-tool-call-terminal-output'
                    )).slice(${Number(
                        baselineLiveUi?.terminalOutputCount || 0
                    )}).some((node) => {
                        const text = node.dataset.outputPreview
                            || node.getAttribute('aria-label')
                            || '';
                        return /alpha/.test(text) && /beta/.test(text);
                    })
                `)
            );
        }, 20000, 150);

        if (!promptOutcome) {
            promptOutcome = await waitForPromptOutcome(
                'permission-final-after-live'
            );
        }
        if (promptOutcome === 'setup') {
            await handleRuntimeSetup();
            promptOutcome = await waitForPromptOutcome(
                'permission-final-after-live-setup'
            );
        }
        if (promptOutcome === 'backend-ready') {
            if (skipRestoreTail) {
                log('backend-ready-skip-restore-tail');
            } else {
                log('backend-ready-fallback');
                await page.send('Page.reload', { ignoreCache: true });
                await waitForDocumentReady('document-ready-after-backend-ready');
                await ensureAuthedSession({
                    authLabel: 'auth-after-backend-ready',
                    sessionLabel: 'session-after-backend-ready'
                });
                await waitFor('agent-panel-after-backend-ready', async () => {
                    return await evaluate(
                        toExpression(`
                            () => {
                                const tabs = Array.from(document.querySelectorAll(
                                    '.agent-editor-tab'
                                ));
                                const active = tabs.find((tab) =>
                                    tab.classList.contains('active')
                                );
                                const panel = document.querySelector('.agent-panel');
                                return Boolean(active)
                                    && active.classList.contains('agent-editor-tab')
                                    && Boolean(panel)
                                    && getComputedStyle(panel).display !== 'none';
                            }
                        `)
                    );
                }, 20000, 250);
            }
        }
    }

    if (promptOutcome !== 'backend-ready') {
        await waitFor('final-message', async () => {
            return await hasFinalMessage();
        });
    }

    if (expectTool) {
        try {
            await waitFor('tool-call', async () => {
                return await evaluate(
                    toExpression(`
                        () => document.querySelectorAll('.agent-tool-call').length > 0
                    `)
                );
            }, 20000, 250);
        } catch (error) {
            const debugState = await dumpPageState(page);
            log('debug-tool-call-state', JSON.stringify(debugState));
            throw error;
        }
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

    if (expectPlanPanel) {
        await waitFor('plan-panel', async () => {
            return await evaluate(
                toExpression(`
                    () => {
                        const panel = document.querySelector(
                            '.agent-plan-panel'
                        );
                        const activeHeader = panel?.querySelector(
                            '.agent-plan-header'
                        );
                        const activeEntries = panel?.querySelectorAll(
                            '.agent-plan-entry'
                        )?.length || 0;
                        const history = document.querySelector(
                            '.agent-plan-history .agent-plan-history-body'
                        );
                        const historyHeader = history?.querySelector(
                            '.agent-plan-header'
                        );
                        const historyEntries = history?.querySelectorAll(
                            '.agent-plan-entry'
                        )?.length || 0;
                        const activePlanVisible = Boolean(panel)
                            && getComputedStyle(panel).display !== 'none'
                            && Boolean(activeHeader)
                            && activeEntries >= 3;
                        const archivedPlanVisible = Boolean(history)
                            && Boolean(historyHeader)
                            && historyEntries >= 3;
                        return activePlanVisible || archivedPlanVisible;
                    }
                `)
            );
        }, 20000, 250);
    }

    if (expectUsageHud) {
        await waitFor('usage-hud', async () => {
            return await evaluate(
                toExpression(`
                    () => {
                        const hud = document.querySelector(
                            '.agent-usage-hud'
                        );
                        const compactMetrics = hud?.querySelectorAll(
                            '.agent-usage-pill'
                        )?.length || 0;
                        return Boolean(hud)
                            && getComputedStyle(hud).display !== 'none'
                            && compactMetrics >= 1;
                    }
                `)
            );
        }, 20000, 250);
    }

    if (expectDiffEditor || expectCodeEditor || expectTerminalSection) {
        await waitFor('tool-sections-expanded', async () => {
            return await evaluate(
                toExpression(`
                    () => {
                        const sections = Array.from(document.querySelectorAll(
                            '.agent-tool-call-section'
                        ));
                        if (sections.length === 0) return false;
                        for (const section of sections) {
                            section.open = true;
                        }
                        return sections.every((section) => section.open);
                    }
                `)
            );
        }, 20000, 250);
    }

    if (expectTerminalSection) {
        await waitFor('terminal-section', async () => {
            return await evaluate(
                toExpression(`
                    () => {
                        const outputs = document.querySelectorAll(
                            '.agent-tool-call-terminal-output'
                        );
                        return Array.from(outputs).some((node) => {
                            const text = node.dataset.outputPreview
                                || node.getAttribute('aria-label')
                                || node.textContent
                                || '';
                            return node.querySelector('.xterm')
                                && /alpha/.test(text)
                                && /beta/.test(text);
                        });
                    }
                `)
            );
        }, 20000, 250);
    }

    if (expectDiffEditor) {
        await waitFor('diff-editor', async () => {
            return await evaluate(
                toExpression(`
                    () => {
                        const diff = document.querySelector(
                            '.agent-tool-call-editor.diff'
                        );
                        const lineNumbers = document.querySelector(
                            '.agent-tool-call-editor .line-numbers'
                        );
                        return !!(diff && lineNumbers);
                    }
                `)
            );
        }, 20000, 250);
    }

    if (expectCodeEditor) {
        await waitFor('code-editor', async () => {
            return await evaluate(
                toExpression(`
                    () => {
                        const editors = Array.from(document.querySelectorAll(
                            '.agent-tool-call-editor'
                        )).filter((node) =>
                            !node.classList.contains('diff')
                        );
                        const lineNumbers = document.querySelector(
                            '.agent-tool-call-editor .line-numbers'
                        );
                        return editors.length > 0 && !!lineNumbers;
                    }
                `)
            );
        }, 20000, 250);
    }

    const finalHint = await readComposerHint();
    log('composer-hint-after-final', JSON.stringify(finalHint));

    if (expectTitlePattern) {
        await waitFor('agent-title-update', async () => {
            return await evaluate(
                toExpression(`
                    () => {
                        const activeTab = document.querySelector(
                            '.agent-editor-tab.active'
                        );
                        const text = activeTab
                            ? Array.from(activeTab.querySelectorAll('span'))
                                .map((node) => node.textContent || '')
                                .join(' ')
                                .trim()
                            : '';
                        return text.includes(${JSON.stringify(
                            expectTitlePattern
                        )});
                    }
                `)
            );
        }, 20000, 250);
    }

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
        return readyHint || !hint.visible;
    });

    if (expectManagedTerminalUi) {
        await waitFor('managed-terminal-released', async () => {
            return await evaluate(
                toExpression(`
                    async () => {
                        if (
                            window.__tabminalSmoke
                            && typeof window.__tabminalSmoke
                                .syncMainServerSessions
                                === 'function'
                        ) {
                            try {
                                await window.__tabminalSmoke
                                    .syncMainServerSessions();
                            } catch {
                                // Ignore sync failures during smoke polling.
                            }
                        }
                        return !document.querySelector(
                            '.agent-tool-call-terminal-open'
                        );
                    }
                `)
            );
        }, 20000, 250);
    }

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
                input.value = '/cancel';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                const sendButton = Array.from(
                    document.querySelectorAll('.agent-panel-button')
                ).find((el) => /send/i.test(el.textContent || ''));
                sendButton?.click();
                return true;
            }
        `)
    );
    log('submitted-cancel');

    await waitFor('stop-enabled', async () => {
        return await evaluate(
            toExpression(`
                () => {
                    const button = document.querySelector(
                        '.agent-activity-action'
                    );
                    return Boolean(button)
                        && button.disabled === false
                        && getComputedStyle(button).display !== 'none';
                }
            `),
            15000,
            250
        );
    });

    await evaluate(
        toExpression(`
            () => {
                const stopButton = document.querySelector(
                    '.agent-activity-action'
                );
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

        const restoredActiveAgentTabText = await evaluate(
            toExpression(`
                () => (
                    document.querySelector('.agent-editor-tab.active')
                        ?.textContent?.trim() || ''
                )
            `)
        );
        log('restored-active-agent-tab', restoredActiveAgentTabText);

        const previousAgentTabCount = await evaluate(
            toExpression(`
                () => document.querySelectorAll('.agent-editor-tab').length
            `)
        );

        const createdSecondAgent = await evaluate(
            toExpression(`
                () => {
                    const button = document.querySelector(
                        '.agent-panel-top-button'
                    );
                    if (!button) return false;
                    button.click();
                    return true;
                }
            `)
        );
        log(
            'created-second-agent',
            createdSecondAgent ? 'clicked' : 'missing-button'
        );

        await waitFor('second-agent-restored', async () => {
            return await evaluate(
                toExpression(`
                    () => {
                        const tabs = document.querySelectorAll(
                            '.agent-editor-tab'
                        );
                        const active = document.querySelector(
                            '.agent-editor-tab.active'
                        );
                        return tabs.length > ${
                            Number(previousAgentTabCount || 0)
                        } && Boolean(active);
                    }
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
                        (tab.textContent || '').trim() === ${
                            JSON.stringify(restoredActiveAgentTabText)
                        }
                    ) || tabs[0];
                    target?.click();
                    return target?.textContent?.trim() || '';
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
                            && (active.textContent || '').trim() === ${
                                JSON.stringify(restoredActiveAgentTabText)
                            }
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
                activeAgentTab:
                    document.querySelector('.agent-editor-tab.active')
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
        if (!debugKeepTarget) {
            try {
                await browser.send('Target.closeTarget', { targetId });
                await waitFor('target-closed', async () => {
                    const list = await getJson(`${chromeBaseUrl}/json/list`);
                    return !list.some((item) => item.id === targetId);
                }, 5000, 100);
            } catch {}
        }
        browser.close();
    }
}

main().catch((error) => {
    console.error(error.stack || String(error));
    process.exit(1);
});
