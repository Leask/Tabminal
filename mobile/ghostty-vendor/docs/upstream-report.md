# Ghostty visionOS Upstream Report

## Status

The local Ghostty custom-I/O fork now builds a universal Apple
`GhosttyKit.xcframework` that includes:

- `ios-arm64`
- `ios-arm64-simulator`
- `macos-arm64_x86_64`
- `xros-arm64`
- `xros-arm64-simulator`

This was verified both by slice inspection and by a real Tabminal consumer build
for `visionOS`.

Publishing is no longer blocked. The first upstream PR is now open:

- `wiedymi/ghostty#2`
  <https://github.com/wiedymi/ghostty/pull/2>

## Local branches

Proof branch:

- `tabminal/visionos-xcframework`

Self-contained upstream PR branch:

- `tabminal/visionos-build-slices`

Stacked follow-up branch:

- `tabminal/visionos-pr-series`

## Current upstream PR branch commits

1. `93e27b7` `build: emit visionos xcframework slices`
2. `f0db759` `build: fix visionos target defaults`
3. `af5164a` `embed: gate cli and benchmark paths on visionos libs`
4. `15fd4a2` `platform: add visionos shims for embedded runtime`
5. `4a1f562` `embed: stub write-screen export on visionos`
6. `ba464f1` `config: avoid PATH_MAX assumptions on visionos`
7. `3a249a0` `embed: avoid host-only exec and graphics paths on visionos`

## Verification

The split branch was re-verified using the vendor scripts in this repo:

```bash
mobile/ghostty-vendor/scripts/build-xcframework.sh /tmp/tabminal-ghostty-custom-io
mobile/ghostty-vendor/scripts/verify-slices.sh /tmp/tabminal-ghostty-custom-io/macos/GhosttyKit.xcframework
mobile/ghostty-vendor/scripts/smoke-tabminal-visionos.sh /tmp/tabminal-ghostty-custom-io/macos/GhosttyKit.xcframework
```

All three passed.

## Recommended PR sequence

### PR 1

Title:

`build: enable visionOS xcframework slices`

Scope:

- `src/build/Config.zig`
- `src/build/GhosttyXCFramework.zig`
- `src/build/MetallibStep.zig`
- `src/build/SharedDeps.zig`
- plus the minimal embedded/platform guards required to keep the change
  independently buildable

### PR 2

Title:

`embed: reduce visionOS host-only surface area`

Scope:

- `src/main_c.zig`
- `src/global.zig`
- `src/config/CApi.zig`

### PR 3

Title:

`platform: add visionOS shims for embedded runtime`

Scope:

- `src/Command.zig`
- `src/config/theme.zig`
- `src/input/keycodes.zig`
- `src/os/cgroup.zig`
- `src/os/desktop.zig`
- `src/os/homedir.zig`
- `src/os/i18n.zig`
- `src/os/main.zig`
- `src/os/open.zig`
- `src/os/path.zig`
- `src/os/path_max.zig`
- `src/os/resourcesdir.zig`
- `src/os/systemd.zig`
- `src/pty.zig`
- `src/renderer/Metal.zig`

### PR 4

Title:

`embed: stub unsupported fs and exec paths on visionOS`

Scope:

- `src/Surface.zig`
- `src/apprt/embedded.zig`
- `src/cli/new_window.zig`
- `src/cli/validate_config.zig`
- `src/config/Config.zig`
- `src/config/path.zig`
- `src/terminal/kitty/graphics_exec.zig`
- `src/terminal/kitty/graphics_image.zig`
- `src/termio/Exec.zig`
- `src/termio/shell_integration.zig`

## Review notes

The first upstream review identified two real issues:

1. `i18n` target selection needed to preserve the existing glibc check rather
   than rely on OS alone.
2. `MetallibStep` should not seed `visionOS` defaults with `xros1.0`, because
   the formatter already prefixes the platform token.

Both were fixed before re-marking the PR ready for review.
