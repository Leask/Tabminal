# visionOS xcframework plan

## Problem

The previous Ghostty custom-I/O reference artifact only shipped these slices:

- iOS
- iOS Simulator
- macOS

That blocked native Ghostty rendering on visionOS because Tabminal's Apple app
could build for `xrsimulator`, but the linked xcframework had no `xros` or
`xrsimulator` libraries.

## What changed locally

The local fork work added enough visionOS support to make the library build as
an embedded artifact:

1. xcframework generation now emits `xros` and `xrsimulator` entries
2. Metal shader build steps understand visionOS SDK targets
3. desktop-only and CLI-only code paths are compiled out for the embedded
   visionOS library build
4. unsupported filesystem/process helpers are stubbed or redirected away from
   host-only APIs
5. the resulting xcframework now passes a real Tabminal visionOS consumer build

## Patch themes

The current patch stack falls into four buckets:

### 1. Build system

- `src/build/Config.zig`
- `src/build/GhosttyXCFramework.zig`
- `src/build/MetallibStep.zig`
- `src/build/SharedDeps.zig`

These changes are the best upstream candidates because they are generic and
platform-enabling.

### 2. Embedded-library gating

- `src/main_c.zig`
- `src/global.zig`
- `src/config/CApi.zig`

These remove benchmark, CLI, crash, and other non-embedded requirements from
visionOS library builds.

### 3. Platform shims

- `src/os/*.zig`
- `src/pty.zig`
- `src/Command.zig`
- `src/input/keycodes.zig`
- `src/renderer/Metal.zig`

These adapt unsupported or meaningless host features for visionOS.

### 4. Filesystem and execution fallbacks

- `src/Surface.zig`
- `src/termio/Exec.zig`
- `src/terminal/kitty/graphics_exec.zig`
- `src/config/path.zig`
- `src/apprt/embedded.zig`

These changes avoid compile-time and runtime assumptions that only hold on
traditional desktop hosts.

## Upstream strategy

Recommended sequence:

1. land the build-system changes first
2. land embedded visionOS gating next
3. keep the more opinionated platform shims isolated until the maintainer
   preference is clear
4. only carry Tabminal-specific vendor glue outside the Ghostty fork

## Success criteria

The fork is considered ready when all of the following are true:

- `scripts/build-xcframework.sh` succeeds from a clean checkout
- `scripts/verify-slices.sh` confirms the five required Apple slice entries
- `scripts/smoke-tabminal-visionos.sh` succeeds against the local Tabminal app
- the patch series can be explained as generic Ghostty embedded/visionOS work,
  not as Tabminal-specific behavior
