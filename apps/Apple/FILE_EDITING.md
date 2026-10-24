# Native File Editing

The native editor uses the same versioned heartbeat writes as the web editor.
Read responses retain `content`, `readonly`, and the file's SHA-256 `version`.
A normal save submits `expectedVersion` with the exact terminal session ID and
file path. It succeeds only when that session/path has one acknowledged `ok`
result containing the new version. HTTP 200 alone is insufficient.

## Document State

`TabminalEditorDocument` owns the buffer, saved baseline, version, conflict, and
local recovery draft. Its identity includes host ID, normalized base URL,
terminal session ID, and full file path. Every live instance with the same
identity is reused; concurrent initial opens share one load. Registry references
are weak, so closed documents do not accumulate as a second content cache.

- A save captures the submitted text. Typing during the request remains dirty
  after that captured text is acknowledged.
- An interrupted save is recorded in the draft. Undoing to the old baseline
  while a request is pending cannot remove recovery text.
- Closing and reopening during a save reuses its owner. An old completion cannot
  overwrite the reopened document's newer draft.
- A conflict retains the local buffer and original baseline. Ordinary Save does
  not force a write. Reload File and Overwrite File each require confirmation;
  Cancel leaves both copies unchanged.
- Reload fetches the latest host copy rather than using a cached conflict body.
- Failed reads, writes, and missing acknowledgements never replace edits with
  an empty buffer or mark them saved.
- Read-only documents cannot submit writes. Replacement text must pass the
  read endpoint's 5 MiB and text-content limits before submission.

## Recovery Storage

Credentials remain in Keychain. Draft content is stored separately in private,
atomic files under the app's Application Support directory:
`Tabminal/editor-drafts/`. An actor serializes filesystem work off the main
actor, with 0700 directories and 0600 files. iOS and visionOS apply file
protection until the first device unlock.

Each document coalesces pending draft writes and flushes them before a remote
save. The app also flushes on leaving the active scene. The status label reports
when a local draft has finished saving. Successful saves/reloads remove obsolete
drafts; failures leave recovery data available.

Workspace metadata in UserDefaults contains open paths, selection, and visibility
only. Its key includes the same host URL and session identity. It retains open
paths and selection even when the last workspace update did not reach the host;
session inventory still comes from heartbeat. A changed host endpoint
invalidates pending workspace loads rather than applying old results to the new
host.

On restoration, the editor fetches the host copy and compares versions. Local
edits remain visible if the host changed, or even if the file is currently
missing/unreachable. An uncertain save whose desired text differs from its
submitted text requires review even if the host still shows the old baseline.

## Verification

### Selected File Tabs

Both tab strips use `SelectedFileTabScrollView`. Opening, selecting, reselecting
the current file, restoring tabs, and changing the viewport width reveal the
active tab after its layout is available. A small transient workspace reveal ID
records explicit selection even when the selected path is unchanged.

Manual horizontal scrolling changes only the offset. It does not change the
active file or continuously snap back. The editor also shows the active
basename independently of the tab-strip offset and long filesystem path.
Long filenames are middle-truncated within the tab's available width so its
close button remains visible, including in the narrow inline editor.

The two targeted UI cases verify actual overflow on narrow viewports, movement
after swiping, unchanged selection during manual scrolling, same-file reveal,
both ends of the strip, and the complete restored tab set. Visibility includes
the full tab capsule and a hittable close button within the viewport/window.

`WorkspaceBrowserView` currently has no production navigation entry. The full
component is exercised through a DEBUG-only host selected by
`TABMINAL_MOBILE_DEBUG_FULL_WORKSPACE`; normal and release navigation stay the
same. The UI test configures this automatically.

```bash
TABMINAL_MOBILE_DEBUG_PORT=19849 \
    apps/Apple/test-local-ui.sh 'Tabminal App Review iOS26' \
    -only-testing:TabminalMobileAppUITests/TabminalMobileAppUITests/testInlineFileTabsKeepSelectionVisibleAndAllowManualScrolling \
    -only-testing:TabminalMobileAppUITests/TabminalMobileAppUITests/testFullFileTabsKeepSelectionVisibleAndAllowManualScrolling
```

Tracking: [issue #29](https://github.com/Leask/Tabminal/issues/29).

### Save and Recovery

```bash
swift test --package-path apps/Apple
node --test test/fs-routes.mjs test/apple-file-writes.mjs
TABMINAL_MOBILE_DEBUG_PORT=19849 \
    apps/Apple/test-local-ui.sh 'Tabminal App Review iOS26'
```

The UI runner creates its own server, workspace, terminal, and five text files
inside `tabminal-apple.*/workspace`. The native UI performs normal saves,
conflict reload/overwrite/cancel, file switching, and unsaved-draft restoration
after relaunch. A long-basename fixture covers tab visibility and truncation.
A second authenticated test client simulates external edits
through versioned heartbeat writes. No production files are mutated.

Core tests cover delayed saves, undo during save, identity reuse, late
acknowledgements, interrupted recovery, permission/read failures, and draft
storage. Headless Node tests exercise the actual server handlers and temporary
filesystem data, including mixed per-file successes/conflicts/errors.

Versioned heartbeat writes now validate replacement text and its UTF-8 byte size
before writing, including forced writes. Invalid payloads preserve the original
bytes and version; regression tests also assert zero filesystem write calls.
The native preflight remains useful for immediate feedback. Server-side
correction is tracked in [issue #28](https://github.com/Leask/Tabminal/issues/28).
The server's existing filesystem concurrency guarantees are unchanged.

Tracking: [issue #27](https://github.com/Leask/Tabminal/issues/27).
Real-device lifecycle acceptance and native Ghostty rendering remain separate
from these text-editor and simulator checks.
