import Testing
@testable import TabminalIOSKit

struct GhosttyRuntimeTests {
    @Test
    func reportsMissingRemoteOutputBridgeWhenOnlyPublicSurfaceAPIExists() {
        let status = GhosttyRuntimeStatus.evaluate(
            libraryPath: "/tmp/GhosttyKit.framework/GhosttyKit",
            loadedSymbols: [
                "ghostty_init",
                "ghostty_config_new",
                "ghostty_app_new",
                "ghostty_surface_config_new",
                "ghostty_surface_new",
                "ghostty_surface_draw",
                "ghostty_surface_set_size",
                "ghostty_surface_text"
            ]
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
        let status = GhosttyRuntimeStatus.evaluate(
            libraryPath: "/tmp/GhosttyKit.framework/GhosttyKit",
            loadedSymbols: [
                "ghostty_init",
                "ghostty_config_new",
                "ghostty_app_new",
                "ghostty_surface_config_new",
                "ghostty_surface_new",
                "ghostty_surface_draw",
                "ghostty_surface_set_size",
                "ghostty_surface_text",
                "ghostty_surface_process_output"
            ]
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
