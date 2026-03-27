# `t>` Tabminal

> `Tab(ter)minal`, a Cloud-Native terminal and ACP agent workspace for desktop, tablet, and phone.

`Tabminal` combines persistent server-side terminal sessions, a built-in
workspace, multi-host access, and Agent Client Protocol (ACP) integrations in
one UI. It is designed for people who want a real terminal, real files, and
real agent tooling without being tied to a desktop-only client let you code from
your desktop, tablet, or phone with an intelligent, persistent, and rich
experience.

![Tabminal Banner](public/favicon.svg)

![IMG_0918](https://github.com/user-attachments/assets/a0cb7d8d-924c-4ba0-852e-bd0b1f2928ae)

## What It Does

- Persistent terminal sessions that survive refreshes, reconnects, and device
  switches.
- Built-in workspace tabs for files, images, agents, and pinned terminals.
- ACP agent support with managed terminals, live tool calls, diffs, code
  viewers, permission requests, plans, and usage HUDs.
- Multi-host cluster support from a single UI, with per-host auth and heartbeat
  state.
- Browser-first mobile and tablet UX, including compact workspace mode and PWA
  install support.
- Terminal-native AI assistance for shell history and auto-fix flows when
  OpenAI or OpenRouter is configured.

![Tabminal Screenshot](https://github.com/user-attachments/assets/608e21c3-bae2-4f16-85b7-4bd6520fd4f5)

<details>
<summary>More screenshots</summary>

<img width="2016" height="1170" alt="Screenshot 2025-11-24 at 3 03 03 PM" src="https://github.com/user-attachments/assets/a74490be-fe97-41c6-9026-44bbf3be79f9" />

<img width="2012" height="1439" alt="Screenshot 2025-11-24 at 3 02 12 PM" src="https://github.com/user-attachments/assets/80fed651-48ce-482a-80a3-03d9dd2767b0" />

<img width="1816" height="1186" alt="Screenshot 2025-11-24 at 3 01 46 PM" src="https://github.com/user-attachments/assets/509f7e99-1d70-46be-bc18-a202c0fe11a4" />

<img width="1815" height="826" alt="Screenshot 2025-11-24 at 2 57 39 PM" src="https://github.com/user-attachments/assets/c503c236-dc38-470e-9a0d-6b824e0dd624" />

</details>

## Current Highlights

### ACP Agent Workspace

Tabminal now has a full ACP agent surface, not just an AI chat box.

- Agent tabs live beside files and terminal tabs in the same workspace bar.
- Tool calls can render live terminal output, diffs, code/resource payloads,
  and file paths inline.
- `Jump in` moves you into the managed terminal session while it is still
  running.
- Agent plans, running-terminal summaries, slash-command menus, permissions,
  and usage data are first-class UI elements.
- The agent composer supports provider-defined slash commands and keyboard
  navigation.
- Agent state restores across refreshes, including transcript history and
  managed terminal relationships.

Built-in agent definitions currently include:

- Gemini CLI
- Codex CLI
- Claude Agent
- GitHub Copilot CLI
- ACP Test Agent (`TABMINAL_ENABLE_TEST_AGENT=1`)

Each definition is detected per host. Availability depends on the runtime
environment of that host and any required local auth or API keys.

### Terminal-Native AI Assistant

Tabminal still includes the original terminal-native assistant path.

- Prefix a shell prompt with `#` to ask the built-in assistant about your
  current terminal context.
- Failed commands can trigger an automatic AI follow-up using recent history and
  error output.
- This path uses your configured OpenAI or OpenRouter key and is separate from
  ACP agent integrations.

### Multi-Host Cluster

One UI can manage multiple Tabminal backends.

- Add hosts from the sidebar.
- Open sessions on any connected host.
- Auth is host-scoped.
- The main host controls the global login modal.
- Sub-host auth failures stay local to that host.
- Host registry is persisted on the main host and restored after refresh.

### Built-In Workspace

- Monaco-based file editor
- File tree and image preview
- Terminal, file, and agent tabs in one shared workspace bar
- Managed terminal previews in the sidebar
- Restore-aware terminal pinning and workspace switching

### Mobile and Tablet UX

- PWA install support
- Safe-area aware responsive layout
- Compact workspace mode for small or short screens
- Touch-friendly controls and virtual keyboard support
- Small-screen agent config controls collapse into icon-only selectors to keep
  the composer usable on tablets and phones

## Getting Started

### Requirements

- Node.js `>= 22`
- A secure environment. Tabminal is a high-privilege app by design.
- Optional provider credentials:
  - OpenAI or OpenRouter for the built-in terminal-native assistant
  - Google Search API key and CX for web search augmentation
  - Local CLI/auth for ACP agents such as Codex, Gemini, Claude, or Copilot

### Security Warning

Tabminal provides direct read/write access to the host file system and can run
commands on that host.

- Do not expose it directly to the public internet.
- Use a VPN, Tailscale, or a Zero Trust layer such as Cloudflare Access.
- If AI features are enabled, terminal history, paths, env hints, or recent
  command context may be sent to your configured provider.
- `--accept-terms` is required to start the server.

### Quick Start

Terminal only:

```bash
npx tabminal --accept-terms
```

With OpenAI:

```bash
npx tabminal --openai-key "YOUR_API_KEY" --accept-terms
```

With OpenRouter:

```bash
npx tabminal --openrouter-key "YOUR_API_KEY" --accept-terms
```

### Docker

```bash
docker run --rm -it -p 9846:9846 \
  leask/tabminal \
  --accept-terms
```

With AI enabled:

```bash
docker run --rm -it -p 9846:9846 \
  leask/tabminal \
  --openai-key "YOUR_API_KEY" \
  --accept-terms
```

### Local Development

```bash
git clone https://github.com/leask/tabminal.git
cd tabminal
npm install
npm start -- --accept-terms
```

## Configuration

Configuration precedence is:

1. built-in defaults
2. `~/.tabminal/config.json`
3. `./config.json`
4. CLI flags
5. environment variables

If no password is provided, Tabminal generates a temporary password at startup
and prints it to the terminal.

### CLI Flags and Environment Variables

| Argument | Env Variable | Description | Default |
| :--- | :--- | :--- | :--- |
| `-p`, `--port` | `TABMINAL_PORT` | Server port | `9846` |
| `-h`, `--host` | `TABMINAL_HOST` | Bind address | `127.0.0.1` |
| `-a`, `--password` | `TABMINAL_PASSWORD` | Access password | generated at startup |
| `-s`, `--shell` | `TABMINAL_SHELL` | Default shell executable | system default |
| `-k`, `--openrouter-key` | `TABMINAL_OPENROUTER_KEY` | OpenRouter API key | `null` |
| `-o`, `--openai-key` | `TABMINAL_OPENAI_KEY` | OpenAI API key | `null` |
| `-u`, `--openai-api` | `TABMINAL_OPENAI_API` | OpenAI-compatible base URL | `null` |
| `-m`, `--model` | `TABMINAL_MODEL` | Built-in assistant model ID | `gpt-5.2` with OpenAI, `gemini-3-flash-preview` with OpenRouter |
| `-f`, `--cloudflare-key` | `TABMINAL_CLOUDFLARE_KEY` | Cloudflare Tunnel token | `null` |
| `-g`, `--google-key` | `TABMINAL_GOOGLE_KEY` | Google Search API key | `null` |
| `-c`, `--google-cx` | `TABMINAL_GOOGLE_CX` | Google Search Engine ID | `null` |
| `-d`, `--debug` | `TABMINAL_DEBUG` | Enable debug logs | `false` |
| `--heartbeat` | `TABMINAL_HEARTBEAT` | WebSocket heartbeat interval in ms, minimum `1000` | `10000` |
| `--history` | `TABMINAL_HISTORY` | Terminal history limit in characters | `1048576` |
| `-y`, `--accept-terms` | `TABMINAL_ACCEPT` / `TABMINAL_ACCEPT_TERMS` | Required risk acknowledgement | `false` |

Notes:

- `--openrouter-key` and `--openai-key` are mutually exclusive.
- `config.json` also supports `heartbeatInterval` / `heartbeat-interval` and
  `historyLimit` / `history-limit`.

### Persistence Files

Tabminal stores runtime state under `~/.tabminal/`:

- `config.json`: optional home-level config
- `cluster.json`: multi-host registry
- `agent-tabs.json`: ACP agent tab restore state
- `agent-config.json`: saved per-agent setup/config values

For multi-host:

- The main host token stays in browser local storage.
- Sub-host tokens are persisted in the main host's `cluster.json`.

## ACP Agent Notes

ACP availability is discovered per host. A backend may show different results if
its runtime environment differs from your interactive shell.

Typical requirements:

- Codex: `codex login`
- Gemini: `gemini --acp` or `npx @google/gemini-cli@latest --acp`
- Claude: `npx @zed-industries/claude-code-acp@latest` plus required Anthropic
  or Vertex configuration
- Copilot: `copilot --acp --stdio` or `gh copilot -- --acp --stdio`

On hosts where the CLI lives in a user-local bin directory such as
`~/.local/bin`, Tabminal augments the agent runtime `PATH` so discovery is more
reliable.

## Keyboard Shortcuts

- `Ctrl + Shift + T`: New terminal
- `Ctrl + Shift + W`: Close terminal
- `Ctrl + Shift + E`: Toggle file workspace pane
- `Ctrl + Shift + A`: Open agent menu
- `Ctrl + Up / Down`: Move focus between workspace and terminal
- `Ctrl + Shift + [ / ]`: Switch session
- `Ctrl + Alt + [ / ]`: Switch workspace tab
- `Ctrl + Shift + ?`: Show shortcuts help
- `Ctrl` / `Cmd` + `F`: Find in terminal
- `Esc`: Stops a running ACP prompt when supported, or closes transient agent UI
  such as menus

### Touch

- The virtual keyboard exposes terminal-friendly modifier keys.
- Workspace and agent controls are optimized for touch and compact screens.

## Architecture Snapshot

- Backend: [`Node.js`](https://nodejs.org/), [`utilitas`](https://github.com/leask/utilitas), [`Koa`](https://github.com/koajs/koa), [`node-pty`](https://github.com/Tyriar/node-pty), [`WebSocket`](https://github.com/websockets/ws), [`ACP SDK`](https://github.com/acp-kit/acp-sdk)
- Frontend: [`Vanilla JS 😝`](http://vanilla-js.com/), [`xterm.js`](https://github.com/xtermjs/xterm.js), [`Monaco Editor`](https://github.com/microsoft/monaco-editor)
- Persistence: host-local files under `~/.tabminal`
- Native clients and packaging work live under:
  - `apps/Apple`
  - `apps/ghostty-vendor`

## Troubleshooting

- On macOS, `node-pty` may need:

  ```bash
  chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper
  ```

- If a sub-host keeps asking for login, check whether Cloudflare Access or
  another auth layer requires an interactive browser login for that host.
- If an ACP agent is missing, verify the CLI is installed on the backend host
  and available in that host's runtime environment.

## Quality Checks

Recommended before shipping changes:

```bash
npm run lint
npm test
npm run build
```

## License

[MIT](LICENSE)
