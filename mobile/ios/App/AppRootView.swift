import Observation
import SwiftUI
import TabminalIOSKit
import TabminalMobileCore

struct AppRootView: View {
    @State private var connectionModel = ServerConnectionModel()

    var body: some View {
        NavigationStack {
            Group {
                if let route = connectionModel.activeRoute {
                    TerminalScreenView(
                        server: route.server,
                        sessionID: route.sessionID,
                        onDisconnect: {
                            connectionModel.disconnect()
                        }
                    )
                } else {
                    ServerConnectionView(model: connectionModel)
                }
            }
            .navigationTitle(connectionModel.activeRoute == nil ? "Tabminal" : "")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

@MainActor
@Observable
final class ServerConnectionModel {
    struct ActiveRoute {
        let server: TabminalServerEndpoint
        let sessionID: String
    }

    var serverURL: String = "http://127.0.0.1:9846"
    var password: String = ""
    var hostName: String = ""
    var isConnecting: Bool = false
    var errorMessage: String = ""
    var activeRoute: ActiveRoute?

    @ObservationIgnored
    private let apiClient = TabminalAPIClient()

    func connect() {
        guard !isConnecting else {
            return
        }

        errorMessage = ""
        isConnecting = true

        Task {
            defer {
                Task { @MainActor in
                    self.isConnecting = false
                }
            }

            do {
                guard let parsedURL = URL(string: serverURL) else {
                    throw ConnectionError.invalidURL
                }

                let token = TabminalPasswordHasher.sha256Hex(password)
                let endpoint = TabminalServerEndpoint(
                    id: "main",
                    baseURL: parsedURL,
                    host: hostName,
                    token: token,
                    isPrimary: true
                )

                let session = try await apiClient.createSession(server: endpoint)

                await MainActor.run {
                    self.activeRoute = ActiveRoute(
                        server: endpoint,
                        sessionID: session.id
                    )
                }
            } catch {
                await MainActor.run {
                    self.errorMessage = Self.message(for: error)
                }
            }
        }
    }

    func disconnect() {
        activeRoute = nil
    }

    private static func message(for error: Error) -> String {
        if let error = error as? ConnectionError {
            return error.localizedDescription
        }

        if case let TabminalClientError.invalidStatus(code, body) = error {
            if body.isEmpty {
                return "Server returned HTTP \(code)."
            }
            return "Server returned HTTP \(code): \(body)"
        }

        return error.localizedDescription
    }
}

enum ConnectionError: LocalizedError {
    case invalidURL

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid server URL."
        }
    }
}
