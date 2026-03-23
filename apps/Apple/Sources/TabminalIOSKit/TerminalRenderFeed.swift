import Foundation

public struct TerminalRenderFeed: Sendable, Equatable {
    public private(set) var snapshotText: String
    public private(set) var snapshotSequence: UInt64
    public private(set) var outputText: String
    public private(set) var outputSequence: UInt64

    public init(
        snapshotText: String = "",
        snapshotSequence: UInt64 = 0,
        outputText: String = "",
        outputSequence: UInt64 = 0
    ) {
        self.snapshotText = snapshotText
        self.snapshotSequence = snapshotSequence
        self.outputText = outputText
        self.outputSequence = outputSequence
    }

    public var isEmpty: Bool {
        snapshotText.isEmpty && outputText.isEmpty
    }

    public mutating func replaceSnapshot(with text: String) {
        snapshotText = text
        snapshotSequence &+= 1
        outputText = ""
    }

    public mutating func appendOutput(_ text: String) {
        outputText = text
        outputSequence &+= 1
    }
}
