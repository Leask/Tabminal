import SwiftUI

public struct TerminalSurfaceHost: View {
    private let transcript: String
    private let renderer: TerminalRenderer

    public init(
        transcript: String,
        renderer: TerminalRenderer = .current
    ) {
        self.transcript = transcript
        self.renderer = renderer
    }

    public var body: some View {
        switch renderer {
        case .text:
            GhosttyTerminalSurface(
                transcript: transcript,
                mode: .textFallback
            )
        case .ghostty:
            GhosttyTerminalSurface(
                transcript: transcript,
                mode: .ghosttyPending
            )
        }
    }
}
