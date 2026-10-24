# Ghostty Vendor

This directory captures the Tabminal-owned Ghostty vendor workflow.

Current goal:

- build a `GhosttyKit.xcframework` that supports iOS, iOS Simulator,
  macOS, visionOS, and visionOS Simulator
- keep the custom-I/O surface API required by the native Tabminal mobile
  clients
- make the result easy to validate and eventually upstream

This is intentionally separate from the main mobile app code.
The mobile client should consume a tested artifact; it should not own the
Ghostty fork/build logic directly.

## Current status

The March custom-I/O Ghostty fork had been patched far enough to:

- emit `xros` and `xrsimulator` slices in `GhosttyKit.xcframework`
- pass a real consumer build of the Tabminal visionOS target

The scripts here document and reproduce that workflow.

The current recovery is tracked in [Apple progress](../Apple/PROGRESS.md) and
[issue #25](https://github.com/Leask/Tabminal/issues/25). Use the documented
source pin, not the floating `custom-io` branch. Supply the compatible compiler
through `TABMINAL_GHOSTTY_ZIG`; `TABMINAL_GHOSTTY_BUILD_JOBS` defaults to 4.
The build and consumer helpers reject a header that differs from our C bridge.
The current Xcode 27.2 SDK blocks the legacy Zig 0.15.2 build runner; an artifact
has not yet been restored with that toolchain.

## Files

- `docs/platform-matrix.md`
  Current platform support and verification matrix.
- `docs/visionos-xcframework-plan.md`
  Patch scope and upstream strategy.
- `scripts/build-xcframework.sh`
  Rebuild a universal Ghostty xcframework from a Ghostty custom-I/O repo.
  The script defaults to a repo-local Zig cache so it does not rely on the
  user's global cache permissions.
- `scripts/verify-slices.sh`
  Verify the xcframework contains the required Apple platform slices.
- `scripts/smoke-tabminal-visionos.sh`
  Prove the built xcframework can be consumed by Tabminal's visionOS app.
