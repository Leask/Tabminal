# ACP Bus Planning

## Status

Branch: `acp_bus`

Last reviewed: 2026-04-16

The ACP bus is no longer only a backend experiment. The current branch has a
working backend bus, SQLite storage, server APIs, bus websocket fan-out, and
open ACP agent tabs now hydrate transcript state through the bus path.

The product UX is still the existing per-agent-tab workspace. We have not yet
introduced a unified multi-session chat UI, global notifications, or external
adapters. The current goal is to make the existing ACP tab UX use the bus as the
main transcript and control source while preserving the existing user-facing tab
model.

## Current Implementation Summary

### Completed

- [x] Backend ACP bus manager and store exist.
- [x] SQLite-backed ACP session and event persistence exists.
- [x] Global ACP session discovery runs on a polling loop.
- [x] Default discovery poll interval is `10000ms`.
- [x] Global hot session limit defaults to `10`.
- [x] Global cached session retention defaults to `1000`.
- [x] Bus startup syncs ACP metadata first, then attaches sessions selected by
  ACP metadata `updatedAt`.
- [x] Bus-owned runtime handles attach to hot or explicitly pinned sessions.
- [x] Bus owns open UI agent tab metadata and persists it in terminal
  `workspaceState.openAgentTabs` as lightweight session identity.
- [x] Server `/api/agents` and heartbeat inventory now list bus-owned open
  tabs.
- [x] Server create/resume/prompt/cancel/mode/config/permission routes now go
  through bus-owned runtime handles instead of `AcpManager` controller tabs.
- [x] Discovery results carry `scope`; only `scope = all` can remove missing
  sessions from the index.
- [x] Timeline persistence distinguishes authoritative full replays from live
  incremental updates.
- [x] Timeline pages expose order bounds so clients know when older/newer
  requests are exhausted.
- [x] Frontend host clients maintain `/ws/acp-bus` connections.
- [x] Open frontend agent tabs attach to the bus with
  `POST /api/acp-bus/tabs/:tabId/attach`.
- [x] Open frontend agent tabs fetch lightweight metadata from
  `GET /api/acp-bus/tabs/:tabId`.
- [x] Open frontend agent tabs fetch transcript windows from
  `GET /api/acp-bus/tabs/:tabId/timeline`.
- [x] `/resume` now returns an attach acknowledgement and lightweight tab
  metadata; transcript hydration happens through the bus sync path.
- [x] Frontend transcript rendering is windowed to 30 blocks with 10-block
  up/down loading steps.
- [x] Frontend transcript render work is debounced and keyed so unchanged
  historical nodes are not rebuilt on every update.

### Still Open

- [ ] The resume session picker still uses the legacy
  `GET /api/agents/sessions` upstream listing path.
- [ ] The bus session index is not yet the primary source for the resume
  picker or global session browser.
- [ ] There is no global notification UI for sessions that update while not
  open.
- [ ] There is no unified multi-session chat UI.
- [ ] There are no Telegram or native-app adapters yet.
- [ ] Bus websocket events are still invalidation events, not structured deltas.
- [ ] Process-restart gaps are still best-effort; strong cross-process
  continuity is not implemented.

## Goals

1. Track globally discoverable ACP sessions across all supported agents.
2. Keep recently updated or user-pinned sessions attached in the backend.
3. Persist recent session state locally so downstream clients attach to
   Tabminal instead of directly to upstream ACP providers.
4. Keep the bus ACP-centric and provider-agnostic.
5. Preserve the existing ACP tab UX until a later UI migration is designed.
6. Avoid unbounded local storage growth.

## Non-Goals For The Current Branch

1. No unified chat UI yet.
2. No global notification center yet.
3. No Telegram adapter yet.
4. No native-app-specific protocol split yet.
5. No provider-specific filesystem/database watchers.
6. No guarantee that a Tabminal process restart cannot miss an upstream update
   that happens exactly during downtime.

## Key ACP Constraints

Current ACP provider capabilities we rely on:

