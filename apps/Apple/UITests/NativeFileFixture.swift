import CryptoKit
import Foundation
import XCTest

// All mutations go to the isolated runner's temporary directory.
@MainActor
struct NativeFileFixture {
    let root: String
    private let baseURL: URL
    private let accessToken: String

    static func connect() async throws -> NativeFileFixture {
        let env = ProcessInfo.processInfo.environment
        guard let root = env["TABMINAL_MOBILE_TEST_DIRECTORY"],
              root.contains("tabminal-apple."),
              let address = env["TABMINAL_MOBILE_DEBUG_URL"],
              let url = URL(string: address), url.host == "127.0.0.1",
              let password = env["TABMINAL_MOBILE_DEBUG_PASSWORD"] else {
            throw XCTSkip("Run file UI tests through test-local-ui.sh.")
        }
        let challenge = try await request(
            url: url.appendingPathComponent("api/auth/challenge"), body: [:]
        )
        let challengeID = try XCTUnwrap(challenge["challengeId"] as? String)
        let salt = try XCTUnwrap(challenge["salt"] as? String)
        let expires = try XCTUnwrap(challenge["expiresAt"] as? String)
        let key = SymmetricKey(data: SHA256.hash(data: Data(password.utf8)))
        let message = "tabminal-login-v1:\(challengeID):\(salt):\(expires)"
        let response = HMAC<SHA256>.authenticationCode(
            for: Data(message.utf8), using: key
        ).map { String(format: "%02x", $0) }.joined()
        let login = try await request(
            url: url.appendingPathComponent("api/auth/login"),
            body: ["challengeId": challengeID, "response": response]
        )
        return NativeFileFixture(
            root: root, baseURL: url,
            accessToken: try XCTUnwrap(login["accessToken"] as? String)
        )
    }

    func read(_ name: String) async throws -> [String: Any] {
        let path = try ownedPath(name)
        var url = URLComponents(
            url: baseURL.appendingPathComponent("api/fs/read"),
            resolvingAgainstBaseURL: false
        )!
        url.queryItems = [URLQueryItem(name: "path", value: path)]
        return try await Self.request(url: url.url!, token: accessToken)
    }

    func externalEdit(_ name: String, content: String) async throws {
        let snapshot = try await read(name)
        let path = try ownedPath(name)
        let inventory = try await Self.request(
            url: baseURL.appendingPathComponent("api/heartbeat"),
            token: accessToken, body: ["updates": ["sessions": []]]
        )
        let sessions = try XCTUnwrap(inventory["sessions"] as? [[String: Any]])
        let sessionID = try XCTUnwrap(sessions.first {
            $0["initialCwd"] as? String == root || $0["cwd"] as? String == root
        }?["id"] as? String)
        let result = try await Self.request(
            url: baseURL.appendingPathComponent("api/heartbeat"), token: accessToken,
            body: ["updates": ["sessions": [[
                "id": sessionID,
                "fileWrites": [["path": path, "content": content,
                    "expectedVersion": try XCTUnwrap(snapshot["version"] as? String)]]
            ]]]]
        )
        let results = try XCTUnwrap(result["fileWriteResults"] as? [[String: Any]])
        let writes = try XCTUnwrap(results.first?["fileWrites"] as? [[String: Any]])
        XCTAssertEqual(writes.first?["status"] as? String, "ok")
    }

    private func ownedPath(_ name: String) throws -> String {
        guard ["save", "conflict", "reload", "draft"].contains(name) else {
            throw NSError(domain: "NativeFileFixture", code: 1)
        }
        return root + "/native-\(name).txt"
    }

    private static func request(
        url: URL, token: String? = nil, body: [String: Any]? = nil
    ) async throws -> [String: Any] {
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = try XCTUnwrap(response as? HTTPURLResponse).statusCode
        guard (200...299).contains(status) else {
            throw NSError(domain: "NativeFileFixture.HTTP", code: status)
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
