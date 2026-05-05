# Tabminal API

Last updated: 2026-04-16

This document is the canonical API contract between Tabminal clients and a
Tabminal server.

It is written for:

- the current web client
- future native clients
- tooling that needs to drive Tabminal programmatically

The goal is not only to list endpoints, but to describe:

- transport and auth rules
- source-of-truth boundaries
- realtime vs authoritative sync behavior
- websocket message contracts
- file-system and ACP agent semantics
- cross-client requirements that must stay stable

When this document conflicts with accidental frontend behavior, the document
should win.

## 1. Design Goals

Tabminal exposes a single host-local API surface that supports:

- persistent terminal sessions
- file tree and editor access
- ACP-backed agent workspaces
- multi-host clients that talk to several Tabminal servers independently

The API must support more than one client implementation. Web and native
clients must share the same protocol assumptions wherever possible.

## 2. Protocol Overview

Tabminal uses two transports:

- HTTP/JSON for authoritative state changes, inventory, and mutations
- WebSocket for low-latency terminal and agent streaming

Broadly:

- HTTP is authoritative.
- WebSocket is for realtime deltas.
- Clients should assume heartbeat or explicit HTTP fetches may reconcile local
  state after websocket activity.

There are two websocket namespaces:

- terminal sessions: `/ws/:sessionId`
- ACP bus stream: `/ws/acp-bus`

## 3. Authentication

All API routes except `/healthz`, `/api/version`, `/api/auth/challenge`,
`/api/auth/login`, `/api/auth/refresh`, and `/api/auth/logout` require
authentication.

### 3.1 Login and session model

Tabminal uses:

- short-lived access tokens
- long-lived refresh tokens
- server-side refresh session state

Current defaults:

- access token lifetime: `15 minutes`
- refresh token lifetime: `90 days`
- refresh tokens rotate on every successful refresh

Login flow:

1. client calls `POST /api/auth/challenge`
2. server returns a one-time `challengeId`, `salt`, `expiresAt`, and
   `algorithm`
3. client computes `SHA-256(password)` locally
4. client computes an HMAC-SHA256 response using that password hash as the key
5. client calls `POST /api/auth/login` with `challengeId` and `response`
6. server consumes the challenge, recomputes the HMAC using its configured
   password hash, and compares the response using a timing-safe comparison
7. server returns `accessToken`, `accessTokenExpiresAt`, `refreshToken`, and
   `refreshTokenExpiresAt`

The browser does not persist the password hash. Login requests also do not send
the reusable password hash; they send only a one-time challenge response.

Challenge response construction:

```text
passwordHash = SHA-256(password)
message = "tabminal-login-v1:" + challengeId + ":" + salt + ":" + expiresAt
response = HMAC-SHA256(key = passwordHash, message)
```

Challenge properties:

- challenge lifetime: `30 seconds`
- every challenge is single-use
- a challenge is destroyed on every login attempt, whether successful or failed
- expired unused challenges are cleaned up server-side

### 3.2 Access token transport

Accepted forms:

- HTTP header: `Authorization: Bearer <access-token>`
- HTTP header: `Authorization: <access-token>`
- HTTP query: `?token=<access-token>`
- WebSocket header: `Authorization: Bearer <access-token>`
- WebSocket subprotocol:
  `Sec-WebSocket-Protocol: tabminal.v1, tabminal.auth.<access-token>`
- WebSocket query: `?token=<access-token>` is accepted only as a legacy
  compatibility path

Browser websocket clients should use the `Sec-WebSocket-Protocol` form because
browser WebSocket construction does not allow arbitrary auth headers and URL
query strings are commonly captured by logs and diagnostics. The server selects
only `tabminal.v1` in the WebSocket response and never echoes the token-bearing
protocol value.

### 3.3 Refresh token handling

Refresh tokens are HTTP-only protocol values, not websocket credentials.

- clients send refresh tokens only to `POST /api/auth/refresh`
- clients should not place refresh tokens on URLs
- web clients currently persist both access and refresh tokens in local storage
- native clients should use platform-secure storage where possible

### 3.4 Lockout behavior

After `30` failed auth attempts, the service enters a locked state and returns:

- `403 Service locked due to too many failed attempts. Please restart the service.`

Lockout is cleared only by restarting the service.

### 3.5 Auth endpoints

#### `POST /api/auth/challenge`

Request body is empty.

Success response:

```json
{
  "challengeId": "<uuid>",
  "salt": "<base64url-random>",
  "expiresAt": "2026-04-10T15:00:30.000Z",
  "algorithm": "tabminal-hmac-sha256-login-v1"
}
```

#### `POST /api/auth/login`

Request:

```json
{
  "challengeId": "<uuid>",
  "response": "<hmac-sha256-hex>"
}
```

Success response:

```json
{
  "accessToken": "ta_...",
  "accessTokenExpiresAt": "2026-04-10T15:00:00.000Z",
  "refreshToken": "tr_...",
  "refreshTokenExpiresAt": "2026-07-09T15:00:00.000Z"
}
```

Failure responses:

- `400 Invalid login challenge`
- `401 Unauthorized`
- `401 Login challenge expired. Please try again.`
- `403 Service locked due to too many failed attempts. Please restart the service.`

#### `POST /api/auth/refresh`

Request:

```json
{
  "refreshToken": "tr_..."
}
```

Success response matches `POST /api/auth/login`.

Failure response:

- `401 Unauthorized`

#### `POST /api/auth/logout`

Request body may include:

```json
{
  "refreshToken": "tr_..."
}
```

The current access token may also be supplied in `Authorization` or `?token=`.

Success response:

- `204 No Content`

#### `GET /api/auth/session`