- `session/list`: discover sessions and metadata such as `updatedAt`.
- `session/load`: authoritative restore with full replay of history.
- `session/update`: live incremental updates while attached.
- `unstable_resumeSession`: low-cost context resume without full replay.

Important consequences:

- `loadSession` is expensive and should not sit on UI critical paths unless an
  authoritative baseline is explicitly required.
- `unstable_resumeSession` cannot repair a history gap by itself.
- Continuous correctness comes from keeping the backend observer attached.
- If a session was detached, evicted, or missed during process downtime, the
  bus should treat it as `resync_required` until a future authoritative load.

## Core Identity Model

A global ACP session is identified by:

```text
agentId + sessionId
```

The working directory is metadata. It is not part of the primary identity.

The current string key is:

```text
agentId + '::' + sessionId
```

## Session Continuity States

### `cold`

The bus knows about the session from discovery metadata only. It may not have a
local materialized transcript.

### `cached`

The bus has a stored snapshot, but no active observer is attached.

### `live`

The session is currently observed by a bus-owned ACP runtime handle.

### `resync_required`

The bus has a snapshot, but continuity cannot be trusted. A future
`loadSession` is required before claiming complete history.

## Backend Components

### `src/acp-bus-store.mjs`

Responsibilities:

- Owns `~/.tabminal/acp-bus.sqlite` by default.
- Persists session metadata.
- Persists structured timeline rows for messages, tools, permissions, and plan
  entries.
- Keeps serialized snapshots as a compatibility/cache layer while the frontend
  migrates to ranged timeline reads.
- Persists a bounded ACP bus event log.
- Maintains hot ranks and bounded cache pruning.
- Preserves cached transcript content when a new live attach initially reports
  an empty restoring snapshot.

Important tables:

- `acp_bus_sessions`
- `acp_bus_timeline_items`
- `acp_bus_events`

Important persisted session fields:

- `session_key`
- `agent_id`
- `session_id`
- `cwd`
- `title`
- `upstream_updated_at`
- `last_activity_at`
- `last_seen_at`
- `last_attached_at`
- `last_loaded_at`
- `last_live_at`
- `last_received_at`
- `last_detached_at`
- `continuity_state`
- `hot_rank`
- `status`
- `busy`
- `error_message`
- `message_count`
- `tool_call_count`
- `snapshot_json`

### `src/acp-bus-manager.mjs`

Responsibilities:

- Poll ACP providers for global session discovery.
- Maintain the global hot set.
- Attach/detach bus-owned runtimes for hot or pinned sessions.
- Own lightweight open agent tab metadata.
- Emit and persist downstream-friendly bus events.
- Serve session state from the store.

Current behavior details:

- Hot selection is driven by ACP session metadata `updatedAt` from
  `session/list`, with local seen/activity fields only as fallback sorting data.
- `session/list` results are treated as authoritative for deletion only when the
  provider reports `scope = all`. CWD-scoped results only upsert seen sessions.
- `markSessionInterest()` ensures a session index row exists and schedules hot
  rebalance, but it no longer changes hot ordering.
- `pinSession()` records a UI pin, ensures that specific session is observed,
  then schedules hot rebalance in the background.
- `unpinSession()` removes a UI pin and schedules hot rebalance in the
  background.
- Hot rebalance is intentionally no longer blocking the UI attach/resume
  critical path.
- `createTabForUi()` creates an ACP session through a bus-owned runtime handle
  and stores only the open tab/session identity in the owning terminal workspace snapshot.
- `resumeTabForUi()` binds the existing workspace tab to the requested ACP
  session and ensures the bus-owned runtime handle is attached.
- Prompt, cancel, permission, mode, config, managed terminal release, and tab
  close operations are resolved by bus-owned runtime handles.

### `src/acp-manager.mjs`

Responsibilities in the bus architecture:

- Provides ACP definitions, agent config persistence, availability checks, and
  the reusable `AcpRuntime` implementation.
- No longer restores or owns open workspace agent tabs on the server main path.
- Any remaining legacy controller-tab helpers are isolated compatibility code;
  server routes no longer use them for open agent tabs or realtime transport.

