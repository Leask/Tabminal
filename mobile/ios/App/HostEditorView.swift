import Observation
import SwiftUI

struct HostEditorView: View {
    @Bindable var model: MobileAppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
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
                        }

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
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(.black)
                            .padding(.vertical, 16)
                            .background(
                                RoundedRectangle(
                                    cornerRadius: 18,
                                    style: .continuous
                                )
                                .fill(Color(red: 0.83, green: 0.90, blue: 0.98))
                            )
                        }
                    }
                    .padding(20)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        model.cancelHostEditor()
                        dismiss()
                    }
                }
            }
            .onChange(of: model.isPresentingHostEditor) { _, presented in
                if !presented {
                    dismiss()
                }
            }
        }
    }

    private var formCard: some View {
        VStack(spacing: 16) {
            ConnectionField(
                label: "Host URL",
                hint: "Use the full host URL, including scheme and port."
            ) {
                TextField("https://host:9846", text: $model.hostDraft.url)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
            }

            ConnectionField(
                label: "Host Alias",
                hint: "Optional. If empty, the hostname is used."
            ) {
                TextField("Enlightenment", text: $model.hostDraft.host)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }

            ConnectionField(
                label: "Password",
                hint: passwordHint
            ) {
                SecureField("Password", text: $model.hostDraft.password)
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
            return "Optional. If empty, the current main host password is reused."
        case .edit:
            return "Optional. Leave empty to keep the existing token."
        case .reconnect:
            return "Optional. Leave empty to retry with the existing token."
        }
    }
}