Requires a valid access token.

Response:

```json
{
  "authenticated": true,
  "sessionId": "uuid",
  "accessTokenExpiresAt": "2026-04-10T15:00:00.000Z",
  "refreshTokenExpiresAt": "2026-07-09T15:00:00.000Z"
}
```

#### `GET /api/auth/sessions`

Requires a valid access token.

Returns refresh-session summaries for the current host. Tokens and token hashes
are never returned.

Response:

```json
{
  "sessions": [
    {
      "id": "uuid",
      "createdAt": "2026-04-10T15:00:00.000Z",
      "lastSeenAt": "2026-04-10T15:10:00.000Z",
      "refreshExpiresAt": "2026-07-09T15:10:00.000Z",
      "userAgent": "Mozilla/5.0 ...",
      "current": true
    }
  ]
}
```

#### `DELETE /api/auth/sessions/:id`

Requires a valid access token.

Revokes the selected refresh session and any active access token belonging to
that session.

Success response:

- `204 No Content`

Failure response:

- `404 Not Found`

#### `POST /api/auth/logout-others`

Requires a valid access token.

Revokes every refresh session except the current one.

Success response:

- `204 No Content`

### 3.6 Cookies and Cloudflare Access

Tabminal now authenticates with opaque access tokens, but some deployments also
sit behind Cloudflare Access or another upstream auth layer.

Clients must be prepared to work with both:

- Tabminal access token / refresh token
- upstream auth cookies/challenges

For browser clients, this is why sub-host fetches use cookies and redirect
handling. Native clients should preserve the same capability:

- maintain a cookie jar when needed
- detect auth redirects
- treat upstream auth separately from Tabminal token auth

## 4. Versioning and Boot Identity

### 4.1 `GET /api/version`

Unauthenticated endpoint used for bootstrap/runtime coherence.

Response:

```json
{
  "bootId": "1775785247592"
}
```

Semantics:

- `bootId` changes when the backend process restarts
- web assets use this to version `app.js`, `styles.css`, and the service worker
- clients may use it to detect runtime replacement and force a clean reload

### 4.2 `GET /healthz`

Unauthenticated liveness probe.

Response:

```json
{
  "status": "ok"
}
```

## 5. Global Client Rules

These are protocol-level expectations, not incidental UI choices.

### 5.1 Host isolation

Every session, websocket, file operation, and agent tab belongs to exactly one
Tabminal host.

Clients must not merge runtime state across hosts.

### 5.2 Source of truth

- `/api/heartbeat` is the authoritative source for terminal session inventory
  and lightweight agent inventory
- `/api/acp-bus/state` is the authoritative source for ACP definitions, config
  summaries, and open agent tab inventory
- `/api/cluster` is the authoritative source for the host registry
- websocket streams are incremental, not the sole source of truth

### 5.3 Realtime vs authoritative state

The intended model is:

- websocket for immediate streaming
- HTTP for reconciliation

Clients should tolerate:

- websocket reconnects
- missing deltas
- authoritative HTTP refresh replacing local assumptions

### 5.4 Time and ordering

Transport ordering and display ordering are separate concerns.

- ACP transcript blocks do not currently have an upstream timestamp contract
- agent transcript display must therefore rely on the server-maintained
  timeline index, not inferred timestamps
- session history and cluster inventory timestamps are normal data fields and
  may be used directly when present

## 6. HTTP API

All endpoints below are relative to one Tabminal host.

Unless stated otherwise:

- request body is JSON
- response body is JSON
- auth is required

## 7. Heartbeat and Runtime Sync

### 7.1 `POST /api/heartbeat`

This is the main sync endpoint for terminal sessions and lightweight agent
inventory.

Request body:

```json
{
  "updates": {
    "sessions": [
      {
        "id": "session-id",
        "resize": {
          "cols": 132,
          "rows": 42
        },
        "workspaceState": {},
        "editorState": {},
        "fileWrites": [
          {
            "path": "/absolute/or/relative/path",
            "content": "new text",
            "expectedVersion": "sha256",
            "force": false
          }
        ]
      }
    ]
  }
}
```

Supported per-session update fields:

- `resize`
- `workspaceState`
- `editorState`
- `fileWrites`

Response body:

```json
{
  "sessions": [],
  "agents": {
    "restoring": false,
    "tabs": []
  },
  "fileWriteResults": [],
  "system": {},
  "runtime": {
    "bootId": "1775785247592"
  }
}
```

Meaning:

- `sessions`: authoritative terminal session list
- `agents`: lightweight ACP inventory for currently open agent tabs
- `fileWriteResults`: per-session results for heartbeat-submitted writes
- `system`: host stats from `SystemMonitor`
- `runtime.bootId`: current backend boot identity

Client contract:

- treat `sessions` as a full authoritative snapshot for that host
- reconcile by session id
- do not treat it as an append-only delta stream

### 7.2 `GET /api/heartbeat`

The route is implemented as `ALL /api/heartbeat`. `GET` is legal, but current
clients use `POST` so the request and response shape remain symmetric.

## 8. Terminal Sessions API

### 8.1 `POST /api/sessions`

Create a persistent terminal session.

Current server-side accepted fields are based on the session restoration path
and may include:

- `cwd`
- `cols`
- `rows`
- `createdAt`
- `title`
- `workspaceState`
- `editorState`
- `executions`

For normal clients, the stable create inputs are:

- `cwd` optional
- `cols` optional
- `rows` optional

Response:

```json
{
  "id": "session-id",
  "createdAt": "2026-04-10T12:34:56.000Z",
  "shell": "/bin/bash",
  "initialCwd": "/Users/leask/Documents/Tabminal",
  "title": "bash",
  "cwd": "/Users/leask/Documents/Tabminal",
  "cols": 120,
  "rows": 32
}
```

