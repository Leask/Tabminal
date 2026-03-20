import SwiftUI
import TabminalMobileCore

public struct TerminalScreenView: View {
    @State private var model: TerminalScreenModel

    public init(server: TabminalServerEndpoint, sessionID: String) {
        _model = State(
            initialValue: TerminalScreenModel(
                server: server,
                sessionID: sessionID
            )
        )
    }

    public var body: some View {
        VStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(model.terminalTitle)
                    .font(.title3)
                Text(model.server.displayName)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if !model.workingDirectory.isEmpty {
                    Text(model.workingDirectory)
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            GhosttyTerminalSurface(
                host: model.server.displayName,
                connectionState: model.connectionState.rawValue
            )
        }
        .padding(20)
        .task {
            model.connect()
        }
        .onDisappear {
            model.disconnect()
        }
    }
}
