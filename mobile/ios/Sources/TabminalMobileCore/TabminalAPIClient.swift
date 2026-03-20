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

    public init(session: URLSession = .shared) {
        self.session = session

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        self.decoder = decoder

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        self.encoder = encoder
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
        return try await send(
            request,
            server: server,
            decodeAs: [TabminalFileEntry].self
        )
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
        path: String,
        content: String
    ) async throws {
        struct RequestBody: Codable, Sendable {
            let path: String
            let content: String
        }

        let request = try makeRequest(
            server: server,
            path: "/api/fs/write",
            method: "POST",
            body: RequestBody(path: path, content: content)
        )
        _ = try await send(request, server: server)
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

    nonisolated public func makeWebSocketRequest(
        server: TabminalServerEndpoint,
        sessionID: String
    ) -> URLRequest {
        var request = URLRequest(url: server.webSocketURL(sessionID: sessionID))
        if !server.token.isEmpty {
            request.setValue(server.token, forHTTPHeaderField: "Authorization")
        }
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
        if !server.token.isEmpty {
            request.setValue(server.token, forHTTPHeaderField: "Authorization")
        }

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
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw TabminalClientError.invalidResponse
        }

        if Self.isLikelyAccessLoginResponse(
            request: request,
            response: httpResponse,
            body: data,
            server: server
        ) {
            throw TabminalClientError.accessLoginRequired(
                httpResponse.url?.absoluteString
            )
        }

        guard (200 ... 299).contains(httpResponse.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? ""
            throw TabminalClientError.invalidStatus(
                httpResponse.statusCode,
                message
            )
        }

        return httpResponse
    }

    private func send<T: Decodable>(
        _ request: URLRequest,
        server: TabminalServerEndpoint,
        decodeAs type: T.Type
    ) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw TabminalClientError.invalidResponse
        }

        if Self.isLikelyAccessLoginResponse(
            request: request,
            response: httpResponse,
            body: data,
            server: server
        ) {
            throw TabminalClientError.accessLoginRequired(
                httpResponse.url?.absoluteString
            )
        }

        guard (200 ... 299).contains(httpResponse.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? ""
            throw TabminalClientError.invalidStatus(
                httpResponse.statusCode,
                message
            )
        }

        return try decoder.decode(T.self, from: data)
    }
}

extension TabminalAPIClient {
    static func isLikelyAccessLoginResponse(
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
