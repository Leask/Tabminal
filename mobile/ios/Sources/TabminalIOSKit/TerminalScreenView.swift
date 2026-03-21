import SwiftUI
import TabminalMobileCore
#if canImport(UIKit)
import UIKit
#endif
#if canImport(AppKit)
import AppKit
#endif

public struct TerminalScreenView: View {
    @State private var model: TerminalScreenModel
    @State private var lastViewportSize: CGSize = .zero
    @State private var inputFocused: Bool = false
    private let onClose: (() -> Void)?

    public init(
        server: TabminalServerEndpoint,
        sessionID: String,
        onClose: (() -> Void)? = nil
    ) {
        _model = State(
            initialValue: TerminalScreenModel(
                server: server,
                sessionID: sessionID
            )
        )
        self.onClose = onClose
    }

    public var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .bottomTrailing) {
                terminalAccessibilityAnchor
                TerminalSurfaceHost(
                    transcript: model.terminalTranscript,
                    renderFeed: model.terminalRenderFeed,
                    renderer: .current
                )
                .contentShape(Rectangle())
                .onTapGesture {
                    inputFocused = true
                }
                .overlay(alignment: .bottomLeading) {
                    if !inputFocused && model.terminalTranscript.isEmpty {
                        focusHint
                            .padding(16)
                    }
                }

                if let onClose {
                    Button {
                        onClose()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.82))
                            .frame(width: 30, height: 30)
                            .background(.black.opacity(0.28), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .padding(14)
                    .accessibilityLabel("Close Tab")
                    .accessibilityIdentifier("terminal.close")
                    .frame(
                        maxWidth: .infinity,
                        maxHeight: .infinity,
                        alignment: .topTrailing
                    )
                }

                TerminalInputBridge(
                    isFocused: $inputFocused,
                    onInput: { input in
                        model.sendInput(input)
                    }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .opacity(0.015)
                .accessibilityIdentifier("terminal.input.capture")

                if showsKeyboardButton {
                    keyboardButton
                        .padding(16)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onAppear {
                updateViewportIfNeeded(proxy.size)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                    inputFocused = true
                }
            }
            .onChange(of: proxy.size) { _, newSize in
                updateViewportIfNeeded(newSize)
            }
        }
        .toolbar {
#if os(iOS)
            ToolbarItemGroup(placement: .keyboard) {
                keyboardAccessoryBar
            }
#endif
        }
        .task {
            model.connect()
        }
        .onDisappear {
            model.disconnect()
        }
    }

    private var terminalAccessibilityAnchor: some View {
        Rectangle()
            .fill(.clear)
            .frame(width: 1, height: 1)
            .accessibilityElement()
            .accessibilityLabel("Terminal View")
            .accessibilityIdentifier("terminal.view")
            .allowsHitTesting(false)
    }

    private var focusHint: some View {
        Text("Tap terminal to focus keyboard")
            .font(.caption.weight(.medium))
            .foregroundStyle(.white.opacity(0.72))
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                Capsule(style: .continuous)
                    .fill(.black.opacity(0.28))
            )
    }

    private var keyboardButton: some View {
        Button {
            inputFocused = true
        } label: {
            Image(
                systemName: inputFocused
                    ? "keyboard.chevron.compact.down"
                    : "keyboard"
            )
                .font(.headline.weight(.semibold))
                .foregroundStyle(.white.opacity(0.9))
                .frame(width: 42, height: 42)
                .background(.black.opacity(0.28), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            inputFocused ? "Hide Keyboard" : "Show Keyboard"
        )
        .accessibilityIdentifier("terminal.keyboard")
    }

    private var keyboardAccessoryBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                keyboardKey("Esc") {
                    model.sendControl("\u{1B}")
                }
                keyboardKey("Tab") {
                    model.sendControl("\t")
                }
                keyboardKey("⌃C") {
                    model.sendControl("\u{03}")
                }
                keyboardKey("↑") {
                    model.sendControl("\u{1B}[A")
                }
                keyboardKey("↓") {
                    model.sendControl("\u{1B}[B")
                }
                keyboardKey("←") {
                    model.sendControl("\u{1B}[D")
                }
                keyboardKey("→") {
                    model.sendControl("\u{1B}[C")
                }
                keyboardKey("Paste") {
                    if let text = platformPasteboardString(),
                       !text.isEmpty {
                        model.sendInput(text)
                    }
                }
                keyboardKey("Hide") {
                    inputFocused = false
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func keyboardKey(
        _ title: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(title, action: action)
            .buttonStyle(.plain)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.primary)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(.regularMaterial)
            )
            .accessibilityIdentifier(
                "terminal.key.\(title.lowercased())"
            )
    }

    private func updateViewportIfNeeded(_ size: CGSize) {
        guard size.width > 0, size.height > 0 else {
            return
        }

        let delta = abs(size.width - lastViewportSize.width)
            + abs(size.height - lastViewportSize.height)
        guard delta > 12 else {
            return
        }

        lastViewportSize = size
        let cols = max(Int((size.width - 28) / 8.4), 40)
        let rows = max(Int((size.height - 28) / 18.0), 12)
        model.resize(cols: cols, rows: rows)
    }

    private var showsKeyboardButton: Bool {
#if os(macOS)
        false
#else
        true
#endif
    }

    private func platformPasteboardString() -> String? {
#if canImport(UIKit)
        return UIPasteboard.general.string
#elseif canImport(AppKit)
        return NSPasteboard.general.string(forType: .string)
#else
        return nil
#endif
    }
}
