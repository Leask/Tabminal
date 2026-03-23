# GhosttyKit Vendor Layout

Tabminal iOS looks for a Ghostty runtime artifact that exports Ghostty's
embedded surface API plus the custom-I/O symbols used by remote terminal
clients.

Expected discovery order:

1. `TABMINAL_GHOSTTY_XCFRAMEWORK_PATH`
2. `TABMINAL_GHOSTTY_REPO_PATH` -> `<repo>/macos/GhosttyKit.xcframework`
3. Checked-in `Vendor/Ghostty/GhosttyKit.xcframework`

At runtime, the loader still probes linked symbols first, then falls back to:

1. `TABMINAL_GHOSTTY_FRAMEWORK_PATH`
2. App bundle `Frameworks/GhosttyKit.framework/GhosttyKit`
3. App bundle `GhosttyKit.framework/GhosttyKit`
4. `libghostty.dylib` in the bundle

The most useful form today is a `custom-io` Ghostty build, such as the
xcframework produced by the `wiedymi/ghostty` `custom-io` fork lineage.

Recommended local workflow:

```bash
cd /Users/leask/Documents/Tabminal
./apps/ghostty-vendor/scripts/build-xcframework.sh /path/to/ghostty-checkout
```

That emits `macos/GhosttyKit.xcframework` from the Ghostty checkout. You can
then point Tabminal at either the xcframework directly or the checkout root:

```bash
TABMINAL_GHOSTTY_XCFRAMEWORK_PATH=/path/to/GhosttyKit.xcframework
```

or:

```bash
TABMINAL_GHOSTTY_REPO_PATH=/path/to/ghostty-checkout
```

Required custom-I/O exports:

- `ghostty_surface_feed_data`
- `ghostty_surface_set_write_callback`

Current supported slice set:

- `ios-arm64`
- `ios-arm64-simulator`
- `macos-arm64_x86_64`
- `xros-arm64`
- `xros-arm64-simulator`
- legacy `xrsimulator-*` names are still accepted by the consumer scripts

If the xcframework omits the visionOS slices, the app still builds and runs
on visionOS, but it falls back to the text renderer there.
