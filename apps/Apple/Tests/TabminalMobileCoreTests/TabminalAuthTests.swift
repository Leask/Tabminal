import Foundation
import Synchronization
import Testing
@testable import TabminalMobileCore

private let challengeJSON = """
{"challengeId":"challenge-123","salt":"test-salt",
"expiresAt":"2099-01-02T03:04:05.678Z",
"algorithm":"tabminal-hmac-sha256-login-v1"}
"""

private func tokenPair(
    _ suffix: String = "new",
    expired: Bool = false
) -> TabminalAuthTokens {
    TabminalAuthTokens(
        accessToken: "ta_\(suffix)",
        accessTokenExpiresAt: Date().addingTimeInterval(expired ? -1 : 900),
        refreshToken: "tr_\(suffix)",
        refreshTokenExpiresAt: Date().addingTimeInterval(86400)
    )
}

private struct StubResponse: Sendable {
    var status: Int = 200
    var body: Data
    var headers = ["Content-Type": "application/json"]

    init(_ json: String, status: Int = 200) {
        self.status = status
        body = Data(json.utf8)
    }

    init(tokens: TabminalAuthTokens) throws {
        body = try TabminalJSONCoding.makeEncoder().encode(tokens)
    }
}

private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) async throws -> StubResponse
    static let handlers = Mutex<[String: Handler]>([:])
    private let work = Mutex<Task<Void, Never>?>(nil)

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let request = request
        let handler = Self.handlers.withLock { $0[request.url!.host!]! }
        let task = Task {
            do {
                let stub = try await handler(request)
                try Task.checkCancellation()
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: stub.status,
                    httpVersion: "HTTP/1.1", headerFields: stub.headers
                )!
                client?.urlProtocol(
                    self, didReceive: response, cacheStoragePolicy: .notAllowed
                )
                client?.urlProtocol(self, didLoad: stub.body)
                client?.urlProtocolDidFinishLoading(self)
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        }
        work.withLock { $0 = task }
    }

    override func stopLoading() {
        work.withLock { $0?.cancel() }
    }
}

private final class MemoryCredentialStore: TabminalCredentialStore {
    let values = Mutex<[String: TabminalAuthTokens]>([:])
    let failingWrites = Mutex(false)

    func load(for key: String) throws -> TabminalAuthTokens? {
        values.withLock { $0[key] }
    }

    func save(_ tokens: TabminalAuthTokens?, for key: String) throws {
        if failingWrites.withLock({ $0 }) {
            throw NSError(domain: "TestCredentialStore", code: 1)
        }
        values.withLock { $0[key] = tokens }
    }
}

private actor RequestLog {
    var requests: [URLRequest] = []

    func append(_ request: URLRequest) -> Int {
        requests.append(request)
        return requests.count
    }

    func count(path: String) -> Int {
        requests.filter { $0.url?.path == path }.count
    }
}

private struct Fixture {
    let endpoint: TabminalServerEndpoint
    let store = MemoryCredentialStore()
    let session: URLSession
    let auth: TabminalAuthSession
    let api: TabminalAPIClient

    init(handler: @escaping StubURLProtocol.Handler) {
        let host = UUID().uuidString.lowercased() + ".example.invalid"
        endpoint = TabminalServerEndpoint(
            id: "main", baseURL: URL(string: "https://\(host)/prefix")!,
            token: String(repeating: "a", count: 64), isPrimary: true
        )
        StubURLProtocol.handlers.withLock { $0[host] = handler }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        session = URLSession(configuration: configuration)
        auth = TabminalAuthSession(session: session, store: store)
        api = TabminalAPIClient(session: session, authentication: auth)
    }

    func seed(_ tokens: TabminalAuthTokens) throws {
        try store.save(tokens, for: TabminalAuthSession.credentialKey(for: endpoint))
    }

    func saved() throws -> TabminalAuthTokens? {
        try store.load(for: TabminalAuthSession.credentialKey(for: endpoint))
    }
}

