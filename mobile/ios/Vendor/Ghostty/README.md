# GhosttyKit Vendor Layout

Tabminal iOS now looks for a `GhosttyKit.framework` /
`GhosttyKit.xcframework` artifact that exports Ghostty's embedded surface
API plus the custom-I/O symbols used by remote terminal clients.

Expected discovery order:

1. `TABMINAL_GHOSTTY_FRAMEWORK_PATH`
2. App bundle `Frameworks/GhosttyKit.framework/GhosttyKit`
3. App bundle `GhosttyKit.framework/GhosttyKit`
4. `libghostty.dylib` in the bundle

The most useful form today is a `custom-io` Ghostty build, such as the
xcframework produced by the `wiedymi/ghostty` fork used by VVTerm.

Example build from a custom-I/O Ghostty checkout:

```bash
zig build -Dapp-runtime=none -Demit-xcframework=true
```

That build emits `macos/GhosttyKit.xcframework` from the Ghostty project.

For simulator debugging, you can point Tabminal directly at the xcframework:

```bash
TABMINAL_GHOSTTY_XCFRAMEWORK_PATH=/path/to/GhosttyKit.xcframework
```

Required custom-I/O exports:

- `ghostty_surface_feed_data`
- `ghostty_surface_set_write_callback`

Current platform expectation:

- `ios-arm64`
- `ios-arm64-simulator`
- `macos-arm64_x86_64`

Tabminal now also probes for future visionOS slices:

- `xros-arm64`
- `xrsimulator-arm64`
- `xrsimulator-arm64_x86_64`

If the xcframework omits the visionOS slices, the app still builds and
runs on visionOS, but it falls back to the text renderer there.
