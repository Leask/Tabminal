# Apple App Recovery

Updated: 2026-10-23

The Apple app is a native SwiftUI terminal/file client for iOS, macOS, and
visionOS. It is not yet a native implementation of the web ACP workspace.
The existing backend and ongoing ACP changes remain independent of this work.

## Recovery Scope

- Replace the obsolete reusable-password-hash login with the current server
  challenge/HMAC login, short-lived bearer tokens, and refresh-token rotation.
- Store host-scoped credentials in Keychain; do not upload sub-host credentials
  into the main host's cluster registry or put tokens in WebSocket URLs.
- Preserve a usable text fallback while restoring the full Ghostty renderer.
- Fix minimum OS versions, portable build scripts, and isolated real-server UI
  tests. Debug servers must not read production session/auth data or kill other
  services occupying a port.

## Ghostty Decision

Do not substitute a current upstream binary for the old custom-I/O renderer.
Current upstream's `libghostty-vt` is a terminal engine, not the UIKit/Metal
renderer and remote-I/O ABI used here. Upstream removed the full iOS renderer
build targets in [#13759](https://github.com/ghostty-org/ghostty/pull/13759) and
[#13760](https://github.com/ghostty-org/ghostty/pull/13760).

The recoverable baseline is:

- Source: [`Leask/ghostty@3a249a0`](https://github.com/Leask/ghostty/commit/3a249a0e1b6a91bf604d150cb38d874ffedd8b23)
- Compiler: Zig 0.15.2, not the machine's current Zig 0.17
- Header SHA-256:
  `6a53d0067ab62fb25bbe4fd040b86353bd378313eb5897a5a07ebe15c0b01bc4`
- Source archive SHA-256:
  `9626042bf3f59a3b64c78fe824d82864a0159a916eef03b734ac3112b984c176`
- [macOS ARM64 Zig archive](https://ziglang.org/download/0.15.2/zig-aarch64-macos-0.15.2.tar.xz)
  SHA-256: `3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b`

The pinned header matches `CGhosttyShim/include/ghostty.h` exactly. The April
custom-I/O fork changes callback signatures and enum values while retaining
symbol names. Build/link helpers now reject mismatched headers. A successful
`dlsym` probe alone is not an ABI guarantee.

Our [visionOS PR](https://github.com/wiedymi/ghostty/pull/2) remains open,
unmerged, and conflicted. [Lakr233/libghostty-spm](https://github.com/Lakr233/libghostty-spm)
is a maintained alternative with Apple artifacts, but adopting it requires a
deliberate host-managed-I/O bridge migration.

Track artifact publication, provenance, compatibility, and device acceptance
in [issue #25](https://github.com/Leask/Tabminal/issues/25).

The pinned source and verified Zig archive were downloaded and a real build
was attempted on this host. Zig 0.15.2 cannot link its build runner against the
installed macOS SDKs (Xcode 27.2 and Command Line Tools 26.5): libc symbols such
as `_getenv`, `_waitpid`, and `_sigaction` are unresolved. The installed
`libSystem.tbd` exposes `arm64e-macos`; the failure occurs in the old compiler's
SDK link stage, before the app bridge is compiled. No SDK files or global
compiler installation were changed.
There is no successfully rebuilt Ghostty artifact from this recovery run.

## Reproducible Checks

From the repository root:

```bash
swift test --package-path apps/Apple
node --test test/auth.mjs test/data-directory.mjs test/apple-build-settings.mjs
for script in apps/Apple/*.sh apps/ghostty-vendor/scripts/*.sh; do
    bash -n "$script"
done
apps/Apple/test-local-ui.sh 'iPhone 17 Pro'
```

The UI runner creates a private `tabminal-apple.*` data directory, starts the
real server with ACP discovery disabled, and stops only its own server on exit.
It retains logs and test data for inspection. Set `TABMINAL_MOBILE_DEBUG_PORT`
if the default port is occupied; the runner refuses to kill that port's owner.
`TABMINAL_DATA_DIR` isolates config, terminal persistence, auth, cluster registry,
and the default ACP database without redefining `HOME`.

For a matching Ghostty checkout and an isolated compiler installation:

```bash
TABMINAL_GHOSTTY_ZIG=/path/to/zig-0.15.2/zig \
    apps/ghostty-vendor/scripts/build-xcframework.sh /path/to/pinned-ghostty
apps/ghostty-vendor/scripts/verify-slices.sh \
    /path/to/pinned-ghostty/macos/GhosttyKit.xcframework
TABMINAL_GHOSTTY_REPO_PATH=/path/to/pinned-ghostty \
TABMINAL_MOBILE_TERMINAL_RENDERER=ghostty \
    apps/Apple/test-local-ui.sh 'iPhone 17 Pro'
```

Forced Ghostty mode must not silently succeed with a missing artifact or slice.
UI tests require an authenticated terminal connection, not merely a visible
shell container. Text assertions do not establish GPU-rendered VT correctness.

## Remaining Product Work

1. Publish/reuse a maintained renderer artifact with an audited dependency and
   license manifest. Do not copy an entire upstream resource tree blindly.
2. Real-device keyboard/IME, scrolling, selection, resize, and background/network
   recovery acceptance. Simulator/build results are not physical-device proof.
3. Validate native Cloudflare Access authentication and cookie/session handling;
   opening Safari is not an end-to-end native authentication test. Tracked in
   [issue #26](https://github.com/Leask/Tabminal/issues/26).
4. Complete real-device lifecycle acceptance for the native file editor.
   Version-checked saves, explicit conflict decisions, host-scoped draft recovery,
   and temporary-file regression coverage are now implemented. Details and test
   commands are in [FILE_EDITING.md](FILE_EDITING.md), tracked in
   [issue #27](https://github.com/Leask/Tabminal/issues/27).
   Selected-tab visibility in both workspace components is implemented and
   verified with targeted native tests, tracked in
   [issue #29](https://github.com/Leask/Tabminal/issues/29).
5. Add a native ACP bus consumer only after the terminal transport is reliable;
   do not duplicate runtime ownership or automatically attach upstream agents.

## Verification Notes

- The project-level deployment targets are now actually emitted by XcodeGen;
  target-level platform maps had silently fallen back to the SDK version.
- Simulator-only ad-hoc signing and Keychain entitlements fix the reproduced
  `OSStatus -34018`. Device signing/provisioning is still a separate release task.
- The input bridge now remains accessible to assistive technology and UI tests;
  the keyboard button toggles focus instead of always showing the keyboard.
- Directory listing decodes the server's `{ items, creatable }` envelope rather
  than a bare array. Inline directory and file-open failures are visible instead
  of silently producing an empty panel.
- The old visionOS vendor smoke wrapper could succeed without executing its
  build command. It now invokes xcodebuild and validates/link-checks the archive.
- Tests use a dedicated iOS 26.3 simulator. A fresh iOS 27 runtime stalled before
  XCTest started on this shared host; no global simulator services were reset.

### Evidence and Limits

- Swift package: 76 tests pass (66 core/auth/editor/storage/protocol, 10
  renderer/buffer).
- Focused Node suite: 47 tests pass (auth, filesystem and heartbeat writes,
  instance storage, portable build helpers, and refusing to take over an occupied
  debug port).
- Vendor verifier: 19 isolated mocked fixtures pass. These test shell validation
  and invocation behavior, not the existence of a working Ghostty archive.
- Native UI: 12/12 tests pass on iOS 26.3, using XCUITest with the real isolated
  Node server, not browser DOM automation. It covers login and terminal WebSocket
  connection, Keychain
  restoration without a password, a distinct new session, sidebar and add-host
  presentation, directory listing, keyboard focus toggle, actual shell command
  input/output, file save/reopen, conflict cancel/overwrite/reload, and unsaved
  draft restoration after switching files and relaunching.
- After the backend preflight fix, the three native save/reopen,
  conflict-reload, and conflict-overwrite UI cases also pass against a new
  isolated server. This follow-up changes backend validation only.
- The selected-tab follow-up passes a fresh 7/7 focused native UI regression:
  both workspace components, save/reopen, explicit conflict reload/overwrite,
  draft restoration, and keyboard toggling. The two tab cases verify long
  filenames, a visible/hittable close button, manual scrolling without changing
  selection, reselecting the current file, and the complete restored tab set.
  The full workspace component uses its DEBUG-only test host, not a new
  production navigation entry.
- Screenshot inspection is part of acceptance. In particular, the original
  workspace-open test passed while its directory was empty; checking its image
  exposed the response-envelope bug, and the test now requires rendered entries.
- macOS and visionOS shell builds pass. These are compile checks, not interactive
  or real-device acceptance. All current UI runs use the plain-text fallback, not
  Ghostty. VT rendering, IME, device lifecycle and complete file editing remain
  separate acceptance tasks.

Local diagnostic logs: `/tmp/tabminal-editor-swift.log`,
`/tmp/tabminal-write-preflight-node.log`, `/tmp/tabminal-editor-ui-acceptance.log`,
`/tmp/tabminal-editor-macos.log`, and `/tmp/tabminal-editor-visionos.log`.
UI result bundles are under `apps/Apple/build/Logs/Test/` (untracked).
The 12-test baseline run is
`Test-TabminalMobileApp-2026.10.23_14-40-03--0400.xcresult`; its exported
screenshots are in `/tmp/tabminal-editor-acceptance-images/`.
The backend follow-up UI log is `/tmp/tabminal-write-preflight-ui.log`, with result
bundle `Test-TabminalMobileApp-2026.10.23_15-16-54--0400.xcresult`.
The final selected-tab regression log is `/tmp/tabminal-selected-tabs-final.log`,
with result bundle
`Test-TabminalMobileApp-2026.10.23_16-45-46--0400.xcresult` and screenshots in
`/tmp/tabminal-selected-tabs-final-images/`. The additional long-filename-only
2/2 run is `Test-TabminalMobileApp-2026.10.23_16-40-43--0400.xcresult`.
The latest package and Node logs are `/tmp/tabminal-selected-tabs-swift.log` and
`/tmp/tabminal-selected-tabs-node.log`.

The native file editor recovery work is described in
[FILE_EDITING.md](FILE_EDITING.md). The backend replacement validation gap in
[issue #28](https://github.com/Leask/Tabminal/issues/28) is now fixed for versioned
heartbeat writes: invalid content is rejected before any filesystem write, with
the same text and UTF-8 size limits used by reads. Native preflight checks remain
in place for immediate feedback.
The isolated test server and dedicated simulator were stopped after acceptance.