private func requestBody(_ request: URLRequest) -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 1024)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        data.append(contentsOf: buffer.prefix(count))
    }
    return data
}

@Test
func directoryListingDecodesCurrentServerEnvelope() async throws {
    let fixture = Fixture { request in
        #expect(request.url?.path == "/api/fs/list")
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)
        #expect(query?.queryItems?.first?.value == "/tmp/native test")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ta_new")
        return StubResponse("""
        {"items":[{"name":"hello.txt","isDirectory":false,
        "path":"/tmp/native test/hello.txt","renameable":true,
        "deleteable":true}],"creatable":true}
        """)
    }
    try fixture.seed(tokenPair())
    let entries = try await fixture.api.listDirectory(
        server: fixture.endpoint, path: "/tmp/native test"
    )
    #expect(entries.count == 1)
    #expect(entries.first?.name == "hello.txt")
    #expect(entries.first?.isDirectory == false)
}

@Test
func emptyDirectoryEnvelopeDecodesWithoutErrors() throws {
    let response = try JSONDecoder().decode(
        TabminalDirectoryResponse.self,
        from: Data(#"{"items":[],"creatable":false}"#.utf8)
    )
    #expect(response.items.isEmpty)
    #expect(!response.creatable)
}

@Test(arguments: [false, true])
func fileSavesUseVersionedHeartbeatAndExactSession(_ force: Bool) async throws {
    let fixture = Fixture { request in
        #expect(request.url?.path == "/api/heartbeat")
        let body = try JSONDecoder().decode(
            TabminalHeartbeatRequest.self, from: requestBody(request)
        )
        #expect(body.updates.sessions.count == 1)
        #expect(body.updates.sessions.first?.id == "owned-session")
        let write = body.updates.sessions.first?.fileWrites?.first
        #expect(write?.path == "/tmp/file.txt")
        #expect(write?.content == "saved text")
        #expect(write?.expectedVersion == "before")
        #expect(write?.force == force)
        return StubResponse("""
        {"sessions":[],"fileWriteResults":[{"id":"owned-session","fileWrites":[
        {"path":"/tmp/file.txt","status":"ok","version":"after","readonly":false}]}]}
        """)
    }
    try fixture.seed(tokenPair())
    let result = try await fixture.api.writeFile(
        server: fixture.endpoint, sessionID: "owned-session", path: "/tmp/file.txt",
        content: "saved text", expectedVersion: "before", force: force
    )
    #expect(result.status == .ok)
    #expect(result.version == "after")
}

@Test(arguments: ["session", "path", "missing", "duplicate", "error", "version"])
func heartbeatHTTP200AloneCannotConfirmAFileSave(_ kind: String) async throws {
    let fixture = Fixture { _ in
        var write: [String: Any] = [
            "path": kind == "path" ? "/different" : "/tmp/file.txt",
            "status": kind == "error" ? "error" : "ok",
            "readonly": false, "error": "Permission denied"
        ]
        if kind != "version" { write["version"] = "after" }
        let result: [String: Any] = [
            "id": kind == "session" ? "different" : "owned-session",
            "fileWrites": kind == "duplicate" ? [write, write] : [write]
        ]
        let body: [String: Any] = [
            "sessions": [],
            "fileWriteResults": kind == "missing" ? [] : [result]
        ]
        let json = try JSONSerialization.data(withJSONObject: body)
        return StubResponse(String(decoding: json, as: UTF8.self))
    }
    try fixture.seed(tokenPair())
    await #expect(throws: (any Error).self) {
        _ = try await fixture.api.writeFile(
            server: fixture.endpoint, sessionID: "owned-session", path: "/tmp/file.txt",
            content: "my changes", expectedVersion: "before"
        )
    }
}

@Test
func aMissingFileVersionCannotFallBackToAnUncheckedSave() async throws {
    let log = RequestLog()
    let fixture = Fixture { request in
        _ = await log.append(request)
        return StubResponse("{}")
    }
    try fixture.seed(tokenPair())
    await #expect(throws: (any Error).self) {
        _ = try await fixture.api.writeFile(
            server: fixture.endpoint, sessionID: "owned-session", path: "/tmp/file.txt",
            content: "my changes", expectedVersion: ""
        )
    }
    #expect(await log.requests.isEmpty)
}