### `src/server.mjs`

Responsibilities in the bus architecture:

- Wires the bus store and manager at process startup.
- Starts bus restore and polling during server restore.
- Exposes bus REST APIs and `/ws/acp-bus`.
- Returns bus-owned open tab metadata separately from transcript timeline pages.
- Routes explicit user actions, such as create, resume, prompt, cancel, mode,
  config, and permission resolution, through the bus manager.

## Backend API Surface

### Bus Inspection And Sync

- `GET /api/acp-bus/state`
- `GET /api/acp-bus/sessions`
- `GET /api/acp-bus/sessions/:agentId/:sessionId`
- `GET /api/acp-bus/events`
- `POST /api/acp-bus/sync`
- `GET /api/acp-bus/tabs/:tabId/timeline?limit=&before=&after=`

### Bus-Backed Agent Tab State

- `GET /api/acp-bus/tabs/:tabId`
  - Returns bus-owned open tab metadata merged with the current bus snapshot.

- `POST /api/acp-bus/tabs/:tabId/attach`
  - Pins the open tab's ACP session into the bus.
  - Ensures that specific session is observed.
  - Returns bus-owned tab state.

- `DELETE /api/acp-bus/tabs/:tabId/attach`
  - Removes the UI pin for that tab.

### Resume Flow

- `POST /api/agents/tabs/resume`
  - Calls the ACP bus resume path.
  - Ensures the resumed session is pinned and attached by the bus.
  - Returns an acknowledgement with lightweight tab metadata.
  - Does not wait for complete transcript replay.
  - The frontend then reconciles through the bus snapshot path.

Current response shape accepts both legacy and new frontend handling:

```json
{
  "ok": true,
  "attach": {
    "ok": true,
    "source": "hot | cache | cold",
    "continuityState": "live | cached | cold | resync_required"
  },
  "tab": {
    "id": "...",
    "agentId": "codex",
    "acpSessionId": "...",
    "status": "restoring",
    "busy": true,
    "busConnectionKind": "shared"
  }
}
```

## Frontend Components

### `ServerClient` Bus Lifecycle

The frontend host client owns the per-host bus websocket:

- Opens `/ws/acp-bus` after host auth succeeds.
- Reconnects the bus websocket separately from terminal and agent tab control
  websockets.
- Routes bus events to matching open agent tabs.
- On reconnect, open tabs call `connect()` to reattach their bus pins.

### `AgentTab` Bus Behavior

Current `AgentTab` defaults to bus mode:

```js
this.connectionKind = 'bus';
```

Important methods:

- `connect()`
  - Ensures host bus websocket is connected.
  - Calls `syncFromBus({ attach: true })` unless already attached to the same
    `agentId::sessionId`.

- `syncFromBus({ attach })`
  - `attach=true`: POST attach endpoint, then update lightweight local
    metadata.
  - `attach=false`: GET bus-owned tab metadata, then update lightweight local
    state.
  - If the visible window is at the latest page, fetches the latest timeline
    page from `/api/acp-bus/tabs/:tabId/timeline`.

- `handleBusEvent(event)`
  - Marks `session_ui_attached` pins locally.
  - Debounces metadata/timeline sync from the server.

- `notifyUi()`
  - Schedules panel render only if the owning terminal session and workspace tab
    are visible.

### Control Path Goes Through The Bus

These operations are exposed through legacy agent-tab HTTP endpoints, but the
server route now resolves them through `AcpBusManager` and bus-owned runtime
handles:

- send prompt
- cancel prompt
- switch mode
- resolve permission
- update config
- close tab
- managed terminal interactions

## Resume UI Flow

Current `/resume` path:

1. User selects a history item from the slash menu.
2. Composer text and command menu are cleared immediately.
3. Frontend calls `POST /api/agents/tabs/resume` with the target tab id.
4. Backend returns attach acknowledgement and lightweight tab metadata.
5. Frontend updates the current tab with a restoring placeholder when needed.
6. Frontend activates the tab.
7. Frontend calls `syncFromBus()` to reconcile metadata and then fetch the
   latest bus timeline page.
