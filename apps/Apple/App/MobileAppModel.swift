import Foundation
import Observation
import TabminalMobileCore

@MainActor
@Observable
final class MobileAppModel {
    enum Phase {
        case login
        case loading
        case ready
    }

    enum HostConnectionState: String {
        case idle
        case connecting
        case connected
        case reconnecting
        case needsAuth
        case error
    }

    enum HostEditorMode {
        case add
        case edit(String)
        case reconnect(String)

        var title: String {
            switch self {
            case .add:
                return "Add Host"
            case .edit:
                return "Edit Host"
            case .reconnect:
                return "Reconnect Host"
            }
        }

        var actionTitle: String {
            switch self {
            case .add:
                return "Register"
            case .edit:
                return "Update Host"
            case .reconnect:
                return "Save and Reconnect"
            }
        }
    }

    struct HostDraft {
        var url: String = ""
        var host: String = ""
        var password: String = ""
    }

    struct SessionRecord: Identifiable, Hashable {
        let hostID: String
        let id: String
        var title: String
        var cwd: String
        var createdAt: Date?
        var env: String?
        var editorState: TabminalSessionEditorState?

        var key: String {
            "\(hostID):\(id)"
        }
    }

    struct HostRecord: Identifiable, Hashable {
        var endpoint: TabminalServerEndpoint
        var connectionState: HostConnectionState = .idle
        var sessions: [SessionRecord] = []
        var lastLatencyMs: Int?
        var runtimeHostname: String?
        var lastError: String = ""

        var id: String {
            endpoint.id
        }

        var displayName: String {
            if !endpoint.host.isEmpty {
                return endpoint.host
            }

            if let runtimeHostname,
               !runtimeHostname.trimmingCharacters(
                    in: .whitespacesAndNewlines
               ).isEmpty {
                return runtimeHostname
            }

            return endpoint.baseURL.host?.lowercased() ?? "unknown"
        }

        var isPrimary: Bool {
            endpoint.isPrimary
        }
    }

    var phase: Phase = .login

    var mainServerURL: String
    var mainPassword: String = ""
    var mainHostName: String
    var loginErrorMessage: String = ""
    var isAuthenticating: Bool = false

    var hosts: [HostRecord] = []
    var activeHostID: String = "main"
    var activeSessionKey: String?

    var isPresentingHostEditor: Bool = false
    var hostEditorMode: HostEditorMode = .add
    var hostDraft = HostDraft()
    var hostDraftErrorMessage: String = ""
    var isSubmittingHostDraft: Bool = false

    var isPresentingWorkspace: Bool = false

    @ObservationIgnored
    private let apiClient = TabminalAPIClient()
    @ObservationIgnored
    private let defaults = UserDefaults.standard
    @ObservationIgnored
    private let credentialStore = MainHostCredentialStore()
    @ObservationIgnored
    private let debugLaunchOptions = MobileDebugLaunchOptions.current
    @ObservationIgnored
    private var heartbeatTask: Task<Void, Never>?
    @ObservationIgnored
    private var mainToken: String = ""
    @ObservationIgnored
    private var workspaces: [String: SessionWorkspaceModel] = [:]
    @ObservationIgnored
    private var didAttemptRestore: Bool = false
    @ObservationIgnored
    private var didRunStartupFlow: Bool = false

    init() {
        mainServerURL = defaults.string(forKey: Self.defaultsMainURLKey)
            ?? "http://127.0.0.1:9846"
        mainHostName = defaults.string(forKey: Self.defaultsMainHostKey) ?? ""

        if let debugURL = debugLaunchOptions.mainURL {
            mainServerURL = debugURL
        }
        if let debugHost = debugLaunchOptions.hostAlias {
            mainHostName = debugHost
        }
        if let debugPassword = debugLaunchOptions.password {
            mainPassword = debugPassword
        }
    }

    var activeHost: HostRecord? {
        hosts.first { $0.id == activeHostID }
    }

