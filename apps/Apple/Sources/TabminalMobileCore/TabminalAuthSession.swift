import CryptoKit
import Foundation
import Security

public struct TabminalAuthTokens: Codable, Equatable, Sendable {
    public let accessToken: String
    public let accessTokenExpiresAt: Date
    public let refreshToken: String
    public let refreshTokenExpiresAt: Date

    public init(
        accessToken: String,
        accessTokenExpiresAt: Date,
        refreshToken: String,
        refreshTokenExpiresAt: Date
    ) {
        self.accessToken = accessToken
        self.accessTokenExpiresAt = accessTokenExpiresAt
        self.refreshToken = refreshToken
        self.refreshTokenExpiresAt = refreshTokenExpiresAt
    }

    func validate() throws {
        guard accessToken.hasPrefix("ta_"), refreshToken.hasPrefix("tr_"),
              accessToken.count > 3, refreshToken.count > 3,
              !accessToken.contains(where: \.isWhitespace),
              !refreshToken.contains(where: \.isWhitespace),
              accessTokenExpiresAt > Date(),
              refreshTokenExpiresAt > accessTokenExpiresAt else {
            throw TabminalClientError.invalidResponse
        }
    }
}

struct TabminalAuthChallenge: Decodable, Sendable {
    let challengeId: String
    let salt: String
    // Preserve the exact server string: it is part of the signed message.
    let expiresAt: String
    let algorithm: String

    func response(password: String) throws -> String {
        guard algorithm == "tabminal-hmac-sha256-login-v1",
              !challengeId.isEmpty, !salt.isEmpty else {
            throw TabminalClientError.invalidResponse
        }
        let dateData = try JSONEncoder().encode(expiresAt)
        let expiration = try TabminalJSONCoding.makeDecoder().decode(
            Date.self, from: dateData
        )
        guard expiration > Date() else {
            throw TabminalClientError.invalidStatus(
                401, "Login challenge expired. Please try again."
            )
        }
        let key = SymmetricKey(data: SHA256.hash(data: Data(password.utf8)))
        let message = "tabminal-login-v1:\(challengeId):\(salt):\(expiresAt)"
        let signature = HMAC<SHA256>.authenticationCode(
            for: Data(message.utf8), using: key
        )
        return signature.map { String(format: "%02x", $0) }.joined()
    }
}

public protocol TabminalCredentialStore: Sendable {
    func load(for key: String) throws -> TabminalAuthTokens?
    func save(_ tokens: TabminalAuthTokens?, for key: String) throws
}

public struct TabminalKeychainCredentialStore: TabminalCredentialStore {
    public init() {}

    public func load(for key: String) throws -> TabminalAuthTokens? {
        var query = query(for: key)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try check(status)
        guard let data = result as? Data else {
            throw TabminalClientError.invalidResponse
        }
        return try TabminalJSONCoding.makeDecoder().decode(
            TabminalAuthTokens.self, from: data
        )
    }

    public func save(_ tokens: TabminalAuthTokens?, for key: String) throws {
        let query = query(for: key)
        guard let tokens else {
            let status = SecItemDelete(query as CFDictionary)
            if status != errSecItemNotFound { try check(status) }
            return
        }
        let data = try TabminalJSONCoding.makeEncoder().encode(tokens)
        let values: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(
            query as CFDictionary, values as CFDictionary
        )
        if status == errSecItemNotFound {
            let attributes = query.merging(values) { _, new in new }
            try check(SecItemAdd(attributes as CFDictionary, nil))
        } else {
            try check(status)
        }
    }

    private func query(for key: String) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "com.leask.tabminal.mobile.auth-v1",
            kSecAttrAccount: key
        ]
    }

    private func check(_ status: OSStatus) throws {
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }
}

