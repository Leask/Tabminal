export function buildAgentTabAttachAck(
    agentTab,
    busSession,
    { attachSource = '' } = {}
) {
    if (!agentTab) {
        return null;
    }
    const continuityState = typeof busSession?.continuityState === 'string'
        ? busSession.continuityState
        : 'cold';
    const normalizedAttachSource = attachSource || (
        continuityState === 'live'
            ? 'hot'
            : continuityState === 'cached'
                ? 'cache'
                : 'cold'
    );
    return {
        ok: true,
        attach: {
            ok: true,
            source: normalizedAttachSource,
            continuityState
        },
        tab: {
            id: agentTab.id,
            runtimeId: agentTab.runtimeId,
            runtimeKey: agentTab.runtimeKey,
            acpSessionId: agentTab.acpSessionId,
            agentId: agentTab.agentId,
            agentLabel: agentTab.agentLabel,
            commandLabel: agentTab.commandLabel,
            title: agentTab.title || '',
            terminalSessionId: agentTab.terminalSessionId || '',
            cwd: agentTab.cwd || '',
            createdAt: agentTab.createdAt || '',
            status: agentTab.status || 'ready',
            busy: !!agentTab.busy,
            errorMessage: agentTab.errorMessage || '',
            currentModeId: agentTab.currentModeId || '',
            availableModes: Array.isArray(agentTab.availableModes)
                ? agentTab.availableModes
                : [],
            availableCommands: Array.isArray(agentTab.availableCommands)
                ? agentTab.availableCommands
                : [],
            sessionCapabilities: agentTab.sessionCapabilities || {},
            configOptions: Array.isArray(agentTab.configOptions)
                ? agentTab.configOptions
                : [],
            toolCalls: Array.isArray(agentTab.toolCalls)
                ? agentTab.toolCalls
                : [],
            permissions: Array.isArray(agentTab.permissions)
                ? agentTab.permissions
                : [],
            plan: Array.isArray(agentTab.plan) ? agentTab.plan : [],
            terminals: Array.isArray(agentTab.terminals)
                ? agentTab.terminals
                : [],
            usage: agentTab.usage || null,
            busConnectionKind: 'shared',
            busContinuityState: continuityState,
            busHotRank: busSession?.hotRank ?? null
        }
    };
}

export async function buildBusBackedAgentTab(
    acpBusManager,
    tabId,
    { attach = false } = {}
) {
    if (attach) {
        const result = await acpBusManager.attachOpenTab(tabId);
        return result?.tab || null;
    }
    return await acpBusManager.getOpenTab(tabId);
}

export async function buildBusTimelinePage(acpBusManager, tabId, query = {}) {
    return await acpBusManager.getTimelinePageForTab(tabId, query);
}

export function buildBusCommandMeta(
    type,
    {
        requestId = '',
        deduped = false,
        idempotency = 'none'
    } = {}
) {
    return {
        type,
        requestId: String(requestId || '').trim(),
        deduped: deduped === true,
        idempotency
    };
}

export function buildBusCommandError(
    code,
    message,
    {
        retryable = false,
        details = null
    } = {}
) {
    const error = {
        code,
        message,
        retryable: retryable === true
    };
    if (details && typeof details === 'object') {
        error.details = details;
    }
    return {
        ok: false,
        error
    };
}

export function classifyBusCommandFailure(error, fallbackMessage) {
    const message = String(
        error?.message
        || fallbackMessage
        || 'ACP bus command failed'
    );
    const details = error?.details && typeof error.details === 'object'
        ? error.details
        : null;
    if (error?.code === 'idempotency_conflict') {
        return {
            status: 409,
            body: buildBusCommandError(
                'idempotency_conflict',
                message,
                { details }
            )
        };
    }
    if (/permission request not found/i.test(message)) {
        return {
            status: 409,
            body: buildBusCommandError(
                'permission_stale',
                message,
                { details }
            )
        };
    }
    if (/continuity required|authoritative reload/i.test(message)) {
        return {
            status: 409,
            body: buildBusCommandError(
                'continuity_required',
                message,
                { details }
            )
        };
    }
    if (/session .*not found|acp bus session not found/i.test(message)) {
        return {
            status: 404,
            body: buildBusCommandError(
                'session_missing',
                message,
                { details }
            )
        };
    }
    if (/agent tab not found/i.test(message)) {
        return {
            status: 404,
            body: buildBusCommandError(
                'tab_missing',
                message,
                { details }
            )
        };
    }
    if (/session is already open|already open/i.test(message)) {
        return {
            status: 409,
            body: buildBusCommandError(
                'session_already_open',
                message,
                { details }
            )
        };
    }
    if (/unknown agent/i.test(message)) {
        return {
            status: 404,
            body: buildBusCommandError(
                'unknown_agent',
                message,
                { details }
            )
        };
    }
    if (/agent unavailable|not ready on the current host/i.test(message)) {
        return {
            status: 503,
            body: buildBusCommandError(
                'runtime_unavailable',
                message,
                {
                    retryable: true,
                    details
                }
            )
        };
    }
    if (/does not support/i.test(message)) {
        return {
            status: 501,
            body: buildBusCommandError(
                'not_supported',
                message,
                { details }
            )
        };
    }
    if (/is required|invalid|missing/i.test(message)) {
        return {
            status: 400,
            body: buildBusCommandError(
                'invalid_request',
                message,
                { details }
            )
        };
    }
    return {
        status: 500,
        body: buildBusCommandError(
            'internal_error',
            message,
            { details }
        )
    };
}
