# Tabminal Relay Planning

This document captures the initial planning notes for a Tabminal-native relay
service. The goal is to provide an official, open-source tunnel path for users
who do not have a safe or convenient inbound network setup, without depending on
third-party commercial tunnel products.

## 1. Product Goal

Tabminal is a host-side remote terminal service. Today, users need one of these
network arrangements to access it remotely:

- A directly reachable host and open port.
- A VPN or private network.
- Cloudflare Tunnel or another third-party tunnel.
- Manual reverse proxy and TLS setup.

For many users this is too much operational work. The desired product shape is:

```text
User starts Tabminal on an internal/private machine
    -> Tabminal opens an outbound tunnel to an official relay
    -> The relay assigns a public HTTPS/WSS URL
    -> The browser opens that URL
    -> Traffic is forwarded back through the outbound tunnel
    -> The existing Tabminal login and API continue to work
```

The official relay should be available as a hosted service, but the relay
implementation should also be open source and self-hostable.

## 2. Non-Goals for the First Version

The first version should stay narrow. Tabminal does not need a generic tunneling
system at the beginning.

Do not build these in the MVP:

- Arbitrary TCP forwarding.
- UDP forwarding.
- SOCKS proxy support.
- SSH forwarding as a generic feature.
- Multi-port service mapping.
- Arbitrary reverse proxying for unrelated web apps.
- Custom domains.
- Team administration.
- Relay-blind end-to-end encryption.
- Full hosted account dashboard.

The MVP should only expose the current Tabminal HTTP/WebSocket service.

## 3. Recommended Architecture

Tabminal should use an application-layer reverse tunnel, not a raw TCP tunnel.
The current Tabminal surface is already HTTP and WebSocket based:

- Static frontend assets.
- REST API.
- Terminal WebSocket.
- ACP agent WebSocket.
- File and media APIs.

Recommended architecture:

```text
Browser
  |
  | HTTPS / WSS
  v
Tabminal Relay
  |
  | outbound persistent tunnel from host
  | WebSocket transport in MVP
  v
Tabminal Host Connector
  |
  | loopback HTTP/WSS
  v
Tabminal Local Server
```

Roles:

| Component | Responsibility |
| --- | --- |
| Tabminal local server | Existing local Tabminal server and auth system. |
| Tabminal tunnel connector | Runs on the user's host, opens an outbound relay connection, forwards requests. |
| Tabminal relay | Public ingress, TLS, hostname routing, tunnel registry, stream routing, limits. |

The connector can initially be embedded in the Tabminal server process. A
separate daemon can be considered later if needed.

## 4. Why L7 HTTP/WebSocket Instead of Generic TCP

A generic tunnel such as frp/rathole/chisel is powerful, but Tabminal has a
clearer and smaller requirement. L7 forwarding is preferable for the first
native implementation because:

- The security boundary is smaller and easier to audit.
- The relay can understand HTTP and WebSocket lifecycle events.
- Backpressure and cancellation can be integrated with request/stream state.
- Abuse controls are easier at the HTTP layer.
- The product UX can stay focused on one exposed Tabminal host.
- The existing Tabminal auth, APIs, and WebSocket protocols remain unchanged.

A generic TCP tunnel can remain a separate BYO option documented for advanced
users.

## 5. Reference Projects and What to Learn

The plan is not to wrap a commercial product, but these systems are useful
references.

### Product References

| Project | What to learn |
| --- | --- |
| ngrok | Best-in-class tunnel UX, agent registration, hosted endpoint model. |
| Cloudflare Tunnel | Production connector reliability, hostname routing, HA connectors, policy layering. |
| Tailscale Funnel | Device identity, safe public sharing, privacy-oriented design tradeoffs. |
| zrok / OpenZiti | Public/private sharing model and zero-trust framing. |
| Pangolin | Self-hosted remote access product shape and identity integration. |

### Open-Source Implementation References

| Project | What to learn |
| --- | --- |
| frp | Mature reverse proxy lifecycle, subdomain routing, auth, dashboard, configuration model. |
| rathole | Lightweight reverse tunnel, token auth, transport abstraction, simple configs. |
| chisel | HTTP/WebSocket-based tunnel, reverse forwarding, multiplexed stream design. |
| bore | Minimal tunnel UX and low-complexity public port exposure. |
| inlets | Client-initiated tunnel product and operational model. |

For Tabminal, copy concepts, not scope. The native relay should be specialized
for Tabminal HTTP/WSS traffic.

## 6. Transport Choice

Candidate transports:

| Transport | Pros | Cons | Recommendation |
| --- | --- | --- | --- |
| WebSocket + custom multiplexing | Easy to implement, widely proxy-compatible, Node-friendly. | Must implement stream IDs, backpressure, and framing. | Best MVP choice. |
| HTTP/2 streams | Native multiplexing and flow control. | More proxy/runtime edge cases and more complex implementation. | Consider after MVP. |
| QUIC / WebTransport | Modern, efficient, avoids head-of-line blocking. | More deployment and compatibility risk. | Not for MVP. |

MVP recommendation: one outbound WSS control/data connection from connector to
relay, with application-level multiplexing.

## 7. Draft Relay Protocol

The connector opens a persistent WSS connection to the relay.

Example control flow:

```json
{ "type": "hello", "version": 1, "tunnelId": "...", "token": "..." }
{ "type": "hello_ok", "publicUrl": "https://blue-river-42.tabminal.app" }
{ "type": "ping", "now": 1770000000000 }
{ "type": "pong", "now": 1770000000001 }
```

Example request stream flow:

```json
{ "type": "request_open", "streamId": "s1", "method": "GET", "path": "/api/sessions", "headers": {} }
{ "type": "request_body", "streamId": "s1", "data": "base64..." }
{ "type": "request_end", "streamId": "s1" }
{ "type": "response_head", "streamId": "s1", "status": 200, "headers": {} }
{ "type": "response_body", "streamId": "s1", "data": "base64..." }
{ "type": "response_end", "streamId": "s1" }
```

Example stream close:

```json
{ "type": "stream_close", "streamId": "s1", "reason": "client_closed" }
```

WebSocket forwarding can use the same stream abstraction:

```text
browser WebSocket <-> relay stream <-> connector <-> local Tabminal WebSocket
```

Important protocol requirements:

- Every request/connection has a unique `streamId`.
- Either side can close a stream.
- Request and response bodies must support streaming.
- Backpressure must exist before large file/media APIs are exposed.
- The connector must be able to cancel a local request if the browser disconnects.
- The relay must close all streams when the connector disconnects.
- Protocol versioning must be explicit from day one.

## 8. Public URL Model

Possible modes:

### Temporary Anonymous Tunnel

```bash
tabminal tunnel
```

Output:

```text
Tabminal tunnel connected.
Public URL: https://blue-river-42.tabminal.app
Expires: 8 hours
```

This is the simplest MVP mode. It should use an unguessable random hostname and
an expiry.

### Account-Bound Stable Tunnel

```bash
tabminal login
tabminal tunnel --name flora
```

Output:

```text
Public URL: https://flora-leask.tabminal.app
```

This requires an official account/device model and can be a later phase.

### Self-Hosted Relay

```bash
tabminal relay
tabminal tunnel --relay https://relay.example.com
```

This should be a first-class design goal, even if it is not the first hosted UX.

## 9. Security Model

Tabminal is a high-privilege remote terminal. Exposing it through an official
relay increases risk, so the relay must have a narrow, explicit threat model.

### Layer 1: Connector Authentication

The host connector must authenticate to the relay. Options:

- One-time registration token.
- Device token.
- Account token.
- Ephemeral token for temporary tunnels.

The relay must not allow arbitrary clients to claim existing tunnel hostnames.

### Layer 2: Existing Tabminal Authentication

The relay does not replace Tabminal login. Public relay URLs must still go
through the existing Tabminal auth system:

- Password challenge/response.
- Access token.
- Refresh token.
- Session management and revoke.
- WebSocket auth via subprotocol.

Relay access only gets traffic to Tabminal. Tabminal auth controls terminal
access.

### Layer 3: Relay Access Policy

Future relay-side controls can include:

- Tunnel expiry.
- IP allowlist.
- Max concurrent browser clients.
- Max concurrent streams.
- Request rate limits.
- Request body limits.
- Idle timeout.
- Abuse detection.
- Audit log.
- Account-level access policy.

## 10. TLS and Trust Boundary

The recommended MVP trust model:

```text
Browser TLS terminates at the official relay.
Relay forwards authenticated HTTP/WSS traffic to the connector.
Existing Tabminal auth still protects the app.
```

This means the official relay can technically observe HTTP metadata and payload.
That is acceptable for MVP only if it is documented clearly.

For stricter environments, users should self-host the relay.

A future relay-blind mode may be considered later:

```text
Browser <-> Host encrypted inner session
Relay only forwards opaque bytes
```

But relay-blind mode is significantly harder because of:

- Browser certificate trust.
- Public hostname certificate management.
- Inner TLS or application encryption.
- WebSocket upgrade handling.
- Reduced ability for relay-side abuse controls.

Do not block the MVP on relay-blind E2E transport.

## 11. Token and Header Handling