@Test
func oversizedEditsCannotCreateAFileTheEditorCannotReadBack() async throws {
    let log = RequestLog()
    let fixture = Fixture { request in
        _ = await log.append(request)
        return StubResponse("{}")
    }
    try fixture.seed(tokenPair())
    await #expect(throws: (any Error).self) {
        _ = try await fixture.api.writeFile(
            server: fixture.endpoint, sessionID: "owned-session", path: "/tmp/file.txt",
            content: String(repeating: "x", count: 5 * 1024 * 1024 + 1),
            expectedVersion: "before"
        )
    }
    #expect(await log.requests.isEmpty)
}

@Test(arguments: ["text\u{0}data", "\u{1}\u{2}"])
func binaryEditsCannotCreateAFileTheEditorCannotReadBack(_ text: String) async throws {
    let log = RequestLog()
    let fixture = Fixture { request in
        _ = await log.append(request)
        return StubResponse("{}")
    }
    try fixture.seed(tokenPair())
    await #expect(throws: (any Error).self) {
        _ = try await fixture.api.writeFile(
            server: fixture.endpoint, sessionID: "owned-session", path: "/tmp/file.txt",
            content: text, expectedVersion: "before"
        )
    }
    #expect(await log.requests.isEmpty)
}

@Test
func challengeResponseMatchesNodeCryptoAndPreservesPasswordWhitespace() throws {
    let challenge = try JSONDecoder().decode(
        TabminalAuthChallenge.self, from: Data(challengeJSON.utf8)
    )
    // Independent Node crypto vector; Unicode is intentionally escaped.
    let response = try challenge.response(password: "  \u{5BC6}\u{78BC} abc  ")
    #expect(response == "35d6ec81b1f2df26e442a3873ebe8f2b99eec210283fb82201e8b73cd23c1180")
}

@Test(arguments: ["wrong-algorithm", "expired", "missing-salt"])
func invalidChallengesNeverSubmitLogin(_ kind: String) async throws {
    let log = RequestLog()
    let fixture = Fixture { request in
        _ = await log.append(request)
        var json = challengeJSON
        switch kind {
        case "wrong-algorithm":
            json = json.replacingOccurrences(
                of: "tabminal-hmac-sha256-login-v1", with: "unknown"
            )
        case "expired":
            json = json.replacingOccurrences(of: "2099-", with: "2000-")
        default:
            json = json.replacingOccurrences(of: "test-salt", with: "")
        }
        return StubResponse(json)
    }
    await #expect(throws: (any Error).self) {
        try await fixture.api.login(server: fixture.endpoint, password: "abc")
    }
    #expect(await log.count(path: "/api/auth/challenge") == 1)
    #expect(await log.count(path: "/api/auth/login") == 0)
    #expect(try fixture.saved() == nil)
}

@Test
func loginPersistsOnlyTokensAndRestoresAcrossClients() async throws {
    let log = RequestLog()
    let issued = tokenPair()
    let fixture = Fixture { request in
        _ = await log.append(request)
        switch request.url!.path {
        case "/api/auth/challenge":
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
            return StubResponse(challengeJSON)
        case "/api/auth/login":
            let body = try JSONDecoder().decode(
                [String: String].self, from: requestBody(request)
            )
            #expect(Set(body.keys) == ["challengeId", "response"])
            #expect(body["challengeId"] == "challenge-123")
            #expect(body["response"]?.count == 64)
            #expect(body["response"] != TabminalPasswordHasher.sha256Hex("abc"))
            #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
            return try StubResponse(tokens: issued)
        default:
            #expect(request.url?.path == "/api/heartbeat")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ta_new")
            return StubResponse("{\"sessions\":[]}")
        }
    }
    try await fixture.api.login(server: fixture.endpoint, password: "abc")
    #expect(try fixture.saved()?.accessToken == issued.accessToken)
    let restoredAuth = TabminalAuthSession(
        session: fixture.session, store: fixture.store
    )
    let restoredClient = TabminalAPIClient(
        session: fixture.session, authentication: restoredAuth
    )
    _ = try await restoredClient.heartbeat(server: fixture.endpoint, updates: [])
    let request = try await restoredClient.makeWebSocketRequest(
        server: fixture.endpoint, sessionID: "terminal"
    )
    #expect(request.url?.scheme == "wss")
    #expect(request.url?.path == "/ws/terminal")
    #expect(request.url?.query == nil)
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ta_new")
    #expect(request.value(forHTTPHeaderField: "Sec-WebSocket-Protocol") == "tabminal.v1")
    #expect(await log.count(path: "/api/auth/refresh") == 0)
}