### 8.2 `DELETE /api/sessions/:id`

Closes and removes a terminal session.

Status:

- `204 No Content`

Special behavior:

- if the session is a managed ACP terminal (`managed.kind === 'agent-terminal'`)
  the server first releases it from ACP ownership
- related ACP tabs may also be closed

### 8.3 `POST /api/sessions/:id/state`

Persists session UI/editor state.

Request body is forwarded to terminal persistence as-is.

Typical fields:

- `workspaceState`
- `editorState`

`workspaceState.openAgentTabs` is the lightweight source of truth for which
agent workspace tabs are open inside that terminal workspace. Transcript
history is not stored there; it is served from the ACP bus timeline store.

Response:

- `200 OK`

## 9. File System API

All filesystem routes are resolved relative to the server process working
directory.

Important:

- paths are resolved by `path.resolve(process.cwd(), targetPath)`
- clients should prefer explicit absolute paths when possible
- text file reads are limited to supported UTF-8 text files up to `5 MiB`

### 9.1 `GET /api/fs/list?path=...`

Lists a directory.

Response:

```json
{
  "items": [
    {
      "name": "src",
      "isDirectory": true,
      "path": "src",
      "renameable": true,
      "deleteable": true
    }
  ],
  "creatable": true
}
```

Notes:

- directories are sorted before files
- `.DS_Store` is filtered

### 9.2 `POST /api/fs/create`

Creates a unique child under `parentPath`.

Request:

```json
{
  "parentPath": ".",
  "kind": "file"
}
```

Response:

```json
{
  "path": "untitled_file",
  "parentPath": ".",
  "name": "untitled_file",
  "isDirectory": false
}
```

### 9.3 `POST /api/fs/rename`

Request:

```json
{
  "path": "old-name.txt",
  "newName": "new-name.txt"
}
```

Response:

```json
{
  "path": "old-name.txt",
  "newPath": "new-name.txt",
  "isDirectory": false
}
```

### 9.4 `POST /api/fs/delete`

Request:

```json
{
  "path": "target"
}
```

Response:

```json
{
  "path": "target",
  "isDirectory": true
}
```

### 9.5 `GET /api/fs/read?path=...`

Reads a text file snapshot.

Response:

```json
{
  "content": "file contents",
  "readonly": false,
  "version": "sha256",
  "size": 1234,
  "mtimeMs": 1775785247592
}
```

Errors:

- `404 File not found`
- `400 Not a file`
- `400 File too large`
- `415 Unsupported file type`

The `version` field is a SHA-256 of the file bytes and is used for optimistic
concurrency.

### 9.6 `GET /api/fs/info?path=...`

Returns metadata only.

Response:

```json
{
  "readonly": false,
  "version": "sha256",
  "size": 1234,
  "mtimeMs": 1775785247592
}
```

### 9.7 `POST /api/fs/write`

Simple text write endpoint.

Request:

```json
{
  "path": "/path/to/file",
  "content": "new text"
}
```

Response:

- `200 OK` with empty body on success

This endpoint does not use optimistic version checks.

Heartbeat-based `fileWrites` are the preferred mutation path for editor-backed
clients because they support conflict detection.

### 9.8 `GET /api/fs/raw?path=...`

Raw binary/file preview endpoint.

Supported types:

- images: `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`
- `.pdf`

Behavior:

- returns raw bytes with correct `Content-Type`
- returns `400` for unsupported file types
- returns `404` if the file cannot be read

Auth note:

- this route still requires auth
- clients that cannot conveniently attach headers to media elements may use
  `?token=<access-token>` on the URL

## 10. Memory API

These routes persist UI state for expanded file-tree folders.

### 10.1 `POST /api/memory/expand`

Request:

```json
{
  "path": "/Users/leask/Documents/Tabminal/src",
  "expanded": true
}
```

Response:

- the full expanded-folder list

### 10.2 `GET /api/memory/expanded`

Response:

- the full expanded-folder list

## 11. Cluster / Host Registry API

The backend is the source of truth for the multi-host registry.

### 11.1 `GET /api/cluster`

Response:

```json
{
  "servers": [
    {
      "id": "main",
      "baseUrl": "https://example.com",
      "host": "example.com",
      "token": ""
    }
  ]
}
```

### 11.2 `PUT /api/cluster`

Request:

```json
{
  "servers": [
    {
      "id": "node-a",
      "baseUrl": "https://node-a.example.com",
      "host": "node-a.example.com",
      "token": ""
    }
  ]
}
```

Response:

```json
{
  "servers": []
}
```

Validation:

- request may be either `{ "servers": [...] }` or a bare array
- server persists and re-reads before returning

Contract:

- clients must treat `/api/cluster` as authoritative
- browser-local host registries are not a substitute

## 12. ACP Agent HTTP API

ACP is managed server-side. The client never speaks ACP directly. It talks to
Tabminal over HTTP and WebSocket.

### 12.1 ACP state source

ACP definitions, config summaries, and open agent tab inventory are exposed
through `GET /api/acp-bus/state`.

The old top-level `GET /api/agents` inventory route is not part of the current
public contract. Clients should use the bus-native endpoints below.

### 12.2 `GET /api/acp-bus/resume-sessions?agentId=...&cwd=...`

Returns resumable ACP sessions for one agent. The bus owns this request and
serves only the local bus session index. It never contacts the upstream ACP
provider on the request path. The background bus sync worker keeps this index
fresh by scanning upstream all-session metadata when supported and by scanning
the deduplicated cwd set from currently open terminal/workspace sessions after
the all-session pass. The response is capped at 300 rows.

