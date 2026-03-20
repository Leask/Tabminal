import SwiftUI

public struct TextTerminalSurface: View {
    private let transcript: String
    private let emptyState: String

    public init(
        transcript: String,
        emptyState: String = """
        Waiting for shell output...
        Text-mode renderer is active.
        """
    ) {
        self.transcript = transcript
        self.emptyState = emptyState
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color(red: 0.05, green: 0.06, blue: 0.08))
                .overlay {
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .strokeBorder(.white.opacity(0.06), lineWidth: 1)
                }

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
                            .padding(.horizontal, 14)
                            .padding(.vertical, 14)

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
        transcript.isEmpty ? emptyState : transcript
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        DispatchQueue.main.async {
            proxy.scrollTo("terminal-bottom", anchor: .bottom)
        }
    }
}
