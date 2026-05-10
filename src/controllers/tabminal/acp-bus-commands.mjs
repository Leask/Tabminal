import { parseAcpBusCommand } from './uploads.mjs';
import {
    buildAgentTabAttachAck,
    buildBusCommandMeta,
    classifyBusCommandFailure
} from './acp-bus-format.mjs';

export function registerAcpBusCommandRoute(router, { acpBusManager }) {
    router.post('/api/acp-bus/command', async (ctx) => {
        let command = null;
        try {
            command = await parseAcpBusCommand(ctx);
        } catch (error) {
            ctx.status = 400;
            ctx.body = classifyBusCommandFailure(
                error,
                'Failed to parse ACP bus command'
            ).body;
            return;
        }

        const type = String(command?.type || '').trim();
        const requestId = String(command?.requestId || '').trim();

        try {
            switch (type) {
                case 'tab.create': {
                    const { agentId, cwd, terminalSessionId, modeId } = command;
                    if (!agentId || typeof agentId !== 'string') {
                        throw new Error('agentId is required');
                    }
                    if (!cwd || typeof cwd !== 'string') {
                        throw new Error('cwd is required');
                    }
                    const tab = await acpBusManager.createTabForUi({
                        agentId,
                        cwd,
                        terminalSessionId: typeof terminalSessionId === 'string'
                            ? terminalSessionId
                            : '',
                        modeId: typeof modeId === 'string' ? modeId : ''
                    });
                    ctx.status = 201;
                    ctx.body = {
                        ok: true,
                        command: buildBusCommandMeta(type, {
                            idempotency: 'none'
                        }),
                        tab
                    };
                    return;
                }
                case 'tab.resume': {
                    const {
                        agentId,
                        cwd,
                        terminalSessionId,
                        sessionId,
                        targetTabId,
                        title
                    } = command;
                    if (!agentId || typeof agentId !== 'string') {
                        throw new Error('agentId is required');
                    }
                    if (!cwd || typeof cwd !== 'string') {
                        throw new Error('cwd is required');
                    }
                    if (!sessionId || typeof sessionId !== 'string') {
                        throw new Error('sessionId is required');
                    }
                    const {
                        serialized,
                        busSession,
                        attachSource
                    } = await acpBusManager.resumeTabForUi({
                        agentId,
                        cwd,
                        sessionId,
                        targetTabId: typeof targetTabId === 'string'
                            ? targetTabId
                            : '',
                        title: typeof title === 'string' ? title : '',
                        terminalSessionId: typeof terminalSessionId === 'string'
                            ? terminalSessionId
                            : ''
                    });
                    ctx.body = {
                        command: buildBusCommandMeta(type, {
                            idempotency: 'natural'
                        }),
                        ...(buildAgentTabAttachAck(serialized, busSession, {
                            attachSource
                        }) || {
                            ok: true,
                            attach: {
                                ok: true,
                                source: attachSource,
                                continuityState: 'cold'
                            },
                            tab: serialized
                        })
                    };
                    return;
                }
                case 'tab.attach': {
                    const tabId = String(command?.tabId || '').trim();
                    if (!tabId) {
                        throw new Error('tabId is required');
                    }
                    const result = await acpBusManager.attachOpenTab(tabId);
                    if (!result?.tab) {
                        throw new Error('Agent tab not found');
                    }
                    ctx.body = {
                        command: buildBusCommandMeta(type, {
                            idempotency: 'natural'
                        }),
                        ...(buildAgentTabAttachAck(
                            result.tab,
                            result.session
                        ) || {
                            ok: true,
                            attach: {
                                ok: true,
                                source: 'cold',
                                continuityState: 'cold'
                            },
                            tab: result.tab
                        })
                    };
                    return;
                }
                case 'tab.detach': {
                    const tabId = String(command?.tabId || '').trim();
                    if (!tabId) {
                        throw new Error('tabId is required');
                    }
                    await acpBusManager.unpinSession(
                        `agent-tab:${tabId}`,
                        'agent_tab_detach'
                    );
                    ctx.body = {
                        ok: true,
                        command: buildBusCommandMeta(type, {
                            idempotency: 'natural'
                        })
                    };
                    return;
                }
                case 'tab.prompt': {
                    const tabId = String(command?.tabId || '').trim();
                    const text = typeof command?.text === 'string'
                        ? command.text
                        : '';
                    const attachments = Array.isArray(command?.attachments)
                        ? command.attachments
                        : [];
                    if (!tabId) {
                        throw new Error('tabId is required');
                    }
                    if (!text.trim() && attachments.length === 0) {
                        throw new Error('text or attachments are required');
                    }
                    const result = await acpBusManager.sendPromptForTab(
                        tabId,
                        text,
                        attachments,
                        { requestId }
                    );
                    ctx.status = 202;
                    ctx.body = {
                        ok: true,
                        command: buildBusCommandMeta(type, {
                            requestId: result.requestId,
                            deduped: result.deduped,
                            idempotency: 'request'
                        })
                    };
                    return;
                }
                case 'tab.cancel': {
                    const tabId = String(command?.tabId || '').trim();
                    if (!tabId) {
                        throw new Error('tabId is required');
                    }
                    await acpBusManager.cancelForTab(tabId);
                    ctx.status = 202;
                    ctx.body = {
                        ok: true,
                        command: buildBusCommandMeta(type, {
                            idempotency: 'natural'
                        })
                    };
                    return;
                }
                case 'tab.resolve_permission': {
                    const tabId = String(command?.tabId || '').trim();
                    const permissionId = String(
                        command?.permissionId || ''
                    ).trim();
                    const optionId = typeof command?.optionId === 'string'
                        ? command.optionId
                        : '';
                    if (!tabId) {
                        throw new Error('tabId is required');
                    }
                    if (!permissionId) {
                        throw new Error('permissionId is required');
                    }
                    await acpBusManager.resolvePermissionForTab(
                        tabId,
                        permissionId,
                        optionId
                    );
                    ctx.body = {
                        ok: true,
                        command: buildBusCommandMeta(type, {
                            idempotency: 'none'
                        })
                    };
                    return;
                }
                case 'tab.set_mode': {
                    const tabId = String(command?.tabId || '').trim();
                    const modeId = typeof command?.modeId === 'string'
                        ? command.modeId
                        : '';
                    if (!tabId) {
                        throw new Error('tabId is required');
                    }
                    if (!modeId) {
                        throw new Error('modeId is required');
                    }
                    const tab = await acpBusManager.setModeForTab(
                        tabId,
                        modeId
                    );
                    ctx.body = {
                        ok: true,
                        command: buildBusCommandMeta(type, {
                            idempotency: 'none'
                        }),
                        tab
                    };
                    return;
                }
                case 'tab.set_config': {
                    const tabId = String(command?.tabId || '').trim();
                    const configId = typeof command?.configId === 'string'
                        ? command.configId
                        : '';
                    const valueId = typeof command?.valueId === 'string'
                        ? command.valueId
                        : '';
                    if (!tabId) {
                        throw new Error('tabId is required');
                    }
                    if (!configId) {
                        throw new Error('configId is required');
                    }
                    if (!valueId) {
                        throw new Error('valueId is required');
                    }
                    const tab = await acpBusManager.setConfigOptionForTab(
                        tabId,
                        configId,
                        valueId
                    );
                    ctx.body = {
                        ok: true,
                        command: buildBusCommandMeta(type, {
                            idempotency: 'none'
                        }),
                        tab
                    };
                    return;
                }
                case 'tab.close': {
                    const tabId = String(command?.tabId || '').trim();
                    if (!tabId) {
                        throw new Error('tabId is required');
                    }
                    await acpBusManager.closeTabForUi(tabId);
                    ctx.body = {
                        ok: true,
                        command: buildBusCommandMeta(type, {
                            idempotency: 'natural'
                        })
                    };
                    return;
                }
                case 'terminal.release': {
                    const terminalSessionId = String(
                        command?.terminalSessionId || ''
                    ).trim();
                    if (!terminalSessionId) {
                        throw new Error('terminalSessionId is required');
                    }
                    const released = await acpBusManager
                        .releaseManagedTerminalSession(
                            terminalSessionId,
                            {
                                destroy: command?.destroy === true
                            }
                        );
                    ctx.body = {
                        ok: true,
                        command: buildBusCommandMeta(type, {
                            idempotency: 'natural'
                        }),
                        released
                    };
                    return;
                }
                default:
                    throw new Error(
                        type
                            ? `Unknown ACP bus command type: ${type}`
                            : 'type is required'
                    );
            }
        } catch (error) {
            const classified = classifyBusCommandFailure(
                error,
                `Failed to execute ACP bus command ${type || '(unknown)'}`
            );
            ctx.status = classified.status;
            ctx.body = classified.body;
        }
    });
}
