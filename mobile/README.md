# Tabminal Mobile

## Goal

Build native mobile clients that reuse the current Tabminal server protocol
and session model while replacing the browser runtime with native terminal
surfaces.

The constraints for this track are:

- Keep the existing server protocol and deployment model.
- Use a full `libghostty` path on iOS.
- Use a conservative and production-friendly renderer path on Android, with
  `libghostty-vt` as the terminal emulation core.
- Share protocol and state logic where it is worth sharing.
- Keep the shell, rendering, input, and platform chrome native.

## Existing Server Contract

The current backend already exposes the protocol required for a native mobile
client:

- Auth via SHA-256 password hash in `Authorization` or `token`
- Heartbeat sync via `POST /api/heartbeat`
- Session create/delete via `/api/sessions`
- Session websocket via `/ws/:sessionId`
- File APIs via `/api/fs/*`
- Cluster registry via `/api/cluster`

Current code references:

- `src/auth.mjs`
- `src/server.mjs`
- `src/fs-routes.mjs`
- `public/app.js`

## Architecture

```text
+---------------------------------------------------------------+
|                        Tabminal Server                        |
| REST: /api/heartbeat /api/sessions /api/fs/* /api/cluster     |
| WS:   /ws/:sessionId                                          |
+------------------------------+--------------------------------+
                               |
                Shared protocol contract and state model
                               |
+------------------------------+--------------------------------+
|                                                           |
|  iOS                                                   Android
|  SwiftUI shell                                         Compose shell
|  Native networking + WS                               Native networking + WS
|  Full libghostty renderer                             libghostty-vt
|  Native text/input/IME bridge                         Native renderer
|                                                           |
+---------------------------------------------------------------+
```

## Module Plan

Phase 1 favors protocol-first implementation over immediate cross-language
sharing. That keeps the iOS path fast and aligned with `libghostty`.

Initial layout:

- `mobile/README.md`
  Global architecture and rollout plan.
- `mobile/ios`
  Swift package, generated app host, and iOS shell scaffolding.
- `mobile/android`
  Deferred until the iOS protocol and state model stabilizes.

Planned medium-term split:

- `mobile-core`
  Shared protocol/state logic once the iOS flow is proven stable.
- `ios-shell`
  SwiftUI + `libghostty` + Apple platform integrations.
- `android-shell`
  Compose + native renderer + Android platform integrations.

## iOS Direction

iOS is the lead platform because the `libghostty` integration path is most
natural there.

Decisions:

- Use Swift and SwiftUI for the app shell.
- Keep terminal rendering inside a dedicated `GhosttyTerminalSurface`.
- Keep protocol, session, heartbeat, and cluster state outside the view layer.
- Do not mirror the web UI 1:1. Mobile gets a native shell with the same
  server protocol.
- Use the newest Apple SDK features where they improve fit and finish, but do
  not tie the protocol or transport layer to Apple-only APIs.

## Android Direction

Android is explicitly a second phase.

Decisions:

- Use `libghostty-vt` for terminal emulation.
- Use a renderer that is stable on Android and fits native input/IME behavior.
- Keep the same server protocol and session state model.
- Revisit deeper code sharing after iOS has validated the transport and state
  model.

## Phased Rollout

1. Freeze the protocol and data model for mobile.
2. Implement iOS transport, session lifecycle, and shell scaffolding.
3. Integrate full `libghostty` rendering on iOS.
4. Add file flows, cluster UI, and background reconnect behavior.
5. Start Android with the validated protocol and state layer.

## Current Status

This branch starts Phase 1 and the first iOS slice:

- Protocol and transport models are moved into `mobile/ios`.
- A native iOS-facing shell module is scaffolded.
- A minimal iOS app host exists and builds against the local Swift package.
- A CLI launch path exists via `mobile/ios/run-sim.sh`.
- `libghostty` is represented as a dedicated bridge surface, ready for the
  real renderer integration step.

## Current iOS CLI Flow

Current bootstrap path:

1. Generate the project from `mobile/ios/project.yml` using `xcodegen`.
2. Build the iOS app against the local package graph.
3. Install the app into the selected simulator.
4. Launch the app via `simctl`.

Entry command:

```bash
cd mobile/ios
./run-sim.sh
```

Optional device argument:

```bash
cd mobile/ios
./run-sim.sh "iPad Pro 11-inch (M5)"
```

Prerequisites:

- Xcode with iOS simulator platform installed
- `xcodegen` available on `PATH`
