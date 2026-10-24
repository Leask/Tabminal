import SwiftUI
import TabminalMobileCore

struct FileEditorStatusView: View {
    @Bindable var document: TabminalEditorDocument
    @State private var pendingAction: Action?

    private enum Action: Equatable { case reload, overwrite }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(document.isDirty
                ? (document.hasPersistedDraft
                    ? "Unsaved changes (draft saved)" : "Unsaved changes")
                : "Saved")
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("workspace.document.state")
            if document.conflict != nil {
                VStack(alignment: .leading, spacing: 8) {
                    Text("This file changed on the host. Your edits are kept.")
                        .font(.footnote)
                        .accessibilityIdentifier("workspace.conflict")
                    HStack {
                        Button("Reload File") { pendingAction = .reload }
                            .accessibilityIdentifier("workspace.conflict.reload")
                        Button("Overwrite File") { pendingAction = .overwrite }
                            .disabled(document.readonly)
                            .accessibilityIdentifier("workspace.conflict.overwrite")
                    }
                    .buttonStyle(.bordered)
                    .disabled(document.isBusy)
                }
                .foregroundStyle(.orange)
            }
            if !document.errorMessage.isEmpty {
                Text(document.errorMessage)
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("workspace.document.error")
            }
            if !document.draftErrorMessage.isEmpty {
                Text(document.draftErrorMessage)
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("workspace.draft.error")
            }
        }
        .font(.footnote)
        .alert(
            pendingAction == .reload ? "Reload this file?" : "Overwrite this file?",
            isPresented: Binding(
                get: { pendingAction != nil },
                set: { if !$0 { pendingAction = nil } }
            ),
            presenting: pendingAction
        ) { action in
            if action == .reload {
                Button("Discard Edits and Reload", role: .destructive) {
                    Task { await document.reloadFromServer() }
                }
            } else {
                Button("Overwrite Host File", role: .destructive) {
                    Task { await document.overwriteConflict() }
                }
            }
            Button("Cancel", role: .cancel) { pendingAction = nil }
        } message: { action in
            Text(action == .reload
                ? "Replace your unsaved text with the latest host copy of \(document.name)."
                : "Replace the host copy of \(document.name) with your current text.")
        }
    }
}