@Test(arguments: [true, false])
func concurrentRESTAndWebSocketClientsShareRotation(expired: Bool) async throws {
    let log = RequestLog()
    let fixture = Fixture { request in
        let index = await log.append(request)
        if request.url?.path == "/api/auth/refresh" {
            let body = try JSONDecoder().decode(
                [String: String].self, from: requestBody(request)
            )
            #expect(body == ["refreshToken": "tr_old"])
            #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
            try await Task.sleep(for: .milliseconds(30))
            return try StubResponse(tokens: tokenPair())
        }
        if request.value(forHTTPHeaderField: "Authorization") == "Bearer ta_old" {
            // Some rejected requests arrive after the refresh has completed.
            try await Task.sleep(for: .milliseconds(index == 1 ? 10 : 90))
            return StubResponse("{}", status: 401)
        }
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ta_new")
        return StubResponse("{\"sessions\":[]}")
    }
    try fixture.seed(tokenPair("old", expired: expired))
    let second = TabminalAPIClient(
        session: fixture.session, authentication: fixture.auth
    )
    try await withThrowingTaskGroup(of: Void.self) { group in
        for index in 0 ..< 20 {
            group.addTask {
                let api = index.isMultiple(of: 2) ? fixture.api : second
                _ = try await api.heartbeat(server: fixture.endpoint, updates: [])
                let request = try await api.makeWebSocketRequest(
                    server: fixture.endpoint, sessionID: "terminal"
                )
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ta_new")
            }
        }
        try await group.waitForAll()
    }
    #expect(await log.count(path: "/api/auth/refresh") == 1)
    #expect(try fixture.saved()?.refreshToken == "tr_new")
}

@Test(arguments: [401, 403, 500])
func refreshErrorsClearOnlyRejectedCredentials(status: Int) async throws {
    let log = RequestLog()
    let fixture = Fixture { request in
        _ = await log.append(request)
        return StubResponse("{\"error\":\"failed\"}", status: status)
    }
    try fixture.seed(tokenPair("old", expired: true))
    let unrelated = tokenPair("unrelated")
    try fixture.store.save(unrelated, for: "another-host")
    await #expect(throws: TabminalClientError.invalidStatus(
        status, "{\"error\":\"failed\"}"
    )) {
        _ = try await fixture.api.heartbeat(server: fixture.endpoint, updates: [])
    }
    #expect(await log.count(path: "/api/auth/refresh") == 1)
    #expect(await log.count(path: "/api/heartbeat") == 0)
    #expect(try fixture.saved()?.refreshToken == (status == 500 ? "tr_old" : nil))
    #expect(try fixture.store.load(for: "another-host") == unrelated)
}

@Test(arguments: [403, 500])
func ordinaryErrorsDoNotRefreshOrReplay(status: Int) async throws {
    let log = RequestLog()
    let fixture = Fixture { request in
        _ = await log.append(request)
        return StubResponse("{}", status: status)
    }
    try fixture.seed(tokenPair("old"))
    await #expect(throws: TabminalClientError.invalidStatus(status, "{}")) {
        _ = try await fixture.api.createSession(server: fixture.endpoint)
    }
    #expect(await log.count(path: "/api/sessions") == 1)
    #expect(await log.count(path: "/api/auth/refresh") == 0)
    #expect(try fixture.saved()?.refreshToken == "tr_old")
}

