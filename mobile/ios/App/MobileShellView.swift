import Observation
import SwiftUI
import TabminalIOSKit

struct MobileShellView: View {
    @Bindable var model: MobileAppModel
    @Environment(\.openURL) private var openURL
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var sidebarPresented: Bool = false
    @State private var hostPendingDeletion: MobileAppModel.HostRecord?

    private var isCompact: Bool {
        horizontalSizeClass == .compact
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .topLeading) {
                shellBackground

                VStack(spacing: 0) {
                    topBar
                    contentArea(in: proxy.size)
                }

                if isCompact {
                    compactSidebarOverlay(in: proxy.size)
                }
            }
            .animation(.easeInOut(duration: 0.18), value: sidebarPresented)
            .animation(
                .easeInOut(duration: 0.18),
                value: model.isActiveWorkspaceVisible
            )
            .accessibilityIdentifier("shell.view")
        }
        .confirmationDialog(
            "Delete Host?",
            isPresented: Binding(
                get: { hostPendingDeletion != nil },
                set: { presented in
                    if !presented {
                        hostPendingDeletion = nil
                    }
                }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let hostPendingDeletion {
                    model.removeHost(hostPendingDeletion.id)
                    self.hostPendingDeletion = nil
                }
            }
            Button("Cancel", role: .cancel) {
                hostPendingDeletion = nil
            }
        } message: {
            if let hostPendingDeletion {
                Text("Remove \(hostPendingDeletion.displayName) from this device?")
            }
        }
    }

    private var shellBackground: some View {
        ZStack {
            Color(red: 0.04, green: 0.05, blue: 0.07)
                .ignoresSafeArea()

            LinearGradient(
                colors: [
                    Color(red: 0.10, green: 0.15, blue: 0.26).opacity(0.42),
                    Color.clear
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()
        }
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            if isCompact {
                Button {
                    sidebarPresented.toggle()
                } label: {
                    Image(systemName: "line.3.horizontal")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.92))
                        .frame(width: 34, height: 34)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("shell.sidebarToggle")
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(activeStatusTitle)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)

                HStack(spacing: 8) {
                    Circle()
                        .fill(activeHostStateColor)
                        .frame(width: 7, height: 7)

                    Text(activeStatusSubtitle)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.58))
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            if let latency = model.activeHost?.lastLatencyMs {
                Text("\(latency) ms")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.62))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(.white.opacity(0.07), in: Capsule())
            }

            Menu {
                Button("Refresh") {
                    model.triggerManualSync()
                }
                Button("Add Host") {
                    model.beginAddHost()
                }
                if let activeSession = model.activeSession {
                    Button("Toggle Editor") {
                        model.toggleWorkspace(for: activeSession)
                    }
                }
                Button("Logout", role: .destructive) {
                    model.logout()
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.88))
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("shell.menu")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.black.opacity(0.16))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(.white.opacity(0.06))
                .frame(height: 1)
        }
    }

    @ViewBuilder
    private func contentArea(in size: CGSize) -> some View {
        if isCompact {
            mainWorkspace(in: size)
        } else {
            HStack(spacing: 0) {
                sidebar(width: 314)
                Rectangle()
                    .fill(.white.opacity(0.06))
                    .frame(width: 1)
                mainWorkspace(in: size)
            }
        }
    }

    @ViewBuilder
    private func mainWorkspace(in size: CGSize) -> some View {
        if let session = model.activeSession,
           let host = model.host(for: session) {
            if isCompact {
                ZStack(alignment: .leading) {
                    terminalPane(for: session, host: host)

                    if let workspace = model.workspaceForSession(session),
                       workspace.isPresented {
                        inlineWorkspacePane(
                            workspace: workspace,
                            session: session,
                            host: host,
                            compact: true,
                            width: min(size.width * 0.84, 420)
                        )
                        .padding(.leading, 12)
                        .padding(.vertical, 12)
                        .transition(
                            .move(edge: .leading).combined(with: .opacity)
                        )
                    }
                }
            } else {
                HStack(spacing: 0) {
                    if let workspace = model.workspaceForSession(session),
                       workspace.isPresented {
                        inlineWorkspacePane(
                            workspace: workspace,
                            session: session,
                            host: host,
                            compact: false,
                            width: min(max(size.width * 0.34, 320), 460)
                        )
                        Rectangle()
                            .fill(.white.opacity(0.06))
                            .frame(width: 1)
                    }

                    terminalPane(for: session, host: host)
                }
            }
        } else {
            emptyWorkspace
        }
    }

    private func terminalPane(
        for session: MobileAppModel.SessionRecord,
        host: MobileAppModel.HostRecord
    ) -> some View {
        TerminalScreenView(
            server: host.endpoint,
            sessionID: session.id
        )
        .id(session.key)
        .padding(isCompact ? 8 : 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyWorkspace: some View {
        VStack(spacing: 14) {
            Image(systemName: "terminal")
                .font(.system(size: 28, weight: .medium))
                .foregroundStyle(.white.opacity(0.62))
            Text("No active tab")
                .font(.headline)
                .foregroundStyle(.white)
            Text("Create a new tab from the host controls in the sidebar.")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.58))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func compactSidebarOverlay(in size: CGSize) -> some View {
        ZStack(alignment: .leading) {
            if sidebarPresented {
                Color.black.opacity(0.42)
                    .ignoresSafeArea()
                    .onTapGesture {
                        sidebarPresented = false
                    }

                sidebar(width: min(size.width * 0.82, 320))
                    .transition(.move(edge: .leading))
                    .shadow(color: .black.opacity(0.36), radius: 24, x: 10)
            }
        }
    }

    private func sidebar(width: CGFloat) -> some View {
        VStack(spacing: 0) {
            ScrollView(showsIndicators: false) {
                LazyVStack(spacing: 12) {
                    ForEach(model.allSessions, id: \.key) { session in
                        sessionSidebarCard(session)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 12)
                .padding(.bottom, 18)
            }

            Rectangle()
                .fill(.white.opacity(0.06))
                .frame(height: 1)

            hostControlSection()
        }
        .frame(width: width, alignment: .top)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(
            Color(red: 0.07, green: 0.08, blue: 0.10)
                .opacity(0.98)
        )
        .accessibilityIdentifier("shell.sidebar")
    }

    private func sessionSidebarCard(
        _ session: MobileAppModel.SessionRecord
    ) -> some View {
        let isActive = model.activeSessionKey == session.key
        let hostName = model.hostDisplayName(for: session)
        let hostColor = Color(red: 0.75, green: 0.88, blue: 0.96)

        return ZStack(alignment: .topTrailing) {
            Button {
                model.selectSession(session)
                if isCompact {
                    sidebarPresented = false
                }
            } label: {
                VStack(alignment: .leading, spacing: 8) {
                    Text(session.title)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .padding(.top, 6)

                    metadataLine(
                        label: "ID",
                        value: shortSessionID(session.id),
                        emphasized: false
                    )
                    metadataLine(
                        label: "HOST",
                        value: "\(sessionUserName(session))@\(hostName)",
                        emphasized: true,
                        emphasisColor: hostColor
                    )
                    metadataLine(
                        label: "PWD",
                        value: shortenPathFishStyle(session.cwd),
                        emphasized: false
                    )
                    metadataLine(
                        label: "SINCE",
                        value: sinceString(session.createdAt),
                        emphasized: false
                    )

                    if let workspace = model.workspaceForSession(session),
                       workspace.isPresented,
                       !workspace.openDocuments.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(
                                workspace.openDocuments.prefix(2),
                                id: \.path
                            ) { document in
                                Label(document.name, systemImage: "doc.text")
                                    .font(.caption2)
                                    .foregroundStyle(.white.opacity(0.45))
                                    .lineLimit(1)
                            }
                        }
                        .padding(.top, 2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(sessionCardBackground(selected: isActive))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("session.card.\(session.key)")

            HStack(spacing: 8) {
                overlayActionButton(
                    systemImage: "folder",
                    accessibilityID: "session.editor.\(session.key)"
                ) {
                    model.toggleWorkspace(for: session)
                }

                overlayActionButton(
                    systemImage: "xmark",
                    accessibilityID: "session.close.\(session.key)"
                ) {
                    model.closeSession(session)
                }
            }
            .padding(10)
        }
    }

    private func hostControlSection() -> some View {
        VStack(spacing: 10) {
            ForEach(model.hosts, id: \.id) { host in
                hostActionRow(host)
            }

            Button {
                model.beginAddHost()
            } label: {
                Text("+ Add Host")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(hostButtonBackground)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("host.add")
        }
        .padding(12)
        .background(Color.black.opacity(0.16))
        .accessibilityIdentifier("hosts.controls")
    }

    private func hostActionRow(
        _ host: MobileAppModel.HostRecord
    ) -> some View {
        let requiresReconnect = host.connectionState == .needsAuth
            || host.connectionState == .reconnecting
            || host.connectionState == .error

        return ZStack(alignment: .topLeading) {
            Button {
                handlePrimaryHostAction(host)
            } label: {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Text(requiresReconnect ? reconnectLabel(for: host) : "New Tab @")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        Text(host.displayName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(
                                Color(red: 0.75, green: 0.88, blue: 0.96)
                            )
                            .lineLimit(1)
                    }

                    HStack(spacing: 8) {
                        Circle()
                            .fill(hostStateColor(host.connectionState))
                            .frame(width: 8, height: 8)
                        Text(hostSecondaryMetric(host))
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.white.opacity(0.56))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(hostButtonBackground)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("host.primary.\(host.id)")

            if !host.isPrimary {
                overlayActionButton(
                    systemImage: "xmark",
                    accessibilityID: "host.delete.\(host.id)"
                ) {
                    hostPendingDeletion = host
                }
                .padding(10)
            }
        }
    }

    private func inlineWorkspacePane(
        workspace: SessionWorkspaceModel,
        session: MobileAppModel.SessionRecord,
        host: MobileAppModel.HostRecord,
        compact: Bool,
        width: CGFloat
    ) -> some View {
        InlineWorkspacePane(
            workspace: workspace,
            session: session,
            hostName: host.displayName,
            width: width,
            compact: compact,
            onClose: {
                model.closeWorkspace()
            }
        )
    }

    private var hostButtonBackground: some View {
        RoundedRectangle(cornerRadius: 18, style: .continuous)
            .fill(.white.opacity(0.06))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(.white.opacity(0.08), lineWidth: 1)
            }
    }

    private func sessionCardBackground(selected: Bool) -> some View {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(
                selected
                    ? Color.white.opacity(0.12)
                    : Color.white.opacity(0.05)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(
                        selected
                            ? Color.white.opacity(0.16)
                            : Color.white.opacity(0.08),
                        lineWidth: 1
                    )
            }
    }

    private func overlayActionButton(
        systemImage: String,
        accessibilityID: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.caption.bold())
                .foregroundStyle(.white.opacity(0.82))
                .frame(width: 24, height: 24)
                .background(.black.opacity(0.24), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(accessibilityID)
    }

    private func metadataLine(
        label: String,
        value: String,
        emphasized: Bool,
        emphasisColor: Color = .white
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("\(label):")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.white.opacity(0.42))

            Text(value)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(
                    emphasized ? emphasisColor : .white.opacity(0.78)
                )
                .lineLimit(1)
        }
    }

    private var activeStatusTitle: String {
        model.activeSession?.title ?? "Tabminal"
    }

    private var activeStatusSubtitle: String {
        guard let host = model.activeHost else {
            return "No host selected"
        }

        if let latency = host.lastLatencyMs {
            return "\(host.displayName) · \(latency) ms"
        }

        return host.displayName
    }

    private var activeHostStateColor: Color {
        hostStateColor(model.activeHost?.connectionState ?? .idle)
    }

    private func hostStateColor(
        _ state: MobileAppModel.HostConnectionState
    ) -> Color {
        switch state {
        case .connected:
            return Color(red: 0.30, green: 0.84, blue: 0.46)
        case .connecting:
            return Color(red: 0.98, green: 0.77, blue: 0.29)
        case .reconnecting:
            return Color(red: 0.96, green: 0.58, blue: 0.29)
        case .needsAuth, .error:
            return Color(red: 0.99, green: 0.39, blue: 0.37)
        case .idle:
            return .white.opacity(0.42)
        }
    }

    private func handlePrimaryHostAction(
        _ host: MobileAppModel.HostRecord
    ) {
        if host.connectionState == .needsAuth {
            if host.isPrimary {
                model.beginReconnectHost(host.id)
            } else {
                openURL(host.endpoint.browserLoginURL)
            }
            return
        }

        if host.connectionState == .reconnecting
            || host.connectionState == .error {
            model.beginReconnectHost(host.id)
            return
        }

        model.createSession(on: host.id)
        if isCompact {
            sidebarPresented = false
        }
    }

    private func reconnectLabel(for host: MobileAppModel.HostRecord) -> String {
        if host.connectionState == .needsAuth && !host.isPrimary {
            return "Cloudflare Login"
        }

        return "Reconnect"
    }

    private func hostSecondaryMetric(
        _ host: MobileAppModel.HostRecord
    ) -> String {
        if let latency = host.lastLatencyMs,
           host.connectionState == .connected {
            return "\(latency) ms"
        }

        switch host.connectionState {
        case .idle:
            return "Idle"
        case .connecting:
            return "Connecting"
        case .connected:
            return "Online"
        case .reconnecting:
            return "Reconnecting"
        case .needsAuth:
            return "Needs Login"
        case .error:
            return host.lastError.isEmpty ? "Error" : host.lastError
        }
    }

    private func shortSessionID(_ id: String) -> String {
        if let tail = id.split(separator: "-").last {
            return String(tail)
        }
        return id
    }

    private func sessionUserName(
        _ session: MobileAppModel.SessionRecord
    ) -> String {
        guard let env = session.env else {
            return "user"
        }

        for line in env.split(separator: "\n") {
            if line.hasPrefix("USER=") {
                return String(line.dropFirst(5))
            }
            if line.hasPrefix("LOGNAME=") {
                return String(line.dropFirst(8))
            }
        }

        return "user"
    }

    private func sinceString(_ date: Date?) -> String {
        guard let date else {
            return "--"
        }

        let formatter = DateFormatter()
        formatter.dateFormat = "MM-dd hh:mm a"
        return formatter.string(from: date)
    }

    private func shortenPathFishStyle(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return "/"
        }

        if trimmed == "/" {
            return "/"
        }

        let components = trimmed.split(separator: "/", omittingEmptySubsequences: true)
        guard components.count > 1 else {
            return trimmed
        }

        let abbreviated = components.enumerated().map { index, component in
            if index == components.count - 1 {
                return String(component)
            }

            return String(component.prefix(1))
        }

        return "/" + abbreviated.joined(separator: "/")
    }
}

private struct InlineWorkspacePane: View {
    @Bindable var workspace: SessionWorkspaceModel
    let session: MobileAppModel.SessionRecord
    let hostName: String
    let width: CGFloat
    let compact: Bool
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle()
                .fill(.white.opacity(0.06))
                .frame(height: 1)
            bodyContent
        }
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .background(
            RoundedRectangle(cornerRadius: compact ? 24 : 0, style: .continuous)
                .fill(Color(red: 0.06, green: 0.07, blue: 0.09))
        )
        .overlay {
            RoundedRectangle(cornerRadius: compact ? 24 : 0, style: .continuous)
                .strokeBorder(.white.opacity(compact ? 0.08 : 0.0), lineWidth: 1)
        }
        .clipShape(
            RoundedRectangle(cornerRadius: compact ? 24 : 0, style: .continuous)
        )
        .accessibilityIdentifier("workspace.inline")
        .task {
            if workspace.entries.isEmpty {
                await workspace.refreshDirectory()
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text(hostName)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.52))
                        .lineLimit(1)
                }

                Spacer(minLength: 0)

                workspaceButton("Save", systemImage: "square.and.arrow.down") {
                    Task {
                        await workspace.saveActiveFile()
                    }
                }

                workspaceButton("Close", systemImage: "xmark") {
                    onClose()
                }
            }

            HStack(spacing: 8) {
                workspaceButton("Root", systemImage: "house") {
                    Task {
                        await workspace.loadDirectory(path: workspace.rootPath)
                    }
                }
                workspaceButton("Up", systemImage: "arrow.up") {
                    Task {
                        await workspace.navigateUp()
                    }
                }
                workspaceButton("Refresh", systemImage: "arrow.clockwise") {
                    Task {
                        await workspace.refreshDirectory()
                    }
                }
            }

            Text(workspace.browserPath.isEmpty ? "/" : workspace.browserPath)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.white.opacity(0.48))
                .lineLimit(2)
        }
        .padding(14)
    }

    private var bodyContent: some View {
        HStack(spacing: 0) {
            fileBrowser
            Rectangle()
                .fill(.white.opacity(0.06))
                .frame(width: 1)
            editorColumn
        }
    }

    private var fileBrowser: some View {
        ScrollView(showsIndicators: false) {
            LazyVStack(alignment: .leading, spacing: 8) {
                if !workspace.openDocuments.isEmpty {
                    Text("OPEN FILES")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.42))
                        .padding(.top, 2)

                    ForEach(workspace.openDocuments, id: \.path) { document in
                        Button {
                            workspace.activeFilePath = document.path
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "doc.text")
                                    .font(.caption)
                                    .foregroundStyle(.white.opacity(0.58))
                                Text(document.name)
                                    .font(.caption)
                                    .foregroundStyle(.white)
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                                if document.isDirty {
                                    Circle()
                                        .fill(Color.orange)
                                        .frame(width: 6, height: 6)
                                }
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(
                                workspace.activeFilePath == document.path
                                    ? Color.white.opacity(0.10)
                                    : Color.white.opacity(0.03),
                                in: RoundedRectangle(
                                    cornerRadius: 12,
                                    style: .continuous
                                )
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }

                Text("DIRECTORY")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.42))
                    .padding(.top, workspace.openDocuments.isEmpty ? 2 : 8)

                if workspace.isBrowserLoading {
                    ProgressView()
                        .tint(.white)
                        .padding(.vertical, 12)
                } else {
                    ForEach(workspace.entries, id: \.path) { entry in
                        Button {
                            if entry.isDirectory {
                                Task {
                                    await workspace.loadDirectory(path: entry.path)
                                }
                            } else {
                                Task {
                                    try? await workspace.openFile(path: entry.path)
                                }
                            }
                        } label: {
                            HStack(spacing: 8) {
                                Image(
                                    systemName: entry.isDirectory
                                        ? "folder"
                                        : "doc.text"
                                )
                                .font(.caption)
                                .foregroundStyle(
                                    entry.isDirectory
                                        ? Color(
                                            red: 0.91,
                                            green: 0.76,
                                            blue: 0.31
                                        )
                                        : .white.opacity(0.58)
                                )

                                Text(entry.name)
                                    .font(.caption)
                                    .foregroundStyle(.white)
                                    .lineLimit(1)

                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(
                                Color.white.opacity(0.03),
                                in: RoundedRectangle(
                                    cornerRadius: 12,
                                    style: .continuous
                                )
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(12)
        }
        .frame(width: compact ? max(width * 0.38, 126) : 180)
    }

    private var editorColumn: some View {
        VStack(spacing: 0) {
            openFileTabs
            Rectangle()
                .fill(.white.opacity(0.06))
                .frame(height: 1)
            editorBody
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var openFileTabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(workspace.openDocuments, id: \.path) { document in
                    HStack(spacing: 8) {
                        Button {
                            workspace.activeFilePath = document.path
                        } label: {
                            Text(document.name)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                        }
                        .buttonStyle(.plain)

                        Button {
                            workspace.closeFile(path: document.path)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(.white.opacity(0.72))
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(
                        workspace.activeFilePath == document.path
                            ? Color.white.opacity(0.10)
                            : Color.white.opacity(0.04),
                        in: RoundedRectangle(
                            cornerRadius: 12,
                            style: .continuous
                        )
                    )
                }
            }
            .padding(10)
        }
    }

    @ViewBuilder
    private var editorBody: some View {
        if let activeDocument = workspace.activeDocument {
            VStack(alignment: .leading, spacing: 8) {
                Text(activeDocument.path)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.46))
                    .lineLimit(2)
                    .padding(.horizontal, 12)
                    .padding(.top, 10)

                TextEditor(text: Binding(
                    get: { workspace.activeDocument?.content ?? "" },
                    set: { workspace.updateActiveDocumentContent($0) }
                ))
                .font(.system(.body, design: .monospaced))
                .scrollContentBackground(.hidden)
                .foregroundStyle(.white)
                .padding(10)
                .background(Color.clear)
                .disabled(activeDocument.readonly)

                if !workspace.editorErrorMessage.isEmpty {
                    Text(workspace.editorErrorMessage)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 10)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            VStack(spacing: 10) {
                Image(systemName: "doc.text")
                    .font(.title3)
                    .foregroundStyle(.white.opacity(0.48))
                Text("Select a file to view")
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.54))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func workspaceButton(
        _ title: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(.white.opacity(0.07))
                )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(
            "workspace.inline.\(title.lowercased())"
        )
    }
}
