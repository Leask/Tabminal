import XCTest

@MainActor
final class TabminalMobileAppUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false

        app = XCUIApplication()
        app.launchEnvironment["TABMINAL_MOBILE_DEBUG_URL"] =
            "http://127.0.0.1:19846"
        app.launchEnvironment["TABMINAL_MOBILE_DEBUG_PASSWORD"] =
            "mobile-debug"
        app.launchEnvironment["TABMINAL_MOBILE_DEBUG_HOST"] = "Local Debug"
        app.launchEnvironment["TABMINAL_MOBILE_DEBUG_AUTO_LOGIN"] = "1"
        app.launch()
    }

    @MainActor
    func testAutoLoginLandsInTerminalShell() {
        waitForShellReady()
        XCTAssertTrue(
            element("terminal.keyboard").waitForExistence(timeout: 10)
        )

        attachScreenshot(named: "terminal-shell")
    }

    @MainActor
    func testSidebarShowsSessionsAndHostControls() {
        waitForShellReady()
        let toggle = element("shell.sidebarToggle")
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        toggle.tap()

        XCTAssertTrue(element("host.add").waitForExistence(timeout: 10))

        attachScreenshot(named: "sidebar")
    }

    @MainActor
    func testInlineWorkspaceOpensFromSidebarEditorAction() {
        waitForShellReady()
        let toggle = element("shell.sidebarToggle")
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        toggle.tap()

        let editorButton = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "session.editor.")
        ).firstMatch
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
        if shell.waitForExistence(timeout: 30) {
            return
        }

        let loginError = element("login.error")
        print("=== UI TREE BEGIN ===")
        print(app.debugDescription)
        print("=== UI TREE END ===")
        attachScreenshot(named: "shell-launch-failure")
        XCTFail("Shell did not appear. Login error: \(loginError.label)")
    }

    @MainActor
    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(identifier: identifier)
            .firstMatch
    }

    @MainActor
    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
