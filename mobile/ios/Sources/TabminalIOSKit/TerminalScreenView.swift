import SwiftUI
import TabminalMobileCore

public struct TerminalScreenView: View {
    @State private var model: TerminalScreenModel
    @State private var pendingInput: String = ""
    @State private var lastViewportSize: CGSize = .zero
    private let onDisconnect: (() -> Void)?

    public init(
        server: TabminalServerEndpoint,
        sessionID: String,
        onDisconnect: (() -> Void)? = nil
    ) {
        _model = State(
            initialValue: TerminalScreenModel(
                server: server,
                sessionID: sessionID
            )
        )
        self.onDisconnect = onDisconnect
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

            GeometryReader { proxy in
                GhosttyTerminalSurface(
                    host: model.server.displayName,
                    connectionState: model.connectionState.rawValue,
                    transcript: model.terminalTranscript
                )
                .onAppear {
                    updateViewportIfNeeded(proxy.size)
                }
                .onChange(of: proxy.size) { _, newSize in
                    updateViewportIfNeeded(newSize)
                }
            }

            inputPanel
        }
        .padding(20)
        .task {
            model.connect()
        }
        .onDisappear {
            model.disconnect()
        }
        .toolbar {
            ToolbarItem {
                Button("Close") {
                    model.disconnect()
                    onDisconnect?()
                }
            }
        }
    }

    private var inputPanel: some View {
        VStack(spacing: 12) {
            configuredInputField

            HStack(spacing: 10) {
                controlButton("Tab") {
                    model.sendControl("\t")
                }
                controlButton("Esc") {
                    model.sendControl("\u{1B}")
                }
                controlButton("Ctrl-C") {
                    model.sendControl("\u{03}")
                }
                Spacer()
                Button("Send") {
                    submitInput()
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    model.connectionState == .connecting
                        || model.connectionState == .reconnecting
                )
            }
        }
    }

    private var configuredInputField: some View {
        let field = TextField("Command or input", text: $pendingInput)
            .textFieldStyle(.roundedBorder)
            .font(.system(.body, design: .monospaced))
            .onSubmit {
                submitInput()
            }

#if os(iOS)
        return field
            .autocorrectionDisabled(true)
            .textInputAutocapitalization(.never)
#else
        return field
#endif
    }

    private func controlButton(
        _ title: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(title, action: action)
            .buttonStyle(.bordered)
            .font(.footnote.weight(.medium))
    }

    private func submitInput() {
        let command = pendingInput
        pendingInput = ""
        model.sendLine(command)
    }

    private func updateViewportIfNeeded(_ size: CGSize) {
        guard size.width > 0, size.height > 0 else {
            return
        }

        let delta = abs(size.width - lastViewportSize.width)
            + abs(size.height - lastViewportSize.height)
        guard delta > 12 else {
            return
        }

        lastViewportSize = size
        let cols = max(Int((size.width - 32) / 8.4), 40)
        let rows = max(Int((size.height - 32) / 18.0), 12)
        model.resize(cols: cols, rows: rows)
    }
}
