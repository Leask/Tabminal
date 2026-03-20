import SwiftUI

public struct TerminalSurfaceHost: View {
    private let transcript: String
    private let renderFeed: TerminalRenderFeed
    private let renderer: TerminalRenderer

    public init(
        transcript: String,
        renderFeed: TerminalRenderFeed = TerminalRenderFeed(),
        renderer: TerminalRenderer = .current
    ) {
        self.transcript = transcript
        self.renderFeed = renderFeed
        self.renderer = renderer
    }

    public var body: some View {
        switch renderer {
        case .text:
            TextTerminalSurface(
                transcript: transcript
            )
        case .ghostty:
            GhosttyNativeTerminalSurface(
                transcript: transcript,
                renderFeed: renderFeed
            )
        }
    }
}
