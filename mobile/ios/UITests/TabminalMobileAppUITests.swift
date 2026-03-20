import XCTest

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

    func testAutoLoginLandsInTerminalShell() {
        XCTAssertTrue(
            app.buttons["shell.sidebarToggle"].waitForExistence(timeout: 15)
        )
        XCTAssertTrue(
            app.buttons["terminal.keyboard"].waitForExistence(timeout: 15)
        )

        attachScreenshot(named: "terminal-shell")
    }

    func testSidebarShowsSessionsAndHostControls() {
        let toggle = app.buttons["shell.sidebarToggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 15))
        toggle.tap()

        XCTAssertTrue(app.buttons["host.add"].waitForExistence(timeout: 10))

        attachScreenshot(named: "sidebar")
    }

    func testInlineWorkspaceOpensFromSidebarEditorAction() {
        let toggle = app.buttons["shell.sidebarToggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 15))
        toggle.tap()

        let editorButton = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "session.editor.")
        ).firstMatch
        XCTAssertTrue(editorButton.waitForExistence(timeout: 10))
        editorButton.tap()

        XCTAssertTrue(
            app.buttons["workspace.inline.save"].waitForExistence(timeout: 10)
        )

        attachScreenshot(named: "workspace-inline")
    }

    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
