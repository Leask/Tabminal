import Foundation
import Testing
@testable import TabminalMobileCore

@Suite
struct TabminalEditorDraftStoreTests {
    private struct TemporaryDirectory {
        let root: URL
        let drafts: URL

        init() throws {
            root = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            drafts = root.appendingPathComponent("drafts", isDirectory: true)
            try FileManager.default.createDirectory(
                at: root, withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
        }

        func remove() throws {
            try FileManager.default.removeItem(at: root)
        }

        func files() throws -> [URL] {
            try FileManager.default.contentsOfDirectory(
                at: drafts, includingPropertiesForKeys: nil
            )
        }
    }

    private func identity(
        hostID: String = "main",
        baseURL: String = "https://example.invalid/prefix",
        sessionID: String = "session-1",
        path: String = "/workspace/file.txt"
    ) throws -> TabminalDraftIdentity {
        TabminalDraftIdentity(
            server: TabminalServerEndpoint(
                id: hostID, baseURL: try #require(URL(string: baseURL))
            ),
            sessionID: sessionID,
            path: path
        )
    }

    private func draft(_ content: String = "edited") -> TabminalEditorDraft {
        TabminalEditorDraft(
            content: content, savedContent: "original", version: "version-1"
        )
    }

    private func permissions(at url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(
            atPath: url.path
        )
        return try #require(attributes[.posixPermissions] as? NSNumber).intValue
    }

    @Test
    func modelsRoundTripAndNormalizeOnlyTheEndpoint() throws {
        let value = try identity(
            baseURL: "https://example.invalid/prefix/?query=ignored#fragment",
            path: "/workspace/a/../file.txt"
        )
        #expect(value.hostID == "main")
        #expect(value.baseURL.absoluteString == "https://example.invalid/prefix")
        #expect(value.path == "/workspace/a/../file.txt")
        let data = try JSONEncoder().encode(value)
        #expect(try JSONDecoder().decode(TabminalDraftIdentity.self, from: data) == value)
        let expected = draft("\u{4E2D}\u{6587}\n\u{0000}text")
        let draftData = try JSONEncoder().encode(expected)
        #expect(try JSONDecoder().decode(TabminalEditorDraft.self, from: draftData) == expected)
    }

    @Test
    func initializationAndMissingReadsDoNotCreateDirectories() async throws {
        let temporary = try TemporaryDirectory()
        defer { try? temporary.remove() }
        let store: any TabminalEditorDraftStore = TabminalFileDraftStore(
            directory: temporary.drafts
        )
        #expect(!FileManager.default.fileExists(atPath: temporary.drafts.path))
        #expect(try await store.load(for: identity()) == nil)
        try await store.save(nil, for: identity())
        #expect(!FileManager.default.fileExists(atPath: temporary.drafts.path))
    }

    @Test
    func persistenceSurvivesActorRecreationAndAtomicReplacement() async throws {
        let temporary = try TemporaryDirectory()
        defer { try? temporary.remove() }
        let key = try identity()
        let first = TabminalFileDraftStore(directory: temporary.drafts)
        try await first.save(draft(), for: key)
        let initialFile = try #require(temporary.files().first)
        #expect(try permissions(at: temporary.drafts) == 0o700)
        #expect(try permissions(at: initialFile) == 0o600)

        let second = TabminalFileDraftStore(directory: temporary.drafts)
        #expect(try await second.load(for: key) == draft())
        let replacement = TabminalEditorDraft(
            content: "", savedContent: "updated base", version: "version-2"
        )
        try await second.save(replacement, for: key)
        #expect(try temporary.files() == [initialFile])
        #expect(try permissions(at: initialFile) == 0o600)
        #expect(try await first.load(for: key) == replacement)
#if os(iOS) || os(visionOS)
        let attributes = try FileManager.default.attributesOfItem(
            atPath: initialFile.path
        )
        #expect(
            attributes[.protectionKey] as? FileProtectionType
                == .completeUntilFirstUserAuthentication
        )
#endif
    }

    @Test
    func interruptedSaveIntentSurvivesActorRecreation() async throws {
        let temporary = try TemporaryDirectory()
        defer { try? temporary.remove() }
        let key = try identity()
        let first = TabminalFileDraftStore(directory: temporary.drafts)
        let pending = TabminalEditorDraft(
            content: "original", savedContent: "original", version: "version-1",
            pendingSaveContent: "submitted before undo"
        )
        try await first.save(pending, for: key)
        let recreated = TabminalFileDraftStore(directory: temporary.drafts)
        #expect(try await recreated.load(for: key) == pending)
    }

