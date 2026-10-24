import {
    LODY_EXTENSION_METHODS as methods,
    normalizeLodyExtensionMethod,
    isLodySubagentEvent,
    supportsLodySubagentEvents
} from 'acp-extension-core';

// A bounded projection into Tabminal's existing tools and usage surfaces.
// No Lody product services, replicated documents, or UI stores are required.
export const clientExtensions = {
    lody: { subagentEvents: { version: 1 } }
};

const OUTPUT_LIMIT = 16 * 1024;
const states = {
    pending: 'pending', running: 'in_progress', completed: 'completed',
    failed: 'failed', cancelled: 'cancelled', unknown: 'unknown'
};

export function supportsExtension(method, capabilities) {
    method = normalizeLodyExtensionMethod(method);
    if (method === methods.subagentEvent) {
        return supportsLodySubagentEvents(capabilities);
    }
    if (method === methods.sessionUsageUpdate) {
        return capabilities?._meta?.lody?.usage?.version === 1;
    }
    return false;
}

export function projectExtension(method, params, previous = null) {
    method = normalizeLodyExtensionMethod(method);
    if (method === methods.subagentEvent) {
        if (!isLodySubagentEvent(params)) return null;
        const toolCallId = `lody:subagent:${params.runId}`;
        const tool = { ...previous, toolCallId, kind: 'other' };
        const child = { ...previous?.subagent, runId: params.runId };
        if (params.type === 'snapshot') {
            Object.assign(child, params.snapshot);
            tool.title = params.snapshot.name || params.snapshot.description
                || previous?.title || 'Subagent';
            tool.status = states[params.snapshot.state];
        } else if (params.type === 'progress') {
            child.progress = params.progress;
        } else {
            const update = params.update;
            if (update.content?.type === 'text') {
                child.output = (String(child.output || '') + update.content.text)
                    .slice(-OUTPUT_LIMIT);
            } else if (update.sessionUpdate.startsWith('tool_call')) {
                child.lastTool = update.title || child.lastTool;
            }
        }
        tool.title ||= 'Subagent';
        tool.status ||= 'pending';
        tool.subagent = child;
        const text = [child.progress?.summary || child.summary,
            child.reason?.message, child.output].filter(Boolean).join('\n\n');
        tool.content = text ? [{
            type: 'content', content: { type: 'text', text }
        }] : [];
        return { type: 'tool', sessionId: params.sessionId, tool };
    }
    if (method === methods.sessionUsageUpdate) {
        const usage = params?.usage;
        if (typeof params?.sessionId !== 'string' || !usage
            || !Number.isFinite(usage.inputTokens)
            || !Number.isFinite(usage.outputTokens)) return null;
        // This is a turn snapshot, not a cumulative billing ledger. Never sum
        // notifications or combine delta with modelUsage (it counts twice).
        const totalTokens = ['inputTokens', 'outputTokens',
            'cacheReadInputTokens', 'cacheCreationInputTokens',
            'reasoningOutputTokens'].reduce((sum, key) => sum + (
            Number.isFinite(usage[key]) ? Math.max(0, usage[key]) : 0
        ), 0);
        return {
            type: 'usage', sessionId: params.sessionId,
            usage: { totals: { ...usage, totalTokens } }
        };
    }
    return null;
}
