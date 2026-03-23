import Foundation

struct TerminalPlainTextBuffer {
    private enum EscapeState {
        case idle
        case escape
        case csi
        case osc
        case oscEscape
    }

    private let maxLength: Int
    private var renderedText: String
    private var escapeState: EscapeState

    init(maxLength: Int = 200_000) {
        self.maxLength = maxLength
        renderedText = ""
        escapeState = .idle
    }

    var text: String {
        renderedText
    }

    mutating func replace(with raw: String) {
        renderedText = ""
        escapeState = .idle
        feed(raw)
    }

    mutating func append(_ raw: String) {
        feed(raw)
    }

    private mutating func feed(_ raw: String) {
        for scalar in raw.unicodeScalars {
            switch escapeState {
            case .idle:
                consumeIdleScalar(scalar)
            case .escape:
                consumeEscapeScalar(scalar)
            case .csi:
                consumeCSIScalar(scalar)
            case .osc:
                consumeOSCScalar(scalar)
            case .oscEscape:
                consumeOSCEscapeScalar(scalar)
            }
        }

        trimIfNeeded()
    }

    private mutating func consumeIdleScalar(_ scalar: UnicodeScalar) {
        switch scalar.value {
        case 0x1B:
            escapeState = .escape
        case 0x08, 0x7F:
            if !renderedText.isEmpty {
                renderedText.removeLast()
            }
        case 0x0A:
            renderedText.append("\n")
        case 0x0D:
            break
        case 0x09:
            renderedText.append("\t")
        case 0x00 ... 0x1F:
            break
        default:
            renderedText.unicodeScalars.append(scalar)
        }
    }

    private mutating func consumeEscapeScalar(_ scalar: UnicodeScalar) {
        switch scalar.value {
        case 0x5B:
            escapeState = .csi
        case 0x5D:
            escapeState = .osc
        default:
            escapeState = .idle
            consumeIdleScalar(scalar)
        }
    }

    private mutating func consumeCSIScalar(_ scalar: UnicodeScalar) {
        if (0x40 ... 0x7E).contains(scalar.value) {
            escapeState = .idle
        }
    }

    private mutating func consumeOSCScalar(_ scalar: UnicodeScalar) {
        switch scalar.value {
        case 0x07:
            escapeState = .idle
        case 0x1B:
            escapeState = .oscEscape
        default:
            break
        }
    }

    private mutating func consumeOSCEscapeScalar(_ scalar: UnicodeScalar) {
        if scalar.value == 0x5C {
            escapeState = .idle
        } else {
            escapeState = .osc
            consumeOSCScalar(scalar)
        }
    }

    private mutating func trimIfNeeded() {
        guard renderedText.count > maxLength else {
            return
        }

        let overflow = renderedText.count - maxLength
        let dropCount = min(
            renderedText.count,
            max(overflow, maxLength / 10)
        )
        renderedText.removeFirst(dropCount)
    }
}