public actor TabminalAuthSession {
    public static let shared = TabminalAuthSession()

    private let session: URLSession
    private let store: any TabminalCredentialStore
    private var tokens: [String: TabminalAuthTokens] = [:]
    private var loadedKeys: Set<String> = []
    private var loggingOut: Set<String> = []
    private var generations: [String: UUID] = [:]
    private var logins: [String: Task<Void, Error>] = [:]
    private var refreshes: [String: Task<String, Error>] = [:]

    public init(
        session: URLSession = .shared,
        store: any TabminalCredentialStore = TabminalKeychainCredentialStore()
    ) {
        self.session = session
        self.store = store
    }

    public nonisolated static func credentialKey(
        for server: TabminalServerEndpoint
    ) -> String {
        "\(server.id):\(server.baseURL.absoluteString)"
    }

    public func login(
        server: TabminalServerEndpoint,
        password: String
    ) async throws {
        let key = Self.credentialKey(for: server)
        guard !loggingOut.contains(key) else { throw Self.loginRequired }
        let generation = UUID()
        generations[key] = generation
        refreshes.removeValue(forKey: key)?.cancel()
        logins.removeValue(forKey: key)?.cancel()
        let pending = Task {
            defer {
                if self.generations[key] == generation {
                    self.logins[key] = nil
                }
            }
            let challenge: TabminalAuthChallenge = try await self.post(
                server: server, path: "/api/auth/challenge", body: [:]
            )
            try self.checkGeneration(generation, for: key)
            let response = try challenge.response(password: password)
            let issued: TabminalAuthTokens = try await self.post(
                server: server, path: "/api/auth/login",
                body: ["challengeId": challenge.challengeId, "response": response]
            )
            try self.checkGeneration(generation, for: key)
            try issued.validate()
            self.tokens[key] = issued
            self.loadedKeys.insert(key)
            try self.store.save(issued, for: key)
        }
        logins[key] = pending
        try await pending.value
    }

    public func accessToken(
        server: TabminalServerEndpoint,
        rejecting rejectedToken: String? = nil
    ) async throws -> String {
        let key = Self.credentialKey(for: server)
        guard !loggingOut.contains(key) else { throw Self.loginRequired }
        if let pending = logins[key] { try await pending.value }
        guard !loggingOut.contains(key) else { throw Self.loginRequired }
        if let pending = refreshes[key] { return try await pending.value }
        if !loadedKeys.contains(key) {
            tokens[key] = try store.load(for: key)
            loadedKeys.insert(key)
        }
        let current = tokens[key]
        guard let current else { throw Self.loginRequired }
        tokens[key] = current
        if current.accessTokenExpiresAt.timeIntervalSinceNow > 60,
           current.accessToken != rejectedToken {
            return current.accessToken
        }
        guard current.refreshTokenExpiresAt > Date() else {
            try clear(server: server)
            throw Self.loginRequired
        }

        let generation = generations[key] ?? UUID()
        generations[key] = generation
        // One task owns rotation and persistence; every client awaits it.
        let pending = Task {
            do {
                let issued: TabminalAuthTokens = try await self.post(
                    server: server, path: "/api/auth/refresh",
                    body: ["refreshToken": current.refreshToken]
                )
                try self.checkGeneration(generation, for: key)
                try issued.validate()
                self.tokens[key] = issued
                try self.store.save(issued, for: key)
                self.refreshes[key] = nil
                return issued.accessToken
            } catch {
                if self.generations[key] == generation {
                    self.refreshes[key] = nil
                    if case TabminalClientError.invalidStatus(let code, _) = error,
                       code == 401 || code == 403 {
                        try self.clear(server: server)
                    }
                }
                throw error
            }
        }
        refreshes[key] = pending
        return try await pending.value
    }

    public func clear(server: TabminalServerEndpoint) throws {
        let key = Self.credentialKey(for: server)
        generations[key] = UUID()
        refreshes.removeValue(forKey: key)?.cancel()
        logins.removeValue(forKey: key)?.cancel()
        tokens[key] = nil
        loadedKeys.insert(key)
        try store.save(nil, for: key)
    }

    public func logout(server: TabminalServerEndpoint) async throws {
        let key = Self.credentialKey(for: server)
        guard loggingOut.insert(key).inserted else { return }
        defer { loggingOut.remove(key) }
        // Rotation invalidates both old tokens. Let its owner finish so logout
        // can revoke the latest pair, while refusing new authenticated work.
        if let pending = logins[key] { _ = try? await pending.value }
        if let pending = refreshes[key] { _ = try? await pending.value }
        let current: TabminalAuthTokens?
        do {
            current = try tokens[key] ?? store.load(for: key)
        } catch {
            try clear(server: server)
            throw error
        }
        try clear(server: server)
        guard let current else { return }
        var request = try makeAuthRequest(
            server: server, path: "/api/auth/logout",
            body: ["refreshToken": current.refreshToken]
        )
        request.setValue(
            "Bearer \(current.accessToken)", forHTTPHeaderField: "Authorization"
        )
        _ = try await TabminalHTTPTransport.send(
            request, server: server, session: session
        )
    }

    private func checkGeneration(_ generation: UUID, for key: String) throws {
        guard generations[key] == generation else { throw CancellationError() }
    }

    private static var loginRequired: TabminalClientError {
        .invalidStatus(401, "Authentication required. Please log in again.")
    }

    private func post<T: Decodable>(
        server: TabminalServerEndpoint,
        path: String,
        body: [String: String]
    ) async throws -> T {
        let request = try makeAuthRequest(server: server, path: path, body: body)
        let (data, _) = try await TabminalHTTPTransport.send(
            request, server: server, session: session
        )
        return try TabminalJSONCoding.makeDecoder().decode(T.self, from: data)
    }

    private func makeAuthRequest(
        server: TabminalServerEndpoint,
        path: String,
        body: [String: String]
    ) throws -> URLRequest {
        var request = URLRequest(url: server.resolve(path))
        request.httpMethod = "POST"
        request.httpShouldHandleCookies = true
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }
}

enum TabminalHTTPTransport {
    static func send(
        _ request: URLRequest,
        server: TabminalServerEndpoint,
        session: URLSession
    ) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(
            for: request, delegate: NoRedirectDelegate()
        )
        guard let response = response as? HTTPURLResponse else {
            throw TabminalClientError.invalidResponse
        }
        if TabminalAPIClient.isLikelyAccessLoginResponse(
            request: request, response: response, body: data, server: server
        ) {
            throw TabminalClientError.accessLoginRequired(
                response.value(forHTTPHeaderField: "Location")
                    ?? response.url?.absoluteString
            )
        }
        guard (200 ... 299).contains(response.statusCode) else {
            throw TabminalClientError.invalidStatus(
                response.statusCode, String(decoding: data, as: UTF8.self)
            )
        }
        return (data, response)
    }
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        // A 307/308 can otherwise forward a refresh token to an Access page.
        completionHandler(nil)
    }
}
