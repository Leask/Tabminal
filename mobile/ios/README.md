# Tabminal iOS

## Scope

This directory starts the native iOS client work without requiring backend
changes.

It is intentionally split into two layers:

- `TabminalMobileCore`
  Protocol models, auth, REST transport, websocket transport, and session key
  handling.
- `TabminalIOSKit`
  SwiftUI-facing shell code and the `libghostty` bridge surface.

This directory also contains:

- `project.yml`
  `xcodegen` spec for the local iOS app host.
- `App/`
  Minimal native iOS app shell that consumes the local package.
- `run-sim.sh`
  Command-line build/install/launch entry point for the simulator.

## Why Swift Package First

The first milestone is protocol stability, not app packaging.

Keeping the first slice in SwiftPM gives us:

- Fast iteration on protocol and transport code.
- Testable models without committing to an `.xcodeproj` shape too early.
- A clean path to embed the package in an app target without duplicating code.

That app target now exists, but it is still intentionally thin. The package
remains the real ownership boundary for mobile protocol logic.

## Launching the App

One-time prerequisites:

- Install Xcode with iOS simulator support
- Install `xcodegen`

Run:

```bash
cd mobile/ios
./run-sim.sh
```

To target a different simulator by name:

```bash
cd mobile/ios
./run-sim.sh "iPhone 17"
```

The script will:

1. Generate `TabminalMobileApp.xcodeproj`
2. Pick the named simulator
3. Boot and wait for it
4. Build the app into `mobile/ios/build`
5. Install and launch `com.leask.tabminal.mobile`

## Near-Term Next Steps

1. Vendor or wrap `libghostty` for Apple platforms.
2. Replace the placeholder terminal surface with a real native renderer host.
3. Connect websocket output directly into the renderer bridge.
4. Add mobile-first server list and session navigation.
5. Add cluster restore, reconnect, and file flows.

## libghostty Integration Boundary

The intended ownership split is:

- `TabminalMobileCore`
  Knows nothing about rendering.
- `TabminalIOSKit`
  Owns renderer lifecycle, resize, focus, keyboard routing, selection, and
  viewport behavior.
- Future app target
  Owns navigation, persistence, scene lifecycle, notifications, and polished
  iOS presentation.
