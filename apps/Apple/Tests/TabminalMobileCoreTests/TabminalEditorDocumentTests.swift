import Foundation
import Observation
import Synchronization
import Testing
@testable import TabminalMobileCore

private actor DraftMemory: TabminalEditorDraftStore {
    var entries: [TabminalDraftIdentity: TabminalEditorDraft] = [:]

    func load(for identity: TabminalDraftIdentity) -> TabminalEditorDraft? {
        entries[identity]
    }

    func save(_ draft: TabminalEditorDraft?, for identity: TabminalDraftIdentity) {
        entries[identity] = draft
    }
}

private actor EditorHost: TabminalFileEditingClient {
    nonisolated let endpoint = TabminalServerEndpoint(
        id: "main", baseURL: URL(string: "https://\(UUID().uuidString).example.invalid")!
    )
    struct Write: Sendable {
        let server: TabminalServerEndpoint
        let sessionID: String
        let path: String
        let content: String
        let version: String
        let force: Bool
    }

    var snapshot = TabminalReadFileResponse(
        content: "original", readonly: false, version: "v1"
    )
    var writes: [Write] = []
    var readError: TabminalClientError?
    var writeError: TabminalClientError?
    var holdWrites = false
    var pending: CheckedContinuation<Void, Never>?
    var started: CheckedContinuation<Void, Never>?

    func readFile(
        server: TabminalServerEndpoint, path: String
    ) throws -> TabminalReadFileResponse {
        if let readError { throw readError }
        return snapshot
    }

    func writeFile(
        server: TabminalServerEndpoint, sessionID: String, path: String,
        content: String, expectedVersion: String, force: Bool
    ) async throws -> TabminalFileWriteResult {
        writes.append(Write(
            server: server, sessionID: sessionID, path: path, content: content,
            version: expectedVersion, force: force
        ))
        if holdWrites {
            await withCheckedContinuation { continuation in
                pending = continuation
                started?.resume()
                started = nil
            }
        }
        if let writeError { throw writeError }
        if !force, expectedVersion != snapshot.version {
            return TabminalFileWriteResult(
                path: path, status: .conflict, version: snapshot.version,
                content: snapshot.content, readonly: snapshot.readonly, error: nil
            )
        }
        snapshot = TabminalReadFileResponse(
            content: content, readonly: snapshot.readonly,
            version: snapshot.version + ".next"
        )
        return TabminalFileWriteResult(
            path: path, status: .ok, version: snapshot.version,
            content: nil, readonly: snapshot.readonly, error: nil
        )
    }

    func change(_ text: String, readonly: Bool = false) {
        snapshot = TabminalReadFileResponse(
            content: text, readonly: readonly, version: snapshot.version + ".remote"
        )
    }

    func failRead(_ code: Int) { readError = .invalidStatus(code, "read failed") }
    func failWrite() { writeError = .invalidStatus(500, "write failed") }
    func pauseWrites() { holdWrites = true }

    func waitForWrite() async {
        if pending != nil { return }
        await withCheckedContinuation { started = $0 }
    }

    func finishWrite() {
        pending?.resume()
        pending = nil
        holdWrites = false
    }
}

@MainActor
private func openEditor(
    _ host: EditorHost, drafts: DraftMemory = DraftMemory(),
    server: TabminalServerEndpoint? = nil, sessionID: String = "session-a"
) async throws -> TabminalEditorDocument {
    try await TabminalEditorDocument.open(
        server: server ?? host.endpoint, sessionID: sessionID, path: "/owned/file.txt",
        client: host, drafts: drafts
    )
}

@Test @MainActor
func editorSavesVersionAndKeepsNewTypingDuringSave() async throws {
    let host = EditorHost()
    let drafts = DraftMemory()
    let document = try await openEditor(host, drafts: drafts)
    document.content = "submitted"
    await host.pauseWrites()
    let saving = Task { await document.save() }
    await host.waitForWrite()
    document.content = "typed while saving"
    await document.save()
    await host.finishWrite()
    await saving.value
    #expect(document.savedContent == "submitted")
    #expect(document.content == "typed while saving")
    #expect(document.isDirty)
    #expect(document.version == "v1.next")
    let writes = await host.writes
    #expect(writes.count == 1)
    #expect(writes.first?.version == "v1")
    #expect(writes.first?.sessionID == "session-a")
    #expect(writes.first?.path == "/owned/file.txt")
    #expect(writes.first?.server == host.endpoint)
    #expect(writes.first?.force == false)
    let identity = TabminalDraftIdentity(
        server: host.endpoint, sessionID: "session-a", path: document.path
    )
    let draft = await drafts.load(for: identity)
    #expect(draft?.content == "typed while saving")
    #expect(draft?.savedContent == "submitted")
    #expect(draft?.version == "v1.next")
}

