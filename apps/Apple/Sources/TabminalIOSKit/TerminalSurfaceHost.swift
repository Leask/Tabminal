import SwiftUI

public struct TerminalSurfaceHost: View {
    private let transcript: String
    private let ghosttyController: GhosttyTerminalController
    private let renderer: TerminalRenderer
    private let onGhosttyWrite: ((String) -> Void)?

    public init(
        transcript: String,
        ghosttyController: GhosttyTerminalController = GhosttyTerminalController(),
        renderer: TerminalRenderer = .current,
        onGhosttyWrite: ((String) -> Void)? = nil
    ) {
        self.transcript = transcript
        self.ghosttyController = ghosttyController
        self.renderer = renderer
        self.onGhosttyWrite = onGhosttyWrite
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
                controller: ghosttyController,
                onGhosttyWrite: onGhosttyWrite
            )
        }
    }
}