Required query params:

- `agentId`
- `cwd`

Response:

```json
{
  "sessions": [
    {
      "sessionId": "upstream-session-id",
      "cwd": "/Users/leask/Documents/Tabminal",
      "title": "Session title",
      "updatedAt": "2026-04-10T12:34:56.000Z"
    }
  ],
  "nextCursor": "",
  "scope": "bus"
}
```

Notes:

- current implementation returns `nextCursor: ""`
- session history pagination is not currently exposed to clients
- normal `scope` is `"bus"` and does not block on upstream ACP listing
- if the bus index is empty, the response is an empty `"bus"` result
- `/resume` never performs cwd or all upstream scans synchronously
- session metadata is retained until attach/load proves the upstream session is
  missing; absence from a metadata scan is not deletion-authoritative

Errors:

- `400` missing `agentId` or `cwd`
- `501` runtime does not support session history

### 12.3 `GET /api/acp-bus/config`

Response:

```json
{
  "configs": {
    "codex": {},
    "claude": {},
    "copilot": {}
  }
}
```

### 12.4 `PUT /api/acp-bus/config/:agentId`

Request:

```json
{
  "env": {
    "COPILOT_GITHUB_TOKEN": "..."
  },
  "clearEnvKeys": [
    "GH_TOKEN"
  ]
}
```

Response:

```json
{
  "config": {},
  "definitions": []
}
```

### 12.5 `DELETE /api/acp-bus/config/:agentId`

Clears persisted config for that agent.

Response:

```json
{
  "config": {},
  "definitions": []
}
```

### 12.6 ACP Tab Control

ACP tab mutations no longer use `/api/agents/tabs*`.

All write operations for ACP tabs now go through the unified bus-native command
route:

```text
POST /api/acp-bus/command
```

This includes:

- create
- resume
- attach
- detach
- prompt
- cancel
- resolve permission
- set mode
- set config
- close tab
- release managed terminal

## 13. ACP Bus HTTP API

The ACP bus is the authoritative transcript and session-cache layer for ACP
clients. Web and native clients should use these routes to hydrate open agent
tabs and page transcript history.

The bus websocket is only a realtime invalidation stream. HTTP responses from
this section are the source of truth after reconnects, restore, or missed
events.

### 13.1 `GET /api/acp-bus/state`

Returns ACP bus process status plus the current public ACP inventory. This is
the authoritative lightweight state endpoint for agent definitions, config
summaries, and open agent tabs.

Response:

```json
{
  "bus": {
    "started": true,
    "restoring": false,
    "observedSessionCount": 2,
    "openTabCount": 1
  },
  "restoring": false,
  "definitions": [],
  "configs": {},
  "tabs": []
}
```

Fields:

- `bus`: process-level bus diagnostics
- `restoring`: backend is replaying persisted ACP tabs
- `definitions`: available built-in agent definitions plus availability info
- `configs`: persisted per-agent config summaries
- `tabs`: lightweight open-tab state from the bus; transcript history is paged
  through `/api/acp-bus/tabs/:tabId/timeline`

### 13.2 `GET /api/acp-bus/sessions`

Returns indexed ACP bus sessions from local bus storage.

Query params:

- `agentId`: optional agent filter
- `present`: optional boolean; only include sessions still present upstream
- `hot`: optional boolean; only include currently hot/observed sessions
- `snapshot`: optional boolean; include cached snapshot payloads
- `limit`: optional positive integer

Response:

```json
{
  "sessions": [
    {
      "sessionKey": "codex::upstream-session-id",
      "agentId": "codex",
      "sessionId": "upstream-session-id",
      "cwd": "/Users/leask/Documents/Tabminal",
      "title": "Session title",
      "upstreamUpdatedAt": "2026-04-16T12:34:56.000Z",
      "continuityState": "live",
      "hotRank": 1,
      "status": "ready",
      "busy": false,
      "messageCount": 12,
      "toolCallCount": 3,
      "snapshot": {}
    }
  ]
}
```

Notes:

- `snapshot` is only present when `snapshot=1`.
- This endpoint is useful for diagnostics and future session browsers.
- Continuity repair is backend-owned. Clients should treat `continuityState`
  as diagnostic metadata and continue reading timeline pages from the bus DB.
- The `/resume` picker is bus-first: the backend returns the local bus index
  immediately when cached rows exist and returns at most 300 sessions.
- The bus worker supplements the session index with cwd-scoped scans for the
  deduplicated paths currently opened by terminal/workspace state after the
  normal all-session metadata pass.
- Continuity repair is also bus-owned. Attach/resume does not synchronously
  replay stale history when the upstream gap is large; the session is marked
  `resync_required` and the background worker repairs one stale session per
  low-load poll.

### 13.3 `GET /api/acp-bus/sessions/:agentId/:sessionId`

Returns one indexed ACP bus session.

Query params:

- `snapshot`: optional boolean; include cached snapshot payload

Errors:

- `404` session not found

### 13.4 `GET /api/acp-bus/tabs/:tabId`

Returns authoritative metadata for an open bus-backed agent tab.

Response:

```json
{
  "id": "open-tab-id",
  "agentId": "codex",
  "acpSessionId": "upstream-session-id",
  "cwd": "/Users/leask/Documents/Tabminal",
  "title": "Session title",
  "status": "ready",
  "busy": false,
  "busConnectionKind": "shared",
  "continuityState": "live",
  "availableCommands": [],
  "availableModes": [],
  "currentModeId": "default",
  "configOptions": [],
  "toolCalls": [],
  "permissions": [],
  "plan": [],
  "terminals": []
}
```

