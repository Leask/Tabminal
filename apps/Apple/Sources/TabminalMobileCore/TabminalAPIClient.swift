import Foundation

public enum TabminalClientError: Error, Equatable, Sendable {
    case invalidResponse
    case invalidStatus(Int, String)
    case accessLoginRequired(String?)
    case encodingFailure
}

public actor TabminalAPIClient {
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    private let authentication: TabminalAuthSession

    public init(
        session: URLSession = .shared,
        authentication: TabminalAuthSession = .shared
    ) {
        self.session = session
        self.authentication = authentication
        self.decoder = TabminalJSONCoding.makeDecoder()
        self.encoder = TabminalJSONCoding.makeEncoder()
    }

    public func login(
        server: TabminalServerEndpoint,
        password: String
    ) async throws {
        try await authentication.login(server: server, password: password)
    }

    public func clearCredentials(server: TabminalServerEndpoint) async throws {
        try await authentication.clear(server: server)
    }

    public func logout(server: TabminalServerEndpoint) async throws {
        try await authentication.logout(server: server)
    }

    public func heartbeat(
        server: TabminalServerEndpoint,
        updates: [TabminalSessionUpdate]
    ) async throws -> TabminalHeartbeatResponse {
        let request = try makeRequest(
            server: server,
            path: "/api/heartbeat",
            method: "POST",
            body: TabminalHeartbeatRequest(sessions: updates)
        )
        return try await send(
            request,
            server: server,
            decodeAs: TabminalHeartbeatResponse.self
        )
    }

    public func createSession(
        server: TabminalServerEndpoint
    ) async throws -> TabminalCreateSessionResponse {
        let request = try makeRequest(
            server: server,
            path: "/api/sessions",
            method: "POST",
            body: [String: String]()
        )
        return try await send(
            request,
            server: server,
            decodeAs: TabminalCreateSessionResponse.self
        )
    }

    public func deleteSession(
        server: TabminalServerEndpoint,
        sessionID: String
    ) async throws {
        let request = try makeRequest(
            server: server,
            path: "/api/sessions/\(sessionID)",
            method: "DELETE",
            body: Optional<String>.none
        )
        _ = try await send(request, server: server)
    }

    public func listDirectory(
        server: TabminalServerEndpoint,
        path: String
    ) async throws -> [TabminalFileEntry] {
        var request = try makeRequest(
            server: server,
            path: "/api/fs/list",
            method: "GET",
            body: Optional<String>.none
        )
        request.url = request.url?
            .appending(queryItems: [URLQueryItem(name: "path", value: path)])
        let response = try await send(
            request,
            server: server,
            decodeAs: TabminalDirectoryResponse.self
        )
        return response.items
    }

    public func readFile(
        server: TabminalServerEndpoint,
        path: String
    ) async throws -> TabminalReadFileResponse {
        var request = try makeRequest(
            server: server,
            path: "/api/fs/read",
            method: "GET",
            body: Optional<String>.none
        )
        request.url = request.url?
            .appending(queryItems: [URLQueryItem(name: "path", value: path)])
        return try await send(
            request,
            server: server,
            decodeAs: TabminalReadFileResponse.self
        )
    }

    public func writeFile(
        server: TabminalServerEndpoint,
        sessionID: String,
        path: String,
        content: String,
        expectedVersion: String,
        force: Bool = false
    ) async throws -> TabminalFileWriteResult {
        guard !expectedVersion.isEmpty else {
            throw TabminalEditorError.missingVersion
        }
        guard content.utf8.count <= 5 * 1024 * 1024 else {
            throw TabminalEditorError.writeFailed("File too large (maximum 5 MB).")
        }
        // Match the read endpoint so a save cannot make its file unreadable.
        let controlBytes = content.utf8.filter {
            $0 < 0x20 && $0 != 0x09 && $0 != 0x0a && $0 != 0x0d
        }.count
        guard !content.utf8.contains(0),
              Double(controlBytes) <= max(1, Double(content.utf8.count) * 0.01) else {
            throw TabminalEditorError.writeFailed("Unsupported text content. Your edits are kept.")
        }
        let response = try await heartbeat(
            server: server,
            updates: [TabminalSessionUpdate(
                id: sessionID,
                fileWrites: [TabminalFileWrite(
                    path: path, content: content,
                    expectedVersion: expectedVersion, force: force
                )]
            )]
        )
        let matches = response.fileWriteResults?
            .filter { $0.id == sessionID }
            .flatMap(\.fileWrites)
            .filter { $0.path == path } ?? []
        guard matches.count == 1, let result = matches.first else {
            throw TabminalEditorError.unacknowledgedWrite
        }
        if result.status == .error {
            throw TabminalEditorError.writeFailed(result.error ?? "Write failed.")
        }
        guard let version = result.version, !version.isEmpty,
              result.readonly != nil,
              result.status != .conflict || result.content != nil else {
            throw TabminalClientError.invalidResponse
        }
        return result
    }

    public func loadCluster(
        server: TabminalServerEndpoint
    ) async throws -> TabminalClusterPayload {
        let request = try makeRequest(
            server: server,
            path: "/api/cluster",
            method: "GET",
            body: Optional<String>.none
        )
        return try await send(
            request,
            server: server,
            decodeAs: TabminalClusterPayload.self
        )
    }

    public func saveCluster(
        server: TabminalServerEndpoint,
        payload: TabminalClusterPayload
    ) async throws -> TabminalClusterPayload {
        let request = try makeRequest(
            server: server,
            path: "/api/cluster",
            method: "PUT",
            body: payload
        )
        return try await send(
            request,
            server: server,
            decodeAs: TabminalClusterPayload.self
        )
    }

    public func makeWebSocketRequest(
        server: TabminalServerEndpoint,
        sessionID: String
    ) async throws -> URLRequest {
        let token = try await authentication.accessToken(server: server)
        var request = URLRequest(url: server.webSocketURL(sessionID: sessionID))
        request.httpShouldHandleCookies = true
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("tabminal.v1", forHTTPHeaderField: "Sec-WebSocket-Protocol")
        return request
    }

    private func makeRequest<Body: Encodable>(
        server: TabminalServerEndpoint,
        path: String,
        method: String,
        body: Body?
    ) throws -> URLRequest {
        var request = URLRequest(url: server.resolve(path))
        request.httpMethod = method
        request.httpShouldHandleCookies = true
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if let body {
            request.setValue(
                "application/json",
                forHTTPHeaderField: "Content-Type"
            )
            do {
                request.httpBody = try encoder.encode(body)
            } catch {
                throw TabminalClientError.encodingFailure
            }
        }

        return request
    }

    @discardableResult
    private func send(
        _ request: URLRequest,
        server: TabminalServerEndpoint
    ) async throws -> HTTPURLResponse {
        let (_, response) = try await sendAuthenticated(request, server: server)
        return response
    }

    private func send<T: Decodable>(
        _ request: URLRequest,
        server: TabminalServerEndpoint,
        decodeAs type: T.Type
    ) async throws -> T {
        let (data, _) = try await sendAuthenticated(request, server: server)
        return try decoder.decode(T.self, from: data)
    }

    private func sendAuthenticated(
        _ request: URLRequest,
        server: TabminalServerEndpoint
    ) async throws -> (Data, HTTPURLResponse) {
        var request = request
        let token = try await authentication.accessToken(server: server)
        try Task.checkCancellation()
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        do {
            return try await TabminalHTTPTransport.send(
                request, server: server, session: session
            )
        } catch TabminalClientError.invalidStatus(401, _) {
            // Middleware rejects unauthenticated requests before side effects.
            // A late 401 for an old token must not rotate the new token again.
            let refreshed = try await authentication.accessToken(
                server: server, rejecting: token
            )
            try Task.checkCancellation()
            request.setValue(
                "Bearer \(refreshed)", forHTTPHeaderField: "Authorization"
            )
            return try await TabminalHTTPTransport.send(
                request, server: server, session: session
            )
        }
    }
}

