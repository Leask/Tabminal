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
    public private(set) var terminalRenderFeed = TerminalRenderFeed()
    public private(set) var terminalInputFeed = TerminalInputFeed()
    public let ghosttyController = GhosttyTerminalController()

    public let server: TabminalServerEndpoint
    public let sessionID: String

    private let apiClient: TabminalAPIClient
    private let socketChannel: TabminalWebSocketChannel
    private var receiveTask: Task<Void, Never>?
    private var wantsConnection: Bool = false
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
        guard !wantsConnection else {
            return
        }

        wantsConnection = true
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            guard let self else {
                return
            }

            await connectionLoop()
        }
    }

    public func disconnect() {
        wantsConnection = false
        receiveTask?.cancel()
        receiveTask = nil
        connectionState = .idle
        Task {
            await socketChannel.disconnect()
        }
    }

    public func sendLocalInput(
        _ data: String,
        renderer: TerminalRenderer = .current
    ) {
        guard !data.isEmpty else {
            return
        }

        if renderer == .ghostty {
            terminalInputFeed.enqueue(data)
            ghosttyController.enqueueInput(data)
            return
        }

        sendInput(data)
    }

    public func handleGhosttyWrite(_ data: String) {
        guard !data.isEmpty else {
            return
        }
        sendInput(data)
    }

    public func sendInput(_ data: String) {
        Task {
            do {
                try await socketChannel.send(.input(data))
            } catch {
                await MainActor.run {
                    connectionState = .reconnecting
                }
                await socketChannel.disconnect()
            }
        }
    }

    public func sendLine(_ line: String) {
        sendLocalInput(line)
        sendLocalInput("\r")
    }

    public func sendControl(_ data: String) {
        sendLocalInput(data)
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
                await socketChannel.disconnect()
            }
        }
    }

    private func connectionLoop() async {
        while wantsConnection && !Task.isCancelled {
            let request = apiClient.makeWebSocketRequest(
                server: server,
                sessionID: sessionID
            )

            if connectionState != .connected {
                connectionState = connectionState == .idle
                    ? .connecting
                    : .reconnecting
            }

            await socketChannel.connect(with: request)

            do {
                try await receiveLoop()
            } catch {
                if !wantsConnection || Task.isCancelled {
                    break
                }

                connectionState = .reconnecting
                await socketChannel.disconnect()
                try? await Task.sleep(for: .seconds(2))
            }
        }

        if Task.isCancelled {
            await socketChannel.disconnect()
        }
    }

    private func receiveLoop() async throws {
        while !Task.isCancelled && wantsConnection {
            let message = try await socketChannel.receive()
            apply(message)
        }
    }

    private func apply(_ message: TabminalInboundMessage) {
        switch message {
        case .snapshot(let text):
            terminalBuffer.replace(with: text)
            terminalTranscript = terminalBuffer.text
            terminalRenderFeed.replaceSnapshot(with: text)
            ghosttyController.replaceSnapshot(with: text)
            connectionState = .connected
        case .output(let text):
            terminalBuffer.append(text)
            terminalTranscript = terminalBuffer.text
            terminalRenderFeed.appendOutput(text)
            ghosttyController.appendOutput(text)
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
