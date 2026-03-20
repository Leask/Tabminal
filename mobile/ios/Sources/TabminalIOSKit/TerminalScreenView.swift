import SwiftUI
import TabminalMobileCore

public struct TerminalScreenView: View {
    @State private var model: TerminalScreenModel
    @State private var pendingInput: String = ""
    @State private var lastViewportSize: CGSize = .zero
    @FocusState private var inputFocused: Bool
    private let onClose: (() -> Void)?

    public init(
        server: TabminalServerEndpoint,
        sessionID: String,
        onClose: (() -> Void)? = nil
    ) {
        _model = State(
            initialValue: TerminalScreenModel(
                server: server,
                sessionID: sessionID
            )
        )
        self.onClose = onClose
    }

    public var body: some View {
        GeometryReader { proxy in
            VStack(spacing: 12) {
                GhosttyTerminalSurface(
                    transcript: model.terminalTranscript
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .onAppear {
                    updateViewportIfNeeded(proxy.size)
                }
                .onChange(of: proxy.size) { _, newSize in
                    updateViewportIfNeeded(newSize)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .safeAreaInset(edge: .bottom) {
            composerDock
        }
        .toolbar {
#if os(iOS)
            ToolbarItemGroup(placement: .keyboard) {
                keyboardAccessoryBar
            }
#endif
        }
        .task {
            model.connect()
        }
        .onAppear {
            inputFocused = true
        }
        .onDisappear {
            model.disconnect()
        }
    }

    private var composerDock: some View {
        HStack(alignment: .center, spacing: 12) {
            Button(action: { onClose?() }) {
                Image(systemName: "xmark")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white.opacity(0.84))
                    .frame(width: 40, height: 40)
                    .background(.white.opacity(0.08), in: Circle())
            }

            TextField(
                "Type a command or paste shell input",
                text: $pendingInput
            )
            .focused($inputFocused)
            .font(.system(.body, design: .monospaced))
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(.white.opacity(0.06))
            )
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(.white.opacity(0.08), lineWidth: 1)
            }
            .foregroundStyle(.white)
            .submitLabel(.send)
            .onSubmit {
                submitInput()
            }
#if os(iOS)
            .autocorrectionDisabled(true)
            .textInputAutocapitalization(.never)
#endif

            Button(action: submitInput) {
                Image(systemName: "arrow.up")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.black)
                    .frame(width: 46, height: 46)
                    .background(
                        Circle()
                            .fill(
                                Color(red: 0.83, green: 0.90, blue: 0.98)
                            )
                    )
            }
            .disabled(
                model.connectionState == .connecting
                    || model.connectionState == .reconnecting
            )
            .opacity(
                model.connectionState == .connecting
                    || model.connectionState == .reconnecting ? 0.45 : 1
            )
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .background(
            Rectangle()
                .fill(.ultraThinMaterial)
                .ignoresSafeArea()
        )
    }

    private var keyboardAccessoryBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                keyboardKey("Tab") {
                    model.sendControl("\t")
                }
                keyboardKey("Esc") {
                    model.sendControl("\u{1B}")
                }
                keyboardKey("⌃C") {
                    model.sendControl("\u{03}")
                }
                keyboardKey("↑") {
                    model.sendControl("\u{1B}[A")
                }
                keyboardKey("↓") {
                    model.sendControl("\u{1B}[B")
                }
                keyboardKey("←") {
                    model.sendControl("\u{1B}[D")
                }
                keyboardKey("→") {
                    model.sendControl("\u{1B}[C")
                }
                keyboardKey("Enter") {
                    model.sendControl("\r")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func keyboardKey(
        _ title: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(title, action: action)
            .buttonStyle(.plain)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.primary)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(.regularMaterial)
            )
    }

    private func submitInput() {
        let command = pendingInput
        pendingInput = ""

        if command.isEmpty {
            model.sendControl("\r")
        } else {
            model.sendLine(command)
        }

        inputFocused = true
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
