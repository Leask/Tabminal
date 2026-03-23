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

The local custom-I/O Ghostty fork has already been patched far enough to:

- emit `xros` and `xrsimulator` slices in `GhosttyKit.xcframework`
- pass a real consumer build of the Tabminal visionOS target

The scripts here document and reproduce that workflow.

## Files

- `docs/platform-matrix.md`
  Current platform support and verification matrix.
- `docs/visionos-xcframework-plan.md`
  Patch scope and upstream strategy.
- `scripts/build-xcframework.sh`
  Rebuild a universal Ghostty xcframework from a Ghostty custom-I/O repo.
- `scripts/verify-slices.sh`
  Verify the xcframework contains the required Apple platform slices.
- `scripts/smoke-tabminal-visionos.sh`
  Prove the built xcframework can be consumed by Tabminal's visionOS app.
