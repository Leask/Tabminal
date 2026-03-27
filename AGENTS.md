# Tabminal Agent Notes

Last updated: 2026-03-27

This file is for future coding agents working in this repo.
Keep it current, specific, and operational. The main goal is to preserve the
current product contracts so later work does not regress multi-host behavior,
ACP agent UX, or mobile ergonomics.

## 1) Project Snapshot

- Runtime: Node.js `>= 22`, ESM project.
- Backend entry: `src/server.mjs`
- Frontend entry: `public/app.js`
- PWA shell:
  - `public/index.html`
  - `public/sw.js`
- Native app workspace:
  - `apps/Apple`
  - `apps/ghostty-vendor`

Current product shape:

- Persistent terminal sessions remain the core product.
- There are now two AI surfaces:
  - terminal-native assistant in `src/terminal-session.mjs`
  - ACP agent workspace in `src/acp-manager.mjs` + `public/app.js`
- One web UI can connect to multiple Tabminal hosts.
- The workspace bar now mixes file tabs, agent tabs, and pinned terminal tabs.

Important persistence files under `~/.tabminal`:

- `config.json`
- `cluster.json`
- `agent-tabs.json`
- `agent-config.json`

## 2) Non-Negotiable Contracts

### 2.1 Host model and state isolation

- UI term is `Host`, not `Server`, for user-facing labels.
- Every session belongs to exactly one host.
- Session state, editor state, file tree state, ACP agent tabs, and workspace
  tabs are host-isolated.
- Do not merge runtime state across hosts.

Relevant code:
- `public/app.js`
- `public/modules/session-meta.js`

### 2.2 Auth model

- Main host (`id = 'main'`) controls the global login modal.
- Only main-host `401/403` should trigger app-wide login UI.
- Sub-host auth failures must stay local to that host.
- Sub-hosts may require Cloudflare Access login without password change.

Relevant code:
- `public/app.js`
  - `ServerClient.handleUnauthorized`
  - `ServerClient.handleAccessRedirect`

### 2.3 Token storage

- Main host token:
  - browser `localStorage`
  - key: `tabminal_auth_token:main`
- Sub-host tokens:
  - persisted in backend `cluster.json`
  - do not persist in browser `localStorage`
- Removing a host should also remove any stale local token keyed to that host.

Relevant code:
- `public/app.js`
- `src/persistence.mjs`

### 2.4 Host registry persistence

- Frontend is not the source of truth for host list persistence.
- Source of truth is backend `GET/PUT /api/cluster`.
- File format:
  - `{ "servers": [{ id, baseUrl, host, token }, ...] }`
- On page load, host list restores only after main-host auth succeeds.

Relevant code:
- `public/app.js`
- `src/server.mjs`
- `src/persistence.mjs`

### 2.5 Deduplication and self-host skip

- Host uniqueness key is normalized `hostname[:port]` in lowercase.
- Path is intentionally not part of the dedupe key.
- Hydration skips entries that resolve to the current main node to avoid
  self-loop duplicates.
- Path-based multi-host routing such as `/a/*` and `/b/*` is not supported by
  the current client assumptions.

Relevant code:
- `public/modules/url-auth.js`
- `public/app.js`

### 2.6 Session creation ownership

- Backend does not auto-create a default session anymore.
- Frontend is responsible for usability:
  - create one main-host session if init returns none
  - recreate one main-host session if user closes the last session

Relevant code:
- `public/app.js`
- `src/server.mjs`

### 2.7 Polling and heartbeat

- Frontend heartbeat cadence: `1000ms`
- Reconnect retry throttle per host: `5000ms`
- Do not weaken these without measuring UX fallout.

Relevant code:
- `public/app.js`

### 2.8 Cloudflare Access handling

- Non-main host requests use `credentials: 'include'`.
- Non-main host fetches default to `redirect: 'manual'`.
- Access redirects should show reconnect/login state, not generic password
  failure.
- Reconnect UI may open the host root in a new tab for Access login.

Relevant code:
- `public/app.js`
- `public/modules/url-auth.js`

### 2.9 Runtime version and PWA coherence

- Backend heartbeat returns runtime boot id.
- Frontend appends `?rt=<bootId>` and reloads on runtime change.
- `index.html` versions `styles.css` and `app.js` with runtime key.
- Service worker is versioned the same way.

Relevant code:
- `src/server.mjs`
- `public/app.js`
- `public/index.html`
- `public/sw.js`

## 3) ACP Design Contracts

### 3.1 ACP architecture shape

- Tabminal embeds an ACP supervisor in the backend.
- ACP agents are not implemented in-repo; Tabminal launches or attaches to
  external ACP runtimes.
