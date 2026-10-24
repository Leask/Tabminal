import Foundation
import Observation

public enum TabminalEditorError: LocalizedError, Sendable {
    case missingVersion
    case unacknowledgedWrite
    case writeFailed(String)

    public var errorDescription: String? {
        switch self {
        case .missingVersion:
            return "Reload the file before saving: its version is missing."
        case .unacknowledgedWrite:
            return "The host did not confirm this file save. Your edits are kept."
        case .writeFailed(let message):
            return message
        }
    }
}

public protocol TabminalFileEditingClient: Sendable {
    func readFile(
        server: TabminalServerEndpoint, path: String
    ) async throws -> TabminalReadFileResponse
    func writeFile(
        server: TabminalServerEndpoint, sessionID: String, path: String,
        content: String, expectedVersion: String, force: Bool
    ) async throws -> TabminalFileWriteResult
}

extension TabminalAPIClient: TabminalFileEditingClient {}

@MainActor
@Observable
public final class TabminalEditorDocument: Identifiable {
    private final class WeakDocument {
        weak var value: TabminalEditorDocument?
        init(_ value: TabminalEditorDocument) { self.value = value }
    }

    private static var documents: [TabminalDraftIdentity: WeakDocument] = [:]
    private static var opening: [
        TabminalDraftIdentity: Task<TabminalEditorDocument, Error>
    ] = [:]

    public let id = UUID()
    public let path: String
    public var content: String {
        didSet {
            if content != oldValue { queueDraft() }
        }
    }
    public private(set) var savedContent: String
    public private(set) var version: String
    public private(set) var readonly: Bool
    public private(set) var conflict: TabminalReadFileResponse?
    public private(set) var isSaving = false
    public private(set) var isReloading = false
    public private(set) var errorMessage = ""
    public private(set) var draftErrorMessage = ""
    private var pendingSaveContent: String?
    private var awaitingHostRead = false

    @ObservationIgnored private let server: TabminalServerEndpoint
    @ObservationIgnored private let sessionID: String
    @ObservationIgnored private let client: any TabminalFileEditingClient
    @ObservationIgnored private let drafts: any TabminalEditorDraftStore
    @ObservationIgnored private let identity: TabminalDraftIdentity
    @ObservationIgnored private var draftTask: Task<Void, Never>?
    private var revision = 0
    private var persistedRevision = 0

    public var name: String { URL(fileURLWithPath: path).lastPathComponent }
    public var isDirty: Bool {
        content != savedContent || conflict != nil || pendingSaveContent != nil
            || awaitingHostRead
    }
    public var isBusy: Bool { isSaving || isReloading }
    public var canSave: Bool { isDirty && !isBusy && !readonly && conflict == nil }
    public var hasPersistedDraft: Bool {
        isDirty && revision == persistedRevision && draftErrorMessage.isEmpty
    }

    private init(
        server: TabminalServerEndpoint, sessionID: String, path: String,
        snapshot: TabminalReadFileResponse, draft: TabminalEditorDraft?,
        client: any TabminalFileEditingClient,
        drafts: any TabminalEditorDraftStore
    ) {
        self.server = server
        self.sessionID = sessionID
        self.path = path
        self.client = client
        self.drafts = drafts
        self.identity = TabminalDraftIdentity(
            server: server, sessionID: sessionID, path: path
        )
        self.content = draft?.content ?? snapshot.content
        self.savedContent = draft?.savedContent ?? snapshot.content
        self.version = draft?.version ?? snapshot.version
        self.readonly = snapshot.readonly
        self.pendingSaveContent = draft?.pendingSaveContent
        if let draft, draft.version != snapshot.version || draft.pendingSaveContent != nil {
            if draft.content == snapshot.content,
               draft.pendingSaveContent == nil || draft.pendingSaveContent == draft.content {
                // A save may have reached the host before the app closed.
                self.savedContent = snapshot.content
                self.version = snapshot.version
                self.pendingSaveContent = nil
            } else {
                self.conflict = snapshot
            }
        }
    }

    public static func open(
        server: TabminalServerEndpoint, sessionID: String, path: String,
        client: any TabminalFileEditingClient = TabminalAPIClient(),
        drafts: any TabminalEditorDraftStore = TabminalFileDraftStore.shared
    ) async throws -> TabminalEditorDocument {
        let identity = TabminalDraftIdentity(
            server: server, sessionID: sessionID, path: path
        )
        if let document = documents[identity]?.value {
            if !document.isDirty, !document.isBusy {
                await document.reloadFromServer()
            }
            return document
        }
        if let pending = opening[identity] { return try await pending.value }
        let pending = Task {
            try await openUncached(
                server: server, sessionID: sessionID, path: path,
                client: client, drafts: drafts, identity: identity
            )
        }
        opening[identity] = pending
        defer { opening[identity] = nil }
        let document = try await pending.value
        documents = documents.filter { $0.value.value != nil }
        documents[identity] = WeakDocument(document)
        return document
    }

