import XCTest

final class TabminalMobileAppUITests: XCTestCase {
    private nonisolated(unsafe) var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        let debugSidebarRequested = requiresSidebarPresentation

        app = MainActor.assumeIsolated {
            let app = XCUIApplication()
            app.launchEnvironment["TABMINAL_MOBILE_DEBUG_URL"] =
                "http://127.0.0.1:19846"
            app.launchEnvironment["TABMINAL_MOBILE_DEBUG_PASSWORD"] =
                "mobile-debug"
            app.launchEnvironment["TABMINAL_MOBILE_DEBUG_HOST"] =
                "Local Debug"
            app.launchEnvironment["TABMINAL_MOBILE_DEBUG_AUTO_LOGIN"] = "1"
            if debugSidebarRequested {
                app.launchEnvironment[
                    "TABMINAL_MOBILE_DEBUG_PRESENT_SIDEBAR"
                ] = "1"
            }
            app.launch()
            return app
        }
    }

    override func tearDownWithError() throws {
        app = nil
    }

    @MainActor
    func testAutoLoginLandsInTerminalShell() {
        waitForShellReady()

        attachScreenshot(named: "terminal-shell")
    }

    @MainActor
    func testSidebarShowsSessionsAndHostControls() {
        waitForShellReady()
        ensureSidebarVisible()

        XCTAssertTrue(element("host.add").waitForExistence(timeout: 10))

        attachScreenshot(named: "sidebar")
    }

    @MainActor
    func testAddHostSheetOpensFromSidebar() {
        waitForShellReady()
        ensureSidebarVisible()

        let addHost = hostAddButton()
        XCTAssertTrue(addHost.waitForExistence(timeout: 10))
        addHost.tap()

        XCTAssertTrue(element("host.editor.view").waitForExistence(timeout: 10))
        XCTAssertTrue(element("host.editor.url").waitForExistence(timeout: 10))
        XCTAssertTrue(element("host.editor.host").waitForExistence(timeout: 10))
        XCTAssertTrue(
            element("host.editor.submit").waitForExistence(timeout: 10)
        )

        attachScreenshot(named: "host-editor-add")
    }

    @MainActor
    func testInlineWorkspaceOpensFromSidebarEditorAction() {
        waitForShellReady()
        ensureSidebarVisible()

        let editorButton = sessionEditorButton()
        XCTAssertTrue(editorButton.waitForExistence(timeout: 10))
        editorButton.tap()

        XCTAssertTrue(
            element("workspace.inline.save").waitForExistence(timeout: 10)
        )

        attachScreenshot(named: "workspace-inline")
    }

    @MainActor
    private func waitForShellReady() {
        let shell = element("shell.view")
        let shellReady = shell.waitForExistence(timeout: 30)

        if shellReady,
           element("terminal.view").waitForExistence(timeout: 10) {
            return
        }

        let loginError = element("login.error")
        print("=== UI TREE BEGIN ===")
        print(app.debugDescription)
        print("=== UI TREE END ===")
        attachScreenshot(named: "shell-launch-failure")
        let message = loginError.exists ? loginError.label : "none"
        XCTFail("Shell did not appear. Login error: \(message)")
    }

    @MainActor
    private func ensureSidebarVisible() {
        if hostAddButton().waitForExistence(timeout: 2) {
            return
        }

        let toggle = button("shell.sidebarToggle")
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        toggle.tap()
        XCTAssertTrue(hostAddButton().waitForExistence(timeout: 10))
    }

    @MainActor
    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(identifier: identifier)
            .firstMatch
    }

    @MainActor
    private func button(_ identifier: String) -> XCUIElement {
        app.buttons.matching(identifier: identifier).firstMatch
    }

    @MainActor
    private func hostAddButton() -> XCUIElement {
        let identified = element("host.add")
        if identified.exists {
            return identified
        }
        return app.buttons["+ Add Host"]
    }

    @MainActor
    private func sessionEditorButton() -> XCUIElement {
        let identified = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "session.editor.")
        ).firstMatch
        if identified.exists {
            return identified
        }
        return app.buttons["Toggle Editor"]
    }

    private var requiresSidebarPresentation: Bool {
        let name = self.name
        return name.contains("testSidebarShowsSessionsAndHostControls")
            || name.contains("testAddHostSheetOpensFromSidebar")
            || name.contains("testInlineWorkspaceOpensFromSidebarEditorAction")
    }

    @MainActor
    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
