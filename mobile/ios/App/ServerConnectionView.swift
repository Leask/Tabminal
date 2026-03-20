import Observation
import SwiftUI

struct ServerConnectionView: View {
    @Bindable var model: ServerConnectionModel

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.94, green: 0.96, blue: 0.98),
                    Color(red: 0.87, green: 0.92, blue: 0.95)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Tabminal Mobile")
                            .font(.largeTitle.weight(.semibold))
                        Text("Native iOS shell, existing Tabminal server protocol.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }

                    VStack(spacing: 16) {
                        inputCard

                        if !model.errorMessage.isEmpty {
                            Text(model.errorMessage)
                                .font(.footnote)
                                .foregroundStyle(.red)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        Button {
                            model.connect()
                        } label: {
                            HStack {
                                if model.isConnecting {
                                    ProgressView()
                                        .tint(.white)
                                }
                                Text(model.isConnecting ? "Connecting" : "Connect")
                                    .frame(maxWidth: .infinity)
                            }
                            .font(.headline)
                            .padding(.vertical, 16)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.isConnecting || model.password.isEmpty)
                    }
                }
                .padding(24)
                .frame(maxWidth: 560)
            }
        }
    }

    private var inputCard: some View {
        VStack(spacing: 16) {
            TextField("Server URL", text: $model.serverURL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .textContentType(.URL)

            TextField("Host (optional)", text: $model.hostName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            SecureField("Password", text: $model.password)
                .textContentType(.password)
        }
        .padding(20)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .strokeBorder(.white.opacity(0.18), lineWidth: 1)
        )
    }
}
