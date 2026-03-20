import SwiftUI

struct AppRootView: View {
    @State private var model = MobileAppModel()

    var body: some View {
        ZStack {
            switch model.phase {
            case .login:
                ServerConnectionView(model: model)
                    .transition(.opacity)
            case .loading:
                loadingView
                    .transition(.opacity)
            case .ready:
                MobileShellView(model: model)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.phase)
        .sheet(isPresented: $model.isPresentingHostEditor) {
            HostEditorView(model: model)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
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