@Test @MainActor
func editorRequiresExplicitOverwriteAfterConflict() async throws {
    let host = EditorHost()
    let document = try await openEditor(host)
    document.content = "my changes"
    await host.change("other writer")
    await document.save()
    #expect(document.content == "my changes")
    #expect(document.savedContent == "original")
    #expect(document.version == "v1")
    #expect(document.conflict?.content == "other writer")
    #expect(await host.snapshot.content == "other writer")
    await document.save()
    #expect(await host.writes.count == 1)
    await document.overwriteConflict()
    #expect(await host.writes.last?.force == true)
    #expect(await host.snapshot.content == "my changes")
    #expect(document.conflict == nil)
    #expect(!document.isDirty)
}

@Test @MainActor
func editorReloadFetchesLatestCopyAndRemovesDraft() async throws {
    let host = EditorHost()
    let drafts = DraftMemory()
    let document = try await openEditor(host, drafts: drafts)
    document.content = "my changes"
    await host.change("first external edit")
    await document.save()
    await host.change("newer external edit")
    await document.reloadFromServer()
    #expect(document.content == "newer external edit")
    #expect(!document.isDirty)
    #expect(document.conflict == nil)
    #expect(await drafts.entries.isEmpty)
}

@Test @MainActor
func editorFailurePreservesTextVersionAndDraft() async throws {
    let host = EditorHost()
    let drafts = DraftMemory()
    let document = try await openEditor(host, drafts: drafts)
    document.content = "keep this text"
    await host.failWrite()
    await document.save()
    #expect(document.content == "keep this text")
    #expect(document.savedContent == "original")
    #expect(document.version == "v1")
    #expect(document.isDirty)
    #expect(!document.errorMessage.isEmpty)
    #expect(await drafts.entries.count == 1)
}

@Test @MainActor
func editorRestoreRetainsUnsavedTextAndDetectsOfflineChanges() async throws {
    let host = EditorHost()
    let drafts = DraftMemory()
    try await leaveDraft(host, drafts: drafts, content: "unsaved before relaunch")
    await host.change("external update while away")
    let restored = try await openEditor(host, drafts: drafts)
    #expect(restored.content == "unsaved before relaunch")
    #expect(restored.savedContent == "original")
    #expect(restored.version == "v1")
    #expect(restored.conflict?.content == "external update while away")
    #expect(restored.isDirty)
}

@Test @MainActor
func editorRestoreRecognizesSaveWhoseAcknowledgementWasLost() async throws {
    let host = EditorHost()
    let drafts = DraftMemory()
    try await leaveDraft(host, drafts: drafts, content: "already reached the host")
    await host.change("already reached the host")
    let restored = try await openEditor(host, drafts: drafts)
    #expect(!restored.isDirty)
    #expect(restored.conflict == nil)
    #expect(restored.version == "v1.remote")
    #expect(await drafts.entries.isEmpty)
}

@Test @MainActor
func editorRestoresDraftEvenWhenFileHasBeenDeleted() async throws {
    let host = EditorHost()
    let drafts = DraftMemory()
    try await leaveDraft(host, drafts: drafts, content: "recovery text")
    await host.failRead(404)
    let restored = try await openEditor(host, drafts: drafts)
    #expect(restored.content == "recovery text")
    #expect(restored.isDirty)
    #expect(restored.errorMessage.contains("404"))
    await restored.reloadFromServer()
    #expect(restored.content == "recovery text")
}

@Test(arguments: [400, 404, 415]) @MainActor
func editorReadFailureDoesNotCreateAnEmptyDocument(_ code: Int) async throws {
    let host = EditorHost()
    await host.failRead(code)
    await #expect(throws: (any Error).self) { _ = try await openEditor(host) }
    #expect(await host.writes.isEmpty)
}

@Test @MainActor
func editorReadOnlyFileNeverSendsAWrite() async throws {
    let host = EditorHost()
    await host.change("protected", readonly: true)
    let document = try await openEditor(host)
    document.content = "local draft"
    await document.save()
    #expect(await host.writes.isEmpty)
    #expect(document.isDirty)
    #expect(document.errorMessage.contains("read-only"))
}

@Test @MainActor
func editorDraftsAndSaveCompletionStayWithTheirOriginalIdentity() async throws {
    let host = EditorHost()
    let drafts = DraftMemory()
    let first = try await openEditor(host, drafts: drafts)
    first.content = "session a draft"
    await first.flushDraft()
    let second = try await openEditor(host, drafts: drafts, sessionID: "session-b")
    #expect(second.content == "original")
    second.content = "session b draft"
    await host.pauseWrites()
    let saving = Task { await first.save() }
    await host.waitForWrite()
    await host.finishWrite()
    await saving.value
    #expect(second.content == "session b draft")
    #expect(second.savedContent == "original")
    #expect(second.isDirty)
    let otherHost = TabminalServerEndpoint(
        id: "secondary", baseURL: URL(string: "https://other.example.invalid")!
    )
    let third = try await openEditor(host, drafts: drafts, server: otherHost)
    #expect(third.content != "session b draft")
}