    private static func openUncached(
        server: TabminalServerEndpoint, sessionID: String, path: String,
        client: any TabminalFileEditingClient,
        drafts: any TabminalEditorDraftStore, identity: TabminalDraftIdentity
    ) async throws -> TabminalEditorDocument {
        let draft = try await drafts.load(for: identity)
        let snapshot: TabminalReadFileResponse
        var readError: Error?
        do {
            snapshot = try await client.readFile(server: server, path: path)
        } catch {
            guard let draft else { throw error }
            // Even a deleted or currently unreachable file must not lose edits.
            snapshot = TabminalReadFileResponse(
                content: draft.savedContent, readonly: false,
                version: draft.version
            )
            readError = error
        }
        let document = TabminalEditorDocument(
            server: server, sessionID: sessionID, path: path,
            snapshot: snapshot, draft: draft, client: client, drafts: drafts
        )
        if let readError {
            document.awaitingHostRead = true
            document.conflict = nil
            document.errorMessage = message(for: readError)
        }
        if draft != nil, !document.isDirty {
            document.queueDraft()
            await document.flushDraft()
        }
        return document
    }

    public func save() async {
        guard conflict == nil else { return }
        await performSave(force: false)
    }

    public func overwriteConflict() async {
        guard conflict != nil else { return }
        await performSave(force: true)
    }

    private func performSave(force: Bool) async {
        guard !isBusy, isDirty else { return }
        guard !readonly else {
            errorMessage = "This file is read-only. Your edits are kept."
            return
        }
        isSaving = true
        errorMessage = ""
        defer { isSaving = false }
        let submittedContent = content
        let submittedVersion = version
        pendingSaveContent = submittedContent
        queueDraft()
        await flushDraft()
        do {
            let result = try await client.writeFile(
                server: server, sessionID: sessionID, path: path,
                content: submittedContent, expectedVersion: submittedVersion,
                force: force
            )
            switch result.status {
            case .ok:
                guard let version = result.version, !version.isEmpty,
                      let readonly = result.readonly else {
                    throw TabminalClientError.invalidResponse
                }
                self.version = version
                self.readonly = readonly
                savedContent = submittedContent
                pendingSaveContent = nil
                awaitingHostRead = false
                conflict = nil
            case .conflict:
                guard let content = result.content, let version = result.version,
                      !version.isEmpty, let readonly = result.readonly else {
                    throw TabminalClientError.invalidResponse
                }
                conflict = TabminalReadFileResponse(
                    content: content, readonly: readonly, version: version
                )
                self.readonly = readonly
                pendingSaveContent = nil
                awaitingHostRead = false
            case .error:
                throw TabminalEditorError.writeFailed(result.error ?? "Write failed.")
            }
        } catch {
            errorMessage = Self.message(for: error)
        }
        queueDraft()
        await flushDraft()
    }

    public func reloadFromServer() async {
        guard !isBusy else { return }
        isReloading = true
        errorMessage = ""
        defer { isReloading = false }
        let previousContent = content
        do {
            let snapshot = try await client.readFile(server: server, path: path)
            guard content == previousContent else {
                conflict = snapshot
                errorMessage = "The text changed while reloading. Your edits are kept."
                return
            }
            content = snapshot.content
            savedContent = snapshot.content
            version = snapshot.version
            readonly = snapshot.readonly
            pendingSaveContent = nil
            awaitingHostRead = false
            conflict = nil
            queueDraft()
            await flushDraft()
        } catch {
            errorMessage = Self.message(for: error)
        }
    }

    public func flushDraft() async {
        if persistedRevision < revision, draftTask == nil { startDraftTask() }
        await draftTask?.value
    }

    private func queueDraft() {
        revision += 1
        if draftTask == nil { startDraftTask() }
    }

    private func startDraftTask() {
        // Serialize writes and coalesce edits made during an in-flight write.
        draftTask = Task {
            while persistedRevision < revision {
                let savingRevision = revision
                let draft = isDirty ? TabminalEditorDraft(
                    content: content, savedContent: savedContent, version: version,
                    pendingSaveContent: pendingSaveContent
                ) : nil
                do {
                    try await drafts.save(draft, for: identity)
                    persistedRevision = savingRevision
                    draftErrorMessage = ""
                } catch {
                    draftErrorMessage = "Could not keep a local draft: \(error.localizedDescription)"
                    break
                }
            }
            draftTask = nil
        }
    }

    private static func message(for error: Error) -> String {
        if case TabminalClientError.invalidStatus(let code, _) = error {
            return "The host returned HTTP \(code). Your edits are kept."
        }
        if case TabminalClientError.accessLoginRequired = error {
            return "Sign in to this host before saving. Your edits are kept."
        }
        return error.localizedDescription
    }
}
