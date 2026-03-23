import CryptoKit
import Foundation

public enum TabminalJSONCoding {
    private static func makeISO8601FractionalFormatter() -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [
            .withInternetDateTime,
            .withFractionalSeconds
        ]
        return formatter
    }

    private static func makeISO8601Formatter() -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }

    public static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let fractionalFormatter = makeISO8601FractionalFormatter()
            let fallbackFormatter = makeISO8601Formatter()

            if let date = fractionalFormatter.date(from: value) ??
                fallbackFormatter.date(from: value) {
                return date
            }

            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Expected date string to be ISO8601-formatted."
            )
        }
        return decoder
    }

    public static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            let formatter = makeISO8601FractionalFormatter()
            try container.encode(formatter.string(from: date))
        }
        return encoder
    }
}

public struct TabminalServerEndpoint: Hashable, Codable, Sendable {
    public let id: String
    public let baseURL: URL
    public let host: String
    public let token: String
    public let isPrimary: Bool

    public init(
        id: String,
        baseURL: URL,
        host: String = "",
        token: String = "",
        isPrimary: Bool = false
    ) {
        self.id = id
        self.baseURL = TabminalURL.normalizeBaseURL(baseURL)
        self.host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        self.isPrimary = isPrimary
    }

    public var displayName: String {
        if !host.isEmpty {
            return host
        }
        return baseURL.host?.lowercased() ?? "unknown"
    }

    public func resolve(_ path: String) -> URL {
        TabminalURL.resolve(path, against: baseURL)
    }

    public func webSocketURL(sessionID: String) -> URL {
        TabminalURL.webSocketURL(
            baseURL: baseURL,
            sessionID: sessionID,
            token: token
        )
    }
}

public enum TabminalURL {
    public static func normalizeBaseURL(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }

        components.query = nil
        components.fragment = nil

        if components.path.isEmpty {
            components.path = "/"
        }

        if components.path.count > 1, components.path.hasSuffix("/") {
            components.path.removeLast()
        }

        return components.url ?? url
    }

    public static func resolve(_ path: String, against baseURL: URL) -> URL {
        let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"
        guard
            var components = URLComponents(
                url: normalizeBaseURL(baseURL),
                resolvingAgainstBaseURL: false
            )
        else {
            return baseURL
        }

        components.path = normalizedPath
        return components.url ?? baseURL
    }

    public static func webSocketURL(
        baseURL: URL,
        sessionID: String,
        token: String
    ) -> URL {
        guard
            var components = URLComponents(
                url: normalizeBaseURL(baseURL),
                resolvingAgainstBaseURL: false
            )
        else {
            return baseURL
        }

        if components.scheme == "https" {
            components.scheme = "wss"
        } else if components.scheme == "http" {
            components.scheme = "ws"
        }

        components.path = "/ws/\(sessionID)"
        components.queryItems = token.isEmpty
            ? []
            : [URLQueryItem(name: "token", value: token)]
        return components.url ?? baseURL
    }
}

