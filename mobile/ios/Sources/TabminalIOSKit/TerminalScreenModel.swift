import Foundation
import Observation
import TabminalMobileCore

@MainActor
@Observable
public final class TerminalScreenModel {
    public enum ConnectionState: String, Sendable {
        case idle
        case connecting
        case connected
        case reconnecting
        case terminated
    }

    public private(set) var connectionState: ConnectionState = .idle
    public private(set) var terminalTitle: String = "Terminal"
    public private(set) var workingDirectory: String = ""
    public private(set) var terminalTranscript: String = ""

    public let server: TabminalServerEndpoint
    public let sessionID: String

    private let apiClient: TabminalAPIClient
    private let socketChannel: TabminalWebSocketChannel
    private var receiveTask: Task<Void, Never>?
    private var terminalBuffer = TerminalPlainTextBuffer()

    public init(
        server: TabminalServerEndpoint,
        sessionID: String,
        apiClient: TabminalAPIClient = TabminalAPIClient(),
        socketChannel: TabminalWebSocketChannel = TabminalWebSocketChannel()
    ) {
        self.server = server
        self.sessionID = sessionID
        self.apiClient = apiClient
        self.socketChannel = socketChannel
    }

    public func connect() {
        guard connectionState == .idle || connectionState == .reconnecting else {
            return
        }

        connectionState = .connecting
        let request = apiClient.makeWebSocketRequest(
            server: server,
            sessionID: sessionID
        )
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            guard let self else {
                return
            }

            await socketChannel.connect(with: request)
            await receiveLoop()
        }
    }

    public func disconnect() {
        receiveTask?.cancel()
        receiveTask = nil
        connectionState = .idle
        Task {
            await socketChannel.disconnect()
        }
    }

    public func sendInput(_ data: String) {
        Task {
            do {
                try await socketChannel.send(.input(data))
            } catch {
                await MainActor.run {
                    connectionState = .reconnecting
                }
            }
        }
    }

    public func sendLine(_ line: String) {
        sendInput(line)
        sendInput("\r")
    }

    public func sendControl(_ data: String) {
        sendInput(data)
    }

    public func resize(cols: Int, rows: Int) {
        let payload = TabminalResizePayload(cols: cols, rows: rows)
        Task {
            do {
                try await socketChannel.send(.resize(payload))
            } catch {
                await MainActor.run {
                    connectionState = .reconnecting
                }
            }
        }
    }

    private func receiveLoop() async {
        do {
            while !Task.isCancelled {
                let message = try await socketChannel.receive()
                apply(message)
            }
        } catch {
            if !Task.isCancelled {
                connectionState = .reconnecting
            }
        }
    }

    private func apply(_ message: TabminalInboundMessage) {
        switch message {
        case .snapshot(let text):
            terminalBuffer.replace(with: text)
            terminalTranscript = terminalBuffer.text
            connectionState = .connected
        case .output(let text):
            terminalBuffer.append(text)
            terminalTranscript = terminalBuffer.text
            connectionState = .connected
        case .meta(let delta):
            if let title = delta.title, !title.isEmpty {
                terminalTitle = title
            }
            if let cwd = delta.cwd {
                workingDirectory = cwd
            }
        case .status(let delta):
            switch delta.status {
            case "terminated":
                connectionState = .terminated
            case "ready":
                connectionState = .connected
            default:
                connectionState = .connected
            }
        }
    }
}
