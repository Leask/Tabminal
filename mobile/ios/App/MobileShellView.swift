import Observation
import SwiftUI
import TabminalIOSKit

struct MobileShellView: View {
    @Bindable var model: MobileAppModel

    var body: some View {
        ZStack {
            shellBackground

            VStack(spacing: 12) {
                topBar
                hostRail
                sessionRail
                terminalSection
            }
            .padding(.horizontal, 14)
            .padding(.top, 8)
            .padding(.bottom, 0)
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

            Button {
                model.triggerManualSync()
            } label: {
                Image(systemName: "arrow.clockwise")
                    .foregroundStyle(.white.opacity(0.88))
                    .frame(width: 36, height: 36)
                    .background(.white.opacity(0.08), in: Circle())
            }

            Button {
                model.beginAddHost()
            } label: {
                Image(systemName: "plus")
                    .foregroundStyle(.white.opacity(0.88))
                    .frame(width: 36, height: 36)
                    .background(.white.opacity(0.08), in: Circle())
            }

            Button {
                model.logout()
            } label: {
                Image(systemName: "rectangle.portrait.and.arrow.right")
                    .foregroundStyle(.white.opacity(0.88))
                    .frame(width: 36, height: 36)
                    .background(.white.opacity(0.08), in: Circle())
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
                        if model.activeSession != nil {
                            Button {
                                model.closeActiveSession()
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.caption.bold())
                                    .foregroundStyle(.white.opacity(0.86))
                                    .frame(width: 24, height: 24)
                                    .background(.white.opacity(0.08), in: Circle())
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
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(
                    isSelected
                        ? Color.white.opacity(0.12)
                        : Color.white.opacity(0.06)
                )
        )
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(
                    isSelected
                        ? Color.white.opacity(0.18)
                        : Color.white.opacity(0.07),
                    lineWidth: 1
                )
        }
        .onTapGesture {
            model.selectHost(host.id)
        }
    }

    private func sessionChip(_ session: MobileAppModel.SessionRecord) -> some View {
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
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(
                    isSelected
                        ? Color(red: 0.17, green: 0.24, blue: 0.34)
                        : Color.white.opacity(0.05)
                )
        )
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(
                    isSelected
                        ? Color(red: 0.49, green: 0.67, blue: 0.88)
                        : Color.white.opacity(0.06),
                    lineWidth: 1
                )
        }
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

    private func hostStateColor(
        _ state: MobileAppModel.HostConnectionState
    ) -> Color {
        switch state {
        case .idle:
            return .gray
        case .connecting:
            return Color(red: 0.99, green: 0.75, blue: 0.29)
        case .connected:
            return Color(red: 0.23, green: 0.82, blue: 0.46)
        case .reconnecting:
            return Color(red: 1.0, green: 0.61, blue: 0.24)
        case .needsAuth:
            return Color(red: 1.0, green: 0.40, blue: 0.36)
        case .error:
            return Color(red: 0.85, green: 0.32, blue: 0.30)
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
