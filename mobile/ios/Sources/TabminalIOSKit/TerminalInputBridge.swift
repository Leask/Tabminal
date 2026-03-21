import SwiftUI

#if canImport(UIKit)
import UIKit

struct TerminalInputBridge: UIViewRepresentable {
    @Binding var isFocused: Bool
    let onInput: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            isFocused: $isFocused,
            onInput: onInput
        )
    }

    func makeUIView(context: Context) -> TerminalInputTextView {
        let view = TerminalInputTextView()
        view.inputDelegateBridge = context.coordinator
        view.delegate = context.coordinator
        return view
    }

    func updateUIView(_ uiView: TerminalInputTextView, context: Context) {
        uiView.inputDelegateBridge = context.coordinator
        uiView.delegate = context.coordinator

        if isFocused {
            if !uiView.isFirstResponder {
                _ = uiView.becomeFirstResponder()
            }
        } else if uiView.isFirstResponder {
            uiView.resignFirstResponder()
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        @Binding private var isFocused: Bool
        private let onInput: (String) -> Void

        init(
            isFocused: Binding<Bool>,
            onInput: @escaping (String) -> Void
        ) {
            _isFocused = isFocused
            self.onInput = onInput
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            isFocused = true
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            isFocused = false
        }

        func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText text: String
        ) -> Bool {
            guard !text.isEmpty else {
                return false
            }

            if text == "\n" {
                onInput("\r")
                return false
            }

            onInput(text)
            return false
        }

        func handleBackspace() {
            onInput("\u{7F}")
        }

        func handlePaste(_ text: String) {
            guard !text.isEmpty else {
                return
            }
            onInput(text)
        }

        func handleEscape() {
            onInput("\u{1B}")
        }

        func handleTab() {
            onInput("\t")
        }

        func handleArrow(_ sequence: String) {
            onInput(sequence)
        }

        func handleCtrlC() {
            onInput("\u{03}")
        }
    }
}

final class TerminalInputTextView: UITextView {
    weak var inputDelegateBridge: TerminalInputBridge.Coordinator?

    override var canBecomeFirstResponder: Bool {
        true
    }

    override var keyCommands: [UIKeyCommand]? {
        [
            UIKeyCommand(
                input: UIKeyCommand.inputEscape,
                modifierFlags: [],
                action: #selector(handleEscape)
            ),
            UIKeyCommand(
                input: "\t",
                modifierFlags: [],
                action: #selector(handleTab)
            ),
            UIKeyCommand(
                input: UIKeyCommand.inputUpArrow,
                modifierFlags: [],
                action: #selector(handleUpArrow)
            ),
            UIKeyCommand(
                input: UIKeyCommand.inputDownArrow,
                modifierFlags: [],
                action: #selector(handleDownArrow)
            ),
            UIKeyCommand(
                input: UIKeyCommand.inputLeftArrow,
                modifierFlags: [],
                action: #selector(handleLeftArrow)
            ),
            UIKeyCommand(
                input: UIKeyCommand.inputRightArrow,
                modifierFlags: [],
                action: #selector(handleRightArrow)
            ),
            UIKeyCommand(
                input: "c",
                modifierFlags: [.control],
                action: #selector(handleCtrlC)
            )
        ]
    }

    init() {
        super.init(frame: .zero, textContainer: nil)
        backgroundColor = .clear
        textColor = .clear
        tintColor = .clear
        autocorrectionType = .no
        autocapitalizationType = .none
        smartInsertDeleteType = .no
        smartDashesType = .no
        smartQuotesType = .no
        spellCheckingType = .no
        keyboardAppearance = .dark
        isScrollEnabled = false
        isEditable = true
        isSelectable = true
        textDragInteraction?.isEnabled = false
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        accessibilityTraits = []
        accessibilityLabel = nil
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        resetSelection()
        return became
    }

    override func caretRect(for position: UITextPosition) -> CGRect {
        .zero
    }

    override func selectionRects(
        for range: UITextRange
    ) -> [UITextSelectionRect] {
        []
    }

    override func deleteBackward() {
        inputDelegateBridge?.handleBackspace()
    }

    override func paste(_ sender: Any?) {
        if let text = UIPasteboard.general.string {
            inputDelegateBridge?.handlePaste(text)
        }
    }

    override func touchesEnded(
        _ touches: Set<UITouch>,
        with event: UIEvent?
    ) {
        _ = becomeFirstResponder()
        super.touchesEnded(touches, with: event)
    }

    private func resetSelection() {
        text = ""
        selectedTextRange = textRange(
            from: beginningOfDocument,
            to: beginningOfDocument
        )
    }

    @objc private func handleEscape() {
        inputDelegateBridge?.handleEscape()
    }

    @objc private func handleTab() {
        inputDelegateBridge?.handleTab()
    }

    @objc private func handleUpArrow() {
        inputDelegateBridge?.handleArrow("\u{1B}[A")
    }

    @objc private func handleDownArrow() {
        inputDelegateBridge?.handleArrow("\u{1B}[B")
    }

    @objc private func handleLeftArrow() {
        inputDelegateBridge?.handleArrow("\u{1B}[D")
    }

    @objc private func handleRightArrow() {
        inputDelegateBridge?.handleArrow("\u{1B}[C")
    }

    @objc private func handleCtrlC() {
        inputDelegateBridge?.handleCtrlC()
    }
}

#elseif canImport(AppKit)

import AppKit

