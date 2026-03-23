import Foundation
import Observation
import TabminalMobileCore

@MainActor
@Observable
final class SessionWorkspaceModel {
    struct EditorDocument: Identifiable, Hashable {
        let path: String
        var content: String
        var savedContent: String
        var readonly: Bool

        var id: String {
            path
        }

        var name: String {
            URL(fileURLWithPath: path).lastPathComponent
        }

        var isDirty: Bool {
            content != savedContent
        }
    }

    let hostID: String
    let sessionID: String
    let sessionKey: String

    var endpoint: TabminalServerEndpoint
    var rootPath: String
    var browserPath: String
    var entries: [TabminalFileEntry] = []
    var openDocuments: [EditorDocument] = []
    var activeFilePath: String?
    var isBrowserLoading: Bool = false
    var isSaving: Bool = false
    var browserErrorMessage: String = ""
    var editorErrorMessage: String = ""
    var isPresented: Bool = false

    @ObservationIgnored
    private let apiClient = TabminalAPIClient()
    @ObservationIgnored
    private var restoredServerEditorState = false
    @ObservationIgnored
    private var pendingServerEditorState: TabminalSessionEditorState?

    init(
        hostID: String,
        sessionID: String,
        sessionKey: String,
        endpoint: TabminalServerEndpoint,
        rootPath: String
    ) {
        self.hostID = hostID
        self.sessionID = sessionID
        self.sessionKey = sessionKey
        self.endpoint = endpoint

        let normalizedRoot = Self.normalizeDirectory(rootPath)
        self.rootPath = normalizedRoot
        self.browserPath = normalizedRoot
    }

    var activeDocument: EditorDocument? {
        guard let activeFilePath else {
            return openDocuments.first
        }

        return openDocuments.first { $0.path == activeFilePath }
            ?? openDocuments.first
    }

    var hasDirtyFiles: Bool {
        openDocuments.contains { $0.isDirty }
    }

    func updateEndpoint(_ endpoint: TabminalServerEndpoint) {
        self.endpoint = endpoint
    }

    func ensureRoot(_ path: String) {
        let normalized = Self.normalizeDirectory(path)
        guard !normalized.isEmpty else {
            return
        }

        if rootPath.isEmpty {
            rootPath = normalized
        }

        if browserPath.isEmpty {
            browserPath = normalized
        }
    }

    func setPresented(_ presented: Bool) {
        isPresented = presented
        guard presented else {
            return
        }

        Task { [weak self] in
            guard let self else {
                return
            }
            await self.hydratePendingEditorStateIfNeeded()
            if self.entries.isEmpty && !self.browserPath.isEmpty {
                await self.loadDirectory(path: self.browserPath)
            }
        }
    }

    func reconcile(
        cwd: String,
        editorState: TabminalSessionEditorState?
    ) async {
        ensureRoot(cwd)

        guard let editorState else {
            return
        }

        if !editorState.root.isEmpty {
            rootPath = Self.normalizeDirectory(editorState.root)
            if browserPath.isEmpty {
                browserPath = rootPath
            }
        }

        pendingServerEditorState = editorState

        if editorState.isVisible {
            isPresented = true
        }

        if isPresented {
            await hydratePendingEditorStateIfNeeded()
            if entries.isEmpty && !browserPath.isEmpty {
                await loadDirectory(path: browserPath)
            }
        }
    }

    private func hydratePendingEditorStateIfNeeded() async {
        guard !restoredServerEditorState,
              let editorState = pendingServerEditorState else {
            return
        }

        restoredServerEditorState = true
        pendingServerEditorState = nil

        for filePath in editorState.openFiles {
            do {
                try await openFile(
                    path: filePath,
                    activate: filePath == editorState.activeFilePath
                )
            } catch {
                editorErrorMessage = MobileAppModel.displayMessage(for: error)
            }
        }

        if let activePath = editorState.activeFilePath,
           openDocuments.contains(where: { $0.path == activePath }) {
            activeFilePath = activePath
        }
    }

    func loadDirectory(path: String) async {
        let normalized = Self.normalizeDirectory(path)
        guard !normalized.isEmpty else {
            return
        }

        isBrowserLoading = true
        browserErrorMessage = ""

        do {
            let list = try await apiClient.listDirectory(
                server: endpoint,
                path: normalized
            )
            entries = list
            browserPath = normalized
        } catch {
            browserErrorMessage = MobileAppModel.displayMessage(for: error)
        }

        isBrowserLoading = false
    }

    func refreshDirectory() async {
        await loadDirectory(path: browserPath)
    }

    func navigateUp() async {
        let current = browserPath.isEmpty ? rootPath : browserPath
        guard !current.isEmpty else {
            return
        }

        let next = Self.parentDirectory(for: current)
        await loadDirectory(path: next)
    }

    func openFile(
        path: String,
        activate: Bool = true
    ) async throws {
        if openDocuments.contains(where: { $0.path == path }) {
            if activate {
                activeFilePath = path
            }
            return
        }

        let response = try await apiClient.readFile(server: endpoint, path: path)
        let document = EditorDocument(
            path: path,
            content: response.content,
            savedContent: response.content,
            readonly: response.readonly
        )
        openDocuments.append(document)

        if activate {
            activeFilePath = path
        }
    }

    func closeFile(path: String) {
        openDocuments.removeAll { $0.path == path }

        if activeFilePath == path {
            activeFilePath = openDocuments.last?.path
        }
    }

    func updateActiveDocumentContent(_ content: String) {
        guard let activeFilePath,
              let index = openDocuments.firstIndex(
                  where: { $0.path == activeFilePath }
              )
        else {
            return
        }

        openDocuments[index].content = content
    }

    func saveActiveFile() async {
        guard let activeFilePath,
              let index = openDocuments.firstIndex(
                  where: { $0.path == activeFilePath }
              )
        else {
            return
        }

        if openDocuments[index].readonly {
            editorErrorMessage = "This file is read-only."
            return
        }

        isSaving = true
        editorErrorMessage = ""

        do {
            try await apiClient.writeFile(
                server: endpoint,
                path: activeFilePath,
                content: openDocuments[index].content
            )
            openDocuments[index].savedContent = openDocuments[index].content
        } catch {
            editorErrorMessage = MobileAppModel.displayMessage(for: error)
        }

        isSaving = false
    }

    func editorStatePayload(
        fallbackRoot: String
    ) -> TabminalSessionEditorState {
        let root = !rootPath.isEmpty ? rootPath : fallbackRoot
        return TabminalSessionEditorState(
            isVisible: isPresented || !openDocuments.isEmpty,
            root: root,
            openFiles: openDocuments.map(\.path),
            activeFilePath: activeDocument?.path
        )
    }

    private static func normalizeDirectory(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return ""
        }

        if trimmed == "/" {
            return "/"
        }

        if trimmed.hasSuffix("/") {
            return String(trimmed.dropLast())
        }

        return trimmed
    }

    private static func parentDirectory(for path: String) -> String {
        let normalized = normalizeDirectory(path)
        if normalized.isEmpty || normalized == "/" {
            return "/"
        }

        let parent = (normalized as NSString).deletingLastPathComponent
        return parent.isEmpty ? "/" : parent
    }
}
