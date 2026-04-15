# ACP Bus Planning

## Status

Draft for the `acp_bus` branch.

This document defines the first backend-only phase of a global ACP session
control plane for Tabminal. The goal is to build durable indexing,
persistence, hot-session tracking, and downstream-friendly event emission
without changing the current frontend UX yet.

## Goals

1. Track globally discoverable ACP sessions across all supported agents.
2. Maintain a small hot set of recently active sessions as continuously
   attached backend observers.
3. Persist recent session state locally so downstream clients can attach to
   Tabminal later instead of going directly to upstream ACP providers.
4. Keep the implementation ACP-centric and provider-agnostic.
5. Avoid unlimited growth in local storage.

## Non-Goals For Phase 1

1. No frontend UX changes.
2. No Telegram adapter yet.
3. No unified multi-session chat UI yet.
4. No attempt to guarantee strong consistency across a Tabminal process
   restart window.
5. No direct coupling to upstream provider filesystem/database internals.

## ACP Constraints

The ACP SDK surface available to Tabminal provides:

- `session/list`: global discovery metadata, including `updatedAt`.
- `session/load`: authoritative restore with full replay of conversation
  history.
- `session/update`: live incremental updates for an attached session.
- `unstable_resumeSession`: fast context resume without replaying history.

Important consequence:

- `loadSession` is expensive and should only be used to establish an
  authoritative baseline or repair continuity gaps.
- `unstable_resumeSession` cannot fill a history gap by itself.
- Continuous correctness comes from keeping a backend observer attached,
  not from repeatedly detaching and resuming.

## Phase 1 Strategy

Tabminal will implement a backend ACP bus with three layers:

1. `SessionIndex`
   - Polls ACP providers using `listSessions`.
   - Maintains a global registry of discoverable sessions.
   - Detects created, updated, and removed sessions.

2. `HotSessionHandle`
   - Continuously attaches to a limited hot set of sessions.
   - Uses `loadSession` when a handle is first materialized.
   - After materialization, remains attached and consumes live
     `sessionUpdate` events.

3. `SessionStore`
   - SQLite-backed local persistence for session metadata and cached
     snapshots.
   - Keeps recent hot and cold sessions bounded by a configurable limit.

The current frontend will continue to use the existing ACP tab system.
The bus exists in parallel for backend indexing and future downstream
consumers.

## Core Model

Each global ACP session is identified by:

- `agentId`
- `sessionId`

Working directory is metadata, not part of the primary identity.

### Session States

- `cold`
  - Present in index only.
  - No local materialized transcript is guaranteed.

- `cached`
  - Stored in SQLite with a materialized snapshot.
  - Not currently observed.

- `live`
  - Backend observer is attached and receiving incremental updates.

- `resync_required`
  - Local snapshot exists, but continuity cannot be trusted anymore.
  - A future authoritative `loadSession` is required before claiming
    complete history.

## Continuity Rules

1. A session becomes authoritative when `loadSession` completes.
2. A session remains trustworthy while its hot observer stays attached.
3. If the observer is detached, evicted, or the bus process restarts, the
   session transitions to `resync_required`.
4. `unstable_resumeSession` is not used in Phase 1 as a gap-repair tool.
5. A process restart race is accepted as a best-effort boundary.

## Hot Set Policy

The bus maintains a global hot set across all agents.

Default policy:

- `hotSessionLimit = 10`
- `cacheSessionLimit = 100`
- `pollIntervalMs = 10000`

Selection is global, not per provider.

Hotness is based on a single sortable `lastActivityAt` value derived from:

1. ACP `updatedAt` from `listSessions`
2. locally observed live updates
3. explicit user/session interest events emitted by Tabminal server flows

Examples:

- 10 Codex sessions can occupy the whole hot set.
- 5 Codex + 5 Gemini sessions is also valid.

## Persistence Model

Phase 1 uses SQLite with one primary table for session metadata and cached
snapshots, plus a compact event log.

### `acp_bus_sessions`

Columns:

- `session_key` primary key (`agentId + '\0' + sessionId`)
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
- `continuity_state`
- `hot_rank`
- `status`
- `busy`
- `error_message`
- `message_count`
- `tool_call_count`
- `snapshot_json`

### `acp_bus_events`

Append-only, bounded event log for future adapters.

Columns:

- `id` integer primary key
- `created_at`
- `type`
- `agent_id`
- `session_id`
- `payload_json`

## Snapshot Format

The store persists a normalized serialized ACP session snapshot.

Snapshot source in Phase 1:

- `AcpRuntime.serializeTab(tab)`

This keeps the transcript, tool calls, plan, usage, and related metadata in
one consistent JSON structure without frontend dependency.

## Runtime Model

The bus uses separate ACP runtime connections from the existing UI-facing
`AcpManager`.

Rationale:

- No frontend UX changes in Phase 1.
- No coupling between UI tabs and backend session observers yet.
- The bus can attach and detach hot sessions independently.

Runtime classes and helpers should be shared where practical with the ACP
manager to avoid provider-specific drift.

## Polling And Reconciliation

### Discovery Poll

For each available ACP provider:

1. List discoverable sessions.
2. Upsert session metadata into SQLite.
3. Emit index-level created/updated/removed events.
4. Recompute desired hot set.

### Hot Rebalance

1. Select top `hotSessionLimit` sessions by `lastActivityAt`.
2. Attach observers for missing hot sessions.
3. Detach observers for sessions no longer in the hot set.
4. Mark detached sessions as `resync_required`.

### Snapshot Persistence

Whenever a hot observer changes:

1. Serialize the observed session.
2. Persist the snapshot into SQLite.
3. Update `last_live_at`, `last_activity_at`, and counts.
4. Emit a downstream-friendly session event.

## Downstream Contract

Phase 1 exposes backend-only events and store access intended for future
consumers.

Planned event types:

- `session_index_created`
- `session_index_updated`
- `session_index_removed`
- `session_hot_attached`
- `session_hot_detached`
- `session_snapshot_updated`
- `session_resync_required`
- `session_runtime_exit`

These events should be emitted through the bus manager and also written into
SQLite as a short bounded history.

## Integration With Existing Server Paths

Without changing frontend UX, the server should still inform the bus when
user intent is obvious.

Examples:

- creating a new ACP tab
- resuming a session in the current ACP tab
- sending a prompt to an ACP tab

These actions should bump `lastActivityAt` in the bus so actively used
sessions stay hot.

## Storage Bounds

To prevent uncontrolled growth:

1. Keep only the most recent `cacheSessionLimit` sessions.
2. Never evict a currently hot session.
3. Evict cold cached sessions by oldest `lastActivityAt`.
4. Truncate the event log to a configurable rolling window.

## Phase 1 Deliverables

1. `src/acp-bus-store.mjs`
   - SQLite schema and persistence helpers.

2. `src/acp-bus-manager.mjs`
   - session index polling
   - hot set selection
   - observer lifecycle
   - event emission

3. startup wiring in `src/server.mjs`
   - restore hot sessions
   - start polling automatically
   - dispose cleanly on shutdown

4. shared ACP runtime support where needed
   - enough for bus observers to attach/detach safely

5. tests
   - persistence round-trip
   - startup restore
   - hot rebalance
   - event emission
   - bounded eviction

## Deferred Items

1. unified downstream websocket/event API
2. frontend bus-backed session browser
3. Telegram adapter
4. unified multi-session chat control plane
5. optional use of `unstable_resumeSession` for low-cost re-attach when
   continuity is still trusted
6. cross-process strong consistency guarantees

## Acceptance Criteria For Phase 1

1. Tabminal starts the ACP bus automatically.
2. The bus restores persisted hot sessions on boot.
3. The bus indexes discoverable sessions across currently supported ACP
   providers.
4. The bus persists recent session snapshots in bounded SQLite storage.
5. Hot sessions remain attached and receive live updates while the process is
   running.
6. The bus emits structured backend events for downstream consumers.
7. No frontend UX changes are required for the system to function.
