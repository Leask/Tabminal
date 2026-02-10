# Tabminal Agent Notes

Last updated: 2026-02-10

This file is for future AI/code agents working in this repo.
Goal: keep context accurate, avoid reintroducing old bugs, and preserve current UX
contracts after the multi-host refactor.

## 1) Project Snapshot

- Runtime: Node.js >= 22, ESM project.
- Backend entry: `src/server.mjs`.
- Frontend entry: `public/app.js` (plus modules in `public/modules/`).
- PWA shell: `public/index.html` + `public/sw.js`.
- Multi-host registry persistence: `~/.tabminal/cluster.json` via backend API.

Core idea now:
- One web app can connect to multiple Tabminal backends.
- Main host controls page-level auth modal/state.
- Sub-hosts are independent connection/auth units and can reconnect separately.

## 2) Non-Negotiable Behavior Contracts

### 2.1 Host model and state isolation

- UI term is `Host` (not `Server`) for user-facing labels.
- Every session belongs to exactly one host.
- Session/editor/file-tree/expanded-path state is host-isolated.
- Do not merge runtime state across hosts.

Relevant code:
- `public/app.js` (`state.servers`, `state.sessions`, `makeSessionKey` usage)
- `public/modules/session-meta.js`

### 2.2 Auth model

- Main host (`id = 'main'`) auth controls the app login modal.
- Only main host 401/403 should trigger global login modal.
- Sub-host 401/403 should mark that host as reconnect/login required, not global logout.
- Sub-host may require Cloudflare Access login without password change.

Relevant code:
- `public/app.js` `ServerClient.handleUnauthorized`
- `public/app.js` `ServerClient.handleAccessRedirect`

### 2.3 Token storage contract

- Main host token:
  - persisted in browser `localStorage` key `tabminal_auth_token:main`.
- Sub-host tokens:
  - persisted in backend registry `~/.tabminal/cluster.json`.
  - should not persist in browser localStorage.
- Removing a host should remove any stale local token key for that host id.

Relevant code:
- `public/app.js` `ServerClient.constructor`, `ServerClient.setToken`
- `src/persistence.mjs` `loadCluster` / `saveCluster`

### 2.4 Host registry persistence contract

- Frontend does not own host list persistence anymore.
- Source of truth: backend `GET/PUT /api/cluster`.
- File format in `~/.tabminal/cluster.json`:
  - `{ "servers": [{ id, baseUrl, host, token }, ...] }`
- On page load, host list is restored from backend after main host auth succeeds.

Relevant code:
- `public/app.js` `loadServerRegistryFromBackend`, `saveServerRegistryToBackend`
- `src/server.mjs` `/api/cluster`
- `src/persistence.mjs` cluster helpers

### 2.5 Deduplication and self-host skip

- Host uniqueness key is normalized `hostname[:port]` in lowercase.
- Path is not part of dedupe key.
- Registry hydration skips entries that resolve to current main node
  (same endpoint key or same hostname) to prevent self-loop duplicates.
- This is intentional to support sharing one cluster config across nodes.

Relevant code:
- `public/modules/url-auth.js` `getServerEndpointKeyFromUrl`
- `public/app.js` `findServerByEndpointKey`, `hydrateServerRegistry`

Important implication:
- Path-based multi-host on one domain (like `/a/*`, `/b/*`) is not supported by current
  client routing assumptions.

### 2.6 Session creation ownership

- Backend no longer auto-creates a default session/tab.
- Frontend ensures usability:
  - if no sessions after init, create one on main host.
  - if user closes last session, create one on main host.

Relevant code:
- `public/app.js` `initApp`, `closeSession`
- `src/server.mjs` (no auto-create fallback)

### 2.7 Polling / heartbeat behavior

- Online heartbeat sync interval: `1000ms` (frontend).
- Reconnect retry cadence when host is down: `5000ms` throttle per host.
- Do not remove strong polling; it is a UX requirement.

Relevant code:
- `public/app.js`
  - `HEARTBEAT_INTERVAL_MS = 1000`
  - `RECONNECT_RETRY_MS = 5000`
  - `syncServer`, `ServerClient.startHeartbeat`

### 2.8 Cloudflare Access handling

Current behavior for sub-hosts:
- requests use `credentials: 'include'` so Access cookies can be sent.
- requests default to `redirect: 'manual'` on non-main hosts.
- Access redirect is treated as reconnect reason, not generic password failure.
- reconnect UI can trigger opening host root in a new tab for Access login.

Relevant code:
- `public/app.js`
  - `ServerClient.fetch`
  - `probeAccessLoginUrl`
  - `openAccessLoginPage`
- `public/modules/url-auth.js`
  - `isAccessRedirectResponse`
  - `buildAccessLoginUrl` (root origin)

### 2.9 CORS policy in backend

- Backend currently allows cross-origin by reflecting request origin when present.
- For requests without origin, backend returns `Access-Control-Allow-Origin: *`.
- OPTIONS is handled with 204 directly.
- No per-origin `cors-origin` config is used now.

Relevant code:
- `src/server.mjs` top-level CORS middleware

### 2.10 Runtime version and PWA cache coherence

- Backend heartbeat returns runtime boot id.
- Frontend appends `?rt=<bootId>` to URL and reloads on server restart/version change.
- `index.html` loads `styles.css` and `app.js` using runtime key.
- SW is registered with `?rt=<bootId>`, cache key includes that runtime id.
- App shell (`/`, `/index.html`, `/app.js`, `/styles.css`, `/modules/*`) uses
  network-first.

Relevant code:
- `src/server.mjs` `/api/heartbeat` -> `runtime.bootId`
- `public/app.js` `handlePrimaryRuntimeVersion`
- `public/index.html` runtime loader script
- `public/sw.js`

