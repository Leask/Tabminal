# ACP Bus Planning

## Status

Branch: `acp_bus`

Last reviewed: 2026-04-17

The ACP bus is now the primary backend path for ACP agent tabs. Existing web
agent tabs keep the current per-tab workspace UX, but their transcript hydration
and runtime control now go through the backend bus rather than directly through
legacy controller tabs.

This document intentionally tracks current architecture and future work only. It
omits completed implementation checklists and deferred ideas that are not in the
current plan.

## Current Architecture

### Product Scope

The current branch preserves the existing ACP tab UX:

- one workspace tab per agent session
- no unified multi-session chat UI yet
- no global notification UI yet
- no external adapters yet

The bus goal for this branch is infrastructure convergence: backend-owned ACP
runtime handles, structured local storage, and stable HTTP/websocket contracts
that future web, native, and adapter clients can share.

### Identity

A global ACP session is identified by:

```text
agentId + sessionId
```

The working directory is metadata. It is not part of the primary identity.

The current string key is:

```text
agentId + '::' + sessionId
```

### Continuity States

- `cold`: discovered from metadata only; local transcript may be absent.
- `cached`: local transcript exists, but no active observer is attached.
- `live`: a bus-owned ACP runtime handle is attached and receiving updates.
- `resync_required`: local history may be incomplete; an authoritative
  `loadSession` is needed before claiming full continuity.

### Backend Store

`src/acp-bus-store.mjs` owns `~/.tabminal/acp-bus.sqlite` by default.

Important tables:

- `acp_bus_sessions`
- `acp_bus_timeline_items`
- `acp_bus_events`

The timeline table uses a single contiguous `item_index` integer. Timeline HTTP
responses expose this as `index`; no `order` alias is part of the bus timeline
API contract.

Timeline rules:

- rows are stored per `agentId::sessionId`
- rows are ordered by contiguous `index`, starting at `1`
- cursors are opaque and encode enough server state for before/after queries
- if stored indexes are no longer contiguous, the store rebuilds indexes from
  current display order
- authoritative full replays may replace timeline rows for a session
- live updates merge by stable item identity
- observed snapshot writes advance `snapshot_version` when transcript or
  snapshot content changes
- bus events include safe `changedItems` deltas, or `requiresFullSync` when the
  client must refetch

### Backend Manager

`src/acp-bus-manager.mjs` owns the ACP bus lifecycle:

- polls ACP providers for global session metadata
- keeps the hot set attached based on ACP metadata `updatedAt`
- treats provider discovery as deletion-authoritative only when `scope = all`
- attaches hot or UI-pinned sessions through bus-owned runtime handles
- owns lightweight open agent tab metadata
- persists bus events for downstream clients
- routes prompt, cancel, permission, mode, config, terminal release, create,
  resume, and close operations through bus-owned runtime handles

Hot set defaults:

```text
poll interval: 10000ms
hot session limit: 10
cached session retention: 1000
```

### Server API Surface

Bus inspection and session cache:

```text
GET  /api/acp-bus/state
GET  /api/acp-bus/sessions
GET  /api/acp-bus/sessions/:agentId/:sessionId
GET  /api/acp-bus/events
POST /api/acp-bus/sync
```

Open agent tab state:

```text
GET    /api/acp-bus/tabs/:tabId
```

Timeline paging:

```text
GET /api/acp-bus/tabs/:tabId/timeline?limit=&before=&after=
```

Bus-native commands:

```text
POST /api/acp-bus/command
```

Current command types:

- `tab.create`
- `tab.resume`
- `tab.attach`
- `tab.detach`
- `tab.prompt`
- `tab.cancel`
- `tab.resolve_permission`
- `tab.set_mode`
- `tab.set_config`
- `tab.close`
- `terminal.release`

Idempotency rules:

- `tab.attach`, `tab.detach`, `tab.resume`, `tab.cancel`, and `tab.close`
  are naturally idempotent
- `tab.prompt` is not naturally idempotent
- `tab.prompt` supports optional `requestId` for at-most-once handling on the
  same open tab and same prompt payload
- reusing a `requestId` with a different prompt payload is a conflict

Command errors now use a structured envelope with stable `code`,
human-readable `message`, `retryable`, and optional `details`.

Timeline page shape is index-first:

```json
{
  "items": [
    {
      "itemKey": "message:m-1",
      "cursor": "opaque-cursor",
      "type": "message",
      "index": 42,
      "updatedAt": "2026-04-17T12:00:00.000Z",
      "value": { "id": "m-1", "index": 42 }
    }
  ],
  "total": 52,
  "hasOlder": true,
  "hasNewer": false,
  "minIndex": 1,
  "maxIndex": 52,
  "firstIndex": 23,
  "lastIndex": 52,
  "prevCursor": "cursor-for-first-item",
  "nextCursor": "cursor-for-last-item"
}
```

