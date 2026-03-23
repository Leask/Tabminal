import Observation
import SwiftUI

struct HostEditorView: View {
    @Bindable var model: MobileAppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        ZStack {
            Color(red: 0.05, green: 0.06, blue: 0.08)
                .ignoresSafeArea()

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 18) {
                    Text(model.hostEditorMode.title)
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(.white)

                    formCard

                    if !model.hostDraftErrorMessage.isEmpty {
                        Text(model.hostDraftErrorMessage)
                            .font(.footnote)
                            .foregroundStyle(.orange)
                            .accessibilityIdentifier("host.editor.error")
                    }

                    actionButtons
                }
                .padding(20)
            }
        }
        .accessibilityIdentifier("host.editor.view")
        .onChange(of: model.isPresentingHostEditor) { _, presented in
            if !presented {
                dismiss()
            }
        }
    }

    private var formCard: some View {
        VStack(spacing: 16) {
            ConnectionField(
                label: "Host URL",
                hint: "Use the root host URL, including scheme and port."
            ) {
                TextField("https://host:9846", text: $model.hostDraft.url)
                    .tabminalURLFieldTraits()
                    .accessibilityIdentifier("host.editor.url")
            }

            ConnectionField(
                label: "Host",
                hint: "Optional. Leave empty to auto-detect the display name."
            ) {
                TextField("Host (optional, auto-detect)", text: $model.hostDraft.host)
                    .tabminalNameFieldTraits()
                    .accessibilityIdentifier("host.editor.host")
            }

            ConnectionField(
                label: "Password",
                hint: passwordHint
            ) {
                SecureField(passwordPlaceholder, text: $model.hostDraft.password)
                    .tabminalPasswordFieldTraits()
                    .accessibilityIdentifier("host.editor.password")
            }
        }
        .padding(20)
        .background(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(.white.opacity(0.06))
        )
        .overlay {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .strokeBorder(.white.opacity(0.08), lineWidth: 1)
        }
    }

    private var passwordHint: String {
        switch model.hostEditorMode {
        case .add:
            return "Optional. Leave empty to reuse the current host password."
        case .edit:
            return "Optional. Leave empty to keep the existing token."
        case .reconnect:
            if reconnectHost?.isPrimary == true {
                return "Optional. Leave empty to reuse the saved main-host login."
            }
            return "Optional. Leave empty to reconnect with the existing token."
        }
    }

    private var passwordPlaceholder: String {
        switch model.hostEditorMode {
        case .add:
            return "Password (optional, use current password)"
        case .edit:
            return "Password (optional, keep existing token)"
        case .reconnect:
            if reconnectHost?.isPrimary == true {
                return "Password (optional, use saved main login)"
            }
            return "Password (optional, use existing token)"
        }
    }

    @ViewBuilder
    private var actionButtons: some View {
        VStack(spacing: 14) {
            if case .reconnect(let hostID) = model.hostEditorMode,
               let host = model.hosts.first(where: { $0.id == hostID }),
               !host.isPrimary {
                Button {
                    openURL(host.endpoint.browserLoginURL)
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "safari")
                            .font(.headline.weight(.semibold))
                        Text("Cloudflare Login")
                            .font(.headline.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .foregroundStyle(.white)
                    .background(
                        RoundedRectangle(
                            cornerRadius: 18,
                            style: .continuous
                        )
                        .fill(.white.opacity(0.08))
                    )
                }
                .accessibilityIdentifier("host.editor.cloudflare")

                Text(
                    "If this host is protected by Cloudflare Access, open the browser and sign in first."
                )
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.56))
            }

            HStack(spacing: 12) {
                Button("Cancel") {
                    model.cancelHostEditor()
                    dismiss()
                }
                .buttonStyle(SecondaryActionButtonStyle())
                .accessibilityIdentifier("host.editor.cancel")

                Button {
                    model.submitHostEditor()
                } label: {
                    HStack {
                        if model.isSubmittingHostDraft {
                            ProgressView()
                                .tint(.black)
                        }
                        Text(model.hostEditorMode.actionTitle)
                            .frame(maxWidth: .infinity)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryActionButtonStyle())
                .disabled(model.isSubmittingHostDraft)
                .opacity(model.isSubmittingHostDraft ? 0.75 : 1)
                .accessibilityIdentifier("host.editor.submit")
            }
        }
    }

    private var reconnectHost: MobileAppModel.HostRecord? {
        guard case .reconnect(let hostID) = model.hostEditorMode else {
            return nil
        }

        return model.hosts.first(where: { $0.id == hostID })
    }
}

private struct PrimaryActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.semibold))
            .foregroundStyle(.black)
            .padding(.vertical, 16)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color(red: 0.83, green: 0.90, blue: 0.98))
            )
            .scaleEffect(configuration.isPressed ? 0.99 : 1)
    }
}

private struct SecondaryActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(.white.opacity(0.08))
            )
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(.white.opacity(0.10), lineWidth: 1)
            }
            .scaleEffect(configuration.isPressed ? 0.99 : 1)
    }
}