extension TabminalAPIClient {
    nonisolated static func isLikelyAccessLoginResponse(
        request: URLRequest,
        response: HTTPURLResponse,
        body: Data,
        server: TabminalServerEndpoint
    ) -> Bool {
        guard !server.isPrimary else {
            return false
        }

        if (300 ... 399).contains(response.statusCode) {
            return true
        }

        let contentType = response.value(
            forHTTPHeaderField: "Content-Type"
        )?.lowercased() ?? ""
        let bodyPrefix = String(data: body.prefix(512), encoding: .utf8)?
            .lowercased() ?? ""

        let looksHTML = contentType.contains("text/html")
            || bodyPrefix.contains("<html")
            || bodyPrefix.contains("<!doctype html")
        guard looksHTML else {
            return false
        }

        guard let requestURL = request.url,
              let finalURL = response.url else {
            return true
        }

        if requestURL.host != finalURL.host {
            return true
        }

        if !finalURL.path.hasPrefix(requestURL.path) {
            return true
        }

        return bodyPrefix.contains("cloudflare")
            || bodyPrefix.contains("access")
            || bodyPrefix.contains("sign in")
    }
}

private extension URL {
    func appending(queryItems: [URLQueryItem]) -> URL {
        guard
            var components = URLComponents(
                url: self,
                resolvingAgainstBaseURL: false
            )
        else {
            return self
        }

        var items = components.queryItems ?? []
        items.append(contentsOf: queryItems)
        components.queryItems = items
        return components.url ?? self
    }
}
