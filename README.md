# Tabminal

> **A modern, AI-native web terminal built for the cloud age.**
> Seamlessly accessible from Desktop, iPad, and iPhone with a native-like experience.

![Tabminal Banner](public/favicon.svg) 

## ✨ Key Features

### 🧠 AI-Native Integration
Tabminal isn't just a terminal; it's an intelligent workspace paired with **Gemini 2.5 Flash**.
*   **Context-Aware**: The AI knows your **Current Working Directory**, **Environment Variables**, and **Recent Command History**. No need to copy-paste context.
*   **Command Hijack (`#`)**: Simply type `#` followed by your question (e.g., `# how to tar a folder`) to chat with the AI. The output streams in real-time with syntax highlighting.
*   **Auto-Fix**: If a shell command fails (non-zero exit code), Tabminal automatically analyzes the error log and suggests a fix.
*   **Audit Logging**: All AI interactions are logged and persisted for future context.

### 📱 Ultimate Mobile Experience
Optimized specifically for **iPadOS** and **iOS**, solving the pain points of coding on touch devices.
*   **PWA Support**: Installable as a full-screen app. Solves the infamous iOS viewport height issues.
*   **HHKB-Style Soft Keyboard**: A custom 12-column virtual keyboard bringing the HHKB layout to iPhone.
    *   **Drag-to-Ctrl**: Touch and drag the `CTRL` key to perform combinations (e.g., drag to 'C' for `Ctrl+C`).
    *   **Smart Modifiers**: `SHIFT` allows continuous entry; `SYM` toggles the full keyboard overlay.
    *   **Responsive Layout**: Keyboard height adapts to landscape/portrait modes automatically.
*   **Optimized UI**: Hamburger menu for sessions on small screens, resource-saving mode (no preview rendering) on iPhone.

### 💻 Powerful Desktop Features
*   **Persistent Sessions**: Close your browser, come back later, and your terminal state (and running processes) are exactly where you left them.
*   **Built-in Editor**: Integrated **Monaco Editor** (VS Code core) with split-pane view. Edit files on the server directly.
*   **Visual File Manager**: Sidebar file tree for easy navigation and opening of files.
*   **Network Heartbeat**: Real-time latency visualization (capsule style on desktop, bottom-fill on mobile).

## 🚀 Getting Started

### Prerequisites
*   Node.js >= 16
*   An AI API Key (e.g., Google AI Studio / OpenRouter)

### Quick Start (No Install)
Run directly with npx:
```bash
npx tabminal --openrouter-key "YOUR_API_KEY" --accept-terms
```

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/tabminal.git
cd tabminal

# Install dependencies
npm install

# Start the server
npm start -- --openrouter-key "YOUR_API_KEY" --accept-terms
```

### Configuration

You can configure Tabminal via command-line arguments or environment variables.

| Argument | Env Variable | Description | Default |
| :--- | :--- | :--- | :--- |
| `-p`, `--port` | `PORT` | Server port | `9846` |
| `-h`, `--host` | `HOST` | Bind address | `127.0.0.1` |
| `-a`, `--password` | `TABMINAL_PASSWORD` | Access password | (Randomly Generated) |
| `-k`, `--openrouter-key` | `TABMINAL_OPENROUTER_KEY` | OpenRouter API Key | `null` |
| `-m`, `--model` | `TABMINAL_MODEL` | AI Model ID | `gemini-2.5-flash-preview-09-2025` |
| `-g`, `--google-key` | `TABMINAL_GOOGLE_KEY` | Google Search API Key | `null` |
| `-c`, `--google-cx` | `TABMINAL_GOOGLE_CX` | Google Search Engine ID (CX) | `null` |
| `-d`, `--debug` | `TABMINAL_DEBUG` | Enable debug logs | `false` |
| `-y`, `--accept-terms` | `TABMINAL_ACCEPT` | Accept security terms | `false` |

## ⌨️ Shortcuts

### Physical Keyboard (Desktop/iPad)
*   **`Ctrl + Shift + T`**: New Tab (Inherits current CWD)
*   **`Ctrl + Shift + W`**: Close Current Tab
*   **`Ctrl + Shift + [` / `]`**: Switch Previous/Next Tab
*   **`Ctrl + Alt + [` / `]`**: Switch Previous/Next Open File in Editor
*   **`Ctrl + Shift + E`**: Toggle Editor Pane
*   **`Ctrl + Up` / `Down`**: Switch Focus between Editor and Terminal
*   **`Ctrl + Shift + ?`**: Show Shortcuts Help

### Touch Gestures (Mobile)
*   **Virtual `^C`**: Send SIGINT (Ctrl+C).
*   **Virtual `CTRL` (Hold & Drag)**: Visualize a QWERTY overlay to quickly trigger Control combinations without lifting your finger.
*   **Virtual `SYM`**: Toggle the full HHKB-style soft keyboard.

## 🛠 Tech Stack
*   **Backend**: Node.js, Koa, node-pty, WebSocket (ws).
*   **Frontend**: Vanilla JS (ES Modules), xterm.js, Monaco Editor.
*   **AI**: Integration via `utilitas`.

## 📄 License
MIT