    @Test
    func everyIdentityDimensionHasIndependentStorage() async throws {
        let temporary = try TemporaryDirectory()
        defer { try? temporary.remove() }
        let store = TabminalFileDraftStore(directory: temporary.drafts)
        let keys = try [
            identity(),
            identity(hostID: "another-host"),
            identity(baseURL: "http://example.invalid/prefix"),
            identity(baseURL: "https://other.invalid/prefix"),
            identity(baseURL: "https://example.invalid:8443/prefix"),
            identity(baseURL: "https://example.invalid/other-prefix"),
            identity(sessionID: "another-session"),
            identity(path: "/workspace/another-file.txt")
        ]
        #expect(Set(keys).count == keys.count)
        for (index, key) in keys.enumerated() {
            try await store.save(draft("draft-\(index)"), for: key)
        }
        #expect(try temporary.files().count == keys.count)
        let restored = TabminalFileDraftStore(directory: temporary.drafts)
        for (index, key) in keys.enumerated() {
            #expect(try await restored.load(for: key) == draft("draft-\(index)"))
        }
    }

    @Test
    func equivalentNormalizedURLsShareDraftWithoutUsingCredentials() async throws {
        let temporary = try TemporaryDirectory()
        defer { try? temporary.remove() }
        let store = TabminalFileDraftStore(directory: temporary.drafts)
        let key = try identity()
        let server = TabminalServerEndpoint(
            id: key.hostID,
            baseURL: try #require(URL(
                string: "https://example.invalid/prefix/?ignored=true#fragment"
            )),
            host: "New display name", token: "not-part-of-identity"
        )
        let equivalent = TabminalDraftIdentity(
            server: server, sessionID: key.sessionID, path: key.path
        )
        #expect(equivalent == key)
        try await store.save(draft(), for: key)
        #expect(try await store.load(for: equivalent) == draft())
        #expect(try temporary.files().count == 1)
    }

    @Test
    func deletionIsIdempotentAndDocumentScoped() async throws {
        let temporary = try TemporaryDirectory()
        defer { try? temporary.remove() }
        let store = TabminalFileDraftStore(directory: temporary.drafts)
        let first = try identity()
        let second = try identity(path: "/workspace/other.txt")
        try await store.save(draft("first"), for: first)
        try await store.save(draft("second"), for: second)
        try await store.save(nil, for: first)
        try await store.save(nil, for: first)
        #expect(try await store.load(for: first) == nil)
        #expect(try await store.load(for: second) == draft("second"))
        #expect(try temporary.files().count == 1)
        try await store.save(nil, for: second)
        #expect(try temporary.files().isEmpty)
    }

    @Test
    func hostileIdentityStringsOnlyProduceHashedFilenames() async throws {
        let temporary = try TemporaryDirectory()
        defer { try? temporary.remove() }
        let sentinel = temporary.root.appendingPathComponent("outside")
        try Data("untouched".utf8).write(to: sentinel)
        let store = TabminalFileDraftStore(directory: temporary.drafts)
        let paths = [
            "../../outside", "/absolute/path", "file:///tmp/escape",
            "a\\b:c\u{0000}\n\u{4E2D}", String(repeating: "x", count: 4096)
        ]
        for path in paths {
            let key = try identity(
                hostID: "../../host", sessionID: "../session:1", path: path
            )
            try await store.save(draft(path), for: key)
            #expect(try await store.load(for: key) == draft(path))
        }
        let files = try temporary.files()
        #expect(files.count == paths.count)
        for file in files {
            #expect(file.lastPathComponent.range(
                of: "^[0-9a-f]{64}\\.json$", options: .regularExpression
            ) != nil)
            #expect(try permissions(at: file) == 0o600)
        }
        #expect(try Data(contentsOf: sentinel) == Data("untouched".utf8))
    }

    @Test(arguments: ["json", "draft", "hostID", "baseURL", "sessionID", "path"])
    func corruptionAndIdentityMismatchThrowWithoutDeletingDraft(
        field: String
    ) async throws {
        let temporary = try TemporaryDirectory()
        defer { try? temporary.remove() }
        let store = TabminalFileDraftStore(directory: temporary.drafts)
        let key = try identity()
        try await store.save(draft(), for: key)
        let file = try #require(temporary.files().first)
        let corrupted: Data
        if field == "json" {
            corrupted = Data("not json".utf8)
        } else {
            var envelope = try #require(JSONSerialization.jsonObject(
                with: Data(contentsOf: file)
            ) as? [String: Any])
            if field == "draft" {
                envelope["draft"] = ["content": "missing required fields"]
            } else {
                var identity = try #require(
                    envelope["identity"] as? [String: Any]
                )
                identity[field] = field == "baseURL"
                    ? "https://wrong.invalid/" : "wrong"
                envelope["identity"] = identity
            }
            corrupted = try JSONSerialization.data(withJSONObject: envelope)
        }
        try corrupted.write(to: file)
        await #expect(throws: (any Error).self) {
            _ = try await store.load(for: key)
        }
        #expect(try Data(contentsOf: file) == corrupted)
    }

    @Test
    func existingPermissionsAreRestrictedOnLoad() async throws {
        let temporary = try TemporaryDirectory()
        defer { try? temporary.remove() }
        let store = TabminalFileDraftStore(directory: temporary.drafts)
        let key = try identity()
        try await store.save(draft(), for: key)
        let file = try #require(temporary.files().first)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755], ofItemAtPath: temporary.drafts.path
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o644], ofItemAtPath: file.path
        )
        #expect(try await store.load(for: key) == draft())
        #expect(try permissions(at: temporary.drafts) == 0o700)
        #expect(try permissions(at: file) == 0o600)
    }

    @Test
    func fileSymlinksAreNotFollowedAndAtomicSaveReplacesTheLink() async throws {
        let temporary = try TemporaryDirectory()
        defer { try? temporary.remove() }
        let store = TabminalFileDraftStore(directory: temporary.drafts)
        let key = try identity()
        try await store.save(draft(), for: key)
        let file = try #require(temporary.files().first)
        let outside = temporary.root.appendingPathComponent("outside.json")
        let previous = try Data(contentsOf: file)
        try FileManager.default.moveItem(at: file, to: outside)
        try FileManager.default.createSymbolicLink(
            at: file, withDestinationURL: outside
        )
        await #expect(throws: (any Error).self) {
            _ = try await store.load(for: key)
        }
        try await store.save(draft("replacement"), for: key)
        #expect(try await store.load(for: key) == draft("replacement"))
        #expect(try Data(contentsOf: outside) == previous)
        let attributes = try FileManager.default.attributesOfItem(
            atPath: file.path
        )
        #expect(attributes[.type] as? FileAttributeType == .typeRegular)
    }

    @Test(arguments: [false, true])
    func unusableDirectorySurfacesErrors(symbolicLink: Bool) async throws {
        let temporary = try TemporaryDirectory()
        defer { try? temporary.remove() }
        if symbolicLink {
            try FileManager.default.createSymbolicLink(
                at: temporary.drafts, withDestinationURL: temporary.root
            )
        } else {
            try Data("not a directory".utf8).write(to: temporary.drafts)
        }
        let store = TabminalFileDraftStore(directory: temporary.drafts)
        await #expect(throws: (any Error).self) {
            _ = try await store.load(for: identity())
        }
        await #expect(throws: (any Error).self) {
            try await store.save(draft(), for: identity())
        }
        await #expect(throws: (any Error).self) {
            try await store.save(nil, for: identity())
        }
    }

    @Test
    func failedReplacementCleansTemporaryFiles() async throws {
        let temporary = try TemporaryDirectory()
        defer { try? temporary.remove() }
        let store = TabminalFileDraftStore(directory: temporary.drafts)
        let key = try identity()
        try await store.save(draft(), for: key)
        let file = try #require(temporary.files().first)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(
            at: file, withIntermediateDirectories: false
        )
        await #expect(throws: (any Error).self) {
            try await store.save(draft("new"), for: key)
        }
        let remaining = try temporary.files().map(\.lastPathComponent)
        #expect(remaining == [file.lastPathComponent])
        await #expect(throws: (any Error).self) {
            _ = try await store.load(for: key)
        }
    }

    @Test
    func atomicReadersOnlyObserveCompleteDrafts() async throws {
        let temporary = try TemporaryDirectory()
        defer { try? temporary.remove() }
        let writer = TabminalFileDraftStore(directory: temporary.drafts)
        let reader = TabminalFileDraftStore(directory: temporary.drafts)
        let key = try identity()
        let first = draft(String(repeating: "first", count: 4096))
        let second = draft(String(repeating: "second", count: 4096))
        try await writer.save(first, for: key)
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                for index in 0 ..< 20 {
                    try await writer.save(
                        index.isMultiple(of: 2) ? first : second, for: key
                    )
                }
            }
            group.addTask {
                for _ in 0 ..< 40 {
                    let value = try await reader.load(for: key)
                    #expect(value == first || value == second)
                }
            }
            try await group.waitForAll()
        }
        #expect(try temporary.files().count == 1)
    }

    @Test
    func newlyCreatedNestedDirectoriesArePrivate() async throws {
        let temporary = try TemporaryDirectory()
        defer { try? temporary.remove() }
        let nested = temporary.drafts.appendingPathComponent("nested")
        let store = TabminalFileDraftStore(directory: nested)
        try await store.save(draft(), for: identity())
        #expect(try permissions(at: temporary.drafts) == 0o700)
        #expect(try permissions(at: nested) == 0o700)
    }
}
