# `t>` Tabminal

> **Tab(ter)minal, the Cloud-Native, Proactive AI Integrated Terminal works in modern browsers.**
> Seamlessly code from your desktop, tablet, or phone with an intelligent, persistent, and rich experience.
> This project was built using Gemini and Codex wich 80% vibe-coding, means `built for the vibe, with the vibe`.

![Tabminal Banner](public/favicon.svg)

## 🌟 Why Tabminal?

Tabminal bridges the gap between traditional CLI tools and modern AI capabilities, all while solving the UX challenges of coding on desktop and mobile devices.

![IMG_0918](https://github.com/user-attachments/assets/a0cb7d8d-924c-4ba0-852e-bd0b1f2928ae)

As a long-time terminal user who frequently needs to step away from my computer while maintaining my workflow, and considering the various scalability issues of traditional terminals alongside the irreversible trend of vibe-coding, I reconsidered a solution that would first serve my own needs. Then, it would serve others whose workflows happen to be similar to mine. So, while waiting for AI to write code for the company, I tried to vibe a terminal from scratch that could meet my daily work needs and that I would enjoy using. As a result, I intermittently wrote this project. I believe this project is not for everyone. However, it is especially suitable for CLI and AI enthusiasts, which is the core motivation behind this project's creation.

## ✨ Innovative Designs

- `Server-side session persistence` ensures your sessions with the AI agent are maintained, allowing you to pick up where you left off at any time.
- `Fast and stable connection management` delivers a seamless, agile experience across platforms and devices, with native support for network roaming.
- Enjoy a comprehensive `Progressive Web App (PWA) experience` anytime, anywhere; all you need is a modern browser to start working.
- `Proactive AI integration` means your terminal becomes your work context. You can ask questions about your current session at any time, and the AI will automatically retrieve the context to accurately solve problems, even proactively offering assistance when commands fail.
- `Cloud-native design` enables access via Zero Trust or VPN, providing unprecedented convenience for managing cloud servers.

<img width="1632" height="1317" alt="Screenshot 2025-11-24 at 10 15 28 PM" src="https://github.com/user-attachments/assets/ad864233-7b22-4b29-8b90-dc81993dd623" />

<details>

<summary>📷 More screenshots</summary>

<img width="2016" height="1170" alt="Screenshot 2025-11-24 at 3 03 03 PM" src="https://github.com/user-attachments/assets/a74490be-fe97-41c6-9026-44bbf3be79f9" />

<img width="2012" height="1439" alt="Screenshot 2025-11-24 at 3 02 12 PM" src="https://github.com/user-attachments/assets/80fed651-48ce-482a-80a3-03d9dd2767b0" />

<img width="1816" height="1186" alt="Screenshot 2025-11-24 at 3 01 46 PM" src="https://github.com/user-attachments/assets/509f7e99-1d70-46be-bc18-a202c0fe11a4" />

<img width="1815" height="826" alt="Screenshot 2025-11-24 at 2 57 39 PM" src="https://github.com/user-attachments/assets/c503c236-dc38-470e-9a0d-6b824e0dd624" />

</details>

### 🧠 AI-Native Intelligence
Powered by **modern AI models** (via OpenRouter or OpenAI), Tabminal understands your context.
*(Defaults to **Gemini 3 Flash** for OpenRouter or **GPT-5.2** for OpenAI if not configured)*
*   **Context-Aware Chat**: Type `# how do I...` to ask questions. The AI knows your **CWD**, **Environment**, and **Recent History**.
*   **Auto-Fix**: Command failed? Tabminal automatically analyzes the exit code and error output to suggest fixes. No copy-pasting required.
*   **Web Search**: Enable Google Search integration to let the AI fetch real-time answers from the web.

### 📱 Ultimate Mobile Experience
Built from the ground up for **iPadOS**, **iOS** and **Android**.
*   **HHKB Virtual Keyboard**: You can perform nearly all terminal operations on any device, without being frustrated by os limitations.
*   **Responsive Layout**: Auto-adapts to landscape/portrait modes, respecting Safe Areas and Notches.
*   **PWA Ready**: Install to Home Screen for a full-screen, native app feel.

### 💻 Powerful Desktop Features
*   **Persistent Sessions**: Your terminal state lives on the server. Refresh or switch devices without losing your work.
*   **Built-in Editor**: Integrated **Monaco Editor** (VS Code core) allows you to edit files directly on the server.
*   **Visual File Manager**: Sidebar file tree for easy navigation.
*   **Network Heartbeat**: Real-time latency visualization.

## 🚀 Getting Started

### Prerequisites
*   Node.js >= 22
*   (Optional) An [OpenRouter](https://openrouter.ai/) API Key or [OpenAI](https://openai.com/) API Key for AI features.
*   (Optional) A pair of Google API Key and Search Engine ID (CX) for web search capabilities.

### ⚠️ Security Warning
Tabminal provides **full read/write access** to the underlying file system.
*   **Do NOT expose this to the public internet** without proper protection (VPN, etc).
*   The `--accept-terms` flag is required to acknowledge that you understand these risks.


### Quick Start (npx)

```bash
npx tabminal --openrouter-key "YOUR_API_KEY" --accept-terms
# Or use OpenAI:
npx tabminal --openai-key "YOUR_API_KEY" --accept-terms
```

### Quick Start (Docker)

```bash
docker run --rm -it -p 9846:9846 \
  leask/tabminal \
  --openrouter-key "YOUR_API_KEY" \
  --accept-terms
```

### Installation

```bash
# Clone the repository
git clone https://github.com/leask/tabminal.git
cd tabminal

# Install dependencies
npm install

# Start the server
npm start -- --openrouter-key "YOUR_API_KEY" --accept-terms
```

### Configuration

You can configure Tabminal via command-line arguments, environment variables, or a `config.json` file.

| Argument | Env Variable | Description | Default |
| :--- | :--- | :--- | :--- |
| `-p`, `--port` | `TABMINAL_PORT` | Server port | `9846` |
| `-h`, `--host` | `TABMINAL_HOST` | Bind address | `127.0.0.1` |
| `-a`, `--password` | `TABMINAL_PASSWORD` | Access password | (Randomly Generated) |
| `-k`, `--openrouter-key` | `TABMINAL_OPENROUTER_KEY` | OpenRouter API Key (Mutually exclusive with OpenAI) | `null` |
| `-o`, `--openai-key` | `TABMINAL_OPENAI_KEY` | OpenAI API Key (Mutually exclusive with OpenRouter) | `null` |
| `-u`, `--openai-api` | `TABMINAL_OPENAI_API` | OpenAI Base API URL (Optional) | `null` |
| `-m`, `--model` | `TABMINAL_MODEL` | AI Model ID | `gpt-5.2` (OpenAI) / `gemini-3-flash-preview` (OpenRouter) |
| `-f`, `--cloudflare-key` | `TABMINAL_CLOUDFLARE_KEY` | Cloudflare Tunnel Token | `null` |
| `-g`, `--google-key` | `TABMINAL_GOOGLE_KEY` | Google Search API Key | `null` |
| `-c`, `--google-cx` | `TABMINAL_GOOGLE_CX` | Google Search Engine ID (CX) | `null` |
| `-d`, `--debug` | `TABMINAL_DEBUG` | Enable debug logs | `false` |
| `--cors-origin` | `TABMINAL_CORS_ORIGIN` | Allowed CORS origin (`*` or comma-separated list) | `*` |
| `-y`, `--accept-terms` | `TABMINAL_ACCEPT` / `TABMINAL_ACCEPT_TERMS` | **Required**: Accept security risks (Full FS Access) | `false` |

## ⌨️ Shortcuts & Gestures

*   **`Ctrl + Shift + T`**: New Terminal
*   **`Ctrl + Shift + W`**: Close Terminal
*   **`Ctrl + Shift + E`**: Toggle Editor Pane
*   **`Ctrl + Up` / `Down`**: Focus Editor / Terminal
*   **`Ctrl + Shift + [` / `]`**: Switch Terminal
*   **`Ctrl + Alt + [` / `]`**: Switch Open File in Editor
*   **`Ctrl + Shift + ?`**: Show Shortcuts Help
*   **`Ctrl` / `Cmd` + `F`**: Find in Terminal

### Touch Actions
*   **Virtual `SYM`**: Toggle HHKB keyboard overlay.

## 🛠 Tech Stack
*   **Backend**: [Node.js](https://nodejs.org), [Koa](https://github.com/koajs/koa), [node-pty](https://github.com/microsoft/node-pty), [WebSocket](https://github.com/websockets/ws).
*   **Frontend**: [Vanilla JS](http://vanilla-js.com/) 😝, [xterm.js](https://github.com/xtermjs/xterm.js), [Monaco Editor](https://github.com/microsoft/monaco-editor).
*   **AI**: Integration via [utilitas](https://github.com/leask/utilitas).

## 🐛 Troubleshooting

- On macOS, you may need to run `chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper` to fix permission issues.

## 📄 License
[MIT](LICENSE)
