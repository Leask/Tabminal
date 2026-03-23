import Testing
@testable import TabminalIOSKit

struct TerminalPlainTextBufferTests {
    @Test
    func stripsANSISequencesAndKeepsVisibleText() {
        var buffer = TerminalPlainTextBuffer()

        buffer.replace(with: "\u{1B}[31mhello\u{1B}[0m")

        #expect(buffer.text == "hello")
    }

    @Test
    func handlesBackspaceAndSnapshotReplacement() {
        var buffer = TerminalPlainTextBuffer()

        buffer.replace(with: "abc\u{08}d")
        #expect(buffer.text == "abd")

        buffer.replace(with: "fresh")
        #expect(buffer.text == "fresh")
    }

    @Test
    func ignoresOSCSequencesAcrossChunks() {
        var buffer = TerminalPlainTextBuffer()

        buffer.append("prefix ")
        buffer.append("\u{1B}]1337;TabminalPrompt")
        buffer.append("\u{07}suffix")

        #expect(buffer.text == "prefix suffix")
    }
}
