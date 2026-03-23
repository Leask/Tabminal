# PR Draft: build: emit visionOS xcframework slices

## Summary

This enables `visionOS` in the Apple xcframework build path used by the
embedded Ghostty library and includes the minimal compile guards required for
the resulting artifact to build as a self-contained change.

Specifically, it teaches the build to:

- recognize `visionos` as a supported Apple target
- emit `xros` and `xrsimulator` slices in `GhosttyKit.xcframework`
- compile Metal shader artifacts for `xros` and `xrsimulator`
- thread the new target through shared dependency setup
- gate host-only CLI and benchmark paths that do not apply to embedded
  `visionOS` library consumers
- add the minimal Apple-platform shims needed for the embedded runtime to
  compile on `visionOS`

## Why

Downstream Apple clients can already target `visionOS`, but the previous
xcframework artifact only shipped:

- iOS
- iOS Simulator
- macOS

That meant native consumers could not link Ghostty into `visionOS` builds even
when the rest of the app stack was ready.

## Verification

I verified this change in a downstream consumer by:

1. building the new xcframework
2. confirming the following slices exist in `Info.plist`
   - `ios-arm64`
   - `ios-arm64-simulator`
   - `macos-arm64_x86_64`
   - `xros-arm64`
   - `xros-arm64-simulator`
3. linking the result into a real `visionOS` app build

## Notes

This started as a build-only PR, but review and downstream verification showed
that the build changes alone were not independently mergeable. The current
version keeps the scope focused on "minimal self-contained `visionOS` Apple
artifact enablement" rather than a larger embedded-runtime redesign.
