# Platform Matrix

## Target artifact

`GhosttyKit.xcframework`

Required libraries:

- `ios-arm64`
- `ios-arm64-simulator`
- `macos-arm64_x86_64`
- `xros-arm64`
- `xros-arm64-simulator`

## Verified status

| Platform | Ghostty slice in xcframework | Tabminal consumer build | Runtime status |
| --- | --- | --- | --- |
| iPhone | Yes | Yes | Passed earlier in mobile app smoke |
| iPad | Yes | Yes | Passed earlier in mobile app smoke |
| macOS | Yes | Yes | Passed earlier in mobile app smoke |
| visionOS | Yes | Yes | Consumer build now passes |
| visionOS Simulator | Yes | Build-time verified by slice inspection | Not yet re-run as separate smoke in this vendor workflow |

## Current local proof

Local xcframework plist inspection confirms:

- `SupportedPlatform = ios`
- `SupportedPlatform = macos`
- `SupportedPlatform = xros`
- simulator variants for both iOS and visionOS

Local consumer proof confirms:

- `xcodebuild -project TabminalMobileApp.xcodeproj -scheme TabminalMobileApp -sdk xros`
  succeeds when `TABMINAL_GHOSTTY_XCFRAMEWORK_PATH` points at the new
  artifact.

## Notes

The remaining work is mostly productization:

- turn the local patch stack into a clean fork/branch history
- wire CI around `verify-slices.sh`
- add a dedicated visionOS runtime smoke once the vendor location is no longer
  ephemeral