- Built-in definitions currently include:
  - Gemini CLI
  - Codex CLI
  - Claude Agent
  - GitHub Copilot
  - ACP Test Agent when `TABMINAL_ENABLE_TEST_AGENT=1`

Relevant code:
- `src/acp-manager.mjs`
- `src/acp-test-agent.mjs`

### 3.2 ACP workspace model

- Agent tabs share the same workspace strip as file tabs and pinned terminal
  tabs.
- Showing the agent workspace must not force-open the file tree.
- Showing the file tree must not be required for agent tabs to exist.
- Workspace bar should stay visible whenever there is any open file tab, agent
  tab, or pinned terminal tab.

Relevant code:
- `public/app.js`
- `public/styles.css`

### 3.3 Agent dropdown and toggle behavior

- Left sidebar robot button is a toggle.
- First click opens the host-scoped agent dropdown.
- Clicking the same button again closes it.
- If either file tree or agent toggle is active, the opposite control remains
  visible; do not let one disappear while the other is lit.

### 3.4 Jump in semantics

- `Jump in` is not a read-only preview.
- While the managed terminal is still alive, it should switch into a real
  controllable terminal session.
- If the terminal has already exited, the restored session is effectively
  history-only.
- Agent sync must never steal focus back from a session the user jumped into.

Relevant code:
- `public/app.js`

### 3.5 Hidden terminal resize contract

- If a main terminal is hidden because it is pinned into a workspace tab and is
  not the active visible tab, do not report resized dimensions from that hidden
  state back to the backend.
- Keep the previous valid size instead.
- This prevents broken sidebar previews caused by tiny hidden-layout sizes.

Relevant code:
- `public/app.js`

### 3.6 Shell ready noise filtering

- `TABMINAL_SHELL_READY=1` and related shell bootstrap commands are internal.
- They must not produce user notifications or visible execution-completed noise.

Relevant code:
- `shell/tabminal-bashrc`
- `src/terminal-session.mjs`
- `public/app.js`

### 3.7 Agent plan behavior

- In-progress plan lives in the fixed area between activity strip and composer.
- Once fully completed, it should archive into transcript history and stop
  occupying the fixed panel slot.
- Completed plans are historical transcript content, not permanent composer UI.

### 3.8 Transcript auto-scroll contract

- If the user was already at the bottom, keep them pinned to bottom when:
  - new transcript messages arrive
  - tool-call terminal blocks grow
  - plan/activity/queue panels change height
  - transcript container height changes
- If the user was not at the bottom, preserve position and do not yank them
  back down.

Relevant code:
- `public/app.js`

### 3.9 Slash command menu contract

- Slash-command menu opens upward, as a floating overlay above the composer.
- It must not push the composer or nearby controls.
- Keyboard navigation must keep the active item scrolled into view with some
  padding from the edges.
- Current shortcut to open agent menu is `Ctrl+Shift+A`.

Relevant code:
- `public/app.js`
- `public/styles.css`
- `public/index.html`

### 3.10 Usage HUD contract

- Expanded usage HUD is now a CSS-driven fixed layout.
- Do not reintroduce JS-measured width growth or time-based width drift.
- Context line uses right-side usage text.
- Limit rows use `% left` plus reset text.
- The HUD should expand predictably and not resize every second as reset text
  updates.

Relevant code:
- `public/styles.css`
- `public/app.js`

## 4) ACP Status and Remaining Gaps

`docs/ACP.md` is partly stale.

Implemented from that plan:

- ACP supervisor and backend APIs
- ACP websocket fan-out
- agent tab restore and `loadSession` restore where supported
- slash commands
- prompt attachments
- structured tool cards
- diff and code/resource rendering
- managed terminal transcript UI
- permission handling
- usage HUD
- browser smoke and ACP test agent support

Still not clearly done end-to-end:

- registry-driven install UX
- explicit TCP ACP runtime support in the UI
- dedicated conversation history browser independent of terminal sessions

Implication:

- Do not delete `docs/ACP.md` just because most of the MVP shipped.
- If it is removed later, first copy the still-open deferred items into a new
  canonical roadmap document.

## 5) File Map for Fast Onboarding

Backend:
- `src/server.mjs`
  - API routes, WS upgrade, auth, runtime boot id
- `src/config.mjs`
  - merged config parser and validation
- `src/auth.mjs`
  - password hashing and auth checks
- `src/persistence.mjs`
  - sessions, cluster registry, ACP tab/config persistence
- `src/terminal-manager.mjs`
  - PTY lifecycle and persistence
- `src/terminal-session.mjs`
  - terminal stream parsing, shell AI path, execution model
- `src/acp-manager.mjs`
  - ACP definitions, runtime supervision, ACP tab lifecycle
