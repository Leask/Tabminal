# Agent Infrastructure Validation

## 2026-10-05: Demand-Owned Controllers

This update supersedes the older automatic-hot-attach lifecycle described in
the 2026-10-02 baseline below. Production services and existing provider
sessions were not restarted or prompted.

Implemented boundaries:

- Startup restores workspace identities and metadata, not controllers.
- Websocket-owned workspace references share controllers. The last reference
  releases a controller only after prompt preparation/execution, permissions,
  tools, and managed terminal work have settled.
- Read-only history uses the negotiated Lody version-1 contract. No hidden
  `loadSession`/resume/attach fallback exists. SQLite staging, first-observed
  indexes, an atomic version-guarded swap, and input backpressure protect the
  previously committed history during failure or concurrent attachment.
- Browser reconnection exposed and fixed a stale controller-id lookup. Commands
  now resolve the stable workspace `agentId + sessionId`, not the old runtime id.

Verification:

- Lint, build, and `git diff --check` passed.
- The focused agent/runtime/store/protocol run passed 131 tests and exited
  cleanly in approximately 24 seconds. The bus/history/store subset has 51 tests.
- The full suite reported 188 passing assertions. Repeats retained a bash PTY
  from the existing `integration-shell.mjs` teardown; that exact test-owned PID
  required SIGKILL after SIGTERM failed. These repeats are **not** clean
  unattended full-suite passes. No unrelated terminal implementation was changed.
- A fresh HOME initially exposed 26 legacy AcpManager tests that depend on the
  local Codex login probe. Repeating with an explicit existing `CODEX_HOME`
  restored the 188 passing assertions; the pure bus/store tests need no login.
- A real ACP stdio fixture streamed 3,000 1-KiB messages into history without
  creating a session. One run imported in 867 ms, with 1.49 ms mean for 20
  latest-page reads, 166 event-loop timer ticks during import, and about 34 MiB
  observed heap growth. This is a small synthetic sample, not an OOM guarantee.
- Failure/cancellation visibility, file-write denial for readers, old-cache
  preservation, contiguous paging indexes, plan archival, concurrent attach,
  multi-browser ownership, post-close work, and reconnect commands are covered.

Real Codex smoke created only session
`01a10a3d-512f-7a30-bcc9-4ea96c30d3d7` in its temporary workspace. New session:
1526 ms; prompt acknowledgement: 2 ms; reply/persistence: 3781 ms; already-owned
resume: 2 ms; bus restart without auto-attach: 90 ms; explicit cold resume:
1147 ms; follow-up context recall: 3533 ms; maximum of 20 timeline reads:
0.68 ms. The assistant, not the user echo, had to return the exact test marker.

MCP browser validation used isolated loopback port 19867 and a temporary HOME:
login, new test agent, demo/tool/terminal/plan rendering, permission cancellation,
new real Codex, disconnect, service restart, reattach, model command, and another
prompt recalling the previous marker all worked. Its new Codex session is
`01a10a3f-507e-7622-8249-1d1d96e0aaec`. Leaving the page produced zero observed
sessions, zero references and zero controller runtimes while retaining two
workspace tab records; service restart also kept these counts at zero until the
browser explicitly reattached. Ten local resume-picker reads were 1-6 ms each.
Screenshot: `/tmp/tabminal-history-ui-verified.png`.

Remaining boundaries:

- Published Codex 1.1.2 lacks read-only history advertisement. For that installed
  adapter the background worker updates metadata only. Protocol history success
  was tested with a real stdio fixture, not misrepresented as real Codex support.
- Manual ACP load replay, provider-internal history reads, large active
  transcripts and multi-GB databases still need separate memory optimization.
- The adapter still resets the selected model on resume. Tests explicitly
  select `gpt-5.6-sol`; persistent model preferences are not claimed fixed.
- Existing xterm font user-activation warnings and the in-app browser's native
  `prompt()` limitation remain outside this refactor. Console-wide silence and
  all-provider end-to-end certification are not claimed.

Cleanup verified that the isolated service and recorded descendants exited,
port 19867 stopped listening, and the three temporary test HOME directories
were removed. Test screenshots/logs remain in `/tmp`; the two newly created
Codex sessions remain in provider history. No commit, push, production
deployment, or production cleanup was performed.

## 2026-10-02 Baseline

Date: 2026-10-02. Branch: `acp_bus`. Node: 26.10.0, macOS arm64.

This report covers the first Lody-module integration and runtime hardening,
not all Lody features or production release certification.

## Automated Gates

- `npm run lint`: passed.
- `npm test`: 181 tests, 10 suites, zero failures.
- `npm run build`: passed.
- `git diff --check`: passed.
- The bus-manager suite also passed three consecutive repeat runs.

Earlier full-suite runs exited normally in about 24 seconds. The final repeat
passed all 181 assertions but retained one PTY from `integration-shell.mjs`,
keeping the runner alive until that owned test shell was killed. This repeat is
not counted as a clean unattended process-exit pass; see release gate 9 below.

Coverage includes startup concurrency and abort, hung initialization cleanup,
prompt admission before asynchronous preparation, cancellation before dispatch,
stale/forged permission replies, exact delta concatenation, native message
identity, stable tool order, child completion after parent completion,
unsupported extension versions, usage snapshot replacement, timeline index and
cursor behavior, replay completion fencing, writes during a continuous stream,
and runtime exit while a snapshot write is still in flight.

