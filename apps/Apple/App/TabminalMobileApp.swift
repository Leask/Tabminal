import SwiftUI

@main
struct TabminalMobileApp: App {
    var body: some Scene {
#if os(macOS)
        WindowGroup {
            rootView
        }
        .defaultSize(width: 1440, height: 920)
#elseif os(visionOS)
        WindowGroup {
            rootView
        }
        .defaultSize(width: 1400, height: 900)
#else
        WindowGroup {
            rootView
        }
#endif
    }

    private var rootView: some View {
        AppRootView()
            .preferredColorScheme(.dark)
    }
}
