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

## Current Runtime Behavior

What works now:

- Connect to an existing Tabminal main host
- Restore the saved main-host login from Keychain on app launch
- Restore the backend cluster registry and saved sub-hosts
- Create, close, and switch sessions across multiple hosts
- Open the websocket for the active session with reconnect behavior
- Render snapshot and output into a plain-text terminal fallback
- Send input, return, tab, escape, Ctrl-C, and arrow keys
- Browse files, open files, edit them, and save them back to the server
- Open sub-host browser login flows for Access-style auth

What is still pending:

- Replace the plain-text fallback with a real `libghostty` renderer host
- Rich terminal behaviors such as proper native selection and full VT rendering
- iPad-focused split-pane workspace and more polished mobile shell ergonomics

## Near-Term Next Steps

1. Vendor or wrap a Ghostty fork for Apple platforms.
2. Expose a remote-output bridge into Ghostty term state.
3. Replace the placeholder terminal surface with a real native renderer host.
4. Add richer terminal UX such as selection, search, and better copy/paste.
5. Polish iPad and large-screen workspace layouts.

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
