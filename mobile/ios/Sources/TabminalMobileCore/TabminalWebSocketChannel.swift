import Foundation

public enum TabminalOutboundMessage: Sendable, Equatable {
    case input(String)
    case resize(TabminalResizePayload)

    fileprivate var envelope: OutboundEnvelope {
        switch self {
        case .input(let data):
            return OutboundEnvelope(type: "input", data: data, cols: nil, rows: nil)
        case .resize(let payload):
            return OutboundEnvelope(
                type: "resize",
                data: nil,
                cols: payload.cols,
                rows: payload.rows
            )
        }
    }
}

public actor TabminalWebSocketChannel {
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private var task: URLSessionWebSocketTask?

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func connect(with request: URLRequest) {
        disconnect()
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()
    }

    public func disconnect() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    public func send(_ message: TabminalOutboundMessage) async throws {
        guard let task else {
            throw TabminalClientError.invalidResponse
        }

        let data = try encoder.encode(message.envelope)
        let payload = String(decoding: data, as: UTF8.self)
        try await task.send(.string(payload))
    }

    public func receive() async throws -> TabminalInboundMessage {
        guard let task else {
            throw TabminalClientError.invalidResponse
        }

        let message = try await task.receive()
        let data: Data

        switch message {
        case .data(let binary):
            data = binary
        case .string(let text):
            data = Data(text.utf8)
        @unknown default:
            throw TabminalClientError.invalidResponse
        }

        let envelope = try decoder.decode(InboundEnvelope.self, from: data)
        return envelope.asMessage()
    }
}

private struct OutboundEnvelope: Codable, Sendable, Equatable {
    let type: String
    let data: String?
    let cols: Int?
    let rows: Int?
}

private struct InboundEnvelope: Decodable, Sendable {
    let type: String
    let data: String?
    let title: String?
    let cwd: String?
    let env: String?
    let cols: Int?
    let rows: Int?
    let status: String?
    let code: Int?
    let signal: String?

    func asMessage() -> TabminalInboundMessage {
        switch type {
        case "snapshot":
            return .snapshot(data ?? "")
        case "output":
            return .output(data ?? "")
        case "meta":
            return .meta(
                TabminalSessionMetaDelta(
                    title: title,
                    cwd: cwd,
                    env: env,
                    cols: cols,
                    rows: rows
                )
            )
        case "status":
            return .status(
                TabminalStatusDelta(
                    status: status ?? "unknown",
                    code: code,
                    signal: signal
                )
            )
        default:
            return .output(data ?? "")
        }
    }
}
