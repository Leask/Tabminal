import Observation
import SwiftUI

struct HostListSheetView: View {
    @Bindable var model: MobileAppModel
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Hosts") {
                    ForEach(model.hosts, id: \.id) { host in
                        Button {
                            model.selectHost(host.id)
                            dismiss()
                        } label: {
                            HStack(spacing: 12) {
                                Circle()
                                    .fill(color(for: host.connectionState))
                                    .frame(width: 9, height: 9)

                                VStack(
                                    alignment: .leading,
                                    spacing: 4
                                ) {
                                    Text(host.displayName)
                                        .font(.body.weight(.medium))
                                        .foregroundStyle(.white)

                                    HStack(spacing: 8) {
                                        Text(label(for: host.connectionState))
                                        if let latency = host.lastLatencyMs {
                                            Text("\(latency) ms")
                                        }
                                    }
                                    .font(.caption)
                                    .foregroundStyle(.white.opacity(0.55))
                                }

                                Spacer(minLength: 0)

                                if !host.isPrimary {
                                    Menu {
                                        Button("Edit") {
                                            dismiss()
                                            model.beginEditHost(host.id)
                                        }
                                        Button("Reconnect") {
                                            dismiss()
                                            model.beginReconnectHost(host.id)
                                        }
                                        Button("Open in Browser") {
                                            openURL(host.endpoint.browserLoginURL)
                                        }
                                        Button(
                                            "Delete",
                                            role: .destructive
                                        ) {
                                            model.removeHost(host.id)
                                        }
                                    } label: {
                                        Image(systemName: "ellipsis.circle")
                                            .foregroundStyle(
                                                .white.opacity(0.72)
                                            )
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                        }
                        .listRowBackground(
                            host.id == model.activeHostID
                                ? Color.white.opacity(0.09)
                                : Color.white.opacity(0.03)
                        )
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color(red: 0.04, green: 0.05, blue: 0.07))
            .navigationTitle("Hosts")
            .tabminalSheetTitleDisplayMode()
            .toolbar {
                ToolbarItem(placement: tabminalLeadingToolbarPlacement) {
                    Button("Close") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: tabminalTrailingToolbarPlacement) {
                    Button {
                        dismiss()
                        model.beginAddHost()
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
        .accessibilityIdentifier("hosts.sheet")
    }

    private func color(
        for state: MobileAppModel.HostConnectionState
    ) -> Color {
        switch state {
        case .connected:
            return Color(red: 0.30, green: 0.84, blue: 0.46)
        case .connecting:
            return Color(red: 0.97, green: 0.78, blue: 0.29)
        case .reconnecting:
            return Color(red: 0.96, green: 0.58, blue: 0.29)
        case .needsAuth, .error:
            return Color(red: 0.99, green: 0.39, blue: 0.37)
        case .idle:
            return .white.opacity(0.45)
        }
    }

    private func label(
        for state: MobileAppModel.HostConnectionState
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

private extension View {
    @ViewBuilder
    func tabminalSheetTitleDisplayMode() -> some View {
        #if os(macOS)
        self
        #else
        self.navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

private var tabminalLeadingToolbarPlacement: ToolbarItemPlacement {
    #if os(macOS)
    return .navigation
    #else
    return .topBarLeading
    #endif
}

private var tabminalTrailingToolbarPlacement: ToolbarItemPlacement {
    #if os(macOS)
    return .primaryAction
    #else
    return .topBarTrailing
    #endif
}
