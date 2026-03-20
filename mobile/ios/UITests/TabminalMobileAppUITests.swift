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

    func testAutoLoginLandsInTerminalShell() {
        XCTAssertTrue(app.buttons["Files"].waitForExistence(timeout: 15))
        XCTAssertTrue(
            app.textFields["Type a command or paste shell input"]
                .waitForExistence(timeout: 10)
        )
    }

    func testWorkspaceOpensFromShell() {
        let filesButton = app.buttons["Files"]
        XCTAssertTrue(filesButton.waitForExistence(timeout: 15))
        filesButton.tap()

        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Refresh"].waitForExistence(timeout: 10))
    }
}
