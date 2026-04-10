# Tabminal API

Last updated: 2026-04-10

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
- ACP agent tabs: `/ws/agents/:tabId`

## 3. Authentication

All API routes except `/healthz` and `/api/version` require authentication.

### 3.1 Auth token format

The server expects the configured password hash directly, not a bearer token.

Accepted forms:

- HTTP header: `Authorization: <sha256-hash>`
- HTTP query: `?token=<sha256-hash>`
- WebSocket query: `?token=<sha256-hash>`
- WebSocket header: `Authorization: <sha256-hash>`

Do not send `Bearer <hash>` unless the server is updated to explicitly strip
the prefix. The current implementation compares the provided value directly.

### 3.2 Lockout behavior

After `30` failed auth attempts, the service enters a locked state and returns:

- `403 Service locked due to too many failed attempts. Please restart the service.`

Lockout is cleared only by restarting the service.

### 3.3 Cookies and Cloudflare Access

Tabminal itself authenticates with the hash above. In practice, some deployments
also sit behind Cloudflare Access or another upstream auth layer.

Clients must be prepared to work with both:

- Tabminal auth token
- upstream auth cookies/challenges

For browser clients, this is why sub-host fetches use cookies and redirect
handling. Native clients should preserve the same capability:

- maintain a cookie jar when needed
- detect auth redirects
- treat upstream auth separately from the Tabminal password hash

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
- `/api/agents` is the authoritative source for full ACP agent state
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
- agent transcript ordering must therefore rely on server-maintained timeline
  order, not inferred timestamps
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
  `?token=<sha256-hash>` on the URL

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
      "token": "sha256-hash-or-empty"
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

### 12.1 `GET /api/agents`

Returns full ACP state.

Response:

```json
{
  "restoring": false,
  "definitions": [],
  "configs": {},
  "tabs": []
}
```

Fields:

- `restoring`: backend is replaying persisted ACP tabs
- `definitions`: available built-in agent definitions plus availability info
- `configs`: persisted per-agent config summaries
- `tabs`: full serialized open-tab state

### 12.2 `GET /api/agents/sessions?agentId=...&cwd=...`

