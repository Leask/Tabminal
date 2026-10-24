import Foundation
import Observation
import TabminalMobileCore

@MainActor
@Observable
final class SessionWorkspaceModel {
    typealias EditorDocument = TabminalEditorDocument

    let hostID: String
    let sessionID: String
    let sessionKey: String

    var endpoint: TabminalServerEndpoint
    var rootPath: String
    var browserPath: String
    var entries: [TabminalFileEntry] = []
    var openDocuments: [EditorDocument] = []
    var activeFilePath: String? {
        didSet { persistWorkspace() }
    }
    var fileTabRevealID = UUID()
    var isBrowserLoading: Bool = false
    var isSaving: Bool { activeDocument?.isBusy ?? false }
    var browserErrorMessage: String = ""
    var editorErrorMessage: String = ""
    var isPresented: Bool = false {
        didSet { persistWorkspace() }
    }

    @ObservationIgnored
    private let apiClient = TabminalAPIClient()
    @ObservationIgnored
    private var restoredServerEditorState = false
    @ObservationIgnored
    private var pendingServerEditorState: TabminalSessionEditorState?
    @ObservationIgnored
    private var localEditorState: TabminalSessionEditorState?
    @ObservationIgnored
    private var endpointGeneration = UUID()

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
        self.localEditorState = loadLocalWorkspace()
        self.isPresented = localEditorState?.isVisible ?? false
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
        if self.endpoint.baseURL != endpoint.baseURL {
            endpointGeneration = UUID()
            restoredServerEditorState = false
            let previousDocuments = openDocuments
            Task {
                for document in previousDocuments { await document.flushDraft() }
            }
            self.endpoint = endpoint
            localEditorState = loadLocalWorkspace()
            rootPath = Self.normalizeDirectory(localEditorState?.root ?? "")
            browserPath = rootPath
            openDocuments.removeAll()
            activeFilePath = nil
            entries = []
            isBrowserLoading = false
            browserErrorMessage = ""
            editorErrorMessage = ""
            pendingServerEditorState = nil
            isPresented = localEditorState?.isVisible ?? false
        }
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

        let presentationGeneration = endpointGeneration
        Task { [weak self] in
            guard let self else {
                return
            }
            guard self.endpointGeneration == presentationGeneration else { return }
            await self.hydratePendingEditorStateIfNeeded()
            guard self.endpointGeneration == presentationGeneration else { return }
            if self.entries.isEmpty && !self.browserPath.isEmpty {
                await self.loadDirectory(path: self.browserPath)
            }
        }
    }

    func reconcile(
        cwd: String,
        editorState: TabminalSessionEditorState?
    ) async {
        let reconcilingGeneration = endpointGeneration
        ensureRoot(cwd)

        if let editorState, !editorState.root.isEmpty {
            rootPath = Self.normalizeDirectory(editorState.root)
            if browserPath.isEmpty {
                browserPath = rootPath
            }
        }

        pendingServerEditorState = editorState

        if !restoredServerEditorState, localEditorState == nil,
           editorState?.isVisible == true {
            isPresented = true
        }

        if isPresented {
            await hydratePendingEditorStateIfNeeded()
            guard endpointGeneration == reconcilingGeneration else { return }
            if entries.isEmpty && !browserPath.isEmpty {
                await loadDirectory(path: browserPath)
            }
        }
    }

    private func hydratePendingEditorStateIfNeeded() async {
        guard !restoredServerEditorState,
              let editorState = localEditorState ?? pendingServerEditorState else {
            return
        }

        restoredServerEditorState = true
        let paths = editorState.openFiles + (pendingServerEditorState?.openFiles ?? [])
        let restoringGeneration = endpointGeneration
        pendingServerEditorState = nil
        localEditorState = nil

        for filePath in paths {
            guard endpointGeneration == restoringGeneration else { return }
            do {
                try await openFile(
                    path: filePath,
                    activate: filePath == editorState.activeFilePath
                )
            } catch {
                guard endpointGeneration == restoringGeneration else { return }
                editorErrorMessage = MobileAppModel.displayMessage(for: error)
            }
        }

        guard endpointGeneration == restoringGeneration else { return }
        if let activePath = editorState.activeFilePath,
           openDocuments.contains(where: { $0.path == activePath }) {
            activeFilePath = activePath
        }
        persistWorkspace()
    }

    func loadDirectory(path: String) async {
        let normalized = Self.normalizeDirectory(path)
        guard !normalized.isEmpty else {
            return
        }

        isBrowserLoading = true
        browserErrorMessage = ""
        let listingEndpoint = endpoint
        let listingGeneration = endpointGeneration

        do {
            let list = try await apiClient.listDirectory(
                server: listingEndpoint,
                path: normalized
            )
            guard endpointGeneration == listingGeneration else { return }
            entries = list
            browserPath = normalized
        } catch {
            guard endpointGeneration == listingGeneration else { return }
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
        editorErrorMessage = ""
        if openDocuments.contains(where: { $0.path == path }) {
            if activate {
                selectFile(path: path)
            }
            return
        }

        let openingEndpoint = endpoint
        let openingGeneration = endpointGeneration
        let document = try await EditorDocument.open(
            server: openingEndpoint, sessionID: sessionID, path: path,
            client: apiClient
        )
        guard endpointGeneration == openingGeneration else {
            throw CancellationError()
        }
        if openDocuments.contains(where: { $0.path == path }) {
            if activate { selectFile(path: path) }
            return
        }
        openDocuments.append(document)

        if activate {
            selectFile(path: path)
        }
        persistWorkspace()
    }

    func selectFile(path: String) {
        guard openDocuments.contains(where: { $0.path == path }) else { return }
        activeFilePath = path
        fileTabRevealID = UUID()
    }

    func closeFile(path: String) {
        if let document = openDocuments.first(where: { $0.path == path }) {
            Task { await document.flushDraft() }
        }
        openDocuments.removeAll { $0.path == path }

        if activeFilePath == path {
            activeFilePath = openDocuments.last?.path
        }
        persistWorkspace()
    }

    func saveActiveFile() async {
        editorErrorMessage = ""
        await activeDocument?.save()
    }

    func flushDrafts() async {
        for document in openDocuments { await document.flushDraft() }
    }

    func editorStatePayload(
        fallbackRoot: String
    ) -> TabminalSessionEditorState {
        let root = !rootPath.isEmpty ? rootPath : fallbackRoot
        return TabminalSessionEditorState(
            isVisible: isPresented,
            root: root,
            openFiles: openDocuments.map(\.path),
            activeFilePath: activeDocument?.path
        )
    }

    private var workspaceStorageKey: String {
        let parts = [hostID, endpoint.baseURL.absoluteString, sessionID]
        let encoded = (try? JSONEncoder().encode(parts)) ?? Data()
        return "tabminal.mobile.workspace." + encoded.base64EncodedString()
    }

    private func loadLocalWorkspace() -> TabminalSessionEditorState? {
        guard let data = UserDefaults.standard.data(forKey: workspaceStorageKey) else {
            return nil
        }
        return try? JSONDecoder().decode(TabminalSessionEditorState.self, from: data)
    }

    private func persistWorkspace() {
        guard !openDocuments.isEmpty || restoredServerEditorState else { return }
        let state = editorStatePayload(fallbackRoot: rootPath)
        if let data = try? JSONEncoder().encode(state) {
            UserDefaults.standard.set(data, forKey: workspaceStorageKey)
        }
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