## 3) UX Contracts to Keep

### 3.1 Sidebar host controls

- Per-host row: primary action button + (non-main only) remove button.
- Remove button is overlay style (top-left), hidden by default, fades in on hover/focus.
- Main host has no remove button.
- Main button text:
  - normal: `New Tab @ <Host>`
  - reconnect: `Reconnect <Host>`
  - access flow: `Cloudflare Login <Host>`
- Second line includes latency text + heartbeat dot + mini heartbeat canvas.

Relevant code:
- `public/app.js` `renderServerControls`
- `public/styles.css` `.server-row`, `.server-main-button`, `.server-delete-button`

### 3.2 Host naming display

Display priority for host name:
1. configured `host` alias
2. runtime hostname from host heartbeat
3. URL hostname
4. `'unknown'`

Session metadata line should stay:
- `HOST: user@<host>`
- host text uses `.host-emphasis` style.

Relevant code:
- `public/modules/session-meta.js`

### 3.3 Path display

- PWD display in tab meta uses fish-style compact path shortening.
- Keep this style unless a full UX redesign is explicitly requested.

Relevant code:
- `public/modules/session-meta.js` `shortenPathFishStyle`

### 3.4 Small-screen rule (< 600px height)

- `new-tab-item` region is capped to two-button area height and scrollable.
- This is intentional for small-height mobile/embedded layouts.

Relevant code:
- `public/styles.css` `@media (max-height: 600px)` on `.new-tab-item`

## 4) Known Pitfalls and Their Root Causes

### 4.1 `SecurityError: insecure WebSocket from HTTPS page`

Cause:
- trying `ws://` from HTTPS page.
Current mitigation:
- WS URL builder chooses `wss://` if page is HTTPS or host URL is HTTPS.

Check:
- `public/app.js` `ServerClient.resolveWsUrl`
- ensure host URL is HTTPS when used from secure origin.

### 4.2 `TypeError: Failed to fetch` during heartbeat

Usually means:
- host down, DNS issue, TLS failure, CORS block, or network unreachable.
Expected behavior:
- warning-level reconnect messaging, not noisy crash behavior.

Check:
- browser network tab
- host availability
- Access auth state for that host

### 4.3 Cloudflare Access 302/login loops

Important:
- CORS headers alone do not fix Access redirect login requirements.
- Main issue is Access auth challenge during API request.
- Current design handles this by detecting redirect and opening host root login page.

### 4.4 Host list not restoring after refresh

Check in order:
1. main host authenticated?
2. `/api/cluster` returns expected `servers` array?
3. entries include valid `id` and `baseUrl`?
4. entry skipped as self-host by dedupe/hostname rule?

### 4.5 Same domain with different path does not behave as separate hosts

Current architecture dedupes by `hostname[:port]` and uses absolute `/api/*`/`/ws/*`.
Do not assume path-prefix multiplexing works without deeper routing redesign.

## 5) File Map for Fast Onboarding

Backend:
- `src/server.mjs`: API routes, WS upgrade, CORS, runtime boot id, startup/shutdown.
- `src/config.mjs`: merged config parser (defaults/home/local/CLI/env), validation.
- `src/auth.mjs`: hash auth, lockout logic, API and WS auth checks.
- `src/persistence.mjs`: sessions, memory, cluster registry disk persistence.
- `src/terminal-manager.mjs`: PTY session lifecycle + persistence glue.
- `src/terminal-session.mjs`: terminal stream parsing, history, metadata, AI context.

Frontend:
- `public/app.js`: host/session state, sync loop, UI orchestration.
- `public/modules/url-auth.js`: URL normalization, dedupe key, auth helpers.
- `public/modules/session-meta.js`: host display and path shortening.
- `public/styles.css`: sidebar/tab/host control styling and responsive rules.
- `public/index.html`: shell DOM, runtime versioned loader, SW register.
- `public/sw.js`: runtime-versioned caching strategy.

## 6) Logs and Debug Guidance

Expected, low-noise warnings:
- host unreachable / reconnect transitions.
- invalid cluster entries skipped.

Avoid:
- spamming full stack traces for normal offline scenarios.
- debug-only console noise left enabled by default.

Note:
- old `cluster-debug` helper has been intentionally removed; do not reintroduce
  unless there is a concrete observability requirement.

## 7) Security and Risk Notes

- Product is high-privilege by design (terminal + file write).
- AI features may send terminal context to model providers.
- Current policy is explicit risk acknowledgment (`--accept-terms` / config flag).
- Choose trusted model providers and least-privilege credentials.

## 8) Deployment and Ops Notes

- Local helper script: `reploy.sh` (intentionally ignored by git and npm package).
- It restarts one macOS launchctl node + several Linux pm2 nodes via SSH.
- Script contains aggressive cleanup on Linux nodes (reset/clean fallback);
  use carefully in shared environments.

## 9) Quality Gates Before Release

Recommended checks:
1. `npm run lint`
2. `npm test`
3. `npm run build`
4. quick manual smoke:
   - main host login
   - add host (with and without password, inheritance path)
   - reconnect flow (normal + Access login path)
   - delete host
   - restart backend and confirm runtime cache refresh (`rt` flow)

## 10) Change Safety Rules for Future Refactors

- Do not move host list back to localStorage.
- Do not make sub-host auth failures trigger global logout.
- Do not remove `credentials: 'include'` from host fetch wrapper.
- Do not remove reconnect backoff (`5s`) or online heartbeat cadence (`1s`).
- Do not reintroduce backend auto-create-session fallback.
- Do not add path-based host assumptions without redesigning URL/WS routing model.
