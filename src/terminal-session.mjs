import AnsiParser from 'node-ansiparser';

const WS_STATE_OPEN = 1;
const DEFAULT_HISTORY_LIMIT = 512 * 1024; // chars

class VirtualScreen {
    constructor(cols, rows) {
        this.cols = cols;
        this.rows = rows;
        this.buffer = Array(rows).fill(null).map(() => Array(cols).fill(' '));
        this.x = 0;
        this.y = 0;
    }

    _scrollUp() {
        this.buffer.shift();
        this.buffer.push(Array(this.cols).fill(' '));
    }

    print(char) {
        // Handle line wrapping
        if (this.x >= this.cols) {
            this.x = 0;
            this.y++;
        }
        // Handle scrolling
        if (this.y >= this.rows) {
            this._scrollUp();
            this.y = this.rows - 1;
        }

        // Place the character in the buffer
        this.buffer[this.y][this.x] = char;
        this.x++;
    }

    resize(cols, rows) {
        if (cols === this.cols && rows === this.rows) {
            return;
        }
        // For simplicity, we just clear on resize. A more complex implementation
        // could try to reflow the buffer.
        this.cols = cols;
        this.rows = rows;
        this.buffer = Array(rows).fill(null).map(() => Array(cols).fill(' '));
        this.x = 0;
        this.y = 0;
    }

    getSnapshot() {
        // Return a simple text representation for now.
        // In the future, this could include color/style data.
        return this.buffer.map(row => row.join('')).join('\n');
    }

    clear() {
        this.buffer = Array(this.rows).fill(null).map(() => Array(this.cols).fill(' '));
        this.x = 0;
        this.y = 0;
    }
}

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

        this.screen = new VirtualScreen(pty.cols, pty.rows);
        this.ansiParser = new AnsiParser({
            inst_p: (text) => {
                for (const char of text) {
                    this.screen.print(char);
                }
            },
            inst_o: (s) => { /* Unhandled */ },
            inst_x: (flag) => { /* Unhandled */ },
            inst_c: (collected, params, flag) => {
                // For simplicity, we only handle basic cursor movements and clearing.
                switch (flag) {
                case 'H': // Cursor position
                    this.screen.y = (params[0] ?? 1) - 1;
                    this.screen.x = (params[1] ?? 1) - 1;
                    break;
                case 'J': // Erase screen
                    if (params[0] === 2) { // Erase entire screen
                        this.screen.clear();
                    }
                    break;
                case 'm': // Graphics mode - could be used for colors later
                    break;
                }
            },
            inst_e: (collected, flag) => { /* Unhandled */ },
            inst_d: (collected, params, flag) => { /* Unhandled */ },
        });

        this._handleData = (chunk) => {
            if (typeof chunk !== 'string') {
                chunk = chunk.toString('utf8');
            }
            // Update both the raw history and the virtual screen
            this._appendHistory(chunk);
            this.ansiParser.parse(chunk);

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

    getSnapshot() {
        return {
            id: this.id,
            createdAt: this.createdAt,
            // In the future, we can add CWD, process name, etc.
            screen: this.screen.getSnapshot()
        };
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
        this.screen.resize(cols, rows);
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
        if (safeCols && safeRows && this.manager) {
            this.manager.resizeAll(safeCols, safeRows);
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