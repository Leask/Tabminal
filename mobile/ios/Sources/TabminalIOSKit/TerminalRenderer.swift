import Foundation

public enum TerminalRenderer: String, Sendable, CaseIterable {
    case text
    case ghostty

    public static var current: TerminalRenderer {
        .text
    }
}
