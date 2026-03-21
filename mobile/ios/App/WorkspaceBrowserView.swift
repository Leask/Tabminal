import Observation
import SwiftUI

struct WorkspaceBrowserView: View {
    enum Pane: String, CaseIterable, Identifiable {
        case browser
        case editor

        var id: String {
            rawValue
        }

        var title: String {
            switch self {
            case .browser:
                return "Files"
            case .editor:
                return "Editor"
            }
        }
    }

    @Bindable var workspace: SessionWorkspaceModel
    let hostName: String
    let sessionTitle: String
    let onClose: () -> Void

    @State private var pane: Pane = .browser

    var body: some View {
        NavigationStack {
            VStack(spacing: 14) {
                accessibilityAnchor
                headerCard
                panePicker

                if pane == .browser {
                    browserPane
                } else {
                    editorPane
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 6)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(
                Color(red: 0.04, green: 0.05, blue: 0.07)
                    .ignoresSafeArea()
            )
            .navigationBarHidden(true)
        }
        .preferredColorScheme(.dark)
        .task {
            if workspace.entries.isEmpty {
                await workspace.refreshDirectory()
            }
        }
        .onAppear {
            workspace.setPresented(true)
            if workspace.activeDocument != nil {
                pane = .editor
            }
        }
        .onDisappear {
            workspace.setPresented(false)
        }
    }

    private var accessibilityAnchor: some View {
        Rectangle()
            .fill(.clear)
            .frame(width: 1, height: 1)
            .accessibilityElement()
            .accessibilityLabel("Workspace View")
            .accessibilityIdentifier("workspace.view")
            .allowsHitTesting(false)
    }

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(sessionTitle)
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text(hostName)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.54))
                }

                Spacer(minLength: 0)

                Button("Done") {
                    onClose()
                }
                .font(.subheadline.weight(.semibold))
                .accessibilityIdentifier("workspace.done")
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Workspace Root")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.48))
                Text(workspace.browserPath.isEmpty ? "/" : workspace.browserPath)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.78))
                    .lineLimit(2)
            }

            HStack(spacing: 10) {
                toolbarButton("Root", icon: "house") {
                    Task {
                        await workspace.loadDirectory(path: workspace.rootPath)
                    }
                }
                .accessibilityIdentifier("workspace.root")
                toolbarButton("Up", icon: "arrow.up") {
                    Task {
                        await workspace.navigateUp()
                    }
                }
                .accessibilityIdentifier("workspace.up")
                toolbarButton("Refresh", icon: "arrow.clockwise") {
                    Task {
                        await workspace.refreshDirectory()
                    }
                }
                .accessibilityIdentifier("workspace.refresh")

                Spacer(minLength: 0)

                if workspace.activeDocument != nil {
                    toolbarButton(
                        workspace.isSaving ? "Saving..." : "Save",
                        icon: "square.and.arrow.down"
                    ) {
                        Task {
                            await workspace.saveActiveFile()
                        }
                    }
                    .accessibilityIdentifier("workspace.save")
                }
            }
        }
        .padding(18)
        .background(cardBackground)
    }

    private var panePicker: some View {
        Picker("Pane", selection: $pane) {
            ForEach(Pane.allCases) { pane in
                Text(pane.title).tag(pane)
            }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("workspace.panePicker")
        .onChange(of: workspace.activeDocument?.path) { _, activePath in
            if activePath != nil {
                pane = .editor
            }
        }
    }

    private var browserPane: some View {
        List {
            if !workspace.openDocuments.isEmpty {
                Section("Open Files") {
                    ForEach(workspace.openDocuments, id: \.path) { document in
                        Button {
                            workspace.activeFilePath = document.path
                            pane = .editor
                        } label: {
                            HStack(spacing: 10) {
                                Image(
                                    systemName: document.isDirty
                                        ? "circle.fill"
                                        : "doc.text"
                                )
                                .font(.caption)
                                .foregroundStyle(
                                    document.isDirty
                                        ? Color.orange
                                        : .white.opacity(0.55)
                                )

                                Text(document.name)
                                    .foregroundStyle(.white)
                                    .lineLimit(1)

                                Spacer(minLength: 0)

                                if document.readonly {
                                    Text("RO")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(.white.opacity(0.56))
                                }
                            }
                        }
                        .listRowBackground(Color.white.opacity(0.03))
                    }
                }
            }

            Section("Directory") {
                if workspace.isBrowserLoading {
                    HStack {
                        ProgressView()
                            .tint(.white)
                        Text("Loading...")
                            .foregroundStyle(.white.opacity(0.66))
                    }
                    .listRowBackground(Color.white.opacity(0.03))
                } else {
                    ForEach(workspace.entries, id: \.path) { entry in
                        Button {
                            if entry.isDirectory {
                                Task {
                                    await workspace.loadDirectory(path: entry.path)
                                }
                            } else {
                                Task {
                                    do {
                                        try await workspace.openFile(path: entry.path)
                                        pane = .editor
                                    } catch {
                                        workspace.editorErrorMessage =
                                            MobileAppModel.displayMessage(
                                                for: error
                                            )
                                    }
                                }
                            }
                        } label: {
                            HStack(spacing: 12) {
                                Image(
                                    systemName: entry.isDirectory
                                        ? "folder"
                                        : "doc.text"
                                )
                                .foregroundStyle(
                                    entry.isDirectory
                                        ? Color(
                                            red: 0.91,
                                            green: 0.76,
                                            blue: 0.31
                                        )
                                        : .white.opacity(0.72)
                                )

                                VStack(
                                    alignment: .leading,
                                    spacing: 4
                                ) {
                                    Text(entry.name)
                                        .foregroundStyle(.white)
                                        .lineLimit(1)
                                    Text(entry.path)
                                        .font(.caption2)
                                        .foregroundStyle(
                                            .white.opacity(0.46)
                                        )
                                        .lineLimit(1)
                                }

                                Spacer(minLength: 0)
                            }
                        }
                        .listRowBackground(Color.white.opacity(0.03))
                    }
                }
            }

            if !workspace.browserErrorMessage.isEmpty {
                Section {
                    Text(workspace.browserErrorMessage)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .listRowBackground(Color.orange.opacity(0.08))
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.clear)
    }

    private var editorPane: some View {
        VStack(spacing: 12) {
            if let activeDocument = workspace.activeDocument {
                openFileStrip

                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                        Text(activeDocument.name)
                            .font(.headline)
                            .foregroundStyle(.white)
                            .lineLimit(1)

                        if activeDocument.isDirty {
                            Circle()
                                .fill(Color.orange)
                                .frame(width: 8, height: 8)
                        }

                        Spacer(minLength: 0)

                        if activeDocument.readonly {
                            Text("Read-only")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.white.opacity(0.54))
                        }
                    }

                    Text(activeDocument.path)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.48))
                        .lineLimit(2)

                    TextEditor(text: activeDocumentBinding)
                        .font(.system(.body, design: .monospaced))
                        .scrollContentBackground(.hidden)
                        .foregroundStyle(.white)
                        .padding(8)
                        .background(
                            RoundedRectangle(
                                cornerRadius: 18,
                                style: .continuous
                            )
                            .fill(Color.black.opacity(0.22))
                        )
                        .overlay {
                            RoundedRectangle(
                                cornerRadius: 18,
                                style: .continuous
                            )
                            .strokeBorder(
                                Color.white.opacity(0.08),
                                lineWidth: 1
                            )
                        }
                        .disabled(activeDocument.readonly)
                }
                .padding(16)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(cardBackground)

                if !workspace.editorErrorMessage.isEmpty {
                    Text(workspace.editorErrorMessage)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                }
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "doc.text")
                        .font(.title2)
                        .foregroundStyle(.white.opacity(0.56))
                    Text("Select a file from the browser to start editing.")
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.62))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(cardBackground)
            }
        }
    }

    private var openFileStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(workspace.openDocuments, id: \.path) { document in
                    HStack(spacing: 8) {
                        Button {
                            workspace.activeFilePath = document.path
                        } label: {
                            Text(document.name)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.white)
                        }

                        Button {
                            workspace.closeFile(path: document.path)
                            if workspace.activeDocument == nil {
                                pane = .browser
                            }
                        } label: {
                            Image(systemName: "xmark")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.white.opacity(0.56))
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(
                        Capsule()
                            .fill(
                                workspace.activeFilePath == document.path
                                    ? Color(
                                        red: 0.18,
                                        green: 0.25,
                                        blue: 0.36
                                    )
                                    : Color.white.opacity(0.06)
                            )
                    )
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private var activeDocumentBinding: Binding<String> {
        Binding(
            get: {
                workspace.activeDocument?.content ?? ""
            },
            set: { newValue in
                workspace.updateActiveDocumentContent(newValue)
            }
        )
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 24, style: .continuous)
            .fill(.white.opacity(0.06))
            .overlay {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .strokeBorder(.white.opacity(0.08), lineWidth: 1)
            }
    }

    private func toolbarButton(
        _ title: String,
        icon: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 9)
                .background(.white.opacity(0.08), in: Capsule())
        }
        .buttonStyle(.plain)
    }
}
