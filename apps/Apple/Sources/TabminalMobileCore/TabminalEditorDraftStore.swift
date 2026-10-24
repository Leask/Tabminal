import CryptoKit
import Darwin
import Foundation

public struct TabminalDraftIdentity: Codable, Hashable, Sendable {
    public let hostID: String
    public let baseURL: URL
    public let sessionID: String
    public let path: String

    public init(
        server: TabminalServerEndpoint,
        sessionID: String,
        path: String
    ) {
        hostID = server.id
        baseURL = TabminalURL.normalizeBaseURL(server.baseURL)
        self.sessionID = sessionID
        self.path = path
    }
}

public struct TabminalEditorDraft: Codable, Equatable, Sendable {
    public let content: String
    public let savedContent: String
    public let version: String
    public let pendingSaveContent: String?

    public init(
        content: String, savedContent: String, version: String,
        pendingSaveContent: String? = nil
    ) {
        self.content = content
        self.savedContent = savedContent
        self.version = version
        self.pendingSaveContent = pendingSaveContent
    }
}

public protocol TabminalEditorDraftStore: Sendable {
    func load(
        for identity: TabminalDraftIdentity
    ) async throws -> TabminalEditorDraft?

    func save(
        _ draft: TabminalEditorDraft?,
        for identity: TabminalDraftIdentity
    ) async throws
}

public actor TabminalFileDraftStore: TabminalEditorDraftStore {
    public static let shared = TabminalFileDraftStore()

    private struct Envelope: Codable {
        let identity: TabminalDraftIdentity
        let draft: TabminalEditorDraft
    }

    private var directory: URL?

    public init(directory: URL? = nil) {
        self.directory = directory
    }

    public func load(
        for identity: TabminalDraftIdentity
    ) async throws -> TabminalEditorDraft? {
        guard let directoryFD = try openDirectory(create: false) else {
            return nil
        }
        defer { close(directoryFD) }
        let name = try filename(for: identity)
        let descriptor = openat(
            directoryFD, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK
        )
        if descriptor == -1 {
            if errno == ENOENT { return nil }
            throw fileSystemError()
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var attributes = stat()
        guard fstat(descriptor, &attributes) == 0 else {
            throw fileSystemError()
        }
        guard attributes.st_mode & S_IFMT == S_IFREG else {
            throw CocoaError(.fileReadCorruptFile)
        }
        guard fchmod(descriptor, 0o600) == 0 else { throw fileSystemError() }
        let data = try handle.readToEnd() ?? Data()
        let envelope = try JSONDecoder().decode(Envelope.self, from: data)
        guard envelope.identity == identity else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return envelope.draft
    }

    public func save(
        _ draft: TabminalEditorDraft?,
        for identity: TabminalDraftIdentity
    ) async throws {
        guard let directoryFD = try openDirectory(create: draft != nil) else {
            return
        }
        defer { close(directoryFD) }
        let name = try filename(for: identity)
        guard let draft else {
            if unlinkat(directoryFD, name, 0) == -1, errno != ENOENT {
                throw fileSystemError()
            }
            return
        }
        let data = try JSONEncoder().encode(
            Envelope(identity: identity, draft: draft)
        )
        let temporaryName = ".\(UUID().uuidString).tmp"
        // Create privately before writing. Data.write(.atomic) alone does not
        // guarantee private permissions for its temporary file.
        let descriptor = openat(
            directoryFD, temporaryName,
            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600
        )
        guard descriptor != -1 else { throw fileSystemError() }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer {
            try? handle.close()
            unlinkat(directoryFD, temporaryName, 0)
        }
        guard fchmod(descriptor, 0o600) == 0 else { throw fileSystemError() }
#if os(iOS) || os(visionOS)
        let temporaryURL = try resolvedDirectory()
            .appendingPathComponent(temporaryName)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: temporaryURL.path
        )
#endif
        try handle.write(contentsOf: data)
        try handle.synchronize()
        try handle.close()
        guard renameat(directoryFD, temporaryName, directoryFD, name) == 0 else {
            throw fileSystemError()
        }
    }

    private func filename(for identity: TabminalDraftIdentity) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let digest = SHA256.hash(data: try encoder.encode(identity))
        return digest.map { String(format: "%02x", $0) }.joined() + ".json"
    }

    private func resolvedDirectory() throws -> URL {
        if let directory {
            guard directory.isFileURL else {
                throw CocoaError(.fileReadUnsupportedScheme)
            }
            return directory
        }
        let support = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: false
        )
        let resolved = support.appendingPathComponent(
            "Tabminal/editor-drafts", isDirectory: true
        )
        directory = resolved
        return resolved
    }

    private func openDirectory(create: Bool) throws -> Int32? {
        let directory = try resolvedDirectory()
        if create {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        }
        let descriptor = open(
            directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor != -1 else {
            if !create, errno == ENOENT { return nil }
            throw fileSystemError()
        }
        guard fchmod(descriptor, 0o700) == 0 else {
            let error = fileSystemError()
            close(descriptor)
            throw error
        }
        return descriptor
    }

    private func fileSystemError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}
