import Observation
import SwiftUI

struct ServerConnectionView: View {
    @Bindable var model: MobileAppModel

    var body: some View {
        ZStack {
            connectionBackground

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 22) {
                    heroCard
                    connectionCard
                    capabilityCard
                }
                .padding(.horizontal, 20)
                .padding(.top, 20)
                .padding(.bottom, 40)
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity, alignment: .center)
            }
        }
        .accessibilityIdentifier("login.view")
    }

    private var connectionBackground: some View {
        ZStack {
            Color(red: 0.05, green: 0.06, blue: 0.08)
                .ignoresSafeArea()

            RadialGradient(
                colors: [
                    Color(red: 0.18, green: 0.28, blue: 0.40).opacity(0.55),
                    .clear
                ],
                center: .topLeading,
                startRadius: 40,
                endRadius: 420
            )
            .ignoresSafeArea()

            RadialGradient(
                colors: [
                    Color(red: 0.18, green: 0.16, blue: 0.34).opacity(0.35),
                    .clear
                ],
                center: .bottomTrailing,
                startRadius: 20,
                endRadius: 360
            )
            .ignoresSafeArea()
        }
    }

    private var heroCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                HStack(spacing: 14) {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(.white.opacity(0.08))
                        .frame(width: 56, height: 56)
                        .overlay {
                            Image(systemName: "terminal")
                                .font(.title2.weight(.semibold))
                                .foregroundStyle(.white)
                        }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Tabminal")
                            .font(.system(size: 32, weight: .semibold))
                            .foregroundStyle(.white)
                        Text("Native terminal client")
                            .font(.subheadline)
                            .foregroundStyle(.white.opacity(0.72))
                    }
                }

                Spacer()

                statusChip("iOS preview", tint: .white.opacity(0.18))
            }

            Text(
                "Connect to the main Tabminal host. The app will then restore the cluster registry and all saved hosts from the backend."
            )
            .font(.subheadline)
            .foregroundStyle(.white.opacity(0.78))
            .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 10) {
                capabilityChip("Multi-host")
                capabilityChip("Session tabs")
                capabilityChip("Ghostty-ready")
            }
        }
        .padding(22)
        .background(cardBackground)
    }

    private var connectionCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Connect to Main Host")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.white)
                Text("Use the same URL and password you already use in Tabminal Web.")
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.62))
            }

            VStack(spacing: 14) {
                ConnectionField(
                    label: "Server URL",
                    hint: "Include scheme and port, for example https://host:9846"
                ) {
                    TextField("https://host:9846",
                              text: $model.mainServerURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .accessibilityIdentifier("login.serverURL")
                }

                ConnectionField(
                    label: "Host Alias",
                    hint: "Optional. Used as the display name for the main host."
                ) {
                    TextField("Flora", text: $model.mainHostName)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("login.hostAlias")
                }

                ConnectionField(
                    label: "Password",
                    hint: model.hasStoredMainLogin
                        ? "Optional. Leave empty to reuse the saved main-host login."
                        : "The app sends the same SHA-256 hash used by the web client."
                ) {
                    SecureField("Password", text: $model.mainPassword)
                        .textContentType(.password)
                        .accessibilityIdentifier("login.password")
                }
            }

            if !model.loginErrorMessage.isEmpty {
                HStack(alignment: .center, spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.orange)
                    Text(model.loginErrorMessage)
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.84))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(Color.orange.opacity(0.12))
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(Color.orange.opacity(0.16), lineWidth: 1)
                }
                .accessibilityIdentifier("login.error")
            }

            Button {
                model.login()
            } label: {
                HStack(spacing: 10) {
                    if model.isAuthenticating {
                        ProgressView()
                            .tint(.black)
                    } else {
                        Image(systemName: "arrow.up.right.square")
                            .font(.headline.weight(.semibold))
                    }

                    Text(
                        model.isAuthenticating
                            ? "Connecting..."
                            : model.hasStoredMainLogin
                                ? "Open Workspace"
                                : "Login and Open Workspace"
                    )
                    .font(.headline.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .foregroundStyle(.black)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(Color(red: 0.83, green: 0.90, blue: 0.98))
                )
            }
            .disabled(!model.canAttemptLogin)
            .opacity(model.canAttemptLogin ? 1 : 0.55)
            .accessibilityIdentifier("login.submit")
        }
        .padding(22)
        .background(cardBackground)
    }

    private var capabilityCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Current mobile slice")
                .font(.headline.weight(.semibold))
                .foregroundStyle(.white)

            VStack(alignment: .leading, spacing: 10) {
                featureRow("Native iOS app shell")
                featureRow("Backend cluster registry restore")
                featureRow("Host switching and session tabs")
                featureRow("Live terminal stream with text fallback renderer")
                featureRow("Main-host login restore via Keychain")
            }
        }
        .padding(20)
        .background(cardBackground)
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 28, style: .continuous)
            .fill(.white.opacity(0.06))
            .overlay {
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .strokeBorder(.white.opacity(0.08), lineWidth: 1)
            }
    }

    private func featureRow(_ text: String) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Circle()
                .fill(Color(red: 0.67, green: 0.86, blue: 0.96))
                .frame(width: 8, height: 8)
            Text(text)
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.76))
        }
    }

    private func capabilityChip(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.medium))
            .foregroundStyle(.white.opacity(0.82))
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.white.opacity(0.08), in: Capsule())
    }

    private func statusChip(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white.opacity(0.82))
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(tint, in: Capsule())
    }
}

struct ConnectionField<Field: View>: View {
    let label: String
    let hint: String
    @ViewBuilder let field: Field

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label.uppercased())
                .font(.caption.weight(.semibold))
                .tracking(0.8)
                .foregroundStyle(.white.opacity(0.48))

            field
                .padding(.horizontal, 14)
                .padding(.vertical, 14)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(.black.opacity(0.18))
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(.white.opacity(0.06), lineWidth: 1)
                }
                .foregroundStyle(.white)

            Text(hint)
                .font(.caption)
                .foregroundStyle(.white.opacity(0.46))
        }
    }
}