Returns resumable ACP sessions for one agent and working directory scope.

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
  "scope": "cwd"
}
```

Notes:

- current implementation returns `nextCursor: ""`
- session history pagination is not currently exposed to clients
- `scope` is currently `"cwd"` unless the runtime supports broader listing

Errors:

- `400` missing `agentId` or `cwd`
- `501` runtime does not support session history

### 12.3 `GET /api/agents/config`

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

### 12.4 `PUT /api/agents/config/:agentId`

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

### 12.5 `DELETE /api/agents/config/:agentId`

Clears persisted config for that agent.

Response:

```json
{
  "config": {},
  "definitions": []
}
```

### 12.6 `POST /api/agents/tabs`

Creates a new ACP tab.

Request:

```json
{
  "agentId": "codex",
  "cwd": "/Users/leask/Documents/Tabminal",
  "terminalSessionId": "optional-linked-terminal-session-id",
  "modeId": "optional-mode-id"
}
```

Response:

- `201 Created`
- body is the full serialized tab

### 12.7 `POST /api/agents/tabs/resume`

Resumes an existing upstream ACP session into a Tabminal tab.

Request:

```json
{
  "agentId": "codex",
  "cwd": "/Users/leask/Documents/Tabminal",
  "sessionId": "upstream-session-id",
  "title": "optional local title override",
  "terminalSessionId": "optional-linked-terminal-session-id"
}
```

Response:

- `201 Created`
- body is the full serialized tab

Errors:

- `409` session already open in another local tab
- `501` runtime cannot restore/load sessions

### 12.8 `POST /api/agents/tabs/:tabId/prompt`

Sends a prompt to an open ACP tab.

Supported content types:

- `application/json`
- `multipart/form-data`

JSON request:

```json
{
  "text": "Explain this failure"
}
```

Multipart fields:

- text field: `text`
- attachment field name: `attachments`

Attachment limits:

- max files: `8`
- max single file: `10 MiB`
- max total file size: `25 MiB`

Response:

```json
{
  "ok": true
}
```

Status:

- `202 Accepted`

Validation:

- request must contain non-empty `text` or at least one attachment

### 12.9 `POST /api/agents/tabs/:tabId/cancel`

Cancels the active prompt turn.

Response:

```json
{
  "ok": true
}
```

Status:

- `202 Accepted`

### 12.10 `POST /api/agents/tabs/:tabId/permissions/:permissionId`

Resolves a pending permission request.

Request:

```json
{
  "optionId": "approve"
}
```

Response:

```json
{
  "ok": true
}
```

### 12.11 `POST /api/agents/tabs/:tabId/mode`

Switches ACP session mode.

Request:

```json
{
  "modeId": "high"
}
```

Response:

- full serialized tab state

### 12.12 `POST /api/agents/tabs/:tabId/config`

Applies one ACP config option.

Request:

```json
{
  "configId": "model",
  "valueId": "gpt-5.4"
}
```

Response:

- full serialized tab state

### 12.13 `DELETE /api/agents/tabs/:tabId`

Closes the ACP tab.

Response:

- `204 No Content`

## 13. WebSocket API: Terminal Sessions

Endpoint:

- `/ws/:sessionId?token=<hash>`

Browser clients use the query param because browser WebSocket construction does
not let them set arbitrary auth headers.

### 13.1 Connection behavior

On connection:

1. the server validates auth
2. the server verifies the session exists
3. the session sends initial state:
   - `snapshot`
   - `meta`
   - `status`
4. queued realtime payloads collected during init are replayed

### 13.2 Server -> client messages

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

### 13.3 Client -> server messages

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

## 14. WebSocket API: ACP Agent Tabs

Endpoint:

- `/ws/agents/:tabId?token=<hash>`

The agent websocket is currently server-to-client only for transcript and tab
realtime updates. Prompt submission and command actions stay on HTTP.

### 14.1 Initial message

On attach, the server sends:

```json
{
  "type": "snapshot",
  "tab": { "...serialized tab..." }
}
```

### 14.2 Tab serialization shape

A serialized agent tab includes:

- `id`
- `runtimeId`
- `runtimeKey`
- `acpSessionId`
- `agentId`
- `agentLabel`
- `commandLabel`
- `title`
- `terminalSessionId`
- `cwd`
- `createdAt`
- `status`
- `busy`
- `errorMessage`
- `currentModeId`
- `availableModes`
- `availableCommands`
- `sessionCapabilities`
- `configOptions`
- `messages`
- `toolCalls`
- `permissions`
- `plan`
- `usage`
- `terminals`

`messages`, `toolCalls`, `permissions`, and `plan` are ordered by the server's
timeline `order` field.

### 14.3 Server -> client incremental messages

#### `message_open`

Creates a new transcript block.

```json
{
  "type": "message_open",
  "message": {
    "id": "local-message-id",
    "streamKey": "stream-id-or-message-id",
    "role": "assistant",
    "kind": "message",
    "text": "Starting text",
    "createdAt": "2026-04-10T12:34:56.000Z",
    "order": 123
  }
}
```

#### `message_chunk`

Appends to an existing transcript block.

```json
{
  "type": "message_chunk",
  "streamKey": "stream-id-or-message-id",
  "role": "assistant",
  "kind": "message",
  "text": "delta text",
  "order": 124
}
```

Contract:

- the server may bump `order` when a block is touched again
- clients must treat `order` as authoritative transcript order
- `streamKey` groups chunk updates for one logical block

#### `session_update`

Generic ACP update envelope.

```json
{
  "type": "session_update",
  "update": {
    "sessionUpdate": "tool_call_update"
  },
  "tab": {
    "title": "Session title",
    "currentModeId": "high",
    "availableModes": [],
    "availableCommands": [],
    "configOptions": []
  }
}
```

Observed `sessionUpdate` kinds currently include:

- `tool_call`
- `tool_call_update`
- `current_mode_update`
- `available_commands_update`
- `config_option_update`
- `session_info_update`
- `plan`
- `usage_update`

#### `permission_request`

```json
{
  "type": "permission_request",
  "permission": {
    "id": "permission-id",
    "sessionId": "acp-session-id",
    "toolCall": {},
    "options": [],
    "status": "pending",
    "createdAt": "2026-04-10T12:34:56.000Z",
    "order": 125,
    "selectedOptionId": ""
  }
}
```

#### `permission_resolved`

```json
{
  "type": "permission_resolved",
  "permissionId": "permission-id",
  "status": "selected",
  "selectedOptionId": "approve"
}
```

#### `terminal_update`

Managed ACP terminal summary changed.

```json
{
  "type": "terminal_update",
  "terminal": {
    "terminalId": "terminal-id",
    "sessionId": "acp-session-id",
    "terminalSessionId": "linked-terminal-session-id",
    "command": "python script.py",
    "cwd": "/Users/leask/Documents/Tabminal",
    "output": "recent output tail",
    "createdAt": "2026-04-10T12:34:56.000Z",
    "updatedAt": "2026-04-10T12:35:10.000Z",
    "running": true,
    "released": false,
    "exitStatus": null
  }
}
```

#### `usage_state`

```json
{
  "type": "usage_state",
  "usage": {
    "used": 1000,
    "size": 100000,
    "totals": {},
    "updatedAt": "",
    "resetAt": "",
    "vendorLabel": "",
    "sessionId": "",
    "summary": "",
    "windows": []
  }
}
```

#### `status`

```json
{
  "type": "status",
  "status": "running",
  "busy": true,
  "errorMessage": ""
}
```

#### `complete`

```json
{
  "type": "complete",
  "status": "ready",
  "busy": false
}
```

### 14.4 Agent websocket authority model

The websocket gives low-latency transcript and tool updates. It does not
replace:

- `/api/agents` for full-state reconciliation
- `/api/agents/tabs/:tabId/*` HTTP mutations

Clients should expect the HTTP snapshot to correct drift after reconnects,
restore, or missed deltas.

## 15. Error Model

Tabminal uses plain HTTP status codes plus JSON bodies of the form:

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

### 15.1 Heartbeat write conflict

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

## 16. Native Client Requirements

Future native clients should follow the same API contract as web.

### 16.1 Required shared behavior

- use `/api/version` for runtime boot identity
- authenticate with the same hash token contract
- use `/api/heartbeat` for authoritative session and agent inventory
- use terminal and agent websockets for realtime streaming
- submit agent prompts and actions over HTTP, not websocket
- treat `/api/cluster` as authoritative host registry
- preserve host isolation

### 16.2 Client-specific storage may differ

Storage location is a client detail, not an API contract.

However, the logical behavior should remain:

- main/default host auth is first-class and controls initial bootstrap
- secondary hosts may require independent upstream auth state
- clients must be able to present and maintain per-host auth state cleanly

### 16.3 Reconnect behavior

Current production web behavior is:

- heartbeat cadence: `1000 ms`
- reconnect throttle: `5000 ms`

Native clients do not have to match the exact implementation, but should not
weaken freshness or reconnect behavior without evidence.

## 17. Stability Notes and Non-Negotiables

These are constraints future API changes should preserve.

### 17.1 Do not move authoritative state to the browser

In particular:

- host registry stays server-authored via `/api/cluster`
- ACP tab persistence stays server-authored
- session inventory remains heartbeat-authored

### 17.2 Do not make websocket the only source of truth

Websocket loss or reconnect must remain survivable through HTTP resync.

### 17.3 Do not fragment web and native APIs

Any new native app should consume the same route structure and websocket
contracts unless there is a very strong reason to split.

### 17.4 Keep terminal and agent transports separate

Terminal sessions and ACP agent tabs are different products with different
message models. They may share host auth and heartbeat, but they should not be
collapsed into one websocket namespace.

## 18. Appendix: Current Endpoint Index

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

- `GET /api/agents`
- `GET /api/agents/sessions`
- `GET /api/agents/config`
- `PUT /api/agents/config/:agentId`
- `DELETE /api/agents/config/:agentId`
- `POST /api/agents/tabs`
- `POST /api/agents/tabs/resume`
- `POST /api/agents/tabs/:tabId/prompt`
- `POST /api/agents/tabs/:tabId/cancel`
- `POST /api/agents/tabs/:tabId/permissions/:permissionId`
- `POST /api/agents/tabs/:tabId/mode`
- `POST /api/agents/tabs/:tabId/config`
- `DELETE /api/agents/tabs/:tabId`
- `WS /ws/agents/:tabId`
