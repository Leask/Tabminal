import Observation
import SwiftUI

struct SessionListSheetView: View {
    @Bindable var model: MobileAppModel
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let host = model.activeHost {
                    List {
                        Section {
                            hostSummary(host)
                                .listRowBackground(Color.clear)
                        }

                        Section("Tabs") {
                            ForEach(host.sessions, id: \.key) { session in
                                HStack(spacing: 12) {
                                    Button {
                                        model.selectSession(session)
                                        dismiss()
                                    } label: {
                                        VStack(
                                            alignment: .leading,
                                            spacing: 5
                                        ) {
                                            Text(session.title)
                                                .font(.body.weight(.medium))
                                                .foregroundStyle(.white)
                                                .lineLimit(1)
                                            Text(
                                                session.cwd.isEmpty
                                                    ? "No path"
                                                    : session.cwd
                                            )
                                            .font(.caption)
                                            .foregroundStyle(
                                                .white.opacity(0.56)
                                            )
                                            .lineLimit(1)
                                        }
                                        Spacer(minLength: 0)
                                        if model.activeSessionKey == session.key {
                                            Image(systemName: "checkmark")
                                                .foregroundStyle(
                                                    Color(
                                                        red: 0.77,
                                                        green: 0.90,
                                                        blue: 0.98
                                                    )
                                                )
                                        }
                                    }
                                    .buttonStyle(.plain)

                                    Button(role: .destructive) {
                                        model.closeSession(session)
                                    } label: {
                                        Image(systemName: "xmark.circle")
                                    }
                                    .buttonStyle(.plain)
                                    .foregroundStyle(
                                        .white.opacity(0.62)
                                    )
                                }
                                .listRowBackground(
                                    model.activeSessionKey == session.key
                                        ? Color.white.opacity(0.09)
                                        : Color.white.opacity(0.03)
                                )
                            }
                        }
                    }
                    .scrollContentBackground(.hidden)
                    .background(Color(red: 0.04, green: 0.05, blue: 0.07))
                    .navigationTitle("Sessions")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Close") {
                                dismiss()
                            }
                        }
                        ToolbarItemGroup(placement: .topBarTrailing) {
                            if host.connectionState == .needsAuth {
                                Button("Browser Login") {
                                    openURL(host.endpoint.browserLoginURL)
                                }
                                Button("Reconnect") {
                                    dismiss()
                                    model.beginReconnectHost(host.id)
                                }
                            } else {
                                Button("New Tab") {
                                    model.createSession(on: host.id)
                                }
                            }
                        }
                    }
                } else {
                    ContentUnavailableView(
                        "No Host Selected",
                        systemImage: "server.rack"
                    )
                    .foregroundStyle(.white.opacity(0.72))
                    .background(Color(red: 0.04, green: 0.05, blue: 0.07))
                }
            }
        }
        .preferredColorScheme(.dark)
        .accessibilityIdentifier("sessions.sheet")
    }

    private func hostSummary(
        _ host: MobileAppModel.HostRecord
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(host.displayName)
                .font(.headline)
                .foregroundStyle(.white)
            Text(host.endpoint.baseURL.absoluteString)
                .font(.caption)
                .foregroundStyle(.white.opacity(0.52))
                .lineLimit(1)
            if !host.lastError.isEmpty {
                Text(host.lastError)
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 6)
    }
}
