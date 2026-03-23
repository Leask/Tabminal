import Foundation

public struct TabminalSessionKey: Hashable, Codable, Sendable {
    public let serverID: String
    public let sessionID: String

    public init(serverID: String, sessionID: String) {
        self.serverID = serverID
        self.sessionID = sessionID
    }

    public init?(rawValue: String) {
        guard let separator = rawValue.firstIndex(of: ":") else {
            return nil
        }

        let serverID = String(rawValue[..<separator])
        let sessionID = String(rawValue[rawValue.index(after: separator)...])

        guard !serverID.isEmpty, !sessionID.isEmpty else {
            return nil
        }

        self.init(serverID: serverID, sessionID: sessionID)
    }

    public var rawValue: String {
        "\(serverID):\(sessionID)"
    }
}