public enum TabminalPasswordHasher {
    public static func sha256Hex(_ password: String) -> String {
        let digest = SHA256.hash(data: Data(password.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

public struct TabminalClusterPayload: Codable, Sendable {
    public let servers: [TabminalClusterServer]

    public init(servers: [TabminalClusterServer]) {
        self.servers = servers
    }
}

public struct TabminalClusterServer: Codable, Hashable, Sendable {
    public let id: String
    public let baseURL: URL
    public let host: String
    public let token: String

    enum CodingKeys: String, CodingKey {
        case id
        case baseURL = "baseUrl"
        case host
        case token
    }

    public init(id: String, baseURL: URL, host: String = "", token: String = "") {
        self.id = id
        self.baseURL = TabminalURL.normalizeBaseURL(baseURL)
        self.host = host
        self.token = token
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        host = try container.decodeIfPresent(String.self, forKey: .host) ?? ""
        token = try container.decodeIfPresent(String.self, forKey: .token) ?? ""
        let baseURLString = try container.decode(String.self, forKey: .baseURL)
        guard let parsed = URL(string: baseURLString) else {
            throw DecodingError.dataCorruptedError(
                forKey: .baseURL,
                in: container,
                debugDescription: "Invalid baseURL"
            )
        }
        baseURL = TabminalURL.normalizeBaseURL(parsed)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(baseURL.absoluteString, forKey: .baseURL)
        try container.encode(host, forKey: .host)
        try container.encode(token, forKey: .token)
    }
}

public struct TabminalSessionEditorState: Codable, Hashable, Sendable {
    public let isVisible: Bool
    public let root: String
    public let openFiles: [String]
    public let activeFilePath: String?

    enum CodingKeys: String, CodingKey {
        case isVisible
        case root
        case openFiles
        case activeFilePath
    }

    public init(
        isVisible: Bool = false,
        root: String = "",
        openFiles: [String] = [],
        activeFilePath: String? = nil
    ) {
        self.isVisible = isVisible
        self.root = root
        self.openFiles = openFiles
        self.activeFilePath = activeFilePath
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        isVisible = try container.decodeIfPresent(
            Bool.self,
            forKey: .isVisible
        ) ?? false
        root = try container.decodeIfPresent(
            String.self,
            forKey: .root
        ) ?? ""
        openFiles = try container.decodeIfPresent(
            [String].self,
            forKey: .openFiles
        ) ?? []
        activeFilePath = try container.decodeIfPresent(
            String.self,
            forKey: .activeFilePath
        )
    }
}

public struct TabminalSessionSummary: Codable, Hashable, Sendable {
    public let id: String
    public let createdAt: Date?
    public let shell: String?
    public let initialCwd: String?
    public let title: String?
    public let cwd: String?
    public let env: String?
    public let cols: Int?
    public let rows: Int?
    public let editorState: TabminalSessionEditorState?
}

public struct TabminalRuntime: Codable, Hashable, Sendable {
    public let bootID: String?

    enum CodingKeys: String, CodingKey {
        case bootID = "bootId"
    }
}

public struct TabminalSystemSnapshot: Codable, Hashable, Sendable {
    public struct CPU: Codable, Hashable, Sendable {
        public let model: String?
        public let count: Int?
        public let speed: String?
        public let usagePercent: String?
    }

    public struct Memory: Codable, Hashable, Sendable {
        public let total: Double?
        public let free: Double?
        public let used: Double?
    }

    public let hostname: String?
    public let osName: String?
    public let ip: String?
    public let cpu: CPU?
    public let memory: Memory?
    public let uptime: Double?
    public let processUptime: Double?
}

public struct TabminalHeartbeatResponse: Codable, Sendable {
    public let sessions: [TabminalSessionSummary]
    public let system: TabminalSystemSnapshot?
    public let runtime: TabminalRuntime?
}

public struct TabminalSessionUpdate: Codable, Sendable {
    public let id: String
    public let resize: TabminalResizePayload?
    public let editorState: TabminalSessionEditorState?
    public let fileWrites: [TabminalFileWrite]?

    public init(
        id: String,
        resize: TabminalResizePayload? = nil,
        editorState: TabminalSessionEditorState? = nil,
        fileWrites: [TabminalFileWrite]? = nil
    ) {
        self.id = id
        self.resize = resize
        self.editorState = editorState
        self.fileWrites = fileWrites
    }
}

public struct TabminalHeartbeatRequest: Codable, Sendable {
    public let updates: TabminalHeartbeatUpdates

    public init(sessions: [TabminalSessionUpdate]) {
        updates = TabminalHeartbeatUpdates(sessions: sessions)
    }
}

public struct TabminalHeartbeatUpdates: Codable, Sendable {
    public let sessions: [TabminalSessionUpdate]
}

public struct TabminalResizePayload: Codable, Hashable, Sendable {
    public let cols: Int
    public let rows: Int

    public init(cols: Int, rows: Int) {
        self.cols = cols
        self.rows = rows
    }
}

public struct TabminalFileWrite: Codable, Hashable, Sendable {
    public let path: String
    public let content: String

    public init(path: String, content: String) {
        self.path = path
        self.content = content
    }
}

public struct TabminalCreateSessionResponse: Codable, Hashable, Sendable {
    public let id: String
    public let createdAt: Date?
    public let shell: String?
    public let initialCwd: String?
    public let title: String?
    public let cwd: String?
    public let cols: Int?
    public let rows: Int?
}

public struct TabminalFileEntry: Codable, Hashable, Sendable {
    public let name: String
    public let isDirectory: Bool
    public let path: String
}

public struct TabminalReadFileResponse: Codable, Hashable, Sendable {
    public let content: String
    public let readonly: Bool
}

public struct TabminalSessionMetaDelta: Codable, Hashable, Sendable {
    public let title: String?
    public let cwd: String?
    public let env: String?
    public let cols: Int?
    public let rows: Int?

    public init(
        title: String? = nil,
        cwd: String? = nil,
        env: String? = nil,
        cols: Int? = nil,
        rows: Int? = nil
    ) {
        self.title = title
        self.cwd = cwd
        self.env = env
        self.cols = cols
        self.rows = rows
    }
}

public struct TabminalStatusDelta: Codable, Hashable, Sendable {
    public let status: String
    public let code: Int?
    public let signal: String?

    public init(status: String, code: Int? = nil, signal: String? = nil) {
        self.status = status
        self.code = code
        self.signal = signal
    }
}

public enum TabminalInboundMessage: Sendable, Equatable {
    case snapshot(String)
    case output(String)
    case meta(TabminalSessionMetaDelta)
    case status(TabminalStatusDelta)
}