@MainActor
private func leaveDraft(
    _ host: EditorHost, drafts: DraftMemory, content: String
) async throws {
    let document = try await openEditor(host, drafts: drafts)
    document.content = content
    await document.flushDraft()
}

@Test @MainActor
func undoDuringSaveKeepsTheIntendedTextInTheRecoveryDraft() async throws {
    let host = EditorHost()
    let drafts = DraftMemory()
    let document = try await openEditor(host, drafts: drafts)
    document.content = "submitted"
    await host.pauseWrites()
    let saving = Task { await document.save() }
    await host.waitForWrite()
    document.content = "original"
    await document.flushDraft()
    let identity = TabminalDraftIdentity(
        server: host.endpoint, sessionID: "session-a", path: document.path
    )
    let interruptedDraft = await drafts.load(for: identity)
    #expect(interruptedDraft?.content == "original")
    #expect(interruptedDraft?.pendingSaveContent == "submitted")
    #expect(document.isDirty)
    await host.finishWrite()
    await saving.value
    #expect(document.content == "original")
    #expect(document.savedContent == "submitted")
    #expect(document.isDirty)
    #expect(await drafts.load(for: identity)?.content == "original")
}

@Test @MainActor
func reopenDuringSaveReusesTheOwnerAndKeepsLaterEdits() async throws {
    let host = EditorHost()
    let drafts = DraftMemory()
    let first = try await openEditor(host, drafts: drafts)
    first.content = "submitted"
    await host.pauseWrites()
    let saving = Task { await first.save() }
    await host.waitForWrite()
    let reopened = try await openEditor(host, drafts: drafts)
    #expect(reopened === first)
    reopened.content = "new edit after reopening"
    await host.finishWrite()
    await saving.value
    await reopened.flushDraft()
    let identity = TabminalDraftIdentity(
        server: host.endpoint, sessionID: "session-a", path: reopened.path
    )
    #expect(await drafts.load(for: identity)?.content == "new edit after reopening")
    #expect(reopened.isDirty)
    #expect(reopened.savedContent == "submitted")
}

@Test(arguments: [false, true]) @MainActor
func restoringInterruptedUndoNeverDiscardsTheDesiredText(_ committed: Bool) async throws {
    let host = EditorHost()
    let drafts = DraftMemory()
    let identity = TabminalDraftIdentity(
        server: host.endpoint, sessionID: "session-a", path: "/owned/file.txt"
    )
    await drafts.save(TabminalEditorDraft(
        content: "original", savedContent: "original", version: "v1",
        pendingSaveContent: "submitted"
    ), for: identity)
    if committed { await host.change("submitted") }
    let restored = try await openEditor(host, drafts: drafts)
    #expect(restored.content == "original")
    #expect(restored.isDirty)
    #expect(restored.conflict != nil)
    #expect(await drafts.load(for: identity)?.content == "original")
}

@MainActor
private func leaveConflictedUndoDraft(_ host: EditorHost, drafts: DraftMemory) async throws {
    let document = try await openEditor(host, drafts: drafts)
    document.content = "my changes"
    await host.change("external copy")
    await document.save()
    document.content = "original"
    await document.flushDraft()
}

@Test @MainActor
func offlineRestoreNeverTreatsAnUnverifiedBaselineAsSaved() async throws {
    let host = EditorHost()
    let drafts = DraftMemory()
    try await leaveConflictedUndoDraft(host, drafts: drafts)
    await host.failRead(503)
    let restored = try await openEditor(host, drafts: drafts)
    #expect(restored.content == "original")
    #expect(restored.isDirty)
    #expect(restored.errorMessage.contains("503"))
    restored.content = "temporary change"
    restored.content = "original"
    await restored.flushDraft()
    let identity = TabminalDraftIdentity(
        server: host.endpoint, sessionID: "session-a", path: restored.path
    )
    #expect(await drafts.load(for: identity)?.content == "original")
}

@Test @MainActor
func finishingADraftNotifiesTheVisibleSaveStatus() async throws {
    let document = try await openEditor(EditorHost())
    document.content = "edited"
    let notified = Mutex(false)
    withObservationTracking {
        #expect(!document.hasPersistedDraft)
    } onChange: {
        notified.withLock { $0 = true }
    }
    await document.flushDraft()
    #expect(document.hasPersistedDraft)
    #expect(notified.withLock { $0 })
}