### Frontend Bus Flow

The frontend host client owns one `/ws/acp-bus` connection per host.

Open agent tabs:

- call `POST /api/acp-bus/command` with `type = tab.attach` when attached or
  restored
- call `GET /api/acp-bus/tabs/:tabId` for lightweight metadata sync
- call `GET /api/acp-bus/tabs/:tabId/timeline` for transcript windows
- apply safe websocket `changedItems` deltas by `itemKey`
- fall back to metadata/timeline fetches when `requiresFullSync` is true
- debounce follow-up metadata/timeline fetches

Timeline windowing:

```text
initial visible blocks: 30
older/newer step: 10
render debounce: 300ms
authoritative sync debounce: 300ms
```

Window behavior:

- initial load fetches the latest 30 blocks
- upward scroll fetches 10 older blocks and drops farthest newer blocks
- downward scroll fetches 10 newer blocks and drops farthest older blocks
- if the user is at latest, incoming updates follow latest
- if the user scrolled away, incoming updates do not yank the viewport

### Resume Flow

The current resume flow is intentionally lightweight:

1. User selects a history item from the slash menu.
2. Frontend clears composer text and the command menu immediately.
3. Frontend calls `POST /api/acp-bus/command` with `type = tab.resume`.
4. Backend binds the current tab to the requested ACP session.
5. Backend ensures the bus pin/attach path is active.
6. Backend returns lightweight tab metadata and attach acknowledgement.
7. Frontend reconciles through bus metadata and timeline APIs.
8. Later bus events continue to invalidate and refresh visible state.

Resume should not wait for a full transcript replay on the UI critical path.

## Active Limitations

### Delta Safety Boundaries

Bus websocket events now carry structured timeline deltas when the store can
classify the write safely. Clients still must treat `requiresFullSync = true`,
removed rows, authoritative replacements, oversized deltas, and unknown local
window state as signals to fetch authoritative metadata and timeline pages.

### Resume Picker Source

The `/resume` picker still uses the upstream session listing path behind
`GET /api/agents/sessions`. The bus index is not currently the picker source
because provider support for complete all-session listing is inconsistent.

### Restart Gaps

If Tabminal is down while an upstream ACP session updates, the bus may miss the
live update. The session should be treated as requiring an authoritative reload
when the gap matters.

### No Global Notification Surface

The bus records events, but the product does not yet expose global notifications
for sessions that update while not open.

### No External Adapters

Native apps, Telegram, and other adapters are future consumers of the shared bus
API, but they are not implemented in this branch.

## Next Plan

### Phase 2E: Global Notifications

Goal: surface useful bus activity outside currently open tabs.

Notification candidates:

- session updated
- permission required
- agent completed
- agent errored
- continuity requires reload

Behavior model:

- if the session is already open, route attention to that tab
- if not open, clicking notification resumes/attaches that session
- notification eligibility should respect hot set and pinned/open sessions first

Prerequisite: Phase 2C deltas or stronger event payloads, otherwise the UI must
fetch too much state to classify events cheaply.

### Phase 2F: Continuity Repair Policy

Goal: keep continuity repair entirely inside the backend bus.

Policy:

- UI and native clients only read local bus state and timeline pages
- frontend scrolling never talks directly to upstream ACP providers
- manual attach/resume and hot-set restore attach compare upstream
  `updatedAt` with the last local receive/load time
- if that attach gap is greater than `10min`, the bus performs an
  authoritative replay and rewrites the local structured timeline
- if that attach gap is within `10min`, the bus accepts the local cache and
  continues from the live stream
- cold sessions are repaired opportunistically after non-startup metadata syncs
- cold repair runs only when normalized 1-minute CPU load is below the bus
  threshold
- each low-load sync repairs at most one cold session: the present non-hot
  session whose local sync is oldest and stale by more than `10min`

User-visible behavior:

- no explicit continuity warning UI
- no user-triggered repair action in this phase
- repair success publishes normal bus delta/full-sync events
- repair failure is kept as internal bus event/state for diagnostics

### Phase 2G: External Consumers

Goal: prepare bus APIs for native apps and adapters after the web path is stable.

Candidate consumers:

- native app
- Telegram adapter
- global multi-session chat UI

Prerequisites:

- stable timeline paging contract
- structured delta events
- documented command contract
- clear auth/token behavior for non-browser clients

## Current Decision Points

1. Should hot-set policy become user-configurable before global notifications
   ship?
