# Security Notes

Last updated: 2026-04-10

This document records the current Tabminal authentication design, the security
properties it provides, known gaps, and likely future hardening paths.

Tabminal is a high-privilege product. A logged-in client can control terminals,
read and write files, manage ACP agents, and send local context to external AI
providers. Authentication should therefore be treated as infrastructure, not UI
state.

## Current Auth Design

### Password Login

The web client submits the entered password to the server over the active HTTP
transport:

```text
POST /api/auth/login
{ "password": "<plain-text password>" }
```

The server hashes that password and checks it against the configured
`config.passwordHash`. The browser no longer computes or stores a reusable
password hash, and the login endpoint no longer accepts the old
`passwordHash` field.

### Access Token

After login or refresh, the server issues an opaque access token.

Current properties:

- token prefix: `ta_`
- lifetime: `15 minutes`
- storage: browser memory plus current in-page runtime state
- transport:
  - `Authorization: Bearer <access-token>` for HTTP APIs
  - `?token=<access-token>` for browser WebSocket connections and media URLs
- validation: server-side in-memory token store

Access tokens are short-lived and are replaced on refresh.

### Refresh Token

The server also issues an opaque refresh token.

Current properties:

- token prefix: `tr_`
- lifetime: `90 days`
- storage: browser `localStorage`
- rotation: every successful refresh returns a new refresh token and invalidates
  the old one
- persistence: server stores only a SHA-256 hash of the refresh token in
  `~/.tabminal/auth-sessions.json`

Refresh tokens are host-scoped by localStorage key:

```text
tabminal_auth_state:<hostId>
```

The stored browser object currently contains:

```json
{
  "accessToken": "ta_...",
  "accessTokenExpiresAt": "...",
  "refreshToken": "tr_...",
  "refreshTokenExpiresAt": "..."
}
```

Legacy password-hash token storage is not supported. Old browser keys from
earlier versions are ignored and cannot be exchanged for access or refresh
tokens.

### Refresh Sessions

Each refresh token belongs to a server-side refresh session.

Persisted fields include:

- `id`
- `passwordFingerprint`
- `refreshTokenHash`
- `createdAt`
- `lastSeenAt`
- `refreshExpiresAt`
- `rotatedAt`
- `revokedAt`
- `userAgent`

The server exposes a safe summary list through:

```text
GET /api/auth/sessions
```

The response intentionally does not include tokens or token hashes.

### Session Management UI

The web UI includes a lightweight login-session modal per host.

Current actions:

- list refresh sessions for the selected host
- revoke a selected non-current session
- log out all other sessions
- log out the current session

This gives users a way to recover from forgotten browsers or misplaced devices.

### Logout

Current logout behavior:

- server revokes the refresh session
- server removes active access tokens for that session
- browser clears local auth state
- current browser returns to the login flow

## Current Security Properties

### Strengths

- The configured password hash is no longer a long-lived API bearer token.
- Access tokens are short-lived.
- Refresh tokens are opaque and rotated.
- Server stores refresh token hashes, not raw refresh tokens.
- Refresh sessions are revocable.
- Password changes invalidate old refresh sessions because each session stores
  a non-login password fingerprint for the password it was created under.
- WebSocket connections use short-lived access tokens rather than the password
  hash.
- The API contract is suitable for future native clients.

### Known Gaps

#### Refresh Tokens Are JS-Readable

The largest remaining web risk is that refresh tokens live in `localStorage`.

If an attacker gets JavaScript execution in the Tabminal origin, they can read
`tabminal_auth_state:<hostId>` and exfiltrate the refresh token. Because refresh
tokens last up to 90 days, this can become a long-lived credential theft unless
the session is revoked.

This is the main reason an HttpOnly-cookie design would be stronger.

#### Access Tokens Are Also Stored in localStorage

The current browser state persists access tokens as part of the same auth state.
Access tokens are short-lived, but storing them still increases the value of an
XSS bug.

A stricter future model should keep access tokens in memory only.

#### Password Hash Login Contract Is Still Legacy-Shaped

The client still sends `SHA-256(password)` to the server. This preserves
compatibility but is not a full modern password-auth design.

A stronger future design could send the password over HTTPS and let the server
verify against an Argon2id password hash. That would require a config/storage
migration.

#### Local HTTP Deployments Cannot Use Secure Cookies