@Test
func failedRetryStopsAfterOneRefresh() async throws {
    let log = RequestLog()
    let fixture = Fixture { request in
        _ = await log.append(request)
        if request.url?.path == "/api/auth/refresh" {
            return try StubResponse(tokens: tokenPair())
        }
        return StubResponse("{}", status: 401)
    }
    try fixture.seed(tokenPair("old"))
    await #expect(throws: TabminalClientError.invalidStatus(401, "{}")) {
        _ = try await fixture.api.heartbeat(server: fixture.endpoint, updates: [])
    }
    #expect(await log.count(path: "/api/heartbeat") == 2)
    #expect(await log.count(path: "/api/auth/refresh") == 1)
}

@Test
func missingCredentialsNeverUseLegacyEndpointHash() async throws {
    let log = RequestLog()
    let fixture = Fixture { request in
        _ = await log.append(request)
        return StubResponse("{}")
    }
    await #expect(throws: (any Error).self) {
        _ = try await fixture.api.heartbeat(server: fixture.endpoint, updates: [])
    }
    await #expect(throws: (any Error).self) {
        _ = try await fixture.api.makeWebSocketRequest(
            server: fixture.endpoint, sessionID: "terminal"
        )
    }
    #expect(await log.requests.isEmpty)
}

@Test
func credentialKeysSeparateHostsOriginsAndPaths() throws {
    let base = URL(string: "https://example.invalid/a")!
    let first = TabminalServerEndpoint(id: "main", baseURL: base)
    let variants = [
        TabminalServerEndpoint(id: "other", baseURL: base),
        TabminalServerEndpoint(id: "main", baseURL: URL(string: "http://example.invalid/a")!),
        TabminalServerEndpoint(id: "main", baseURL: URL(string: "https://example.invalid/b")!),
        TabminalServerEndpoint(id: "main", baseURL: URL(string: "https://example.invalid:8443/a")!)
    ]
    for other in variants {
        #expect(TabminalAuthSession.credentialKey(for: first) != TabminalAuthSession.credentialKey(for: other))
    }
}

@Test
func networkFailurePreservesRefreshCredentials() async throws {
    let fixture = Fixture { _ in throw URLError(.notConnectedToInternet) }
    try fixture.seed(tokenPair("old", expired: true))
    await #expect(throws: (any Error).self) {
        _ = try await fixture.api.heartbeat(server: fixture.endpoint, updates: [])
    }
    #expect(try fixture.saved()?.refreshToken == "tr_old")
}

private actor RefreshGate {
    private var arrived = false
    private var arrivalWaiter: CheckedContinuation<Void, Never>?
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    func enter() async {
        arrived = true
        arrivalWaiter?.resume()
        arrivalWaiter = nil
        await withCheckedContinuation { releaseWaiter = $0 }
    }

    func waitForArrival() async {
        if arrived { return }
        await withCheckedContinuation { arrivalWaiter = $0 }
    }

    func release() {
        releaseWaiter?.resume()
        releaseWaiter = nil
    }
}

@Test
func clearingDuringRefreshCannotResurrectCredentials() async throws {
    let gate = RefreshGate()
    let fixture = Fixture { _ in
        await gate.enter()
        return try StubResponse(tokens: tokenPair())
    }
    try fixture.seed(tokenPair("old", expired: true))
    let refresh = Task {
        try await fixture.auth.accessToken(server: fixture.endpoint)
    }
    await gate.waitForArrival()
    try await fixture.auth.clear(server: fixture.endpoint)
    await gate.release()
    await #expect(throws: (any Error).self) { _ = try await refresh.value }
    #expect(try fixture.saved() == nil)
}

