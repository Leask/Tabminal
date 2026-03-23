# Upstream PR Series

The local Ghostty fork work now exists in two forms:

- a single proof commit on `tabminal/visionos-xcframework`
- a split four-commit series on `tabminal/visionos-pr-series`

The split branch is the one to use for upstream preparation.

## Branch

`tabminal/visionos-pr-series`

## Commit order

1. `93e27b7` `build: emit visionos xcframework slices`
2. `877ffa4` `embed: gate cli and benchmark paths on visionos libs`
3. `a38cc55` `platform: add visionos shims for embedded runtime`
4. `9b5f23a` `embed: stub unsupported fs and exec paths on visionos`

## Why this split

### PR 1: build system

Files:

- `src/build/Config.zig`
- `src/build/GhosttyXCFramework.zig`
- `src/build/MetallibStep.zig`
- `src/build/SharedDeps.zig`

Intent:

- teach the build system about `visionos`
- emit `xros` and `xrsimulator` slices
- make the Metal shader step understand visionOS SDK targets
- keep dependency wiring explicit for the new target

This is the cleanest and most upstream-friendly change.

### PR 2: embedded library gating

Files:

- `src/main_c.zig`
- `src/global.zig`
- `src/config/CApi.zig`

Intent:

- remove benchmark, CLI, and crash-only assumptions from embedded visionOS
  library builds
- keep the C-facing entry points available without dragging in host-only code

This is still broadly upstreamable because it is about embedded library shape,
not Tabminal-specific behavior.

### PR 3: platform shims

Files:

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

Intent:

- define the minimal platform surface for visionOS
- route unsupported desktop assumptions to safe stubs
- allow the embedded renderer/runtime to compile cleanly

This is where maintainer preference may vary, so keeping it isolated matters.

### PR 4: filesystem and execution fallbacks

Files:

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

Intent:

- stop embedded visionOS builds from depending on unsupported host filesystem
  and execution behaviors
- keep unsupported actions explicit instead of failing later in undefined ways

This is the most opinionated part of the stack and may need the most review.

## Verification status

The split branch has been re-verified with the Tabminal vendor scripts:

1. `scripts/build-xcframework.sh /tmp/tabminal-ghostty-custom-io`
2. `scripts/verify-slices.sh /tmp/tabminal-ghostty-custom-io/macos/GhosttyKit.xcframework`
3. `scripts/smoke-tabminal-visionos.sh /tmp/tabminal-ghostty-custom-io/macos/GhosttyKit.xcframework`

All three passed after the split.

## Recommendation

Use `tabminal/visionos-pr-series` as the source branch for future public fork
work. Keep `tabminal/visionos-xcframework` only as the original proof branch.
