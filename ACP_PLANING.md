# ACP Planing

## Goal

Integrate ACP-based coding agents into Tabminal without implementing agents
ourselves. Agents run on the Tabminal host, managed by the Tabminal backend.
The web UI adds an Agent panel integrated into the existing workspace/editor
area and supports multiple concurrent agent tabs per host.

## Constraints

- Do not break existing terminal, file editor, multi-host, or AI-assist flows.
- Reuse community-maintained protocol and agent ecosystem pieces where
  practical.
- Keep lifecycle bounded: lazy start, reusable while tabs are open, and
  cleaned up after inactivity.
- Host isolation remains strict: each agent runtime and tab belongs to one
  host.
- MVP should be usable before advanced ACP capabilities are added.

## Selected Architecture

### Backend

Add an ACP supervisor inside the Tabminal backend.

Responsibilities:
- List supported agent definitions available on the host.
- Start ACP runtimes on demand.
- Reuse ACP runtime processes while tabs/sessions are active.
- Create ACP sessions within a runtime.
- Bridge ACP events to browser clients over a dedicated WebSocket.
- Expose minimal approval surfaces later; MVP focuses on prompt/stream/cancel.

Transport strategy:
- Primary: stdio-launched ACP agents.
- Future: attach to TCP ACP servers for tools like GitHub Copilot CLI.

Lifecycle:
- Lazy runtime start on first use.
- Keep alive while any agent tab is attached.
- Idle timeout after last tab closes.
- Destroy all runtimes on backend shutdown.

### Frontend

Add a host-scoped Agent button beside the file editor toggle area.

Behavior:
- Clicking Agent opens a dropdown of available agents for the active host.
- Choosing an agent opens a new Agent tab inside the existing editor pane tab
  strip.
- Agent tabs coexist with file tabs.
- Each agent tab streams conversation updates and supports prompt send/cancel.

MVP UI:
- Agent tabs render in the editor workspace.
- Transcript area with message stream.
- Prompt textarea + send button + cancel button.
- Status row with host, agent label, and runtime/session status.

## Reuse Strategy

Use:
- `@agentclientprotocol/sdk` for protocol/client implementation.
- ACP Registry later for agent metadata discovery.

Do not directly embed:
- Chrome ACP web client.
- ACP UI desktop frontend.

Reason:
- They are standalone apps, not embeddable widgets.
- Tabminal needs native integration with existing host/session/workspace state.

## MVP Scope

### Phase 1

Status:
- Implemented on `acp` branch and usable with real browser smoke.
- Backend ACP supervisor, API, and WS fan-out are live.
- Frontend agent tabs, transcript rendering, prompt send/cancel, and
  permission resolution are live.
- Verified with:
  - `npm run lint`
  - `npm test`
  - browser smoke against isolated local ACP test agent
- Current polish fixes already applied:
  - Codex token stream is coalesced into a single assistant message instead of
    one message per chunk.
  - Gemini definition availability is disabled with reason
    `API key missing` when no key is configured.
  - Agent panel typography has been reduced to align with the existing
    workspace/editor density.

Backend:
- ACP supervisor module.
- Built-in agent definitions for Gemini CLI, Codex CLI adapter, Claude adapter,
  and Copilot CLI ACP server descriptor.
- REST endpoints:
  - `GET /api/agents`
  - `POST /api/agents/runtimes`
  - `POST /api/agents/runtimes/:runtimeId/sessions`
  - `POST /api/agents/sessions/:sessionId/prompt`
  - `POST /api/agents/sessions/:sessionId/cancel`
  - `DELETE /api/agents/tabs/:tabId`
- WebSocket endpoint for live event fan-out.

Frontend:
- Agent dropdown button.
- Agent tab state model.
- Agent transcript rendering.
- Prompt send/cancel.
- Host-scoped tabs in editor pane.

### Deferred

- File attachments.
- Full ACP permission approval UI.
- Terminal/tool call visualization.
- Registry-driven install UX.
- Session persistence across backend restart.
- TCP ACP runtime support in UI.

## Safety and Isolation

- Agent runtimes inherit the host filesystem context, not browser-local state.
- Prompt and transcript data stay isolated per host.
- Closing an agent tab detaches from its ACP session.
- When the last ACP session on a runtime closes, runtime enters idle cleanup.

## Test Plan

Backend:
- Unit tests for supervisor lifecycle.
- Mock ACP runtime process to test stream/cancel behavior.
- API tests for create/send/cancel/close.

Frontend:
- State/unit tests are minimal in current stack; use integration smoke.
- Manual flow:
  - open agent dropdown
  - create Gemini/Codex tab
  - send prompt
  - receive stream
  - cancel
  - open second agent tab
  - verify file editor tabs still work
  - verify terminal tabs still work

Regression checks:
- `npm run lint`
- `npm test`
- existing multi-host session behavior
- editor pane switching between file tabs and agent tabs

## Implementation Order

1. Add ACP dependency and inspect exact SDK client API.
2. Implement backend supervisor with a mockable adapter layer.
3. Expose API/WS endpoints with no frontend integration yet.
4. Add frontend Agent button and agent tab model.
5. Wire prompt streaming and cancellation.
6. Run tests and manual smoke.
7. Iterate on lifecycle and UI fit.