@Test(arguments: [204, 500, 0])
func logoutRevokesAndAlwaysClearsLocalTokens(status: Int) async throws {
    let log = RequestLog()
    let fixture = Fixture { request in
        _ = await log.append(request)
        #expect(request.url?.path == "/api/auth/logout")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ta_old")
        let body = try JSONDecoder().decode(
            [String: String].self, from: requestBody(request)
        )
        #expect(body == ["refreshToken": "tr_old"])
        if status == 0 { throw URLError(.notConnectedToInternet) }
        return StubResponse("", status: status)
    }
    try fixture.seed(tokenPair("old"))
    if status == 204 {
        try await fixture.api.logout(server: fixture.endpoint)
    } else {
        await #expect(throws: (any Error).self) {
            try await fixture.api.logout(server: fixture.endpoint)
        }
    }
    #expect(try fixture.saved() == nil)
    await #expect(throws: (any Error).self) {
        _ = try await fixture.auth.accessToken(server: fixture.endpoint)
    }
    #expect(await log.count(path: "/api/auth/logout") == 1)
}

@Test
func logoutDuringRefreshRevokesRotatedPair() async throws {
    let gate = RefreshGate()
    let log = RequestLog()
    let fixture = Fixture { request in
        _ = await log.append(request)
        if request.url?.path == "/api/auth/refresh" {
            await gate.enter()
            return try StubResponse(tokens: tokenPair())
        }
        #expect(request.url?.path == "/api/auth/logout")
        let body = try JSONDecoder().decode(
            [String: String].self, from: requestBody(request)
        )
        #expect(body == ["refreshToken": "tr_new"])
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ta_new")
        return StubResponse("", status: 204)
    }
    try fixture.seed(tokenPair("old", expired: true))
    let refresh = Task {
        try await fixture.auth.accessToken(server: fixture.endpoint)
    }
    await gate.waitForArrival()
    let logout = Task { try await fixture.api.logout(server: fixture.endpoint) }
    await gate.release()
    _ = try await refresh.value
    try await logout.value
    #expect(try fixture.saved() == nil)
    #expect(await log.count(path: "/api/auth/logout") == 1)
}

@Test(arguments: ["malformed", "empty-token", "legacy-hash", "expired"])
func invalidTokenResponsesAreNotPersisted(kind: String) async throws {
    let fixture = Fixture { request in
        if request.url?.path == "/api/auth/challenge" {
            return StubResponse(challengeJSON)
        }
        if kind == "malformed" { return StubResponse("{}") }
        let accessToken: String
        switch kind {
        case "empty-token": accessToken = ""
        case "legacy-hash": accessToken = String(repeating: "a", count: 64)
        default: accessToken = "ta_new"
        }
        let invalid = TabminalAuthTokens(
            accessToken: accessToken,
            accessTokenExpiresAt: Date().addingTimeInterval(
                kind == "expired" ? -1 : 900
            ),
            refreshToken: "tr_new",
            refreshTokenExpiresAt: Date().addingTimeInterval(86400)
        )
        return try StubResponse(tokens: invalid)
    }
    await #expect(throws: (any Error).self) {
        try await fixture.api.login(server: fixture.endpoint, password: "abc")
    }
    #expect(try fixture.saved() == nil)
}

@Test
func requestsWaitForLoginInsteadOfRotatingOldCredentials() async throws {
    let gate = RefreshGate()
    let log = RequestLog()
    let fixture = Fixture { request in
        _ = await log.append(request)
        if request.url?.path == "/api/auth/challenge" {
            await gate.enter()
            return StubResponse(challengeJSON)
        }
        return try StubResponse(tokens: tokenPair())
    }
    try fixture.seed(tokenPair("old", expired: true))
    let login = Task {
        try await fixture.api.login(server: fixture.endpoint, password: "abc")
    }
    await gate.waitForArrival()
    let access = Task {
        try await fixture.auth.accessToken(server: fixture.endpoint)
    }
    await gate.release()
    try await login.value
    #expect(try await access.value == "ta_new")
    #expect(await log.count(path: "/api/auth/refresh") == 0)
    #expect(try fixture.saved()?.refreshToken == "tr_new")
}