- `src/acp-test-agent.mjs`
  - local ACP smoke agent with slash-command fixtures

Frontend:
- `public/app.js`
  - nearly all UI orchestration lives here
- `public/modules/url-auth.js`
  - URL normalization and auth helpers
- `public/modules/session-meta.js`
  - host display and compact path formatting
- `public/styles.css`
  - all current UI contracts and responsive rules
- `public/index.html`
  - shell DOM, layout bootstrapping, shortcuts modal

Tests and smoke:
- `test/acp-manager.mjs`
  - richest ACP coverage
- `scripts/acp-browser-smoke.mjs`
  - browser ACP smoke against a real running app and real Chrome remote debug

## 6) Debug and Testing Guidance

### 6.1 Basic quality gates

Run these before release or after meaningful ACP/UI changes:

1. `npm run lint`
2. `npm test`
3. `npm run build`

### 6.2 ACP test agent

Enable it with:

```bash
TABMINAL_ENABLE_TEST_AGENT=1 npm start -- --accept-terms
```

Useful slash commands in ACP Test Agent:

- `/demo`: richest happy-path demo
- `/plan`: plan and usage only
- `/diff`: terminal, diff, code/resource payloads
- `/permission`: permission flow
- `/cancel`: long-running cancel flow
- `/stale`: stale tool settlement path
- `/order`: message ordering around tools
- `/fail`: prompt error path

Use these instead of inventing ad-hoc prompts when validating ACP UI.

### 6.3 Browser smoke

Preferred browser smoke:

- `scripts/acp-browser-smoke.mjs`

It supports:

- Chrome remote debugging target
- ACP Test Agent slash-command flows
- attachment coverage
- tool/diff/code/terminal assertions
- restore-tail validation

Typical setup:

1. Start a local Tabminal instance with `TABMINAL_ENABLE_TEST_AGENT=1`
2. Run Chrome with remote debugging
3. Point smoke at that Chrome target and Tabminal URL

### 6.4 Availability/debug tips

If an ACP agent appears inconsistently available:

- Compare the backend runtime `PATH` with your interactive shell `PATH`.
- Do not assume your login shell and the running `npm start` environment match.
- Copilot and other CLIs may live in `~/.local/bin`; ACP discovery now augments
  common user-local bin paths.
- Restore failures should not temporarily mark built-in definitions unavailable.

Relevant code:
- `src/acp-manager.mjs`

### 6.5 Focus and session-debug tips

If `Jump in` appears to bounce back to the original agent workspace:

- inspect agent-sync code first
- the previous bug was backend updates restoring preferred workspace on the
  wrong session and stealing focus

If terminal preview proportions become huge:

- check whether a hidden terminal is still reporting resized dimensions

If you get noisy shell-ready notifications:

- check for internal execution events being surfaced to the frontend

## 7) Known Pitfalls

### 7.1 `SecurityError: insecure WebSocket from HTTPS page`

Cause:
- trying `ws://` from an HTTPS page

Mitigation:
- websocket URL must switch to `wss://` when page or host URL is HTTPS

### 7.2 `TypeError: Failed to fetch` during heartbeat

Typical causes:
- host down
- DNS/TLS failure
- CORS block
- network unreachable
- Cloudflare Access auth needed

Expected behavior:
- reconnect warning state, not noisy crash behavior

### 7.3 Cloudflare Access loops

- CORS headers alone do not solve auth redirects.
- The problem is usually Access challenge during API fetch.
- Current model is to detect redirect and open host root login page.

### 7.4 Same domain with different path as multiple hosts

- Not supported by current assumptions.
- Do not patch around this casually; it needs a deeper routing redesign.

## 8) Security and Risk Notes

- Product is high-privilege by design.
- AI features may send terminal or agent context to external providers.
- `--accept-terms` is the explicit risk-ack mechanism.
- Prefer least-privilege credentials and trusted providers.

## 9) Deployment and Ops Notes

- Local helper script:
  - `reploy.sh`
- It restarts one macOS launchctl node plus several Linux `pm2` nodes via SSH.
- It includes aggressive cleanup behavior on Linux nodes; use carefully.

## 10) Change Safety Rules

- Do not move host registry persistence back into browser-owned local state.
- Do not make sub-host auth failures trigger global logout.
- Do not remove `credentials: 'include'` from host fetch wrapper.
- Do not remove the `1s` heartbeat or `5s` reconnect throttle without evidence.
- Do not reintroduce backend auto-create-session fallback.
- Do not bring back JS-driven usage HUD width measurement.
- Do not let agent sync steal focus from a user-selected terminal session.
- Do not let hidden terminal tabs report bogus tiny sizes to the backend.