    var activeSessions: [SessionRecord] {
        activeHost?.sessions ?? []
    }

    var allSessions: [SessionRecord] {
        hosts
            .flatMap(\.sessions)
            .sorted { lhs, rhs in
                let leftDate = lhs.createdAt ?? .distantPast
                let rightDate = rhs.createdAt ?? .distantPast
                if leftDate != rightDate {
                    return leftDate < rightDate
                }

                return lhs.key < rhs.key
            }
    }

    var activeSession: SessionRecord? {
        guard let activeSessionKey else {
            return activeSessions.first
        }

        return activeSessions.first { $0.key == activeSessionKey }
            ?? activeSessions.first
    }

    var activeWorkspace: SessionWorkspaceModel? {
        guard let session = activeSession else {
            return nil
        }

        return workspaces[session.key]
    }

    var isActiveWorkspaceVisible: Bool {
        activeWorkspace?.isPresented == true
    }

    var hasStoredMainLogin: Bool {
        let token = credentialStore.loadToken() ?? ""
        return !token.isEmpty
    }

    var canAttemptLogin: Bool {
        if isAuthenticating {
            return false
        }

        if !mainPassword.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return true
        }

        return hasStoredMainLogin
    }

    func login() {
        guard !isAuthenticating else {
            return
        }

        guard let parsedURL = URL(string: mainServerURL) else {
            loginErrorMessage = "Invalid server URL."
            return
        }

        let trimmedPassword = mainPassword.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        let token = !trimmedPassword.isEmpty
            ? TabminalPasswordHasher.sha256Hex(trimmedPassword)
            : credentialStore.loadToken() ?? ""

        guard !token.isEmpty else {
            loginErrorMessage = "Password is required."
            return
        }

        loginErrorMessage = ""
        isAuthenticating = true
        let mainEndpoint = TabminalServerEndpoint(
            id: "main",
            baseURL: parsedURL,
            host: mainHostName,
            token: token,
            isPrimary: true
        )

        Task {
            defer {
                isAuthenticating = false
            }

            do {
                phase = .loading
                mainToken = token
                try await bootstrap(mainEndpoint: mainEndpoint)
                defaults.set(
                    mainEndpoint.baseURL.absoluteString,
                    forKey: Self.defaultsMainURLKey
                )
                defaults.set(
                    mainEndpoint.host,
                    forKey: Self.defaultsMainHostKey
                )
                credentialStore.saveToken(token)
                phase = .ready
            } catch {
                phase = .login
                loginErrorMessage = Self.displayMessage(for: error)
            }
        }
    }

    func logout(clearCredentials: Bool = true) {
        stopHeartbeat()
        if clearCredentials {
            credentialStore.clearToken()
        }
        isPresentingWorkspace = false
        isPresentingHostEditor = false
        hosts = []
        activeHostID = "main"
        activeSessionKey = nil
        loginErrorMessage = ""
        hostDraftErrorMessage = ""
        isSubmittingHostDraft = false
        phase = .login
        mainPassword = ""
        mainToken = ""

        for workspace in workspaces.values {
            workspace.setPresented(false)
        }
        workspaces.removeAll()
    }

    func restoreMainHostSessionIfNeeded() {
        guard !didAttemptRestore else {
            return
        }
        didAttemptRestore = true

        guard let parsedURL = URL(string: mainServerURL),
              let token = credentialStore.loadToken(),
              !token.isEmpty
        else {
            return
        }

        let mainEndpoint = TabminalServerEndpoint(
            id: "main",
            baseURL: parsedURL,
            host: mainHostName,
            token: token,
            isPrimary: true
        )

        phase = .loading
        loginErrorMessage = ""
        isAuthenticating = true

        Task {
            defer {
                isAuthenticating = false
            }

            do {
                mainToken = token
                try await bootstrap(mainEndpoint: mainEndpoint)
                phase = .ready
            } catch let TabminalClientError.invalidStatus(code, _)
                where code == 401 || code == 403 {
                credentialStore.clearToken()
                mainToken = ""
                phase = .login
                loginErrorMessage = "Saved login expired."
            } catch {
                mainToken = token
                phase = .login
                loginErrorMessage = Self.displayMessage(for: error)
            }
        }
    }

    func runStartupFlowIfNeeded() {
        guard !didRunStartupFlow else {
            return
        }
        didRunStartupFlow = true

        if debugLaunchOptions.autoLogin {
            login()
            return
        }

        restoreMainHostSessionIfNeeded()
    }

    func selectHost(_ hostID: String) {
        activeHostID = hostID
        resolveSelection(for: hostID)
    }

    func selectSession(_ session: SessionRecord) {
        activeHostID = session.hostID
        activeSessionKey = session.key
    }

    func host(for session: SessionRecord) -> HostRecord? {
        hostRecord(for: session.hostID)
    }

    func hostDisplayName(for session: SessionRecord) -> String {
        host(for: session)?.displayName ?? "unknown"
    }

    func isWorkspaceVisible(for session: SessionRecord) -> Bool {
        workspaces[session.key]?.isPresented == true
    }

    func toggleWorkspace(for session: SessionRecord) {
        activeHostID = session.hostID
        activeSessionKey = session.key
        guard let workspace = ensureWorkspaceForSelection(session) else {
            return
        }
        let next = !workspace.isPresented
        workspace.setPresented(next)
        if !next {
            workspace.editorErrorMessage = ""
        }
        isPresentingWorkspace = next
    }

    func createSessionOnActiveHost() {
        createSession(on: activeHostID)
    }

    func createSession(on hostID: String) {
        guard let host = hostRecord(for: hostID) else {
            return
        }

        Task {
            do {
                let created = try await apiClient.createSession(server: host.endpoint)
                let session = SessionRecord(
                    hostID: hostID,
                    id: created.id,
                    title: Self.sessionTitle(
                        title: created.title,
                        shell: created.shell
                    ),
                    cwd: created.cwd ?? created.initialCwd ?? "",
                    createdAt: created.createdAt,
                    env: nil,
                    editorState: nil
                )

                updateHost(hostID) { current in
                    current.sessions.append(session)
                    current.connectionState = .connected
                    current.lastError = ""
                }

                _ = ensureWorkspace(for: session, on: host.endpoint)
                activeHostID = hostID
                activeSessionKey = session.key
            } catch TabminalClientError.accessLoginRequired {
                updateHost(hostID) { current in
                    if current.isPrimary {
                        current.connectionState = .error
                    } else {
                        current.connectionState = .needsAuth
                    }
                    current.lastError = "Cloudflare Login required."
                }
            } catch {
                updateHost(hostID) { current in
                    current.connectionState = .error
                    current.lastError = Self.displayMessage(for: error)
                }
            }
        }
    }

    func closeActiveSession() {
        guard let session = activeSession else {
            return
        }

        closeSession(session)
    }

    func closeSession(_ session: SessionRecord) {
        guard let host = hostRecord(for: session.hostID) else {
            return
        }

        Task {
            do {
                try await apiClient.deleteSession(
                    server: host.endpoint,
                    sessionID: session.id
                )

                updateHost(session.hostID) { current in
                    current.sessions.removeAll { $0.id == session.id }
                }

                if workspaces[session.key]?.isPresented == true {
                    isPresentingWorkspace = false
                }
                workspaces.removeValue(forKey: session.key)

                if session.hostID == "main",
                   hostRecord(for: session.hostID)?.sessions.isEmpty == true {
                    createSession(on: session.hostID)
                } else {
                    resolveSelection(for: session.hostID)
                }
            } catch {
                updateHost(session.hostID) { current in
                    current.lastError = Self.displayMessage(for: error)
                }
            }
        }
    }

    func beginAddHost() {
        hostEditorMode = .add
        hostDraft = HostDraft(url: "", host: "", password: "")
        hostDraftErrorMessage = ""
        isPresentingHostEditor = true
    }

    func beginEditHost(_ hostID: String) {
        guard let host = hostRecord(for: hostID), !host.isPrimary else {
            return
        }

        hostEditorMode = .edit(hostID)
        hostDraft = HostDraft(
            url: host.endpoint.baseURL.absoluteString,
            host: host.endpoint.host,
            password: ""
        )
        hostDraftErrorMessage = ""
        isPresentingHostEditor = true
    }

    func beginReconnectHost(_ hostID: String) {
        guard let host = hostRecord(for: hostID) else {
            return
        }

        hostEditorMode = .reconnect(hostID)
        hostDraft = HostDraft(
            url: host.endpoint.baseURL.absoluteString,
            host: host.endpoint.host,
            password: ""
        )
        hostDraftErrorMessage = ""
        isPresentingHostEditor = true
    }

    func cancelHostEditor() {
        isPresentingHostEditor = false
        hostDraftErrorMessage = ""
        isSubmittingHostDraft = false
    }

    func submitHostEditor() {
        guard !isSubmittingHostDraft else {
            return
        }

        guard let parsedURL = URL(string: hostDraft.url) else {
            hostDraftErrorMessage = "Invalid host URL."
            return
        }

        let inheritedToken = mainToken
        let tokenToUse: String
        if !hostDraft.password.isEmpty {
            tokenToUse = TabminalPasswordHasher.sha256Hex(hostDraft.password)
        } else {
            switch hostEditorMode {
            case .add:
                tokenToUse = inheritedToken
            case .edit(let hostID), .reconnect(let hostID):
                tokenToUse = hostRecord(for: hostID)?.endpoint.token
                    ?? inheritedToken
            }
        }

        guard !tokenToUse.isEmpty else {
            hostDraftErrorMessage = "Password is required for this host."
            return
        }

        isSubmittingHostDraft = true
        hostDraftErrorMessage = ""

        Task {
            defer {
                isSubmittingHostDraft = false
            }

            do {
                switch hostEditorMode {
                case .add:
                    try await addHost(
                        baseURL: parsedURL,
                        host: hostDraft.host,
                        token: tokenToUse
                    )
                case .edit(let hostID), .reconnect(let hostID):
                    try await updateHost(
                        hostID: hostID,
                        baseURL: parsedURL,
                        host: hostDraft.host,
                        token: tokenToUse
                    )
                }

                isPresentingHostEditor = false
            } catch {
                hostDraftErrorMessage = Self.displayMessage(for: error)
            }
        }
    }

    func removeHost(_ hostID: String) {
        guard let host = hostRecord(for: hostID), !host.isPrimary else {
            return
        }

        Task {
            do {
                hosts.removeAll { $0.id == hostID }
                workspaces = workspaces.filter { _, workspace in
                    workspace.hostID != hostID
                }
                try await persistCluster()
                if activeHostID == hostID {
                    activeHostID = "main"
                    resolveSelection(for: activeHostID)
                }
            } catch {
                if hostRecord(for: hostID) == nil {
                    hosts.append(host)
                    sortHosts()
                }
            }
        }
    }

    func openWorkspace() {
        guard let session = activeSession, let host = activeHost else {
            return
        }

        let workspace = ensureWorkspace(for: session, on: host.endpoint)
        workspace.setPresented(true)
        isPresentingWorkspace = true
    }

    func closeWorkspace() {
        activeWorkspace?.setPresented(false)
        isPresentingWorkspace = false
    }

    func workspaceForSession(_ session: SessionRecord) -> SessionWorkspaceModel? {
        workspaces[session.key]
    }

    func triggerManualSync() {
        Task {
            await syncAllHosts(ensurePrimarySession: false)
        }
    }

    private func bootstrap(mainEndpoint: TabminalServerEndpoint) async throws {
        stopHeartbeat()
        _ = try await apiClient.heartbeat(server: mainEndpoint, updates: [])

        let cluster = try await apiClient.loadCluster(server: mainEndpoint)
        hosts = [HostRecord(endpoint: mainEndpoint)]
        var seenEndpointKeys = Set([Self.endpointKey(for: mainEndpoint.baseURL)])
        var seenHostIDs = Set(["main"])

        for server in cluster.servers {
            if server.id == "main" {
                continue
            }

            let candidate = TabminalServerEndpoint(
                id: server.id,
                baseURL: server.baseURL,
                host: server.host,
                token: server.token,
                isPrimary: false
            )

            if shouldSkipClusterEndpoint(
                candidate,
                comparedTo: mainEndpoint
            ) {
                continue
            }

            let endpointKey = Self.endpointKey(for: candidate.baseURL)
            guard seenEndpointKeys.insert(endpointKey).inserted,
                  seenHostIDs.insert(candidate.id).inserted else {
                continue
            }

            hosts.append(HostRecord(endpoint: candidate))
        }

        sortHosts()
        activeHostID = "main"
        await syncHost("main", ensurePrimarySession: true)
        startHeartbeat()

        Task { @MainActor [weak self] in
            guard let self else {
                return
            }

            for host in hosts where !host.isPrimary {
                await syncHost(host.id, ensurePrimarySession: false)
            }
        }
    }

    private func addHost(
        baseURL: URL,
        host: String,
        token: String
    ) async throws {
        let existing = existingHostID(for: baseURL)
        if existing == "main" {
            return
        }

        let hostID = existing ?? UUID().uuidString
        let endpoint = TabminalServerEndpoint(
            id: hostID,
            baseURL: baseURL,
            host: host,
            token: token,
            isPrimary: false
        )

        _ = try await apiClient.heartbeat(server: endpoint, updates: [])

        if let existing {
            updateHost(existing) { current in
                current.endpoint = endpoint
                current.connectionState = .connected
                current.lastError = ""
            }
        } else {
            hosts.append(
                HostRecord(
                    endpoint: endpoint,
                    connectionState: .connected
                )
            )
        }

        sortHosts()
        try await persistCluster()
        await syncHost(hostID, ensurePrimarySession: false)
        activeHostID = hostID
        resolveSelection(for: hostID)
    }

    private func updateHost(
        hostID: String,
        baseURL: URL,
        host: String,
        token: String
    ) async throws {
        guard let current = hostRecord(for: hostID) else {
            throw ConnectionError.invalidURL
        }

        let endpoint = TabminalServerEndpoint(
            id: current.id,
            baseURL: baseURL,
            host: host,
            token: token,
            isPrimary: current.isPrimary
        )

        _ = try await apiClient.heartbeat(server: endpoint, updates: [])

        updateHost(hostID) { record in
            record.endpoint = endpoint
            record.connectionState = .connected
            record.lastError = ""
        }

        for workspace in workspaces.values where workspace.hostID == hostID {
            workspace.updateEndpoint(endpoint)
        }

        try await persistCluster()
        await syncHost(hostID, ensurePrimarySession: false)
    }

    private func persistCluster() async throws {
        guard let mainHost = hostRecord(for: "main") else {
            return
        }

        let payload = TabminalClusterPayload(
            servers: hosts
                .filter { !$0.isPrimary }
                .map {
                    TabminalClusterServer(
                        id: $0.id,
                        baseURL: $0.endpoint.baseURL,
                        host: $0.endpoint.host,
                        token: $0.endpoint.token
                    )
                }
        )

        _ = try await apiClient.saveCluster(
            server: mainHost.endpoint,
            payload: payload
        )
    }

    private func syncAllHosts(ensurePrimarySession: Bool) async {
        for host in hosts {
            await syncHost(host.id, ensurePrimarySession: ensurePrimarySession)
        }
    }

    private func syncHost(
        _ hostID: String,
        ensurePrimarySession: Bool
    ) async {
        guard let host = hostRecord(for: hostID) else {
            return
        }

        if host.connectionState == .needsAuth && !host.isPrimary {
            return
        }

        updateHost(hostID) { current in
            if current.connectionState != .connected {
                current.connectionState = .connecting
            }
        }

        let startedAt = Date()
        let updates = pendingUpdates(for: host)

        do {
            let response = try await apiClient.heartbeat(
                server: host.endpoint,
                updates: updates
            )

            var mappedSessions = response.sessions.map { summary in
                SessionRecord(
                    hostID: hostID,
                    id: summary.id,
                    title: Self.sessionTitle(
                        title: summary.title,
                        shell: summary.shell
                    ),
                    cwd: summary.cwd ?? summary.initialCwd ?? "",
                    createdAt: summary.createdAt,
                    env: summary.env,
                    editorState: summary.editorState
                )
            }

            mappedSessions.sort {
                ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast)
            }

            if hostID == "main",
               mappedSessions.isEmpty,
               ensurePrimarySession {
                let created = try await apiClient.createSession(server: host.endpoint)
                mappedSessions = [
                    SessionRecord(
                        hostID: hostID,
                        id: created.id,
                        title: Self.sessionTitle(
                            title: created.title,
                            shell: created.shell
                        ),
                        cwd: created.cwd ?? created.initialCwd ?? "",
                        createdAt: created.createdAt,
                        env: nil,
                        editorState: nil
                    )
                ]
            }

            let latencyMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            updateHost(hostID) { current in
                current.sessions = mappedSessions
                current.connectionState = .connected
                current.lastLatencyMs = latencyMs
                current.runtimeHostname = response.system?.hostname
                current.lastError = ""
            }

            await reconcileWorkspaces(
                sessions: mappedSessions,
                hostEndpoint: host.endpoint
            )

            if activeHostID == hostID || activeSessionKey == nil {
                resolveSelection(for: hostID)
            }
        } catch TabminalClientError.accessLoginRequired {
            updateHost(hostID) { current in
                if current.isPrimary {
                    current.connectionState = .error
                } else {
                    current.connectionState = .needsAuth
                }
                current.lastError = "Cloudflare Login required."
            }
        } catch let TabminalClientError.invalidStatus(code, _) {
            if code == 401 || code == 403 {
                if host.isPrimary {
                    credentialStore.clearToken()
                    logout(clearCredentials: false)
                    loginErrorMessage = "Main host authentication expired."
                    return
                }

                updateHost(hostID) { current in
                    current.connectionState = .needsAuth
                    current.lastError = "Authentication required."
                }
                return
            }

            updateHost(hostID) { current in
                current.connectionState = .error
                current.lastError = "HTTP \(code)"
            }
        } catch {
            updateHost(hostID) { current in
                current.connectionState = .reconnecting
                current.lastError = Self.displayMessage(for: error)
            }
        }
    }

    private func reconcileWorkspaces(
        sessions: [SessionRecord],
        hostEndpoint: TabminalServerEndpoint
    ) async {
        let validKeys = Set(sessions.map(\.key))
        for session in sessions {
            let workspace = ensureWorkspace(for: session, on: hostEndpoint)
            await workspace.reconcile(
                cwd: session.cwd,
                editorState: session.editorState
            )
        }

        for (key, workspace) in workspaces
        where workspace.hostID == hostEndpoint.id && !validKeys.contains(key) {
            if workspace.isPresented {
                isPresentingWorkspace = false
            }
            workspaces.removeValue(forKey: key)
        }
    }

    private func pendingUpdates(
        for host: HostRecord
    ) -> [TabminalSessionUpdate] {
        host.sessions.compactMap { session in
            guard let workspace = workspaces[session.key] else {
                return nil
            }

            let state = workspace.editorStatePayload(fallbackRoot: session.cwd)
            return TabminalSessionUpdate(
                id: session.id,
                editorState: state
            )
        }
    }

    private func ensureWorkspace(
        for session: SessionRecord,
        on endpoint: TabminalServerEndpoint
    ) -> SessionWorkspaceModel {
        if let existing = workspaces[session.key] {
            existing.updateEndpoint(endpoint)
            existing.ensureRoot(session.cwd)
            return existing
        }

        let workspace = SessionWorkspaceModel(
            hostID: session.hostID,
            sessionID: session.id,
            sessionKey: session.key,
            endpoint: endpoint,
            rootPath: session.editorState?.root ?? session.cwd
        )
        workspaces[session.key] = workspace
        return workspace
    }

    private func ensureWorkspaceForSelection(
        _ session: SessionRecord
    ) -> SessionWorkspaceModel? {
        guard let host = hostRecord(for: session.hostID) else {
            return nil
        }

        return ensureWorkspace(for: session, on: host.endpoint)
    }

    private func resolveSelection(for hostID: String) {
        guard let host = hostRecord(for: hostID) else {
            return
        }

        if let activeSessionKey,
           host.sessions.contains(where: { $0.key == activeSessionKey }) {
            return
        }

        activeSessionKey = host.sessions.first?.key
    }

    private func sortHosts() {
        hosts.sort {
            if $0.isPrimary != $1.isPrimary {
                return $0.isPrimary
            }

            return $0.displayName.localizedCaseInsensitiveCompare(
                $1.displayName
            ) == .orderedAscending
        }
    }

    private func startHeartbeat() {
        stopHeartbeat()
        heartbeatTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                if Task.isCancelled {
                    return
                }
                await self.syncAllHosts(ensurePrimarySession: false)
            }
        }
    }

    private func stopHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = nil
    }

    private func hostRecord(for hostID: String) -> HostRecord? {
        hosts.first { $0.id == hostID }
    }

    private func updateHost(
        _ hostID: String,
        mutate: (inout HostRecord) -> Void
    ) {
        guard let index = hosts.firstIndex(where: { $0.id == hostID }) else {
            return
        }

        mutate(&hosts[index])
    }

    private func shouldSkipClusterEndpoint(
        _ candidate: TabminalServerEndpoint,
        comparedTo mainEndpoint: TabminalServerEndpoint
    ) -> Bool {
        let candidateKey = Self.endpointKey(for: candidate.baseURL)
        let mainKey = Self.endpointKey(for: mainEndpoint.baseURL)

        if candidateKey == mainKey {
            return true
        }

        return candidate.baseURL.host?.lowercased()
            == mainEndpoint.baseURL.host?.lowercased()
    }

    private func existingHostID(for baseURL: URL) -> String? {
        let key = Self.endpointKey(for: baseURL)
        return hosts.first {
            Self.endpointKey(for: $0.endpoint.baseURL) == key
        }?.id
    }

    private static func endpointKey(for url: URL) -> String {
        let host = url.host?.lowercased() ?? ""
        let port = url.port.map(String.init) ?? ""
        return port.isEmpty ? host : "\(host):\(port)"
    }

    private static func sessionTitle(
        title: String?,
        shell: String?
    ) -> String {
        let trimmedTitle = title?.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        if let trimmedTitle, !trimmedTitle.isEmpty {
            return trimmedTitle
        }

        let trimmedShell = shell?.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        if let trimmedShell, !trimmedShell.isEmpty {
            return trimmedShell
        }

        return "Terminal"
    }

    static func displayMessage(for error: Error) -> String {
        if let error = error as? ConnectionError {
            return error.localizedDescription
        }

        if case .accessLoginRequired = error as? TabminalClientError {
            return "Cloudflare Login required."
        }

        if case let TabminalClientError.invalidStatus(code, body) = error {
            if body.isEmpty {
                return "Server returned HTTP \(code)."
            }
            return "Server returned HTTP \(code): \(body)"
        }

        return error.localizedDescription
    }

    private static let defaultsMainURLKey = "tabminal.mobile.mainURL"
    private static let defaultsMainHostKey = "tabminal.mobile.mainHost"
}

enum ConnectionError: LocalizedError {
    case invalidURL

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid server URL."
        }
    }
}