@Test
func clearingDuringLoginPreventsCredentialResurrection() async throws {
    let gate = RefreshGate()
    let fixture = Fixture { request in
        if request.url?.path == "/api/auth/challenge" {
            return StubResponse(challengeJSON)
        }
        await gate.enter()
        return try StubResponse(tokens: tokenPair())
    }
    let login = Task {
        try await fixture.api.login(server: fixture.endpoint, password: "abc")
    }
    await gate.waitForArrival()
    try await fixture.auth.clear(server: fixture.endpoint)
    await gate.release()
    await #expect(throws: (any Error).self) { try await login.value }
    #expect(try fixture.saved() == nil)
}

@Test
func expiredRefreshIsClearedWithoutNetworkRequest() async throws {
    let log = RequestLog()
    let fixture = Fixture { request in
        _ = await log.append(request)
        return StubResponse("{}")
    }
    try fixture.seed(TabminalAuthTokens(
        accessToken: "ta_old", accessTokenExpiresAt: .distantPast,
        refreshToken: "tr_old", refreshTokenExpiresAt: .distantPast
    ))
    await #expect(throws: (any Error).self) {
        _ = try await fixture.auth.accessToken(server: fixture.endpoint)
    }
    #expect(try fixture.saved() == nil)
    #expect(await log.requests.isEmpty)
}

@Test(arguments: [401, 403])
func rejectedLoginNeverRetriesOrSavesTokens(status: Int) async throws {
    let log = RequestLog()
    let fixture = Fixture { request in
        _ = await log.append(request)
        if request.url?.path == "/api/auth/challenge" {
            return StubResponse(challengeJSON)
        }
        return StubResponse("{}", status: status)
    }
    await #expect(throws: TabminalClientError.invalidStatus(status, "{}")) {
        try await fixture.api.login(server: fixture.endpoint, password: "bad")
    }
    #expect(await log.count(path: "/api/auth/login") == 1)
    #expect(await log.count(path: "/api/auth/refresh") == 0)
    #expect(try fixture.saved() == nil)
}

@Test(arguments: [200, 302])
func accessLoginDoesNotDiscardSubHostCredentials(status: Int) async throws {
    let log = RequestLog()
    let fixture = Fixture { request in
        _ = await log.append(request)
        var response = StubResponse("<html>Cloudflare Access sign in</html>", status: status)
        response.headers = [
            "Content-Type": "text/html",
            "Location": "https://access.example.invalid/login"
        ]
        return response
    }
    let endpoint = TabminalServerEndpoint(
        id: "secondary", baseURL: fixture.endpoint.baseURL
    )
    let key = TabminalAuthSession.credentialKey(for: endpoint)
    try fixture.store.save(tokenPair("old"), for: key)
    await #expect(throws: TabminalClientError.accessLoginRequired(
        "https://access.example.invalid/login"
    )) {
        _ = try await fixture.api.heartbeat(server: endpoint, updates: [])
    }
    #expect(await log.count(path: "/api/auth/refresh") == 0)
    #expect(try fixture.store.load(for: key)?.refreshToken == "tr_old")
}

@Test
func failedPersistenceDoesNotReuseConsumedRefreshToken() async throws {
    let log = RequestLog()
    let fixture = Fixture { request in
        _ = await log.append(request)
        return try StubResponse(tokens: tokenPair())
    }
    try fixture.seed(tokenPair("old", expired: true))
    fixture.store.failingWrites.withLock { $0 = true }
    await #expect(throws: (any Error).self) {
        _ = try await fixture.auth.accessToken(server: fixture.endpoint)
    }
    #expect(try await fixture.auth.accessToken(server: fixture.endpoint) == "ta_new")
    #expect(await log.count(path: "/api/auth/refresh") == 1)
    // Failed Keychain deletion must not reload the stale value in this process.
    await #expect(throws: (any Error).self) {
        try await fixture.auth.clear(server: fixture.endpoint)
    }
    await #expect(throws: (any Error).self) {
        _ = try await fixture.auth.accessToken(server: fixture.endpoint)
    }
}