8. Later bus events trigger debounced `syncFromBus()` calls as replay/live
   updates arrive.

This means resume UX should no longer be blocked by full transcript replay.

## Frontend Timeline Windowing

The frontend now pages transcript data from backend bus storage. The local
window remains small and the backend provides cursor-based older/newer pages.

Current constants:

```js
AGENT_TRANSCRIPT_INITIAL_VISIBLE_BLOCKS = 30
AGENT_TRANSCRIPT_WINDOW_STEP = 10
AGENT_TRANSCRIPT_FOLLOW_LATEST_TOLERANCE = 5
AGENT_TRANSCRIPT_RENDER_DEBOUNCE_MS = 300
AGENT_TRANSCRIPT_AUTH_SYNC_DEBOUNCE_MS = 300
```

Behavior:

- Initial render pins to the latest 30 timeline blocks.
- Scrolling up fetches 10 older blocks and drops the farthest newer blocks from
  the local window.
- Scrolling down fetches 10 newer blocks and drops the farthest older blocks
  from the local window.
- Backend pages include `minOrder` and `maxOrder`; the client uses those bounds
  to avoid requesting before the first known item or after the latest known
  item.
- If the user is near the latest window, new updates follow the latest content.
- If the user has scrolled away from the latest window, updates should not yank
  the viewport to the bottom.
- DOM nodes are keyed by timeline identity and render signature so unchanged
  historical nodes are reused.

Important limitation:

- Bus websocket events still trigger a follow-up fetch. They do not yet carry
  fine-grained item deltas.

## Snapshot And Event Flow

### Discovery Flow

```text
ACP provider listSessions
  -> AcpBusManager.syncNow()
  -> result scope controls whether missing sessions can be reconciled
  -> AcpBusStore.upsertIndexedSession()
  -> hot rebalance
  -> optional bus runtime attach
  -> snapshot persistence
  -> bus event
  -> frontend /ws/acp-bus
```

### Open Agent Tab Flow

```text
Frontend AgentTab.connect()
  -> POST /api/acp-bus/tabs/:tabId/attach
  -> AcpBusManager.pinSession()
  -> bus runtime attach
  -> AcpBusStore.saveObservedSession()
  -> frontend updates from merged snapshot
```

### Prompt Flow

```text
Frontend sendPrompt()
  -> POST /api/agents/tabs/:tabId/prompt
  -> AcpBusManager.sendPromptForTab()
  -> active bus-owned runtime handle
  -> ACP runtime updates
  -> AcpBusStore.saveObservedSession()
  -> /ws/acp-bus event
  -> frontend debounced syncFromBus()
```

### Resume Flow

```text
Frontend /resume selection
  -> POST /api/agents/tabs/resume
  -> AcpBusManager.resumeTabForUi()
  -> ACP session/resume returns initial lightweight bus tab state
  -> AcpBusManager.pinSession() ensures attached
  -> response returns attach ack + lightweight tab metadata
  -> frontend shows restoring placeholder or cached snapshot
  -> bus timeline supplies cached/live transcript pages
  -> bus event triggers frontend sync
```

## Storage Relationships

### Terminal `workspaceState.openAgentTabs`

Stores lightweight open UI agent tab records inside the owning terminal
session workspace snapshot. This answers:

- which agent tabs should reopen with the workspace
- which terminal session they are linked to
- which ACP provider/session each workspace tab represents

There is no standalone `agent-tabs.json` source of truth. Transcript state
belongs to `acp-bus.sqlite`.

### `acp-bus.sqlite`

Stores global ACP session cache and events. This database answers:

- which ACP sessions exist globally
- which sessions were recently active
- which sessions are hot, cached, or require resync
- what snapshot is available for downstream clients
- what events happened recently

### Current Relationship

These stores overlap but are not the same thing:

- terminal `workspaceState.openAgentTabs` is lightweight UI open-tab persistence.
- `acp-bus.sqlite` is global session/cache/event persistence.
- Open agent tabs hydrate transcript state from the bus and send control
  operations through bus-owned runtime handles.

