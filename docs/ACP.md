# ACP

Last updated: 2026-03-27

This file is no longer a pure implementation plan.
It is now the ACP status ledger for Tabminal:

- what shipped
- what is stable
- what remains open

Use `/Users/leask/Documents/Tabminal/AGENTS.md` as the broader engineering
handoff document. Use this file as the ACP-specific roadmap/status snapshot.

## 1) Goal

Integrate ACP-based coding agents into Tabminal without building custom agents
in-repo. Agents should run on the Tabminal host, be managed by the Tabminal
backend, and feel native inside the existing workspace/editor UI.

## 2) Current Architecture

### Backend

Implemented:

- ACP supervisor in `/Users/leask/Documents/Tabminal/src/acp-manager.mjs`
- Built-in host-local agent definitions:
  - Gemini CLI
  - Codex CLI
  - Claude Agent
  - GitHub Copilot
  - ACP Test Agent when `TABMINAL_ENABLE_TEST_AGENT=1`
- Lazy runtime startup
- Runtime reuse while tabs are active
- Idle cleanup
- ACP websocket fan-out to browser clients
- Session restore for ACP runtimes that support `loadSession`
- Per-agent saved config/env persistence

### Frontend

Implemented:

- Host-scoped agent dropdown from the sidebar
- Agent tabs inside the shared workspace tab strip
- Transcript rendering with message/tool/permission/plan history
- Composer with send/stop, slash-command suggestions, attachments, and keyboard
  shortcuts
- Mode/model/thought-level/permission selectors
- Managed terminal summaries and `Jump in`
- Usage HUD
- Plan panel that archives into transcript history once complete
- Agent-specific workspace restore and focus behavior

## 3) Completed Scope

The following items are effectively shipped and usable.

### 3.1 Core ACP plumbing

- ACP dependency integrated
- Backend ACP supervisor live
- REST endpoints live:
  - `GET /api/agents`
  - `GET /api/agents/config`
  - `PUT /api/agents/config/:agentId`
  - `DELETE /api/agents/config/:agentId`
  - `POST /api/agents/tabs`
  - `POST /api/agents/tabs/:tabId/prompt`
  - `POST /api/agents/tabs/:tabId/cancel`
  - `POST /api/agents/tabs/:tabId/mode`
  - `POST /api/agents/tabs/:tabId/config`
  - `POST /api/agents/tabs/:tabId/permissions/:permissionId`
  - `DELETE /api/agents/tabs/:tabId`
- ACP websocket endpoint live

### 3.2 Agent tab UX

- Agent tabs coexist with file tabs and pinned terminal tabs
- Duplicate agent tabs auto-number
- `Enter` sends
- `Shift+Enter` and `Ctrl+J` insert newline
- `Esc` stops active runs
- `Ctrl+Shift+A` opens the agent menu
- Slash-command menu opens upward as floating overlay
- Keyboard navigation inside slash-command menu is implemented

### 3.3 Transcript and tool rendering

- Coalesced assistant message streaming
- Optimistic user message insertion
- De-duplication when runtime echoes user chunks
- Structured tool-call cards
- Structured permission cards
- Diff rendering
- Code/resource rendering
- Terminal output rendering inside tool cards
- Path link rendering
- Running-terminal activity summary

### 3.4 Managed terminal flow

- ACP tool calls can create managed terminal sessions
- `Jump in` switches to the real terminal session when still alive
- Focus-stealing bug after `Jump in` has been fixed
- Hidden pinned terminals no longer report bogus tiny sizes to the backend

### 3.5 Persistence and restore

- Agent tab metadata persists on backend
- Agent config persists on backend
- Transcript/tool/permission/plan state persists
- Restore works across backend restart for runtimes that support `loadSession`
- Restore no longer wrongly penalizes built-in agent availability on startup

### 3.6 Usage / status UI

- Usage HUD implemented
- CSS-only expanded HUD layout stabilized
- Plan panel implemented
- Completed plan moves into transcript history instead of permanently occupying
  composer-adjacent UI
- Transcript auto-scroll logic now follows the correct “only pin if already at
  bottom” rule

### 3.7 Test tooling

- ACP Test Agent supports real slash-command scenarios:
  - `/demo`
  - `/plan`
  - `/diff`
  - `/permission`
  - `/cancel`
  - `/stale`
  - `/order`
  - `/fail`
- ACP browser smoke covers current UI shape
- ACP manager tests cover restore, prompt attachments, config, availability, and
  slash commands

## 4) Stable Contracts

These should now be treated as product contracts, not experiments.

- ACP agents are host-scoped.
- Agent tabs do not require the file tree to be open.
- Workspace tabs should remain visible if there is any file tab, agent tab, or
  pinned terminal tab.
- `Jump in` is a management path, not a read-only preview, while the terminal is
  still alive.
- Internal shell bootstrap commands such as `TABMINAL_SHELL_READY=1` must never
  surface as user notifications.
- ACP availability should reflect the backend runtime environment, not only the
  developer's interactive shell.
- On small screens, agent config selectors collapse to icon-only affordances.

## 5) Remaining Work

This is the actual remaining ACP backlog.

### 5.1 Still open

#### A) Registry-driven install/setup UX

Status: not done

Missing:

- guided install flow for agents that are unavailable
- first-class setup UX for installing required CLIs
- richer host diagnostics for why a definition is unavailable

Current state:

- availability reasons are shown
- some config/setup flows exist
- but this is not yet a complete install-onboarding UX

#### B) Explicit TCP ACP runtime support in the UI

Status: not done

Missing:

- user-visible workflow for attaching to TCP ACP servers
- transport selection UX
- connection lifecycle UX for non-stdio ACP runtimes

Current state:

- architecture originally allowed for this direction
- product currently operates around stdio-launched/local CLI definitions

#### C) Dedicated conversation history browser

Status: not done

Missing:

- independent history browser for ACP conversations
- browsing/searching old conversations outside the current terminal/workspace
  session context

Current state:

- transcript restores with the tab
- completed plans archive into the transcript
- but there is no standalone conversation history surface

### 5.2 Nice-to-have follow-up work

These are not blockers, but they are logical next ACP improvements.

- stronger browser smoke coverage for touch/mobile-only ACP interactions
- clearer visual distinction between running, attention, and completed agent
  states at scale
- broader multi-host ACP smoke scenarios
- richer availability/setup diagnostics in the UI

## 6) What Was Originally Deferred But Is Now Done

These items were previously listed as deferred and should no longer be treated
as open backlog:

- prompt/file attachments
- diff rendering in tool outputs
- code/resource rendering in tool outputs
- terminal execution transcript UI for ACP tool calls

## 7) Test and Verification Status

Current ACP verification surface:

- `npm run lint`
- `npm test`
- `npm run build`
- browser smoke via
  `/Users/leask/Documents/Tabminal/scripts/acp-browser-smoke.mjs`

Recommended ACP manual spot-checks when behavior changes:

1. Start with `TABMINAL_ENABLE_TEST_AGENT=1`
2. Run `/demo`
3. Verify:
   - agent menu
   - slash-command menu
   - plan panel
   - usage HUD
   - tool call cards
   - managed terminal
   - `Jump in`
   - transcript scroll behavior
4. Run `/permission`
5. Run `/cancel`
6. Reload and verify restore

## 8) Recommendation

ACP is no longer in “MVP not landed” status.
It is in “shipped, actively polished, with a short remaining backlog” status.

Practical summary:

- Core ACP product: done
- ACP UI polish: largely done
- ACP infra/test surface: done
- Remaining strategic work: 3 real items

That remaining scope is small enough that this file should stay as a status
ledger, not a large speculative design doc.
