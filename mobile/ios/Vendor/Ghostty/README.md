# GhosttyKit Vendor Layout

Tabminal iOS now looks for an official Ghostty `main` build artifact named
`GhosttyKit.framework` / `GhosttyKit.xcframework`.

Expected discovery order:

1. `TABMINAL_GHOSTTY_FRAMEWORK_PATH`
2. App bundle `Frameworks/GhosttyKit.framework/GhosttyKit`
3. App bundle `GhosttyKit.framework/GhosttyKit`
4. `libghostty.dylib` in the bundle

The most useful form is the official xcframework built from Ghostty `main`.

Example build from an official Ghostty checkout:

```bash
zig build -Dapp-runtime=none -Demit-xcframework=true
```

That build emits `macos/GhosttyKit.xcframework` from the Ghostty project.

For simulator debugging, you can point Tabminal directly at the xcframework:

```bash
TABMINAL_GHOSTTY_FRAMEWORK_PATH=/path/to/GhosttyKit.xcframework
```

Important: the public C API still does not expose remote PTY output injection.
Tabminal therefore detects the runtime and proves native linkage, but still
falls back to the text renderer unless Ghostty exports a manual-output bridge
such as `ghostty_surface_process_output`.
