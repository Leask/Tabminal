# Ghostty Integration Notes

Last updated: 2026-03-23

## Current status

Tabminal iOS now includes a concrete native Ghostty integration path:

1. raw VT output is preserved alongside the plain-text transcript
2. the Apple client can drive a native Ghostty surface through the
   custom-I/O bridge
3. renderer selection now defaults to `ghostty` whenever the runtime
   exports the required remote-I/O symbols
4. a native Ghostty runtime loader probes for `GhosttyKit.framework`
   and build-linked xcframework artifacts
5. the package includes a thin C shim target (`CGhosttyShim`) to
   stabilize the expected runtime artifact and symbol names
6. a native host scaffold (`GhosttyNativeTerminalSurface`) is now the
   render entrypoint when Ghostty is available

This all works without changing the Tabminal backend protocol.

## Current conclusion

Tabminal iOS can use `libghostty` directly when the runtime exposes the
custom-I/O bridge used by remote terminal clients.

The reason is specific and technical:

1. Ghostty's public C API exposes app/surface creation, rendering,
   input, selection, resize, and config hooks.
2. Tabminal needs a terminal renderer that can consume a remote PTY byte
   stream coming from the existing WebSocket protocol.
3. Stock upstream builds do not currently expose the remote client bridge
   that Tabminal needs.
4. The `custom-io` Ghostty fork used by mature Apple clients does export
   this bridge in `include/ghostty.h`.

## Source evidence

- Custom-I/O C header:
  - `wiedymi/ghostty` `custom-io`
  - Exported surface API includes:
    - `ghostty_surface_feed_data`
    - `ghostty_surface_set_write_callback`
    - `ghostty_surface_draw`
    - `ghostty_surface_refresh`
    - `ghostty_surface_text`

- Custom-I/O implementation:
  - `src/apprt/embedded.zig`
  - `ghostty_surface_feed_data(...)`
    forwards to `ptr.core_surface.io.processOutput(...)`
  - `ghostty_surface_set_write_callback(...)`
    updates the terminal I/O thread callback backend

## What this means for Tabminal

Tabminal is not a local terminal app with an in-process child PTY.
It is a remote terminal client with:

- WebSocket input/output
- heartbeat-based session reconciliation
- remote session ownership on the backend

Therefore, for iOS, the required bridge is:

- backend WS output -> `ghostty_surface_feed_data`
- local terminal input -> Ghostty write callback -> backend WS input

## Practical next step

The viable path is a custom-I/O Ghostty runtime. With that, Tabminal can
keep the existing backend protocol unchanged and replace only the renderer
host.

Current platform state:

- `iOS/iPadOS`
  Ghostty custom-I/O renderer path is working and UI smoke tests pass.
- `macOS`
  Ghostty renderer path is working.
- `visionOS`
  The app-side bridge compiles and runs. Ghostty rendering works when the
  linked `GhosttyKit.xcframework` includes the visionOS slices
  `xros-arm64` and `xros-arm64-simulator`; text fallback remains the safe
  path when no such artifact is linked.

## What has already been prepared in this repo

The iOS client now has a renderer abstraction layer and a native runtime
probe so the future Ghostty host can be swapped in without rewriting
session, shell, or workspace UI.

- `/Users/leask/Documents/Tabminal/mobile/ios/Sources/TabminalIOSKit/TerminalRenderer.swift`
- `/Users/leask/Documents/Tabminal/mobile/ios/Sources/TabminalIOSKit/TerminalSurfaceHost.swift`
- `/Users/leask/Documents/Tabminal/mobile/ios/Sources/TabminalIOSKit/TerminalRenderFeed.swift`
- `/Users/leask/Documents/Tabminal/mobile/ios/Sources/TabminalIOSKit/GhosttyRuntime.swift`
- `/Users/leask/Documents/Tabminal/mobile/ios/Sources/TabminalIOSKit/GhosttyNativeTerminalSurface.swift`
- `/Users/leask/Documents/Tabminal/mobile/ios/Sources/CGhosttyShim/include/ghostty_loader.h`
- `/Users/leask/Documents/Tabminal/mobile/ios/Vendor/Ghostty/README.md`

Current renderer behavior:

- default: Ghostty renderer whenever the runtime exports the embedded
  surface API plus remote-I/O symbols
- fallback: text renderer when the runtime or platform slice is missing
- Ghostty mode: native runtime loader + host scaffold + custom-I/O bridge
  when the runtime exports the required symbols

## Recommendation

Do not attempt to fake remote rendering by abusing Ghostty's local PTY
execution path. The correct move remains:

1. use a Ghostty runtime that exports the custom-I/O bridge
2. keep the Tabminal server protocol unchanged
3. continue hardening the Apple host views around Ghostty's IOSurface model
4. bundle or vendor a Ghostty artifact with the visionOS slices
   `xros-arm64` and `xros-arm64-simulator` so visionOS can use Ghostty by
   default instead of relying on explicit local overrides

## Vendor workflow

This repo now includes a dedicated helper workflow for Ghostty vendor
artifacts:

- `/Users/leask/Documents/Tabminal/mobile/ghostty-vendor/README.md`

That workflow can build a `GhosttyKit.xcframework` from a compatible
custom-I/O Ghostty checkout and verify the resulting Apple slices.

Supported integration inputs in the Apple app now are:

1. `TABMINAL_GHOSTTY_XCFRAMEWORK_PATH=/path/to/GhosttyKit.xcframework`
2. `TABMINAL_GHOSTTY_REPO_PATH=/path/to/ghostty-checkout`

The repo-path form resolves `<repo>/macos/GhosttyKit.xcframework`.
