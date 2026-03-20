import SwiftUI

public struct GhosttyTerminalSurface: View {
    private let host: String
    private let connectionState: String
    private let transcript: String

    public init(
        host: String,
        connectionState: String,
        transcript: String
    ) {
        self.host = host
        self.connectionState = connectionState
        self.transcript = transcript
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color(red: 0.10, green: 0.13, blue: 0.16),
                            Color(red: 0.05, green: 0.06, blue: 0.08)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .strokeBorder(.white.opacity(0.14), lineWidth: 1)
                )

            VStack(spacing: 0) {
                HStack(alignment: .center, spacing: 12) {
                    Label(host, systemImage: "terminal")
                        .font(.headline)
                        .foregroundStyle(.white)
                    Spacer()
                    Text(connectionState)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.white.opacity(0.72))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.white.opacity(0.08), in: Capsule())
                }
                .padding(.horizontal, 20)
                .padding(.top, 18)
                .padding(.bottom, 14)

                Divider()
                    .overlay(.white.opacity(0.08))

                ScrollViewReader { proxy in
                    ScrollView {
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
                                .padding(20)

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
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.001))
    }

    private var displayTranscript: String {
        if transcript.isEmpty {
#if canImport(libghostty)
            return "libghostty renderer host ready.\nWaiting for session output..."
#else
            return "Waiting for session output...\nPlain-text fallback is active until libghostty is linked."
#endif
        }
        return transcript
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        DispatchQueue.main.async {
            proxy.scrollTo("terminal-bottom", anchor: .bottom)
        }
    }
}
