import Observation
import SwiftUI
import TabminalIOSKit

struct MobileShellView: View {
    @Bindable var model: MobileAppModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    @State private var isPresentingHostList: Bool = false
    @State private var isPresentingSessionList: Bool = false

    private var isCompactLayout: Bool {
        horizontalSizeClass == .compact || verticalSizeClass == .compact
    }

    var body: some View {
        ZStack {
            shellBackground

            Group {
                if isCompactLayout {
                    compactShell
                } else {
                    regularShell
                }
            }
            .padding(.horizontal, isCompactLayout ? 12 : 14)
            .padding(.top, 8)
            .padding(.bottom, 0)
        }
        .sheet(isPresented: $isPresentingHostList) {
            HostListSheetView(model: model)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $isPresentingSessionList) {
            SessionListSheetView(model: model)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .fullScreenCover(isPresented: $model.isPresentingWorkspace) {
            workspaceCover
        }
    }

    private var shellBackground: some View {
        ZStack {
            Color(red: 0.03, green: 0.04, blue: 0.05)
                .ignoresSafeArea()

            RadialGradient(
                colors: [
                    Color(red: 0.12, green: 0.18, blue: 0.32).opacity(0.35),
                    .clear
                ],
                center: .topLeading,
                startRadius: 10,
                endRadius: 320
            )
            .ignoresSafeArea()
        }
    }

    private var compactShell: some View {
        VStack(spacing: 10) {
            compactTopBar
            activeContextCard
            compactActionRow
            terminalSection
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var regularShell: some View {
        VStack(spacing: 12) {
            topBar
            hostRail
            sessionRail
            terminalSection
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var compactTopBar: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Tabminal")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.white)
                if let host = model.activeHost {
                    Text(host.displayName)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.56))
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            iconButton("arrow.clockwise") {
                model.triggerManualSync()
            }

            iconButton("server.rack") {
                isPresentingHostList = true
            }

            iconButton("rectangle.portrait.and.arrow.right") {
                model.logout()
            }
        }
        .padding(.horizontal, 2)
    }

    private var activeContextCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Circle()
                    .fill(
                        hostStateColor(
                            model.activeHost?.connectionState ?? .idle
                        )
                    )
                    .frame(width: 8, height: 8)

                Text(model.activeHost?.displayName ?? "No Host")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)

                Spacer(minLength: 0)

                if let latency = model.activeHost?.lastLatencyMs {
                    Text("\(latency) ms")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.52))
                }
            }

            VStack(alignment: .leading, spacing: 5) {
                Text(model.activeSession?.title ?? "No active tab")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.92))
                    .lineLimit(1)
                Text(
                    model.activeSession?.cwd.isEmpty == false
                        ? model.activeSession?.cwd ?? ""
                        : "Open or create a tab to start working."
                )
                .font(.caption)
                .foregroundStyle(.white.opacity(0.52))
                .lineLimit(2)
            }
        }
        .padding(14)
        .background(panelBackground(selected: true))
    }

    private var compactActionRow: some View {
        HStack(spacing: 10) {
            actionPill("Tabs", icon: "square.on.square") {
                isPresentingSessionList = true
            }

            actionPill("Files", icon: "folder") {
                model.openWorkspace()
            }
            .disabled(model.activeSession == nil)
            .opacity(model.activeSession == nil ? 0.48 : 1)

            Spacer(minLength: 0)

            if model.activeHost?.connectionState == .needsAuth,
               let host = model.activeHost {
                actionPill("Reconnect", icon: "key") {
                    model.beginReconnectHost(host.id)
                }
            } else if let host = model.activeHost {
                actionPill("New Tab", icon: "plus") {
                    model.createSession(on: host.id)
                }
            }
        }
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Tabminal")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.white)
                if let host = model.activeHost {
                    Text(host.displayName)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.58))
                }
            }

            Spacer()

            iconButton("folder") {
                model.openWorkspace()
            }
            .disabled(model.activeSession == nil)
            .opacity(model.activeSession == nil ? 0.48 : 1)

            iconButton("arrow.clockwise") {
                model.triggerManualSync()
            }

            iconButton("plus") {
                model.beginAddHost()
            }

            iconButton("rectangle.portrait.and.arrow.right") {
                model.logout()
            }
        }
        .padding(.horizontal, 4)
    }

    private var hostRail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(model.hosts, id: \.id) { host in
                    hostCard(host)
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private var sessionRail: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let host = model.activeHost {
                HStack {
                    Text("Sessions")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.52))
                    Spacer()
                    if host.connectionState == .needsAuth {
                        Button("Reconnect") {
                            model.beginReconnectHost(host.id)
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                    } else {
                        Button {
                            model.openWorkspace()
                        } label: {
                            Label("Files", systemImage: "folder")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.white)
                        }

                        if model.activeSession != nil {
                            Button {
                                model.closeActiveSession()
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.caption.bold())
                                    .foregroundStyle(.white.opacity(0.86))
                                    .frame(width: 24, height: 24)
                                    .background(
                                        .white.opacity(0.08),
                                        in: Circle()
                                    )
                            }
                        }

                        Button {
                            model.createSession(on: host.id)
                        } label: {
                            Label("New Tab", systemImage: "plus")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.white)
                        }
                    }
                }

                if host.sessions.isEmpty {
                    emptySessionState(for: host)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(host.sessions, id: \.key) { session in
                                sessionChip(session)
                            }
                        }
                        .padding(.horizontal, 2)
                    }
                }
            }
        }
    }

    private var terminalSection: some View {
        Group {
            if let host = model.activeHost,
               let session = model.activeSession {
                TerminalScreenView(
                    server: host.endpoint,
                    sessionID: session.id,
                    onClose: {
                        model.closeSession(session)
                    }
                )
                .id(session.key)
            } else if let host = model.activeHost {
                terminalEmptyState(for: host)
            } else {
                terminalPlaceholder("No host selected.")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var workspaceCover: some View {
        if let workspace = model.activeWorkspace,
           let host = model.activeHost,
           let session = model.activeSession {
            WorkspaceBrowserView(
                workspace: workspace,
                hostName: host.displayName,
                sessionTitle: session.title,
                onClose: {
                    model.closeWorkspace()
                }
            )
        } else {
            Color.clear
                .onAppear {
                    model.closeWorkspace()
                }
        }
    }

    private func hostCard(_ host: MobileAppModel.HostRecord) -> some View {
        let isSelected = model.activeHostID == host.id

        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Circle()
                    .fill(hostStateColor(host.connectionState))
                    .frame(width: 8, height: 8)
                Text(host.displayName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if !host.isPrimary {
                    Menu {
                        Button("Edit") {
                            model.beginEditHost(host.id)
                        }
                        Button("Reconnect") {
                            model.beginReconnectHost(host.id)
                        }
                        Button("Delete", role: .destructive) {
                            model.removeHost(host.id)
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.white.opacity(0.7))
                    }
                }
            }

            HStack(spacing: 8) {
                Text(hostStateLabel(host.connectionState))
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.66))
                if let latency = host.lastLatencyMs {
                    Text("\(latency) ms")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.46))
                }
            }
        }
        .padding(14)
        .frame(width: 180, alignment: .leading)
        .background(panelBackground(selected: isSelected))
        .onTapGesture {
            model.selectHost(host.id)
        }
    }

    private func sessionChip(
        _ session: MobileAppModel.SessionRecord
    ) -> some View {
        let isSelected = model.activeSessionKey == session.key

        return VStack(alignment: .leading, spacing: 5) {
            Text(session.title)
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
                .foregroundStyle(.white)
            Text(session.cwd.isEmpty ? "No path" : session.cwd)
                .font(.caption2)
                .lineLimit(1)
                .foregroundStyle(.white.opacity(0.54))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(width: 150, alignment: .leading)
        .background(panelBackground(selected: isSelected))
        .onTapGesture {
            model.selectSession(session)
        }
    }

    private func emptySessionState(
        for host: MobileAppModel.HostRecord
    ) -> some View {
        HStack {
            Text(
                host.connectionState == .needsAuth
                    ? "Host needs authentication before opening new tabs."
                    : "No sessions yet."
            )
            .font(.footnote)
            .foregroundStyle(.white.opacity(0.58))
            Spacer()
        }
    }

    private func terminalEmptyState(
        for host: MobileAppModel.HostRecord
    ) -> some View {
        terminalPlaceholder(
            host.connectionState == .needsAuth
                ? "Reconnect this host to load sessions."
                : "Create a new tab to start a terminal session."
        )
    }

    private func terminalPlaceholder(_ message: String) -> some View {
        RoundedRectangle(cornerRadius: 26, style: .continuous)
            .fill(.white.opacity(0.05))
            .overlay {
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .strokeBorder(.white.opacity(0.07), lineWidth: 1)
            }
            .overlay {
                VStack(spacing: 10) {
                    Image(systemName: "terminal")
                        .font(.title2)
                        .foregroundStyle(.white.opacity(0.62))
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.62))
                }
            }
    }

    private func iconButton(
        _ icon: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .foregroundStyle(.white.opacity(0.88))
                .frame(width: 36, height: 36)
                .background(.white.opacity(0.08), in: Circle())
        }
        .buttonStyle(.plain)
    }

    private func actionPill(
        _ title: String,
        icon: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(.white.opacity(0.08), in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private func panelBackground(selected: Bool) -> some View {
        RoundedRectangle(cornerRadius: 20, style: .continuous)
            .fill(
                selected
                    ? Color.white.opacity(0.12)
                    : Color.white.opacity(0.06)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(
                        selected
                            ? Color.white.opacity(0.18)
                            : Color.white.opacity(0.07),
                        lineWidth: 1
                    )
            }
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

    private func hostStateLabel(
        _ state: MobileAppModel.HostConnectionState
    ) -> String {
        switch state {
        case .idle:
            return "Idle"
        case .connecting:
            return "Connecting"
        case .connected:
            return "Connected"
        case .reconnecting:
            return "Reconnecting"
        case .needsAuth:
            return "Needs Login"
        case .error:
            return "Error"
        }
    }
}
