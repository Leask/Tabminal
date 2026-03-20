# Ghostty Integration Notes

Last updated: 2026-03-20

## Current conclusion

Tabminal iOS cannot switch to the public `libghostty` C API directly yet
without changing the integration surface.

The reason is specific and technical:

1. Ghostty's public C API exposes app/surface creation, rendering,
   input, selection, resize, and config hooks.
2. Tabminal needs a terminal renderer that can consume a remote PTY byte
   stream coming from the existing WebSocket protocol.
3. The public C API currently does not expose a function equivalent to
   Ghostty's internal `Termio.processOutput(...)` for feeding external
   terminal output bytes into a surface.
4. Ghostty does have this capability internally in Zig, but it is not
   exported in `include/ghostty.h`.

## Source evidence

- Public C header:
  - `/tmp/ghostty-tabminal/include/ghostty.h`
  - Public surface API includes:
    - `ghostty_surface_new`
    - `ghostty_surface_draw`
    - `ghostty_surface_key`
    - `ghostty_surface_text`
    - `ghostty_surface_set_size`
  - There is no exported API for "feed remote output bytes".

- Internal termio API:
  - `/tmp/ghostty-tabminal/src/termio/Termio.zig`
  - `pub fn processOutput(self: *Termio, buf: []const u8) void`
  - This is the exact kind of API Tabminal needs for remote PTY output.

- Surface wiring:
  - `/tmp/ghostty-tabminal/src/Surface.zig`
  - The current embedded path initializes termio with `.backend = .exec`
  - Surface owns its own child process / PTY model.

- Embedded C exports:
  - `/tmp/ghostty-tabminal/src/apprt/embedded.zig`
  - Exported C functions stop at surface/app/input/render/config APIs.
  - No exported manual-output path exists today.

## What this means for Tabminal

Tabminal is not a local terminal app with an in-process child PTY.
It is a remote terminal client with:

- WebSocket input/output
- heartbeat-based session reconciliation
- remote session ownership on the backend

Therefore, for iOS, the missing bridge is:

- remote output bytes -> Ghostty termio

Input already maps well:

- keyboard text -> Ghostty surface key/text APIs

Output does not:

- backend WS output currently cannot be injected through the public API

## Practical next step

The smallest viable path is a narrow Ghostty fork or upstream patch that
adds a supported embedded/manual IO bridge. The ideal exported C entry
points would look conceptually like:

- `ghostty_surface_process_output(surface, bytes, len)`
- optionally a manual backend/surface config that disables local PTY exec
- optionally an explicit surface input queue/write API if needed

With that, Tabminal can keep the existing backend protocol unchanged and
replace only the iOS renderer host.

## What has already been prepared in this repo

The iOS client now has a renderer abstraction layer so the future Ghostty
host can be swapped in without rewriting session, shell, or workspace UI.

- `/Users/leask/Documents/Tabminal/mobile/ios/Sources/TabminalIOSKit/TerminalRenderer.swift`
- `/Users/leask/Documents/Tabminal/mobile/ios/Sources/TabminalIOSKit/TerminalSurfaceHost.swift`

Current renderer mode is still the text fallback.

## Recommendation

Do not attempt to fake a full `libghostty` integration through the public
C API as-is. It would either:

- break Tabminal's remote-session architecture, or
- create an unmaintainable side channel around Ghostty internals.

The correct engineering move is:

1. add a tiny, explicit embedded/manual output API on top of Ghostty
2. keep the Tabminal server protocol unchanged
3. swap the iOS renderer host once the bridge compiles end-to-end