struct TerminalInputBridge: NSViewRepresentable {
    @Binding var isFocused: Bool
    let onInput: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            isFocused: $isFocused,
            onInput: onInput
        )
    }

    func makeNSView(context: Context) -> TerminalInputTextView {
        let view = TerminalInputTextView(frame: .zero)
        view.inputDelegateBridge = context.coordinator
        return view
    }

    func updateNSView(_ nsView: TerminalInputTextView, context: Context) {
        nsView.inputDelegateBridge = context.coordinator

        guard let window = nsView.window else {
            return
        }

        if isFocused {
            if window.firstResponder !== nsView {
                window.makeFirstResponder(nsView)
            }
        } else if window.firstResponder === nsView {
            window.makeFirstResponder(nil)
        }
    }

    final class Coordinator: NSObject {
        @Binding private var isFocused: Bool
        private let onInput: (String) -> Void

        init(
            isFocused: Binding<Bool>,
            onInput: @escaping (String) -> Void
        ) {
            _isFocused = isFocused
            self.onInput = onInput
        }

        func focusChanged(_ focused: Bool) {
            isFocused = focused
        }

        func handleInput(_ text: String) {
            guard !text.isEmpty else {
                return
            }
            onInput(text)
        }

        func handleBackspace() {
            onInput("\u{7F}")
        }

        func handleEscape() {
            onInput("\u{1B}")
        }

        func handleTab() {
            onInput("\t")
        }

        func handleArrow(_ sequence: String) {
            onInput(sequence)
        }

        func handleCtrlC() {
            onInput("\u{03}")
        }

        func handlePaste(_ text: String) {
            guard !text.isEmpty else {
                return
            }
            onInput(text)
        }
    }
}

final class TerminalInputTextView: NSTextView {
    weak var inputDelegateBridge: TerminalInputBridge.Coordinator?

    override var acceptsFirstResponder: Bool {
        true
    }

    override init(frame frameRect: NSRect) {
        let storage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        let container = NSTextContainer(size: .zero)
        container.widthTracksTextView = false
        container.heightTracksTextView = false
        layoutManager.addTextContainer(container)
        storage.addLayoutManager(layoutManager)

        super.init(frame: frameRect, textContainer: container)

        drawsBackground = false
        isRichText = false
        isEditable = true
        isSelectable = true
        textColor = .clear
        insertionPointColor = .clear
        backgroundColor = .clear
        importsGraphics = false
        isAutomaticQuoteSubstitutionEnabled = false
        isAutomaticDashSubstitutionEnabled = false
        isAutomaticTextReplacementEnabled = false
        isAutomaticSpellingCorrectionEnabled = false
        isContinuousSpellCheckingEnabled = false
        isGrammarCheckingEnabled = false
        smartInsertDeleteEnabled = false
        allowsUndo = false
        isHorizontallyResizable = false
        isVerticallyResizable = false
        textContainerInset = .zero
        selectedTextAttributes = [:]
    }

    override init(frame frameRect: NSRect, textContainer container: NSTextContainer?) {
        super.init(frame: frameRect, textContainer: container)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        inputDelegateBridge?.focusChanged(became)
        resetSelection()
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        inputDelegateBridge?.focusChanged(false)
        return resigned
    }

    override func insertText(
        _ insertString: Any,
        replacementRange: NSRange
    ) {
        let text: String
        if let attributed = insertString as? NSAttributedString {
            text = attributed.string
        } else if let string = insertString as? String {
            text = string
        } else {
            text = ""
        }

        guard !text.isEmpty else {
            return
        }

        if text == "\n" {
            inputDelegateBridge?.handleInput("\r")
        } else {
            inputDelegateBridge?.handleInput(text)
        }
        resetSelection()
    }

    override func doCommand(by selector: Selector) {
        switch selector {
        case #selector(deleteBackward(_:)):
            inputDelegateBridge?.handleBackspace()
        case #selector(cancelOperation(_:)):
            inputDelegateBridge?.handleEscape()
        case #selector(insertTab(_:)):
            inputDelegateBridge?.handleTab()
        case #selector(moveUp(_:)):
            inputDelegateBridge?.handleArrow("\u{1B}[A")
        case #selector(moveDown(_:)):
            inputDelegateBridge?.handleArrow("\u{1B}[B")
        case #selector(moveLeft(_:)):
            inputDelegateBridge?.handleArrow("\u{1B}[D")
        case #selector(moveRight(_:)):
            inputDelegateBridge?.handleArrow("\u{1B}[C")
        case #selector(insertNewline(_:)):
            inputDelegateBridge?.handleInput("\r")
        default:
            super.doCommand(by: selector)
        }
        resetSelection()
    }

    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.control),
           event.charactersIgnoringModifiers?.lowercased() == "c" {
            inputDelegateBridge?.handleCtrlC()
            return
        }

        super.keyDown(with: event)
    }

    override func paste(_ sender: Any?) {
        if let text = NSPasteboard.general.string(forType: .string) {
            inputDelegateBridge?.handlePaste(text)
        }
    }

    override func mouseUp(with event: NSEvent) {
        window?.makeFirstResponder(self)
        super.mouseUp(with: event)
    }

    private func resetSelection() {
        string = ""
        setSelectedRange(NSRange(location: 0, length: 0))
    }
}

#else

struct TerminalInputBridge: View {
    @Binding var isFocused: Bool
    let onInput: (String) -> Void

    var body: some View {
        Color.clear
    }
}

#endif