## Real Codex

Command:

```sh
TABMINAL_SMOKE_MODEL=gpt-5.6-sol node scripts/agent-provider-smoke.mjs codex
```

The successful run created only a new session:
`01a0fd91-f57e-7c11-a946-4eca83b20047`.
Global upstream discovery was disabled. The test used a disposable workspace
and database, and resumed only the session it created.

| Step | Observed duration |
| --- | ---: |
| New session | 1133 ms |
| Prompt acknowledgement | 2 ms |
| Actual assistant reply plus persistence | 4283 ms |
| Resume already owned session | 2 ms |
| Dispose and restart bus, including cached hot attach | 1498 ms |
| Resume after bus restart | 2 ms |
| Follow-up prompt acknowledgement | 2 ms |
| Follow-up reply recalling the previous marker | 4034 ms |
| Maximum of 20 local timeline reads | 0.45 ms |

These are one-run observations of a small transcript, not percentiles or a
large-history benchmark. Restart includes automatic attachment, so the later
2 ms resume is not a standalone cold-runtime initialization measurement.

The assertion requires the assistant message itself to contain the exact
marker. A user-message match or an unrelated assistant warning cannot pass.
The follow-up does not repeat the marker, testing upstream context retention
rather than just local cached history. Earlier weaker smoke results are
superseded by this run.

## Browser Verification

Used the MCP-controlled in-app browser against an isolated service on loopback
port 19867 with a separate HOME. The user's normal service was not restarted.

- Password login and app bootstrap.
- Create a new real Codex session; select a supported model; send a no-tool
  request; observe `TABMINAL_BROWSER_LODY_OK` from the assistant.
- Restart the isolated backend and reload; real Codex transcript restores.
- ACP fixture permission approval and completed permission/tool UI.
- Long-running fixture cancellation: stops before 250 chunks and releases the
  composer. The earlier short fixture completed before clicking Stop and was
  not counted as a cancellation test.
- New Chat creates a separate session.
- Negotiated Core subagent events render one tool card, preserve child output,
  and complete independently of the parent reply.
- Timeline fixture loads 30 blocks; scrolling upward loads older blocks and
  scrolling downward loads newer blocks without jumping to the end. The observed
  newer page had scrollTop 809.5 of a 1532-pixel scroll range, not a bottom pin.
- Completed plans remain historical transcript content.
- Unsupported restore errors are no longer retried every heartbeat.
- Cached transcript remains readable when a provider cannot restore its
  controller; the connection error is retained rather than hidden by metadata.
- The isolated Codex resume-picker HTTP request returned in 2 ms. The current
  open session is excluded from selectable candidates; global discovery stayed
  disabled throughout the test.

Local proof images: `/tmp/tabminal-lody-codex-restored.jpg` and
`/tmp/tabminal-lody-subagent.jpg`.

## Limitations And Release Gates

1. Real Claude session creation succeeded, but the prompt failed with
   `Credit balance is too low`. Full Claude validation remains blocked by the
   provider account. No account settings or payment changes were made.
2. The isolated Codex environment's default model `gpt-6.1-sol` was rejected by
   the provider. An explicitly selected supported model worked. Resume can reset
   the selected model to provider defaults; persistent user preferences are not
   implemented by this change. The smoke explicitly reapplies its test model.
3. Published Codex/Claude adapters lag their repositories. Their current installed
   versions do not establish real-provider support for all modern Core features.
   Subagent projection is fixture-verified. Steering, goals, elicitation and
   child controls have not been shipped as user-facing functionality.
4. Gemini/Copilot paths are retained, but no real authenticated end-to-end run
   was performed for those providers.
5. The test agent intentionally cannot restore sessions across process restarts;
   that path verifies unsupported-capability handling, not successful restore.
6. The existing xterm ligatures addon logged `SecurityError: User activation is
   required` during reload. This terminal/font issue is outside the agent change;
   the browser console is not claimed to be globally error-free.
7. `npm audit` reported 10 dependency vulnerabilities (1 moderate, 9 high), in
   the web/server dependency graph. No forced dependency downgrades were applied.
   Production security release review remains necessary.
8. Large-history replay still assembles transcript data in memory. No multi-GB
   production database, 145 MB session, OOM, or multi-platform stress run was
   performed. Bounded starts and owned process cleanup reduce risk; they do not
   prove immunity to OOM or cleanup after an OS hard kill.
9. One repeat exposed an existing ordinary-terminal teardown gap: the shell
   test's interactive bash remained after `TerminalManager` sent SIGHUP, and
   also ignored SIGTERM. Killing that exact test-owned PID with SIGKILL released
   the runner, which reported 181 passes. This is outside the changed ACP runtime
   group supervisor. Ordinary PTY cleanup still needs bounded escalation and a
   dedicated regression before claiming whole-product shutdown reliability.

No production deployment, Git commit or push was performed as part of this run.

## Cleanup

The isolated service was stopped with SIGTERM. Its server process and all ten
recorded descendants were gone after shutdown, and port 19867 was no longer
listening. The two temporary test HOME directories were removed. Test screenshots
and validation logs remain under `/tmp`; provider-created test sessions remain
in provider history. Existing user sessions and the production service were not
targeted by cleanup.
