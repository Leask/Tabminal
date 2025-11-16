# Tabminal

**Tabminal** is a modern, persistent web-based terminal interface built with Node.js, xterm.js, and WebSockets. It features a robust multi-tab system, real-time server monitoring, and session persistence, allowing you to manage multiple terminal sessions that survive browser reloads.

![Tabminal Screenshot](https://via.placeholder.com/800x450.png?text=Tabminal+Preview)

## Features

- **Persistent Sessions:** Terminal sessions run on the server. Close your browser, come back later, and your work is exactly where you left it.
- **Multi-Tab Interface:**
  - Create and manage multiple terminal tabs.
  - Live previews of background tabs.
  - "Sticky" new tab button for easy access.
  - Intelligent tab closing and switching logic.
- **Real-Time System Monitoring:**
  - Global status bar showing Server Host, OS, IP, Uptime.
  - Live CPU usage (Core count, Frequency, Usage % with progress bar).
  - Live Memory usage (Used/Total with progress bar).
  - Client-side FPS counter.
- **Modern UI/UX:**
  - Dark mode theme (Solarized Dark inspired).
  - Responsive layout with a collapsible sidebar (future).
  - Canvas-based rendering for high performance.
  - Custom fonts (`SF Mono`, `JetBrains Mono`, etc.).

## Tech Stack

- **Backend:** Node.js, Express, `node-pty` (for pseudo-terminal management), `ws` (WebSockets).
- **Frontend:** Vanilla JavaScript (ES Modules), xterm.js (with Fit, WebLinks, and Canvas addons).
- **Testing:** Vitest.

## Installation

### Prerequisites

- Node.js (v18 or higher)
- Python (required for building `node-pty`)
- C++ Build Tools (make, g++, etc.)

### Steps

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/leask/tabminal.git
    cd tabminal
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```
    *Note: This will compile `node-pty`, which may take a few moments.*

3.  **Start the server:**
    ```bash
    npm start
    ```

4.  **Access the application:**
    Open your browser and navigate to `http://localhost:9846`.

## Development

To run the server in development mode with auto-restart:

```bash
npm run dev
```

To run tests:

```bash
npm test
```

## Configuration

You can configure the server using environment variables:

- `PORT`: The port to listen on (default: `9846`).
- `HOST`: The host to bind to (default: `0.0.0.0`).
- `TABMINAL_HISTORY`: Scrollback history limit in characters (default: `524288`).
- `TABMINAL_HEARTBEAT`: Heartbeat interval in ms (default: `30000` for server-side check).

## License

MIT License. See [LICENSE](LICENSE) for details.