Use this endpoint after bus websocket invalidation events when the client needs
fresh tab-level metadata or active live resources but does not need transcript
rows. Full transcript rows remain paged through the timeline endpoint.

### 13.5 `GET /api/acp-bus/tabs/:tabId/timeline`

Returns one ordered page of transcript blocks from bus storage.

Query params:

- `limit`: optional page size; default `30`, maximum `200`
- `before`: optional opaque cursor from a previous page
- `after`: optional opaque cursor from a previous page

Cursor rules:

- omit both `before` and `after` to fetch the latest page
- pass `before=<prevCursor>` to fetch older rows before the current first row
- pass `after=<nextCursor>` to fetch newer rows after the current last row
- clients must treat cursors as opaque strings
- if both `before` and `after` are supplied, current server behavior gives
  `before` precedence; clients should not send both

Response:

```json
{
  "sessionKey": "codex::upstream-session-id",
  "items": [
    {
      "itemKey": "message:assistant-message-id",
      "cursor": "opaque-cursor",
      "type": "message",
      "index": 42,
      "updatedAt": "2026-04-16T12:34:56.000Z",
      "value": {
        "id": "assistant-message-id",
        "role": "assistant",
        "kind": "message",
        "text": "Hello",
        "index": 42
      }
    }
  ],
  "total": 52,
  "hasOlder": true,
  "hasNewer": false,
  "minIndex": 1,
  "maxIndex": 52,
  "firstIndex": 24,
  "lastIndex": 52,
  "prevCursor": "cursor-for-first-item",
  "nextCursor": "cursor-for-last-item"
}
```

Item types:

- `message`: user, assistant, thought, or other agent message block
- `tool`: tool-call card and terminal/resource summaries
- `permission`: pending or resolved permission request
- `plan`: active or completed plan block

Ordering contract:

- `items` are returned in display order from oldest to newest.
- `index` is a server-maintained, contiguous timeline index starting at `1`.
- `itemKey` is the stable row identity within the session timeline.
- Upstream ids, stream keys, tool ids, and any upstream `order`-like fields are
  identity inputs only. They are not part of the client ordering contract.
- Incremental writes preserve the first-observed bus order: existing `itemKey`
  rows keep their index, and newly observed rows append after the current
  maximum index in the order the bus observed them.
- `minIndex` and `maxIndex` are page-independent timeline bounds for the
  session.
- `firstIndex` and `lastIndex` describe the returned page.
- `hasOlder` and `hasNewer` are the primary UI booleans for pagination controls.
- Non-authoritative updates do not delete missing timeline rows.
- If an authoritative replay shows that upstream removed timeline rows, the
  server may reassign indexes by rebuilding the session timeline and will mark
  the event as requiring a full sync.
- Clients should treat fetched pages as authoritative and dedupe by `itemKey`.

Native client fixed-window example:

1. Fetch latest visible history:

   ```http
   GET /api/acp-bus/tabs/open-tab-id/timeline?limit=30
   ```

2. Store `items`, `prevCursor`, `nextCursor`, `hasOlder`, and `hasNewer`.

3. When the user scrolls up and `hasOlder` is true:

   ```http
   GET /api/acp-bus/tabs/open-tab-id/timeline?limit=10&before=<prevCursor>
   ```

   Prepend the returned rows, dedupe by `itemKey`, sort by `(index, itemKey)`,
   then drop the newest rows if keeping a fixed 30-block local window.

4. When the user scrolls down and `hasNewer` is true:

   ```http
   GET /api/acp-bus/tabs/open-tab-id/timeline?limit=10&after=<nextCursor>
   ```

   Append the returned rows, dedupe by `itemKey`, sort by `(index, itemKey)`,
   then drop the oldest rows if keeping a fixed 30-block local window.

5. When the client is following the latest page and receives a bus websocket
   event for the same tab/session, first apply safe `changedItems` deltas if
   present. If `requiresFullSync` is true or the delta cannot be merged safely,
   fetch the latest page again:

   ```http
   GET /api/acp-bus/tabs/open-tab-id/timeline?limit=30
   ```

   If the user has scrolled away from latest, do not yank the viewport. Update
   only rows already inside the visible window. Mark that newer content may
   exist, then fetch newer rows only when the user moves down or explicitly
   jumps to latest.

Recommended native behavior:

- Keep cursors as the canonical pagination input.
- Use `hasOlder` and `hasNewer` to enable or disable scroll pagination.
- Use `minIndex` and `maxIndex` only as bounds for UI state, diagnostics, and
  avoiding obviously exhausted requests.
- Do not derive timestamps from timeline rows for display ordering.
- Do not parse cursor contents or persist assumptions about cursor encoding.

### 13.6 `POST /api/acp-bus/command`

The ACP bus command route is the only HTTP mutation surface for ACP tabs.

Request body always includes a `type` field.

#### Command envelope

```json
{
  "type": "tab.prompt"
}
```

Successful responses always include:

```json
{
  "ok": true,
  "command": {
    "type": "tab.prompt",
    "requestId": "optional-client-request-id",
    "deduped": false,
    "idempotency": "request"
  }
}
```

#### Supported command types

`tab.create`

```json
{
  "type": "tab.create",
  "agentId": "codex",
  "cwd": "/Users/leask/Documents/Tabminal",
  "terminalSessionId": "optional-linked-terminal-session-id",
  "modeId": "optional-mode-id"
}
```

Response:

- `201 Created`
- includes `tab`

Idempotency:

- not idempotent
- retrying can create another local open tab

`tab.resume`