## Event Types

Current or planned event types include:

- `session_index_created`
- `session_index_updated`
- `session_index_removed`
- `session_hot_attached`
- `session_hot_detached`
- `session_ui_attached`
- `session_ui_detached`
- `session_snapshot_updated`
- `session_resync_required`
- `session_runtime_exit`

The event stream is intended for future clients such as native apps,
notification UIs, or adapters.

## Current Testing Coverage

Implemented tests cover:

- store persistence round-trip
- snapshot counts
- preserving cached transcript content during restoring attach
- cache pruning rules
- event pruning
- global indexing and hot selection
- pinned session behavior
- persisted open tabs becoming bus-owned session pins
- create/resume/prompt control through bus-owned runtime handles
- runtime snapshot flush debounce
- runtime exit handling
- manager resume returning restoring immediately
- manager session lookup avoiding full serialization of unrelated tabs
- markdown fence streaming preservation
- duplicate synthetic replay handling

## Known Weak Points

1. Delta event payloads
   - Bus tab endpoints now split metadata and timeline pages.
   - Websocket events still indicate that a session changed rather than sending
     the changed timeline items directly.

2. Resume picker still upstream-based
   - `/resume` suggestions still call `GET /api/agents/sessions`.
   - This can be slow because it depends on upstream provider listing.
   - The bus index is the natural future source for this menu.

3. Bus sync is pull-after-event
   - The websocket currently notifies that something changed.
   - Frontend then fetches metadata and, if it is following latest, the latest
     timeline page.
   - There is no delta payload path yet.

4. `loadSession` replay granularity
   - Restore replay persists authoritative structured timeline rows.
   - Authoritative replay replaces existing timeline rows for that session.
   - Live incremental updates merge by item identity.
   - It is exposed to frontend as cursor pages, not as a full snapshot.

6. Restart gap
   - If Tabminal is down while an upstream ACP session updates, the bus may need
     `loadSession` to repair continuity.
   - This is accepted for now.

## Next Phase Candidates

### Phase 2A: Make Resume Picker Bus-First

- Use `GET /api/acp-bus/sessions` for the initial `/resume` menu.
- Fall back to upstream `GET /api/agents/sessions` only when bus data is empty
  or explicitly refreshed.
- Mark source in UI/debug state: `hot`, `cache`, `cold`, or `upstream`.

### Phase 2B: Harden Ranged Timeline APIs

The first timeline endpoint exists:

```text
GET /api/acp-bus/tabs/:tabId/timeline?limit=&before=&after=
```

Remaining work:

- Add stronger browser smoke coverage for older/newer page transitions.
- Add native-app-facing API examples.
- Decide whether native clients should use cursors only or also rely on
  `minOrder`/`maxOrder` bounds for pagination controls.

### Phase 2C: Add Event Delta Payloads

Instead of websocket event -> full snapshot fetch, support event payloads that
carry enough structured delta information for open tabs to update locally.

Possible model:

- `snapshot_version`
- `timeline_order`
- `changed_items`
- `requires_full_sync`

### Phase 2D: Bus Command Router

Introduce bus-level commands for:

- prompt
- cancel
- permission resolution
- mode switch
- attach/release

This is complete for the current web tab surface. Native apps, Telegram, or a
global chat UI can build on the same bus command path.

### Phase 2E: Global Notifications

Use the bus event stream to surface:

- session updated
- agent requires permission
- agent completed
- agent errored

If a session is already open, route to that tab. If not open, clicking the
notification should resume/attach the session.

## Current Review Questions

1. Should the frontend resume picker become bus-first, given that not every
   provider supports global `session/list(all)` equally?
2. Should bus timeline pages expose absolute indexes, or are opaque cursors
   enough for native clients?
3. Should `resync_required` sessions auto-load when opened, or wait for an
   explicit user action to avoid surprise expensive `loadSession` calls?
4. Should hot-set policy become configurable in UI before global notifications
   ship?
