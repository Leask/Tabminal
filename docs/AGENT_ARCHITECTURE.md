# Agent Architecture Evolution

## Scope

Tabminal owns the authenticated multi-host web product, terminal integration,
workspace tabs, local history, and pagination. Reuse independently published
Lody ACP adapters and extension contracts. Port narrowly scoped runtime and
message-processing ideas where Lody has not published a standalone library.
Do not embed the Lody application, cloud services, or collaborative storage.

The bus remains the local authority for history and downstream events. Its
runtime dependencies must become small agent modules with explicit ownership.
Browser tabs subscribe to sessions; they do not own upstream processes.

## Boundaries

1. Provider definitions launch pinned adapters. Capability negotiation, rather
   than an agent name or an assumed upstream version, enables extensions.
2. Runtime supervision bounds concurrent starts and startup duration, owns the
   entire child process group, and prevents starts after disposal.
3. Session control admits one prompt before asynchronous preparation. Cancel
   requests cancellation but does not release execution ownership. Unknown
   delivery is never retried automatically.
4. Message ingress uses source identity when supplied. ACP text chunks are
   deltas; explicit whole-message updates replace content. Never infer overlap
   or insert whitespace. First observation determines local timeline order.
5. History loading and live control have distinct ownership. An authoritative
   replay may replace history only after completion, never from a partial
   restoring snapshot or while another turn is modifying the same session.
6. The store assigns the public contiguous index. Frontends consume structured
   messages and state; they do not implement provider-specific text recovery.
7. Extension events are validated using acp-extension-core. Unsupported
   versions degrade to ordinary ACP without enabling unknown controls.

## Community Reuse

Research baseline: LodyAI/Lody commit
`9ea276890e9d2e115f8495da36c30fad6ca30a7e` and its ACP repositories.
Published adapters may lag that source. Record installed versions and test the
actual wire protocol instead of claiming capabilities from unreleased source.
Copied or adapted source must retain its license and provenance. Independently
implemented architectural ideas are identified as such in the source notes.

Installed, lockfile-pinned dependencies:

| Module | Version | Responsibility |
| --- | --- | --- |
| `@agentclientprotocol/sdk` | 1.5.1 | Standard ACP transport and types |
| `acp-extension-core` | 0.1.9 | Extension methods, validation, negotiation |
| `acp-extension-codex` | 1.1.2 | Codex app-server to ACP adapter |
| `acp-extension-claude` | 0.54.3 | Claude to ACP adapter |

Codex and Claude launch installed entrypoints with the current Node executable;
runtime startup does not download an unpinned `@latest` adapter. Gemini and
Copilot retain their existing provider integrations. Their real-provider paths
have not been revalidated in this iteration.

References inspected:

- [Lody](https://github.com/LodyAI/Lody):
  `apps/cli/src/lib/agent-execution-slots.ts`,
  `apps/cli/src/session/session-execution-service.ts`,
  `apps/cli/src/agent/acp-startup-monitor.ts`, and `packages/cli-supervisor`.
- [ACP Core](https://github.com/LodyAI/acp-extension-core): negotiated extension
  contracts and validators, used directly as a dependency.
- [Codex adapter](https://github.com/LodyAI/acp-extension-codex) and
  [Claude adapter](https://github.com/LodyAI/acp-extension-claude).

The supervisor package depends on Lody workspace packages and is not a
standalone drop-in Node dependency here. Admission and execution ownership are
independent implementations of the architectural ideas, not copied Lody source.
No Lody application, Loro store, cloud account, or frontend framework is added.

The published adapters lag the inspected repositories. In particular, the
installed Codex adapter does not advertise the current Core subagent extension;
Claude's older session-less notifications are not guessed into a session. Core
integration is validated using negotiated fixture events, not presented as a
feature already available from these installed real adapters.

As checked on 2026-10-05, installed `acp-extension-codex@1.1.2` also does not
advertise read-only session history. The newer Codex repository implements it,
but this branch does not substitute unpinned repository code for a release.
Background Codex history therefore remains disabled until a tested adapter
advertises version 1. This is intentional metadata-only degradation, not a
fallback to automatic attachment. Gemini/Copilot and other providers must
advertise that same contract before background history is enabled.

## Module Map

- `src/agents/providers.mjs`: installed adapter resolution.
- `src/agents/admission.mjs`: global startup admission and per-session turn lease.
- `src/agents/message-stream.mjs`: native/synthetic source identity.
- `src/agents/history.mjs`: read-only replay projection into SQLite staging.
- `public/modules/agent-messages.js`: shared exact delta and snapshot semantics.
- `src/agents/extensions.mjs`: capability-gated Core projections.
- `src/acp-manager.mjs`: ACP transport and terminal/file/permission client.
- `src/acp-bus-manager.mjs`: controller ownership, persistence and event delivery.
- `src/acp-bus-store.mjs`: structured history and public timeline indexes.

This is an incremental replacement of risky runtime behavior. It does not yet
remove the large legacy runtime/definition facade or all older testing helpers.

## Lifecycle And Data Rules

- At most two adapters initialize concurrently. Queue wait is abortable; the
  30-second startup deadline starts when an admission slot is obtained.
- Disposal aborts queued startup before terminating the owned process group.
  Delayed initialization cannot register itself again after disposal.
- Prompt ownership begins before asynchronous attachment preparation. A second
  prompt is rejected while preparation, execution, or cancellation is active.
- Cancel during preparation sends no upstream prompt. Cancel after dispatch
  keeps ownership until the prompt settles. Uncertain delivery is never replayed.
- Session creation, resume and list RPCs have 30-second deadlines; full history
  loading has a 120-second deadline. A timed-out transport is disposed rather
  than left available for more commands. The timeout is not a history-size cap.
- Controllers are demand-owned, not a metadata-ranked hot pool. Restoring stored
  workspace identities never auto-attaches an upstream session. A websocket
  `clientId` owns each web subscription; disconnect releases its references.
  Hidden but subscribed tabs and unfinished work remain alive. The last idle
  reference releases the controller and its otherwise unused process group.
- History sync is separate from control and uses only negotiated Lody read-only
  history version 1. Unsupported adapters have metadata discovery only; never
  fall back to a hidden load/resume/attach. Active controllers are excluded.
- Read-only history uses bounded byte-stream backpressure and per-item SQLite
  staging rather than an in-memory transcript. The 16 MiB per-item safety limit
  rejects an import without damaging the previous cache. A failed/expired reader
  is disposed. Successful imports commit atomically with a snapshot-version
  guard and issue `requiresFullSync`; racing live attachment wins.
- Snapshot writes are serialized per session. Continuous chunks trigger bounded
  cadence flushing instead of indefinitely restarting a debounce timer.
- Bus disposal stops new work, terminates transports, waits for outstanding
  operations, then drains persistence before closing SQLite.
- A native message id identifies updates. Distinct ids with equal text remain
  distinct messages. Missing ids use local stream/turn identity; without upstream
  identity, replay equivalence across reconnects cannot be guaranteed.
- Subagent runs are separate tool identities with their own completion status.
  Parent completion does not mark children complete. Child text projection keeps
  the last 16,384 UTF-16 code units. This bound does not cover all ordinary ACP
  message payloads.
- Usage updates replace snapshots. They are not a durable billing ledger and do
  not invent missing costs or double-count usage delta plus model totals.
- Permission replies require a pending request and an advertised option. A
  consumed request produces `permission_stale`, not a second approval.
- Permanent unsupported/missing-session attachment errors do not retry every
  heartbeat. Transient failures retry no faster than once per five seconds;
  reconnect or session identity change clears the failure fence.

## Execution Checklist

- [x] Pin published Core, ACP SDK, Codex and Claude adapters.
- [x] Extract runtime admission and source-message semantics into small modules.
- [x] Integrate capability-gated subagent and usage event projections.
- [x] Fence prompt preparation, cancellation, runtime disposal and history repair.
- [x] Verify bus event/store ordering and bounded downstream reads.
- [x] Add protocol, lifecycle and opt-in real-adapter integration regressions.
- [x] Run lint, unit tests, build and isolated Codex/browser flows.
- [ ] Complete real Claude conversation validation after account credit is available.

## Validation Isolation

Use temporary data/config/database directories and an unused loopback port.
Real Codex validation creates new sessions in a temporary workspace and resumes
only the session ids created by that test. Never run the production hot-session
scanner for this validation, mutate existing Codex sessions, or restart the
user's production Tabminal service. Runtime cleanup targets only owned children.

`TABMINAL_AGENT_IDS=codex,test-agent` limits built-in provider definitions.
`TABMINAL_ACP_DISCOVERY=0` disables upstream discovery and maintenance scanning;
explicitly opened sessions can still attach. These are test isolation controls,
not recommended production defaults. Use a separate `HOME` for a test server;
share `CODEX_HOME` only for the authorized real-provider login.

```sh
npm run lint
npm test
npm run build
TABMINAL_SMOKE_MODEL=gpt-5.6-sol node scripts/agent-provider-smoke.mjs codex
node scripts/agent-provider-smoke.mjs claude
```

The real-provider smoke creates a temporary workspace/database, creates a new
session, prompts, checks stored indexes, resumes, restarts the bus, and prompts
again to verify upstream context. It deletes its local test database/workspace
and disposes owned runtimes; the newly created session remains in provider
history. Do not run it against a production bus database.
The model override must be one supported by the test account. It is applied to
the new test session and reapplied after resume, not to the user's global config.

## Acceptance

New/resume/prompt/cancel/permission/reconnect work through the bus. Repeated and
overlapping text chunks are preserved byte-for-byte. Message identity survives
interleaved tool updates. Failed startup releases admission, disposal cannot
leave a delayed start behind, and history repair never publishes partial data.
Test reports distinguish synthetic coverage from real provider validation.

## Remaining Evolution

1. Upgrade to reproducible published adapters exposing current Core capabilities.
   Add real-provider extension contract tests before enabling their controls.
2. Extend the existing command contract for supported steering, goal/fork and
   child-session controls, and elicitation. Do not expose buttons solely because
   the Core package defines a method.
3. Separate persistent user session preferences from upstream capability/default
   snapshots. The isolated Codex browser test observed model choice reverting
   after resume; silently replaying permission-mode changes is not acceptable.
4. The new read-only history path is staged, but user-requested ACP load replay,
   active-runtime transcript assembly, and provider-internal history reads can
   still consume large memory. Bound those separately; process-group cleanup
   cannot guarantee cleanup after abrupt OS termination.
5. Further split the runtime facade, then add global notifications/native
   consumers on the same bus rather than a second session-management layer.

See `docs/AGENT_VALIDATION.md` for measured results and remaining release gates.
