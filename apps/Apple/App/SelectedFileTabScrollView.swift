import SwiftUI

struct SelectedFileTabScrollView<Content: View>: View {
    let selectedPath: String?
    let paths: [String]
    let revealID: UUID
    let content: @MainActor (CGFloat) -> Content
    @State private var viewportWidth: CGFloat = 0

    private struct Target: Hashable {
        let path: String?
        let paths: [String]
        let width: CGFloat
        let revealID: UUID
    }

    init(
        selectedPath: String?, paths: [String], revealID: UUID,
        @ViewBuilder content: @escaping @MainActor (CGFloat) -> Content
    ) {
        self.selectedPath = selectedPath
        self.paths = paths
        self.revealID = revealID
        self.content = content
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                content(viewportWidth)
            }
            .accessibilityIdentifier("workspace.file.tabs")
            .onGeometryChange(for: CGFloat.self) { geometry in
                geometry.size.width
            } action: { width in
                viewportWidth = width
            }
            .task(id: Target(
                path: selectedPath, paths: paths,
                width: viewportWidth, revealID: revealID
            )) {
                @MainActor in
                guard viewportWidth > 0, let selectedPath,
                      paths.contains(selectedPath) else { return }
                // Wait for newly inserted/restored tab IDs to reach layout.
                await Task.yield()
                guard !Task.isCancelled else { return }
                proxy.scrollTo(selectedPath, anchor: .center)
            }
        }
    }
}
