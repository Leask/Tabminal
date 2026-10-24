import SwiftUI

struct AppRootView: View {
    @State private var model = MobileAppModel()
    @Environment(\.scenePhase) private var scenePhase
#if DEBUG
    @State private var debugFullWorkspaceClosed = false
#endif

    var body: some View {
        ZStack {
            switch model.phase {
            case .login:
                ServerConnectionView(model: model)
                    .accessibilityIdentifier("root.login")
                    .transition(.opacity)
            case .loading:
                loadingView
                    .accessibilityIdentifier("root.loading")
                    .transition(.opacity)
            case .ready:
                readyContent
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.phase)
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                Task { await model.flushEditorDrafts() }
            }
        }
        .task {
            await Task.yield()
            model.runStartupFlowIfNeeded()
        }
        .sheet(isPresented: $model.isPresentingHostEditor) {
            HostEditorView(model: model)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    @ViewBuilder
    private var readyContent: some View {
#if DEBUG
        if MobileDebugLaunchOptions.current.fullWorkspace,
           !debugFullWorkspaceClosed,
           let session = model.activeSession,
           let host = model.activeHost,
           let workspace = model.activeWorkspace {
            WorkspaceBrowserView(
                workspace: workspace,
                hostName: host.displayName,
                sessionTitle: session.title,
                onClose: {
                    debugFullWorkspaceClosed = true
                    model.closeWorkspace()
                }
            )
        } else {
            MobileShellView(model: model)
        }
#else
        MobileShellView(model: model)
#endif
    }

    private var loadingView: some View {
        ZStack {
            Color(red: 0.03, green: 0.04, blue: 0.05)
                .ignoresSafeArea()

            VStack(spacing: 16) {
                ProgressView()
                    .scaleEffect(1.2)
                    .tint(.white)
                Text("Preparing hosts and sessions...")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.72))
            }
        }
    }
}