```json
{
  "type": "tab.resume",
  "agentId": "codex",
  "cwd": "/Users/leask/Documents/Tabminal",
  "sessionId": "upstream-session-id",
  "targetTabId": "optional-existing-open-tab-id",
  "title": "optional-local-title-override",
  "terminalSessionId": "optional-linked-terminal-session-id"
}
```

Response:

- includes `tab`
- includes `attach`

Idempotency:

- naturally idempotent for the same target tab and upstream session
- backend coalesces concurrent resumes for the same `(agentId, sessionId,
  targetTabId)`

`tab.attach`

```json
{
  "type": "tab.attach",
  "tabId": "open-tab-id"
}
```

Response:

- includes `tab`
- includes `attach`

Idempotency:

- naturally idempotent

`tab.detach`

```json
{
  "type": "tab.detach",
  "tabId": "open-tab-id"
}
```

Idempotency:

- naturally idempotent

`tab.prompt`

Supported content types:

- `application/json`
- `multipart/form-data`

JSON request:

```json
{
  "type": "tab.prompt",
  "tabId": "open-tab-id",
  "text": "Explain this failure",
  "requestId": "optional-client-generated-id"
}
```

Multipart fields:

- `type = tab.prompt`
- `tabId`
- `text`
- optional `requestId`
- attachment field name: `attachments`

Attachment limits:

- max files: `8`
- max single file: `10 MiB`
- max total file size: `25 MiB`

Response:

- `202 Accepted`

Idempotency:

- prompt is not naturally idempotent
- without `requestId`, replaying the same request can send the prompt again
- with `requestId`, the bus provides at-most-once handling for the same open
  tab and same prompt payload
- reusing a `requestId` with a different payload returns
  `409 idempotency_conflict`

Validation:

- request must contain non-empty `text` or at least one attachment

`tab.cancel`

```json
{
  "type": "tab.cancel",
  "tabId": "open-tab-id"
}
```

Idempotency:

- naturally idempotent

`tab.resolve_permission`

```json
{
  "type": "tab.resolve_permission",
  "tabId": "open-tab-id",
  "permissionId": "permission-id",
  "optionId": "approve"
}
```

`tab.set_mode`

```json
{
  "type": "tab.set_mode",
  "tabId": "open-tab-id",
  "modeId": "high"
}
```

Response:

- includes `tab`

`tab.set_config`

```json
{
  "type": "tab.set_config",
  "tabId": "open-tab-id",
  "configId": "model",
  "valueId": "gpt-5.4"
}
```

Response:

- includes `tab`

`tab.close`

```json
{
  "type": "tab.close",
  "tabId": "open-tab-id"
}
```

Idempotency:

- naturally idempotent

`terminal.release`

```json
{
  "type": "terminal.release",
  "terminalSessionId": "managed-terminal-session-id",
  "destroy": true
}
```

This releases a managed ACP terminal from the bus/runtime side.

#### Error envelope

All ACP bus commands use the same error shape:

```json
{
  "ok": false,
  "error": {
    "code": "runtime_unavailable",
    "message": "Codex CLI is not ready on this host.",
    "retryable": true,
    "details": {}
  }
}
```

Important command error codes:

- `invalid_request`
- `unknown_agent`
- `runtime_unavailable`
- `session_missing`
- `tab_missing`
- `permission_stale`
- `continuity_required`
- `session_already_open`
- `idempotency_conflict`
- `not_supported`
- `internal_error`

### 13.7 `GET /api/acp-bus/events`

Returns a bounded recent ACP bus event log.

Query params:

- `sinceId`: optional integer event id cursor
- `limit`: optional positive integer

Response:

```json
{
  "events": [
    {
      "id": 123,
      "type": "session_snapshot_updated",
      "createdAt": "2026-04-16T12:34:56.000Z",
      "agentId": "codex",
      "sessionId": "upstream-session-id",
      "payload": {
        "snapshotVersion": 7,
        "timelineIndex": {
          "total": 52,
          "minIndex": 1,
          "maxIndex": 52
        },
        "resources": {
          "toolCalls": [],
          "permissions": [],
          "plan": [],
          "terminals": []
        },
        "changedItems": [],
        "removedItemKeys": [],
        "requiresFullSync": true
      }
    }
  ]
}
```

This endpoint is useful for reconnect catch-up and diagnostics. It is bounded,
so clients must still use authoritative tab metadata and timeline pages when
correctness matters.

## 14. WebSocket API: Terminal Sessions

Endpoint:

- `/ws/:sessionId`

Browser clients authenticate with WebSocket subprotocols:

```js
new WebSocket('/ws/<sessionId>', [
  'tabminal.v1',
  'tabminal.auth.<access-token>'
]);
```

The server response selects only:

```text
Sec-WebSocket-Protocol: tabminal.v1
```

`?token=<access-token>` remains accepted as a legacy compatibility path, but
new clients should not use it.

### 14.1 Connection behavior

On connection:

1. the server validates auth
2. the server verifies the session exists
3. the session sends initial state:
   - `snapshot`
   - `meta`
   - `status`
4. queued realtime payloads collected during init are replayed

### 14.2 Server -> client messages

#### `snapshot`

```json
{
  "type": "snapshot",
  "data": "<xterm serialized snapshot>"
}
```

`data` is currently an xterm serialized buffer and should be treated as opaque.

#### `meta`

```json
{
  "type": "meta",
  "title": "bash",
  "cwd": "/Users/leask/Documents/Tabminal",
  "env": "KEY=value\nKEY2=value2",
  "cols": 120,
  "rows": 32
}
```

#### `status`

Ready state:

```json
{
  "type": "status",
  "status": "ready"
}
```

Termination:

```json
{
  "type": "status",
  "status": "terminated",
  "code": 0,
  "signal": null
}
```

#### `output`

```json
{
  "type": "output",
  "data": "raw terminal output chunk"
}
```

#### `execution`

Execution lifecycle events emitted by the shell integration.

Typical shapes:

```json
{
  "type": "execution",
  "phase": "started",
  "executionId": "exec-1",
  "command": "npm test"
}
```

```json
{
  "type": "execution",
  "phase": "completed",
  "executionId": "exec-1",
  "entry": {
    "command": "npm test",
    "exitCode": 0
  }
}
```

```json
{
  "type": "execution",
  "phase": "idle"
}
```

### 14.3 Client -> server messages

#### `input`

```json
{
  "type": "input",
  "data": "ls -la\r"
}
```

#### `resize`

```json
{
  "type": "resize",
  "cols": 132,
  "rows": 42
}
```

#### `claim_terminal_control`

```json
{
  "type": "claim_terminal_control"
}
```

Used when more than one frontend is attached and terminal query responses
should belong to the visible owner.

#### `ping`

```json
{
  "type": "ping"
}
```

Server responds with:

```json
{
  "type": "pong"
}
```

## 15. WebSocket API: ACP Bus

Endpoint:

- `/ws/acp-bus`

The ACP bus websocket is the only agent realtime stream. Legacy per-tab agent
websockets are removed. Agent tab identity, control actions, and timeline pages
are resolved through HTTP APIs; realtime changes arrive as bus events.

Authentication uses the same WebSocket subprotocol contract as terminal
websockets.

### 15.1 Initial message

After the bus is ready, the server sends a bus-native inventory snapshot:

```json
{
  "type": "snapshot",
  "state": {
    "bus": {
      "started": true,
      "restoring": false,
      "observedSessionCount": 2,
      "openTabCount": 1
    },
    "restoring": false,
    "definitions": [],
    "configs": {},
    "tabs": []
  },
  "sessions": []
}
```

`sessions` is a bounded cache summary from the ACP bus store. Clients should
use it as a hint, not as the only source of visible tab state. `state.tabs` is
the same lightweight open-tab inventory returned by `/api/acp-bus/state`.

### 15.2 Event messages

Every later message is an event envelope:

```json
{
  "type": "event",
  "event": {
    "id": 123,
    "type": "session_snapshot_updated",
    "createdAt": "2026-04-16T12:34:56.000Z",
    "payload": {
      "session": {
        "sessionKey": "codex::upstream-session-id",
        "agentId": "codex",
        "sessionId": "upstream-session-id",
        "title": "Session title",
        "cwd": "/Users/leask/Documents/Tabminal",
        "continuityState": "live",
        "busy": false,
        "status": "ready",
        "snapshotVersion": 7
      },
      "pinId": "agent-tab:open-tab-id",
      "snapshotVersion": 7,
      "timelineIndex": {
        "total": 52,
        "minIndex": 1,
        "maxIndex": 52
      },
      "resources": {
        "toolCalls": [],
        "permissions": [],
        "plan": [],
        "terminals": []
      },
      "changedItems": [
        {
          "itemKey": "message:assistant-message-id",
          "cursor": "opaque-cursor",
          "type": "message",
          "index": 52,
          "updatedAt": "2026-04-16T12:34:56.000Z",
          "value": {
            "id": "assistant-message-id",
            "role": "assistant",
            "kind": "message",
            "text": "Hello",
            "index": 52
          }
        }
      ],
      "removedItemKeys": [],
      "requiresFullSync": false
    }
  }
}
```

Current event types include:

- `session_index_created`
- `session_index_updated`
- `session_index_removed`
- `session_hot_attached`
- `session_hot_detached`
- `session_snapshot_updated`
- `session_ui_attached`
- `session_ui_detached`
- `session_resync_required`
- `session_runtime_exit`

Clients should route events to visible agent tabs by `pinId` when present, or
by `(agentId, sessionId)` otherwise. `session_snapshot_updated` and
`session_hot_attached` may carry structured timeline deltas:

- `snapshotVersion`: monotonic per-session version for observed snapshot writes.
- `timelineIndex`: page-independent timeline bounds after the write.
- `resources`: current non-history live resources for the tab/session, including
  active tool calls, pending permissions, active plan rows, and managed terminal
  summaries. Clients can apply these directly without fetching `/api/acp-bus/state`.
- `changedItems`: timeline rows that were inserted or updated and are safe to
  merge by `itemKey`.
- `removedItemKeys`: row keys removed by the write; non-empty removals currently
  require an authoritative timeline fetch.
- `requiresFullSync`: when true, ignore `changedItems` and fetch tab metadata plus
  an authoritative timeline page.

A client following the latest timeline page may merge `changedItems`, sort by
`(index, itemKey)`, and trim to its fixed local window. A client that has
scrolled away from latest should only update rows already in its visible window;
it should not append unseen latest rows and yank the viewport. For ambiguous
cases, or any event with `requiresFullSync = true`, use
`GET /api/acp-bus/tabs/:tabId` and
`GET /api/acp-bus/tabs/:tabId/timeline`.

### 15.3 Open agent tab state

Open agent tabs are not stored in a separate `agent-tabs.json` file. They live
inside the owning terminal session workspace snapshot:

```json
{
  "workspaceState": {
    "activeWorkspaceTabKey": "agent:main:open-tab-id",
    "openAgentTabs": [
      {
        "id": "open-tab-id",
        "agentId": "codex",
        "acpSessionId": "upstream-session-id",
        "cwd": "/Users/leask/Documents/Tabminal",
        "terminalSessionId": "terminal-session-id",
        "createdAt": "2026-04-16T12:34:56.000Z",
        "title": "Session title",
        "currentModeId": "default"
      }
    ]
  }
}
```