The relay must be careful with credentials.

Requirements:

- Do not log `Authorization` headers.
- Do not log cookies.
- Do not log `Sec-WebSocket-Protocol` values containing Tabminal access tokens.
- Do not log query strings by default.
- Scrub known sensitive headers in error logs.
- Preserve required WebSocket upgrade headers.
- Preserve Tabminal WebSocket subprotocol behavior.

Current Tabminal WebSocket auth uses subprotocols such as:

```text
Sec-WebSocket-Protocol: tabminal.v1, tabminal.auth.<access-token>
```

The relay must forward enough protocol information for the local Tabminal server
to authenticate, but must not accidentally echo or log token-bearing protocol
values.

## 12. Relay Data Model Draft

```ts
type Tunnel = {
    id: string;
    publicHost: string;
    ownerId?: string;
    connectorId: string;
    status: 'connected' | 'disconnected';
    createdAt: number;
    expiresAt?: number;
    lastSeenAt: number;
    localTarget: string;
    policy: TunnelPolicy;
};

type TunnelToken = {
    id: string;
    tunnelId: string;
    tokenHash: string;
    createdAt: number;
    expiresAt: number;
    revokedAt?: number;
};

type ConnectorConnection = {
    tunnelId: string;
    protocolVersion: number;
    activeStreams: Map<string, StreamState>;
    connectedAt: number;
    lastSeenAt: number;
};
```

## 13. MVP Feature Boundary

The first implementation should support:

- `tabminal tunnel` command.
- Outbound connector WSS connection.
- Random public HTTPS URL.
- HTTP request forwarding.
- WebSocket forwarding.
- Tunnel heartbeat.
- Reconnect.
- Tunnel close on process exit.
- Tunnel expiry.
- Basic relay-side rate limit.
- Token-scrubbed logs.
- Stream concurrency limits.
- Self-host relay command or package.

The first implementation should not support:

- Custom domains.
- Generic TCP/UDP.
- Multiple local services.
- Team access management.
- Account dashboard.
- Relay-blind encryption.
- Permanent device registry unless needed for the hosted beta.

## 14. CLI Shape Draft

Official hosted relay:

```bash
tabminal tunnel
```

Explicit relay:

```bash
tabminal tunnel --relay https://relay.example.com
```

Temporary expiry:

```bash
tabminal tunnel --ttl 8h
```

Named tunnel, future account mode:

```bash
tabminal tunnel --name flora
```

Self-hosted relay:

```bash
tabminal relay --host 0.0.0.0 --port 443
```

## 15. Development Plan

### Phase 0: Design

- Write a formal tunnel protocol document.
- Define the MVP threat model.
- Decide hosted relay trust boundary.
- Decide whether the connector is embedded or a separate package.

### Phase 1: Local Prototype

- Build relay process locally.
- Build connector inside Tabminal server.
- Forward HTTP requests over one WSS connector.
- Add simple stream IDs and response frames.

### Phase 2: WebSocket Support

- Forward terminal WebSocket.
- Forward ACP agent WebSocket.
- Preserve Tabminal auth subprotocol semantics.
- Test terminal attach, resize, input, and reconnect.

### Phase 3: Product MVP

- Add `tabminal tunnel` CLI.
- Print public URL.
- Add tunnel connected/disconnected UI or server log state.
- Add relay-side expiry and limits.
- Add token scrubbing.

### Phase 4: Hosted Beta

- Deploy official relay.
- Add abuse protection.
- Add tunnel observability.
- Add account/device model if needed.
- Add operational runbooks.

### Phase 5: Advanced Security

- Explore relay-blind mode.
- Explore self-host relay packaging.
- Explore stable names and custom domains.

## 16. Open Questions

- Should temporary tunnels require a Tabminal account, or can they be anonymous
  with strong random URLs and short TTLs?
- Should the official relay terminate TLS and see Tabminal traffic in MVP?
- What should the default tunnel TTL be?
- What rate limits are safe for terminal, file, and ACP workloads?
- How should official relay abuse handling work?
- Should self-host relay be part of the main package or a separate binary?
- Should tunnel connection state be visible in the web UI?
- Should the relay support multiple connector replicas for the same tunnel?

## 17. Current Recommendation

Start with a narrow, open-source, Tabminal-specific L7 relay:

- WebSocket transport from connector to relay.
- HTTP/WSS forwarding only.
- Existing Tabminal auth unchanged.
- Official relay terminates TLS in MVP.
- Self-host relay supported for stricter trust boundaries.
- No generic TCP tunnel in the first version.

This gives the product the desired zero-setup remote access experience while
keeping the implementation scope and security surface manageable.
