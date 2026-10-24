// A read-only ACP replay projector. History lives in SQLite, not in this object.
// Upstream ids identify updates; the store assigns first-observed indexes.
export class HistoryImporter {
    constructor(store, stage) {
        this.store = store;
        this.stage = stage;
        this.turn = 0;
        this.lastStream = '';
        this.planId = '';
    }

    async receive(update) {
        const event = update?.sessionUpdate;
        const role = event === 'user_message_chunk' ? 'user' : 'assistant';
        if (['user_message_chunk', 'agent_message_chunk',
            'agent_thought_chunk'].includes(event)) {
            const kind = event === 'agent_thought_chunk' ? 'thought' : 'message';
            const stream = `${role}:${kind}`;
            if (stream !== this.lastStream) this.turn++;
            this.lastStream = stream;
            const id = update.messageId || `history:${this.turn}:${stream}`;
            const content = update.content;
            await this.store.writeHistoryItem(this.stage, 'message', id, {
                id, streamKey: id, role, kind,
                ...(content?.type === 'text' ? {} : { content })
            }, content?.type === 'text'
                ? content.text : `[${content?.type || 'content'}]`);
        } else if (event === 'tool_call' || event === 'tool_call_update') {
            if (!update.toolCallId) throw new Error('History tool requires an id');
            this.lastStream = '';
            const { sessionUpdate: _event, ...tool } = update;
            await this.store.writeHistoryItem(
                this.stage, 'tool', tool.toolCallId, tool
            );
        } else if (event === 'plan') {
            this.planId ||= `history:plan:${++this.turn}`;
            const entries = Array.isArray(update.entries) ? update.entries : [];
            const completed = entries.length > 0
                && entries.every((entry) => entry.status === 'completed');
            await this.store.writeHistoryItem(this.stage, 'plan', this.planId, {
                id: this.planId, entries, active: false,
                status: completed ? 'completed' : 'archived'
            });
            if (completed) {
                this.planId = '';
            }
        } else if (event === 'session_info_update') {
            if (typeof update.title === 'string') this.stage.title = update.title;
        }
    }
}
