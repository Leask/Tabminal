import XCTest

final class TabminalMobileAppUITests: XCTestCase {
    private nonisolated(unsafe) var app: XCUIApplication!
    private nonisolated(unsafe) static var didWarmGhosttyRenderer = false

    override func setUpWithError() throws {
        continueAfterFailure = false
        let debugSidebarRequested = requiresSidebarPresentation

        app = MainActor.assumeIsolated {
            @MainActor
            func configuredApp() -> XCUIApplication {
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
                for key in [
                    "TABMINAL_MOBILE_TERMINAL_RENDERER",
                    "TABMINAL_MOBILE_ALLOW_UNSTABLE_GHOSTTY",
                    "TABMINAL_GHOSTTY_FRAMEWORK_PATH",
                    "TABMINAL_GHOSTTY_XCFRAMEWORK_PATH"
                ] {
                    if let value = ProcessInfo.processInfo.environment[key],
                       !value.isEmpty {
                        app.launchEnvironment[key] = value
                    }
                }
                return app
            }

            if ProcessInfo.processInfo.environment[
                "TABMINAL_MOBILE_TERMINAL_RENDERER"
            ] == "ghostty",
               !Self.didWarmGhosttyRenderer {
                let warmup = configuredApp()
                warmup.launch()
                let terminal = warmup.descendants(matching: .any)
                    .matching(identifier: "terminal.view")
                    .firstMatch
                let shell = warmup.descendants(matching: .any)
                    .matching(identifier: "shell.view")
                    .firstMatch
                let hostAdd = warmup.descendants(matching: .any)
                    .matching(identifier: "host.add")
                    .firstMatch
                let sidebarToggle = warmup.buttons.matching(
                    identifier: "shell.sidebarToggle"
                ).firstMatch
                let shellReady = terminal.waitForExistence(timeout: 15)
                    || shell.waitForExistence(timeout: 15)
                if debugSidebarRequested {
                    _ = shellReady
                    _ = hostAdd.waitForExistence(timeout: 15)
                        || sidebarToggle.waitForExistence(timeout: 15)
                } else {
                    _ = shellReady
                }
                warmup.terminate()
                Self.didWarmGhosttyRenderer = true
            }

            let app = configuredApp()
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
    func testPrimaryHostNewTabCreatesAnotherSession() {
        waitForShellReady()
        ensureSidebarVisible()

        let previousTerminalIdentifier = activeTerminalSessionIdentifier()
        let primaryHost = element("host.primary.main")
        XCTAssertTrue(primaryHost.waitForExistence(timeout: 10))
        primaryHost.tap()

        let expectation = NSPredicate { _, _ in
            guard let currentTerminalIdentifier =
                self.activeTerminalSessionIdentifier()
            else {
                return false
            }
            return currentTerminalIdentifier != previousTerminalIdentifier
        }
        let sessionExpectation = XCTNSPredicateExpectation(
            predicate: expectation,
            object: nil
        )
        XCTAssertEqual(
            XCTWaiter().wait(
                for: [sessionExpectation],
                timeout: 10
            ),
            .completed
        )

        XCTAssertTrue(element("terminal.view").waitForExistence(timeout: 10))

        attachScreenshot(named: "primary-host-new-tab")
    }

    @MainActor
    private func waitForShellReady() {
        let terminal = element("terminal.view")
        let shell = element("shell.view")
        let sidebarToggle = button("shell.sidebarToggle")
        let primaryHost = element("host.primary.main")

        let shellReady = terminal.waitForExistence(timeout: 30)
            || shell.waitForExistence(timeout: 5)
            || sidebarToggle.waitForExistence(timeout: 5)
            || primaryHost.waitForExistence(timeout: 5)

        if shellReady && terminal.waitForExistence(timeout: 10) {
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
        if hostAddButton().waitForExistence(timeout: 10) {
            return
        }

        let toggle = button("shell.sidebarToggle")
        if toggle.waitForExistence(timeout: 2) {
            toggle.tap()
        }

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

    @MainActor
    private func sessionCards() -> XCUIElementQuery {
        app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "session.card.")
        )
    }

    @MainActor
    private func activeTerminalSessionIdentifier() -> String? {
        let activeTerminal = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "terminal.session.")
        ).firstMatch
        guard activeTerminal.waitForExistence(timeout: 10) else {
            return nil
        }
        return activeTerminal.identifier
    }

    private var requiresSidebarPresentation: Bool {
        let name = self.name
        return name.contains("testSidebarShowsSessionsAndHostControls")
            || name.contains("testAddHostSheetOpensFromSidebar")
            || name.contains("testInlineWorkspaceOpensFromSidebarEditorAction")
            || name.contains("testPrimaryHostNewTabCreatesAnotherSession")
    }

    @MainActor
    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