Many Tabminal deployments use local HTTP origins such as:

```text
http://127.0.0.1:9846
http://192.168.1.83:9846
```

Secure cookies require HTTPS in normal browser behavior. Any future cookie-based
refresh-token model must either:

- omit `Secure` on local HTTP deployments, or
- require HTTPS for the stronger mode.

#### CSRF Needs Design if Cookies Become Auth

Bearer tokens in headers are naturally resistant to classic CSRF because another
site cannot set the `Authorization` header in a normal form submission.

HttpOnly cookies are sent automatically by the browser. If refresh tokens move to
cookies, mutating endpoints need explicit CSRF handling or strict origin checks.

Important high-privilege endpoints include:

- terminal input
- file write/delete/rename
- agent prompt submission
- session deletion
- host registry updates
- auth session revocation

## Recommended Future Hardening

### Option A: Keep Current localStorage Model

This is the current implementation.

Pros:

- simple
- works for IP, localhost, LAN hostnames, and public domains
- same shape works for web and native clients
- easy multi-host isolation with localStorage keys
- easy to debug and support

Cons:

- XSS can steal refresh tokens
- access tokens persist across page reloads
- localStorage must be treated as sensitive data

Best fit:

- trusted local deployments
- early native-client API stabilization
- users who prefer explicit client-side token storage

### Option B: HttpOnly Refresh Cookie + In-Memory Access Token

This is the strongest web-oriented option discussed so far.

Design:

- refresh token is stored in an HttpOnly cookie
- access token is returned by `/api/auth/login` and `/api/auth/refresh`
- access token is stored only in JavaScript memory
- page reload calls `/api/auth/refresh` to get a new access token
- WebSockets continue to use `?token=<access-token>`

Cookie attributes:

```text
HttpOnly
SameSite=Lax
Secure when HTTPS
no Domain attribute by default
```

Pros:

- XSS cannot directly read or exfiltrate the 90-day refresh token
- closing the page drops the access token
- refresh-token theft becomes much harder
- still works with WebSocket access tokens

Cons:

- requires cookie handling per host/origin
- changing from IP to DNS name requires login again
- local HTTP cannot use `Secure`
- needs CSRF mitigation for cookie-authenticated refresh/logout/session APIs
- native clients need a separate secure-storage refresh-token path
- multi-host web state becomes less uniform than localStorage

Best fit:

- public or semi-public deployments
- HTTPS deployments with stable hostnames
- users prioritizing XSS credential-theft resistance

### Option C: Full Server-Side Cookie Session

Design:

- browser only has a session cookie
- all HTTP APIs authenticate through the cookie
- WebSocket uses a short-lived ticket minted over HTTP

Pros:

- strongest browser ergonomics
- no bearer token storage in JavaScript
- easy server-side revocation

Cons:

- larger rewrite
- must solve CSRF thoroughly
- WebSocket ticketing is required
- diverges from native-client auth shape
- cross-host behavior is more complex

Best fit:

- future enterprise-style deployment mode
- browser-first installations behind HTTPS

## Native Client Guidance

A future native app should not copy the web localStorage compromise.

Recommended native shape:

- store refresh token in Keychain / Keystore / platform secure storage
- keep access token in memory
- refresh on launch and before expiry
- support session revocation through the same `/api/auth/sessions` APIs

If the web moves to HttpOnly cookies later, native clients can still keep the
same logical access/refresh model with a different storage backend.

## Operational Notes

- `~/.tabminal/auth-sessions.json` is sensitive metadata. It does not contain
  raw refresh tokens, but it can reveal session existence and user-agent data.
- Deleting `auth-sessions.json` logs out all persisted refresh sessions.
- Restarting the server clears access tokens because access tokens are in memory.
  Clients with valid refresh tokens should recover automatically.
- Changing the configured password invalidates existing refresh sessions.

## Current Recommendation

The current localStorage-based rotating refresh token model is a reasonable
intermediate step. It is materially stronger than using the password hash as a
long-lived API token.

For a future public or multi-device security hardening pass, the recommended
next design is:

```text
HttpOnly refresh cookie + in-memory access token
```

That migration should be done as a focused auth-layer change and should include:

- cookie attribute policy
- CSRF strategy
- local HTTP fallback rules
- native-client storage rules
- migration from `tabminal_auth_state:<hostId>`
