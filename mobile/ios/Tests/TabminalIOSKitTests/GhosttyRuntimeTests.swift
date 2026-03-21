import Testing
@testable import TabminalIOSKit

struct GhosttyRuntimeTests {
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
            status.missingSymbols == [
                "ghostty_surface_process_output"
            ]
        )
    }

    @Test
    func marksRuntimeReadyWhenRemoteOutputSymbolExists() {
        let required = Set(GhosttyRuntimeStatus.requiredSurfaceSymbols)
            .union(["ghostty_surface_process_output"])
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
}
