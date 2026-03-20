import SwiftUI

public struct GhosttyTerminalSurface: View {
    public enum Mode: Sendable {
        case textFallback
        case ghosttyPending
    }

    private let transcript: String
    private let mode: Mode

    public init(
        transcript: String,
        mode: Mode = .textFallback
    ) {
        self.transcript = transcript
        self.mode = mode
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color(red: 0.07, green: 0.08, blue: 0.10),
                            Color(red: 0.03, green: 0.04, blue: 0.05)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .strokeBorder(.white.opacity(0.08), lineWidth: 1)
                }

            LinearGradient(
                colors: [
                    .white.opacity(0.04),
                    .clear
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 84)
            .clipShape(
                RoundedRectangle(cornerRadius: 28, style: .continuous)
            )
            .allowsHitTesting(false)

            HStack(spacing: 8) {
                terminalDot(Color(red: 1.0, green: 0.37, blue: 0.33))
                terminalDot(Color(red: 1.0, green: 0.74, blue: 0.28))
                terminalDot(Color(red: 0.18, green: 0.84, blue: 0.44))
            }
            .padding(.top, 18)
            .padding(.leading, 18)
            .allowsHitTesting(false)

            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(displayTranscript)
                            .font(
                                .system(
                                    size: 13,
                                    weight: .regular,
                                    design: .monospaced
                                )
                            )
                            .foregroundStyle(.white.opacity(0.94))
                            .textSelection(.enabled)
                            .frame(
                                maxWidth: .infinity,
                                alignment: .leading
                            )
                            .padding(.top, 48)
                            .padding(.horizontal, 18)
                            .padding(.bottom, 18)

                        Color.clear
                            .frame(height: 1)
                            .id("terminal-bottom")
                    }
                }
                .onAppear {
                    scrollToBottom(proxy)
                }
                .onChange(of: transcript) { _, _ in
                    scrollToBottom(proxy)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.001))
        .accessibilityIdentifier("terminal.surface")
    }

    private var displayTranscript: String {
        if transcript.isEmpty {
            switch mode {
            case .textFallback:
                return """
                Waiting for shell output...
                Text-mode renderer is active.
                """
            case .ghosttyPending:
                return """
                Ghostty renderer selected.
                The public libghostty C API does not yet expose a remote PTY input path for Tabminal.
                Text fallback remains active until the bridge layer is extended.
                """
            }
        }

        return transcript
    }

    private func terminalDot(_ color: Color) -> some View {
        Circle()
            .fill(color.opacity(0.92))
            .frame(width: 10, height: 10)
            .shadow(color: color.opacity(0.18), radius: 6, y: 1)
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        DispatchQueue.main.async {
            proxy.scrollTo("terminal-bottom", anchor: .bottom)
        }
    }
}
