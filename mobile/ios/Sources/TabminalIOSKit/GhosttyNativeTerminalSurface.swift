import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

public struct GhosttyNativeTerminalSurface: View {
    private let transcript: String
    private let renderFeed: TerminalRenderFeed
    private let runtimeStatus: GhosttyRuntimeStatus

    public init(
        transcript: String,
        renderFeed: TerminalRenderFeed,
        runtimeStatus: GhosttyRuntimeStatus = GhosttyRuntimeLoader.shared.status
    ) {
        self.transcript = transcript
        self.renderFeed = renderFeed
        self.runtimeStatus = runtimeStatus
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            backgroundSurface

            contentSurface

            statusBanner
                .padding(14)
        }
        .accessibilityIdentifier("terminal.surface.ghostty")
    }

    private var backgroundSurface: some View {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(Color(red: 0.05, green: 0.06, blue: 0.08))
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(.white.opacity(0.06), lineWidth: 1)
            }
    }

    @ViewBuilder
    private var contentSurface: some View {
#if canImport(UIKit)
        if runtimeStatus.canProcessRemoteOutput {
            GhosttyHostContainer(renderFeed: renderFeed)
                .clipShape(
                    RoundedRectangle(
                        cornerRadius: 22,
                        style: .continuous
                    )
                )
        } else {
            fallbackSurface
        }
#else
        fallbackSurface
#endif
    }

    private var fallbackSurface: some View {
        TextTerminalSurface(
            transcript: transcript,
            emptyState: """
            Ghostty renderer selected.
            \(runtimeStatus.detail)
            """
        )
    }

    private var statusBanner: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Ghostty")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
            Text(statusTitle)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.78))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(.black.opacity(0.45))
        )
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(.white.opacity(0.08), lineWidth: 1)
        }
    }

    private var statusTitle: String {
        switch runtimeStatus.availability {
        case .unavailable:
            return "Native runtime not bundled. Falling back to text renderer."
        case .publicSurfaceAPI:
            return "Embedded iOS surface API found. Remote-output injection is still missing."
        case .remoteIOReady:
            return "Runtime exports a remote-output bridge. Native host scaffold is active."
        }
    }
}

#if canImport(UIKit)
private struct GhosttyHostContainer: UIViewRepresentable {
    let renderFeed: TerminalRenderFeed

    func makeCoordinator() -> GhosttyHostCoordinator {
        GhosttyHostCoordinator()
    }

    func makeUIView(context: Context) -> GhosttyHostView {
        let view = GhosttyHostView()
        context.coordinator.attach(to: view)
        return view
    }

    func updateUIView(_ uiView: GhosttyHostView, context: Context) {
        context.coordinator.attach(to: uiView)
        context.coordinator.apply(renderFeed)
    }
}

private final class GhosttyHostCoordinator {
    private weak var hostView: GhosttyHostView?

    func attach(to view: GhosttyHostView) {
        guard hostView !== view else {
            return
        }
        hostView = view
    }

    @MainActor
    func apply(_ feed: TerminalRenderFeed) {
        hostView?.update(
            snapshotText: feed.snapshotText,
            outputText: feed.outputText
        )
    }
}

private final class GhosttyHostView: UIView {
    private let statusLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(
            red: 0.05,
            green: 0.06,
            blue: 0.08,
            alpha: 1.0
        )
        layer.cornerRadius = 22
        layer.masksToBounds = true

        statusLabel.numberOfLines = 0
        statusLabel.font = UIFont.monospacedSystemFont(
            ofSize: 12,
            weight: .regular
        )
        statusLabel.textColor = UIColor(white: 1.0, alpha: 0.72)
        statusLabel.text = """
        Ghostty native host scaffold initialized.
        Waiting for remote-output capable runtime bridge.
        """
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(statusLabel)
        NSLayoutConstraint.activate([
            statusLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            statusLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            statusLabel.topAnchor.constraint(equalTo: topAnchor, constant: 16)
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func update(snapshotText: String, outputText: String) {
        let snapshotInfo = snapshotText.isEmpty ? "empty" : "loaded"
        let chunkInfo = outputText.isEmpty ? "idle" : "pending chunk"
        statusLabel.text = """
        Ghostty native host scaffold initialized.
        Snapshot: \(snapshotInfo)
        Output: \(chunkInfo)
        """
    }
}
#endif
