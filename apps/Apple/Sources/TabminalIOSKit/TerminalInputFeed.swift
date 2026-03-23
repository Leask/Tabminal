import Foundation

public struct TerminalInputFeed: Sendable, Equatable {
    public private(set) var text: String
    public private(set) var sequence: UInt64

    public init(text: String = "", sequence: UInt64 = 0) {
        self.text = text
        self.sequence = sequence
    }

    public mutating func enqueue(_ text: String) {
        self.text = text
        sequence &+= 1
    }
}
