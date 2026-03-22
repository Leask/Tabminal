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
- `xcodebuild-lock.sh`
  Shared lock helper that prevents concurrent `xcodegen` / `xcodebuild`
  commands from corrupting the generated Xcode project.

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

## visionOS

To install the visionOS simulator runtime on this machine:

```bash
xcodebuild -downloadPlatform visionOS -exportPath /tmp/tabminal-visionos-download
```

To build and launch the app in the Apple Vision Pro simulator:

```bash
cd mobile/ios
./run-visionos.sh
```

The visionOS path uses the same mobile package and app shell, but targets the
`xrsimulator` SDK and the installed `Apple Vision Pro` simulator device.

## Current Runtime Behavior

What works now:

- Connect to an existing Tabminal main host
- Restore the saved main-host login from Keychain on app launch
- Restore the backend cluster registry and saved sub-hosts
- Create, close, and switch sessions across multiple hosts
- Open the websocket for the active session with reconnect behavior
- Drive a native Ghostty renderer through the custom-I/O bridge when the
  runtime is linked and exports the required symbols
- Fall back to the text renderer when the runtime or platform slice is
  missing
- Send input, return, tab, escape, Ctrl-C, and arrow keys
- Browse files, open files, edit them, and save them back to the server
- Open sub-host browser login flows for Access-style auth

What is still pending:

- Ship a Ghostty vendor artifact that includes `xros/xrsimulator` slices
  so visionOS can use Ghostty instead of text fallback
- Rich terminal behaviors such as proper native selection and full VT rendering
- iPad-focused split-pane workspace and more polished mobile shell ergonomics

## Near-Term Next Steps

1. Produce a Ghostty xcframework that includes `xros/xrsimulator` slices.
2. Polish the Apple host views around Ghostty's IOSurface lifecycle.
3. Add richer terminal UX such as selection, search, and better copy/paste.
4. Polish iPad and large-screen workspace layouts.

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
