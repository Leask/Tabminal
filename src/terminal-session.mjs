const WS_STATE_OPEN = 1;
const DEFAULT_HISTORY_LIMIT = 512 * 1024; // chars

export class TerminalSession {
    constructor(pty, options = {}) {
        this.pty = pty;
        this.id = options.id;
        this.manager = options.manager; // Store a reference to the manager
        this.createdAt = options.createdAt ?? new Date();
        this.historyLimit = Math.max(
            1,
            options.historyLimit ?? DEFAULT_HISTORY_LIMIT
        );
        this.history = '';
        this.clients = new Set();
        this.closed = false;

        this._handleData = (chunk) => {
            if (typeof chunk !== 'string') {
                chunk = chunk.toString('utf8');
            }
            // Update the raw history
            this._appendHistory(chunk);

            // Broadcast the raw output to active clients
            this._broadcast({ type: 'output', data: chunk });
        };

        this._handleExit = (details) => {
            this.closed = true;
            this._broadcast({
                type: 'status',
                status: 'terminated',
                code: details?.exitCode ?? 0,
                signal: details?.signal ?? null
            });
        };

        this.dataSubscription = this.pty.onData(this._handleData);
        this.exitSubscription = this.pty.onExit(this._handleExit);
    }

    attach(ws) {
        if (!ws) {
            throw new Error('WebSocket instance required');
        }

        this.clients.add(ws);
        ws.once('close', () => {
            this.clients.delete(ws);
        });
        ws.on('message', (raw) => this._routeIncoming(raw, ws));
        ws.on('error', () => {
            ws.close();
        });

        this._send(ws, { type: 'snapshot', data: this.history });
        if (this.closed) {
            this._send(ws, { type: 'status', status: 'terminated' });
        } else {
            this._send(ws, { type: 'status', status: 'ready' });
        }
    }

    dispose() {
        this.clients.clear();
        this.dataSubscription?.dispose?.();
        this.exitSubscription?.dispose?.();
    }

    // Public method for the manager to call
    resize(cols, rows) {
        if (this.closed) {
            return;
        }
        this.pty.resize(cols, rows);
    }

    _routeIncoming(raw, ws) {
        let payload;
        try {
            const text = typeof raw === 'string'
                ? raw
                : raw.toString('utf8');
            payload = JSON.parse(text);
        } catch (_err) {
            return;
        }

        switch (payload.type) {
        case 'input':
            this._handleInput(payload.data);
            break;
        case 'resize':
            this._handleResize(payload.cols, payload.rows);
            break;
        case 'ping':
            this._send(ws, { type: 'pong' });
            break;
        default:
            break;
        }
    }

    _handleInput(data) {
        if (this.closed || typeof data !== 'string') {
            return;
        }
        this.pty.write(data);
    }

    // Internal handler that delegates to the manager
    _handleResize(cols, rows) {
        if (this.closed) {
            return;
        }
        const safeCols = clampDimension(cols);
        const safeRows = clampDimension(rows);
        if (safeCols && safeRows) {
            if (this.manager) {
                this.manager.resizeAll(safeCols, safeRows);
            } else {
                this.resize(safeCols, safeRows);
            }
        }
    }

    _appendHistory(chunk) {
        this.history += chunk;
        if (this.history.length > this.historyLimit) {
            this.history = this.history.slice(
                this.history.length - this.historyLimit
            );
        }
    }

    _broadcast(message) {
        const data = JSON.stringify(message);
        for (const client of this.clients) {
            this._send(client, message, data);
        }
    }

    _send(ws, message, preEncoded) {
        if (!ws || ws.readyState !== WS_STATE_OPEN) {
            return;
        }
        const payload = preEncoded ?? JSON.stringify(message);
        ws.send(payload);
    }
}

function clampDimension(value) {
    const num = Number.parseInt(value, 10);
    if (Number.isNaN(num) || num <= 0) {
        return null;
    }
    return Math.min(500, num);
}