This state answers which tabs should reopen with the workspace. ACP transcript
content, tool calls, plans, permissions, and managed terminal summaries are
stored in the ACP bus database and fetched through bus-backed APIs.
Production servers access the bus database through `webjam.dbio`, backed by
the worker-thread SQLite support inherited from `utilitas`, so DB-backed ACP
bus reads do not run SQLite work on the main event loop.

### 15.4 Authority model

The bus websocket gives low-latency invalidation and event delivery. It does
not replace:

- `/api/acp-bus/state` for definitions, config summaries, and open-tab inventory
- `/api/acp-bus/tabs/:tabId` for authoritative open-tab metadata
- `/api/acp-bus/tabs/:tabId/timeline` for paged transcript history
- `/api/acp-bus/command` for ACP tab mutations and runtime control

Clients should expect HTTP snapshots and timeline pages to correct drift after
reconnects, restore, or missed websocket events.

## 16. Error Model

Most routes use plain HTTP status codes plus JSON bodies of the form:

```json
{
  "error": "Human-readable message"
}
```

Some filesystem routes also include:

```json
{
  "error": "Unsupported file type",
  "code": "unsupported-file-type"
}
```

Common statuses:

- `400` invalid request body or missing required fields
- `401` unauthorized
- `403` service locked or write-forbidden path
- `404` session/file not found
- `409` file version conflict or already-open ACP resume
- `415` unsupported text file type
- `500` internal server/runtime failure
- `501` runtime capability not supported

### 16.1 ACP Bus Command Errors

`POST /api/acp-bus/command` uses the structured command error envelope:

```json
{
  "ok": false,
  "error": {
    "code": "runtime_unavailable",
    "message": "Codex CLI is not ready on this host.",
    "retryable": true,
    "details": {}
  }
}
```

This route is the exception to the older string-only error body.

### 16.2 Heartbeat write conflict

Heartbeat file writes may return per-file conflicts through
`fileWriteResults`:

```json
{
  "id": "session-id",
  "fileWrites": [
    {
      "path": "/path/to/file",
      "status": "conflict",
      "version": "sha256",
      "content": "server copy",
      "readonly": false,
      "error": "File version conflict"
    }
  ]
}
```

This is the canonical optimistic concurrency path for text editing.

## 17. Native Client Requirements

Future native clients should follow the same API contract as web.

### 17.1 Required shared behavior

- use `/api/version` for runtime boot identity
- authenticate with the same login/refresh/access-token contract
- use `/api/heartbeat` for authoritative session and agent inventory
- use terminal websockets and `/ws/acp-bus` for realtime streaming
- submit agent prompts and actions over HTTP, not websocket
- hydrate ACP tab metadata and transcript pages through bus HTTP APIs
- treat `/api/cluster` as authoritative host registry
- preserve host isolation

### 17.2 Client-specific storage may differ

Storage location is a client detail, not an API contract.

However, the logical behavior should remain:

- main/default host auth is first-class and controls initial bootstrap
- secondary hosts may require independent upstream auth state
- clients must be able to present and maintain per-host auth state cleanly

### 17.3 Reconnect behavior

Current production web behavior is:

- heartbeat cadence: `1000 ms`
- reconnect throttle: `5000 ms`

Native clients do not have to match the exact implementation, but should not
weaken freshness or reconnect behavior without evidence.

## 18. Stability Notes and Non-Negotiables

These are constraints future API changes should preserve.

### 18.1 Do not move authoritative state to the browser

In particular:

- host registry stays server-authored via `/api/cluster`
- ACP tab persistence stays server-authored
- session inventory remains heartbeat-authored

### 18.2 Do not make websocket the only source of truth

Websocket loss or reconnect must remain survivable through HTTP resync.

### 18.3 Do not fragment web and native APIs

Any new native app should consume the same route structure and websocket
contracts unless there is a very strong reason to split.

### 18.4 Keep terminal and agent transports separate

Terminal sessions and ACP agent tabs are different products with different
message models. They may share host auth and heartbeat, but they should not be
collapsed into one websocket namespace.

## 19. Appendix: Current Endpoint Index

### Public

- `GET /healthz`
- `GET /api/version`

### Sync and host state

- `ALL /api/heartbeat`
- `GET /api/cluster`
- `PUT /api/cluster`
- `POST /api/memory/expand`
- `GET /api/memory/expanded`

### Terminal sessions

- `POST /api/sessions`
- `DELETE /api/sessions/:id`
- `POST /api/sessions/:id/state`
- `WS /ws/:sessionId`

### File system

- `GET /api/fs/list`
- `POST /api/fs/create`
- `POST /api/fs/rename`
- `POST /api/fs/delete`
- `GET /api/fs/read`
- `GET /api/fs/info`
- `GET /api/fs/raw`
- `POST /api/fs/write`

### ACP agents

- ACP runtime state and control are exposed through the ACP bus endpoints below.

### ACP bus

- `GET /api/acp-bus/state`
- `GET /api/acp-bus/sessions`
- `GET /api/acp-bus/sessions/:agentId/:sessionId`
- `GET /api/acp-bus/resume-sessions`
- `GET /api/acp-bus/config`
- `PUT /api/acp-bus/config/:agentId`
- `DELETE /api/acp-bus/config/:agentId`
- `GET /api/acp-bus/tabs/:tabId`
- `GET /api/acp-bus/tabs/:tabId/timeline`
- `POST /api/acp-bus/command`
- `GET /api/acp-bus/events`
- `WS /ws/acp-bus`
