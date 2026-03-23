import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
#if canImport(AppKit)
import AppKit
#endif

public struct GhosttyNativeTerminalSurface: View {
    private let transcript: String
    private let controller: GhosttyTerminalController
    private let onGhosttyWrite: ((String) -> Void)?
    private let runtimeStatus: GhosttyRuntimeStatus

    public init(
        transcript: String,
        controller: GhosttyTerminalController,
        onGhosttyWrite: ((String) -> Void)? = nil,
        runtimeStatus: GhosttyRuntimeStatus = GhosttyRuntimeLoader.shared.status
    ) {
        self.transcript = transcript
        self.controller = controller
        self.onGhosttyWrite = onGhosttyWrite
        self.runtimeStatus = runtimeStatus
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            backgroundSurface

            contentSurface
                .clipShape(
                    RoundedRectangle(
                        cornerRadius: 22,
                        style: .continuous
                    )
                )

            if showsFallbackBanner {
                fallbackBanner
                    .padding(14)
            }
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
        if runtimeStatus.canProcessRemoteOutput {
            nativeSurface
        } else {
            TextTerminalSurface(
                transcript: transcript,
                emptyState: "Waiting for shell output..."
            )
        }
    }

    @ViewBuilder
    private var nativeSurface: some View {
#if canImport(AppKit) && !targetEnvironment(macCatalyst)
        GhosttyAppKitHostContainer(
            controller: controller,
            onGhosttyWrite: onGhosttyWrite
        )
#elseif canImport(UIKit)
        GhosttyUIKitHostContainer(
            controller: controller,
            onGhosttyWrite: onGhosttyWrite
        )
#else
        TextTerminalSurface(
            transcript: transcript,
            emptyState: "Waiting for shell output..."
        )
#endif
    }

    private var showsFallbackBanner: Bool {
        !runtimeStatus.canProcessRemoteOutput
    }

    private var fallbackBanner: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Ghostty Unavailable")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
            Text(runtimeStatus.detail)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.72))
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
}

#if canImport(UIKit)
private struct GhosttyUIKitHostContainer: UIViewRepresentable {
    let controller: GhosttyTerminalController
    let onGhosttyWrite: ((String) -> Void)?

    func makeCoordinator() -> GhosttyUIKitHostCoordinator {
        GhosttyUIKitHostCoordinator()
    }

    func makeUIView(context: Context) -> GhosttyUIKitHostView {
        let view = GhosttyUIKitHostView()
        context.coordinator.attach(to: view)
        return view
    }

    func updateUIView(
        _ uiView: GhosttyUIKitHostView,
        context: Context
    ) {
        context.coordinator.attach(to: uiView)
        context.coordinator.apply(
            controller: controller,
            onGhosttyWrite: onGhosttyWrite
        )
    }

    static func dismantleUIView(
        _ uiView: GhosttyUIKitHostView,
        coordinator: GhosttyUIKitHostCoordinator
    ) {
        coordinator.detachCurrentController()
        uiView.cleanup()
    }
}

@MainActor
private final class GhosttyUIKitHostCoordinator {
    private weak var hostView: GhosttyUIKitHostView?
    private var controller: GhosttyTerminalController?

    func attach(to view: GhosttyUIKitHostView) {
        guard hostView !== view else {
            return
        }
        if let controller, let hostView {
            controller.detach(from: hostView)
        }
        hostView = view
        if let controller {
            controller.attach(to: view)
        }
    }

    func detachCurrentController() {
        if let controller, let hostView {
            controller.detach(from: hostView)
        }
        controller = nil
        hostView = nil
    }

    @MainActor
    func apply(
        controller: GhosttyTerminalController,
        onGhosttyWrite: ((String) -> Void)?
    ) {
        if self.controller !== controller {
            if let current = self.controller, let hostView {
                current.detach(from: hostView)
            }
            self.controller = controller
            if let hostView {
                controller.attach(to: hostView)
            }
        }
        controller.setWriteHandler(onGhosttyWrite)
    }
}
#endif

#if canImport(AppKit)
private struct GhosttyAppKitHostContainer: NSViewRepresentable {
    let controller: GhosttyTerminalController
    let onGhosttyWrite: ((String) -> Void)?

    func makeCoordinator() -> GhosttyAppKitHostCoordinator {
        GhosttyAppKitHostCoordinator()
    }

    func makeNSView(context: Context) -> GhosttyAppKitHostView {
        let view = GhosttyAppKitHostView()
        context.coordinator.attach(to: view)
        return view
    }

    func updateNSView(
        _ nsView: GhosttyAppKitHostView,
        context: Context
    ) {
        context.coordinator.attach(to: nsView)
        context.coordinator.apply(
            controller: controller,
            onGhosttyWrite: onGhosttyWrite
        )
    }

    static func dismantleNSView(
        _ nsView: GhosttyAppKitHostView,
        coordinator: GhosttyAppKitHostCoordinator
    ) {
        coordinator.detachCurrentController()
        nsView.cleanup()
    }
}

@MainActor
private final class GhosttyAppKitHostCoordinator {
    private weak var hostView: GhosttyAppKitHostView?
    private var controller: GhosttyTerminalController?

    func attach(to view: GhosttyAppKitHostView) {
        guard hostView !== view else {
            return
        }
        if let controller, let hostView {
            controller.detach(from: hostView)
        }
        hostView = view
        if let controller {
            controller.attach(to: view)
        }
    }

    func detachCurrentController() {
        if let controller, let hostView {
            controller.detach(from: hostView)
        }
        controller = nil
        hostView = nil
    }

    @MainActor
    func apply(
        controller: GhosttyTerminalController,
        onGhosttyWrite: ((String) -> Void)?
    ) {
        if self.controller !== controller {
            if let current = self.controller, let hostView {
                current.detach(from: hostView)
            }
            self.controller = controller
            if let hostView {
                controller.attach(to: hostView)
            }
        }
        controller.setWriteHandler(onGhosttyWrite)
    }
}
#endif
