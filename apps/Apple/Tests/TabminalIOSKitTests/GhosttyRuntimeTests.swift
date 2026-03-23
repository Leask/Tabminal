import Foundation
import Testing
@testable import TabminalIOSKit

struct GhosttyRuntimeTests {
    @MainActor
    private final class GhosttyTerminalDriverSpy: GhosttyTerminalSurfaceDriver {
        var lastWriteHandler: ((String) -> Void)?
        var snapshotCalls: [(String, String)] = []
        var outputCalls: [String] = []
        var inputCalls: [String] = []

        func updateGhosttyWriteHandler(
            _ handler: ((String) -> Void)?
        ) {
            lastWriteHandler = handler
        }

        func replaceGhosttySnapshot(
            _ snapshotText: String,
            outputText: String
        ) {
            snapshotCalls.append((snapshotText, outputText))
        }

        func appendGhosttyOutput(_ text: String) {
            outputCalls.append(text)
        }

        func enqueueGhosttyInput(_ text: String) {
            inputCalls.append(text)
        }
    }

    @Test
    func reportsMissingRemoteOutputBridgeWhenOnlyPublicSurfaceAPIExists() {
        let required = Set(GhosttyRuntimeStatus.requiredSurfaceSymbols)
        let status = GhosttyRuntimeStatus.evaluate(
            libraryPath: "/tmp/GhosttyKit.framework/GhosttyKit",
            loadedSymbols: required
        )

        #expect(status.availability == .publicSurfaceAPI)
        #expect(status.canCreateSurface)
        #expect(!status.canProcessRemoteOutput)
        #expect(
            status.missingSymbols
                == GhosttyRuntimeStatus.requiredRemoteIOSymbols
        )
    }

    @Test
    func marksRuntimeReadyWhenRemoteOutputSymbolExists() {
        let required = Set(GhosttyRuntimeStatus.requiredSurfaceSymbols)
            .union(GhosttyRuntimeStatus.requiredRemoteIOSymbols)
        let status = GhosttyRuntimeStatus.evaluate(
            libraryPath: "/tmp/GhosttyKit.framework/GhosttyKit",
            loadedSymbols: required
        )

        #expect(status.availability == .remoteIOReady)
        #expect(status.canProcessRemoteOutput)
        #expect(status.missingSymbols.isEmpty)
    }

    @Test
    func renderFeedTracksSnapshotsAndOutputIndependently() {
        var feed = TerminalRenderFeed()

        feed.replaceSnapshot(with: "hello")
        feed.appendOutput(" world")

        #expect(feed.snapshotText == "hello")
        #expect(feed.outputText == " world")
        #expect(feed.snapshotSequence == 1)
        #expect(feed.outputSequence == 1)
    }

    @MainActor
    @Test
    func ghosttyControllerReplaysSnapshotAndBuffersInputAcrossAttach() {
        let controller = GhosttyTerminalController()
        let firstDriver = GhosttyTerminalDriverSpy()
        let secondDriver = GhosttyTerminalDriverSpy()

        controller.replaceSnapshot(with: "snapshot")
        controller.appendOutput(" + output")
        controller.enqueueInput("ls\r")
        controller.setWriteHandler({ _ in })

        controller.attach(to: firstDriver)

        #expect(firstDriver.snapshotCalls.last?.0 == "snapshot")
        #expect(firstDriver.snapshotCalls.last?.1 == " + output")
        #expect(firstDriver.inputCalls == ["ls\r"])
        #expect(firstDriver.lastWriteHandler != nil)

        controller.detach(from: firstDriver)
        controller.enqueueInput("pwd\r")
        controller.attach(to: secondDriver)

        #expect(secondDriver.snapshotCalls.last?.0 == "snapshot")
        #expect(secondDriver.snapshotCalls.last?.1 == " + output")
        #expect(secondDriver.inputCalls == ["pwd\r"])
        #expect(secondDriver.lastWriteHandler != nil)
    }

    @Test
    func ghosttyWriteFilterDropsTerminalQueryResponses() {
        var filter = GhosttyWriteFilter()
        let payload = Data(
            "\u{1B}[4;1R\u{1B}]11;rgb:2828/2c2c/3434\u{07}ls\r".utf8
        )

        let filtered = filter.consume(payload)

        #expect(String(decoding: filtered, as: UTF8.self) == "ls\r")
    }

    @Test
    func ghosttyWriteFilterPreservesArrowKeys() {
        var filter = GhosttyWriteFilter()
        let payload = Data("\u{1B}[A".utf8)

        let filtered = filter.consume(payload)

        #expect(filtered == payload)
    }

    @Test
    func ghosttyWriteFilterHandlesSplitSequencesAcrossChunks() {
        var filter = GhosttyWriteFilter()

        let first = filter.consume(Data("\u{1B}[4;".utf8))
        let second = filter.consume(
            Data("1R\u{1B}]11;rgb:2828/2c2c/3434\u{07}pwd\r".utf8)
        )

        #expect(first.isEmpty)
        #expect(String(decoding: second, as: UTF8.self) == "pwd\r")
    }
}
