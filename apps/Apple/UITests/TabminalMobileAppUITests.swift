import XCTest

final class TabminalMobileAppUITests: XCTestCase {
    private nonisolated(unsafe) var app: XCUIApplication!
    private nonisolated(unsafe) static var didWarmGhosttyRenderer = false

    override func setUpWithError() throws {
        continueAfterFailure = false
        let debugSidebarRequested = requiresSidebarPresentation
        let debugFullWorkspaceRequested = name.contains("testFullFileTabs")

        app = MainActor.assumeIsolated {
            @MainActor
            func configuredApp() -> XCUIApplication {
                let app = XCUIApplication()
                app.launchEnvironment["TABMINAL_MOBILE_DEBUG_URL"] =
                    ProcessInfo.processInfo.environment[
                        "TABMINAL_MOBILE_DEBUG_URL"
                    ] ?? "http://127.0.0.1:19846"
                app.launchEnvironment["TABMINAL_MOBILE_DEBUG_PASSWORD"] =
                    ProcessInfo.processInfo.environment[
                        "TABMINAL_MOBILE_DEBUG_PASSWORD"
                    ] ?? "mobile-debug"
                app.launchEnvironment["TABMINAL_MOBILE_DEBUG_HOST"] =
                    "Local Debug"
                app.launchEnvironment["TABMINAL_MOBILE_DEBUG_AUTO_LOGIN"] = "1"
                if debugFullWorkspaceRequested {
                    app.launchEnvironment["TABMINAL_MOBILE_DEBUG_FULL_WORKSPACE"] = "1"
                }
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
        waitForTerminalConnection()

        attachScreenshot(named: "terminal-shell")
    }

    @MainActor
    func testTerminalInputReachesShellAndRendersOutput() throws {
        try XCTSkipIf(
            ProcessInfo.processInfo.environment[
                "TABMINAL_MOBILE_TERMINAL_RENDERER"
            ] == "ghostty",
            "Text assertions do not inspect Ghostty's GPU-rendered pixels."
        )
        waitForShellReady()
        waitForTerminalConnection()
        // The contiguous marker exists only in shell output, not command echo.
        let input = app.textViews["terminal.input.capture"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText("printf 'TABMINAL_%s_OK\\n' 'NATIVE'\n")
        let output = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "TABMINAL_NATIVE_OK")
        ).firstMatch
        XCTAssertTrue(output.waitForExistence(timeout: 15))
        attachScreenshot(named: "terminal-input-output")
    }

    @MainActor
    func testKeyboardButtonHidesAndRestoresInput() {
        waitForShellReady()
        waitForTerminalConnection()
        let keyboardButton = element("terminal.keyboard")
        XCTAssertTrue(keyboardButton.waitForExistence(timeout: 5))
        if keyboardButton.label == "Hide Keyboard" {
            keyboardButton.tap()
        }
        let hidden = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Show Keyboard"),
            object: keyboardButton
        )
        XCTAssertEqual(XCTWaiter().wait(for: [hidden], timeout: 5), .completed)
        keyboardButton.tap()
        let shown = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Hide Keyboard"),
            object: keyboardButton
        )
        XCTAssertEqual(XCTWaiter().wait(for: [shown], timeout: 5), .completed)
    }

    @MainActor
    func testRelaunchRestoresLoginWithoutPassword() {
        waitForShellReady()
        waitForTerminalConnection()
        app.terminate()
        app.launchEnvironment["TABMINAL_MOBILE_DEBUG_AUTO_LOGIN"] = "0"
        app.launchEnvironment["TABMINAL_MOBILE_DEBUG_PASSWORD"] = ""
        app.launch()
        waitForShellReady()
        waitForTerminalConnection()
        attachScreenshot(named: "keychain-login-restore")
    }

    @MainActor
    private func waitForTerminalConnection() {
        let terminal = element("terminal.view")
        let requested = ProcessInfo.processInfo.environment[
            "TABMINAL_MOBILE_TERMINAL_RENDERER"
        ]
        let predicate: NSPredicate
        if requested == "ghostty" {
            predicate = NSPredicate(format: "value == %@", "ghostty:connected")
        } else {
            predicate = NSPredicate(format: "value ENDSWITH %@", ":connected")
        }
        let connected = XCTNSPredicateExpectation(
            predicate: predicate,
            object: terminal
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [connected], timeout: 20),
            .completed,
            "Shell UI appeared, but authenticated terminal did not connect."
        )
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
        openWorkspaceIfNeeded()

        XCTAssertTrue(
            element("workspace.inline.save").waitForExistence(timeout: 10)
        )
        XCTAssertTrue(
            element("workspace.directory.entry").waitForExistence(timeout: 10),
            "The panel opened, but the server directory listing did not render."
        )
        XCTAssertFalse(element("workspace.directory.error").exists)

        attachScreenshot(named: "workspace-inline")
        element("workspace.inline.close").tap()
    }

    @MainActor
    func testFileSaveReopensFromHost() async throws {
        let fixture = try await NativeFileFixture.connect()
        openFileFixture("save")
        let editor = app.textViews["workspace.editor.content"]
        editor.tap()
        editor.typeText("NATIVE_SAVE_OK")
        element("workspace.inline.save").tap()
        waitForDocumentState("Saved")
        let saved = try await fixture.read("save")
        XCTAssertTrue((saved["content"] as? String)?.contains("NATIVE_SAVE_OK") == true)
        app.terminate()
        app.launch()
        waitForShellReady()
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        XCTAssertTrue((editor.value as? String)?.contains("NATIVE_SAVE_OK") == true)
        attachScreenshot(named: "file-saved-and-reopened")
        element("workspace.inline.close").tap()
    }

    @MainActor
    func testFileConflictRequiresExplicitOverwrite() async throws {
        let fixture = try await NativeFileFixture.connect()
        openFileFixture("conflict")
        let editor = app.textViews["workspace.editor.content"]
        editor.tap()
        editor.typeText("MY_LOCAL_EDIT")
        try await fixture.externalEdit("conflict", content: "EXTERNAL_COPY")
        element("workspace.inline.save").tap()
        XCTAssertTrue(element("workspace.conflict.reload").waitForExistence(timeout: 10))
        XCTAssertTrue((editor.value as? String)?.contains("MY_LOCAL_EDIT") == true)
        let untouched = try await fixture.read("conflict")
        XCTAssertEqual(untouched["content"] as? String, "EXTERNAL_COPY")
        element("workspace.conflict.reload").tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap()
        XCTAssertTrue((editor.value as? String)?.contains("MY_LOCAL_EDIT") == true)
        attachScreenshot(named: "file-conflict-keeps-local-text")
        element("workspace.conflict.overwrite").tap()
        app.buttons["Overwrite Host File"].tap()
        waitForDocumentState("Saved")
        let overwritten = try await fixture.read("conflict")
        XCTAssertTrue((overwritten["content"] as? String)?.contains("MY_LOCAL_EDIT") == true)
        element("workspace.inline.close").tap()
    }

    @MainActor
    func testFileConflictReloadFetchesCurrentHostText() async throws {
        let fixture = try await NativeFileFixture.connect()
        openFileFixture("reload")
        let editor = app.textViews["workspace.editor.content"]
        editor.tap()
        editor.typeText("LOCAL_TO_DISCARD")
        try await fixture.externalEdit("reload", content: "FIRST_REMOTE_COPY")
        element("workspace.inline.save").tap()
        XCTAssertTrue(element("workspace.conflict.reload").waitForExistence(timeout: 10))
        try await fixture.externalEdit("reload", content: "LATEST_REMOTE_COPY")
        element("workspace.conflict.reload").tap()
        app.buttons["Discard Edits and Reload"].tap()
        waitForDocumentState("Saved")
        XCTAssertEqual(editor.value as? String, "LATEST_REMOTE_COPY")
        attachScreenshot(named: "file-conflict-reloaded")
        element("workspace.inline.close").tap()
    }

    @MainActor
    func testFileUnsavedDraftSurvivesRelaunchAndSwitchingFiles() async throws {
        _ = try await NativeFileFixture.connect()
        openFileFixture("draft")
        let editor = app.textViews["workspace.editor.content"]
        editor.tap()
        editor.typeText("RESTORE_UNSAVED_DRAFT")
        waitForDocumentState("Unsaved changes (draft saved)")
        openFileFixture("save")
        openFileFixture("draft")
        XCTAssertTrue((editor.value as? String)?.contains("RESTORE_UNSAVED_DRAFT") == true)
        app.terminate()
        app.launch()
        waitForShellReady()
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        XCTAssertTrue((editor.value as? String)?.contains("RESTORE_UNSAVED_DRAFT") == true)
        waitForDocumentState("Unsaved changes (draft saved)")
        attachScreenshot(named: "file-unsaved-draft-restored")
        element("workspace.inline.close").tap()
    }

    @MainActor
    func testInlineFileTabsKeepSelectionVisibleAndAllowManualScrolling() async throws {
        _ = try await NativeFileFixture.connect()
        try await checkFileTabVisibility(fullWorkspace: false)
    }

    @MainActor
    func testFullFileTabsKeepSelectionVisibleAndAllowManualScrolling() async throws {
        _ = try await NativeFileFixture.connect()
        try await checkFileTabVisibility(fullWorkspace: true)
    }

    @MainActor
    private func checkFileTabVisibility(fullWorkspace: Bool) async throws {
        let lastName = "this-is-a-long-file-name-used-to-check-selected-tab-visibility"
        let names = ["conflict", "reload", "save", "draft", lastName]
        for name in names {
            openTabTestFile(name, fullWorkspace: fullWorkspace)
            assertSelectedFileTabVisible(name)
        }
        let strip = app.scrollViews["workspace.file.tabs"]
        let first = fileTab("conflict")
        let last = fileTab(lastName, selected: true)
        let tabSpan = last.frame.maxX - first.frame.minX
        if strip.frame.width <= 400 {
            XCTAssertGreaterThan(tabSpan, strip.frame.width)
        }
        if tabSpan > strip.frame.width {
            let originalFirstX = first.frame.minX
            strip.swipeRight()
            for _ in 0..<5 {
                if first.isHittable { break }
                strip.swipeRight()
            }
            XCTAssertTrue(first.isHittable)
            XCTAssertGreaterThan(first.frame.minX, originalFirstX + 2)
            XCTAssertEqual(element("workspace.activeFile.name").label, "native-\(lastName).txt")
            // Opening the current file is also an explicit request to reveal it.
            openTabTestFile(lastName, fullWorkspace: fullWorkspace)
            assertSelectedFileTabVisible(lastName)
            for _ in 0..<5 {
                if first.isHittable { break }
                strip.swipeRight()
            }
        }
        first.tap()
        assertSelectedFileTabVisible("conflict")
        openTabTestFile(lastName, fullWorkspace: fullWorkspace)
        assertSelectedFileTabVisible(lastName)
        let expectedTabs = fileTabIdentifiers()
        XCTAssertGreaterThanOrEqual(expectedTabs.count, names.count)
        attachScreenshot(named: fullWorkspace ? "full-file-tab-selected" : "inline-file-tab-selected")
        app.terminate()
        app.launch()
        if fullWorkspace {
            XCTAssertTrue(element("workspace.view").waitForExistence(timeout: 20))
        } else {
            waitForShellReady()
        }
        let tabQuery = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH %@", "workspace.file.tab."
        ))
        let restored = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "count == %d", expectedTabs.count),
            object: tabQuery
        )
        XCTAssertEqual(XCTWaiter().wait(for: [restored], timeout: 15), .completed)
        XCTAssertEqual(fileTabIdentifiers(), expectedTabs)
        assertSelectedFileTabVisible(lastName)
        attachScreenshot(named: fullWorkspace ? "full-file-tab-restored" : "inline-file-tab-restored")
        element(fullWorkspace ? "workspace.done" : "workspace.inline.close").tap()
    }

    @MainActor
    private func fileTab(_ name: String, selected: Bool = false) -> XCUIElement {
        app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@",
            selected ? "workspace.file.tab.selected." : "workspace.file.tab.",
            "/native-\(name).txt"
        )).firstMatch
    }

    @MainActor
    private func fileTabIdentifiers() -> Set<String> {
        Set(app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH %@", "workspace.file.tab."
        )).allElementsBoundByIndex.map {
            $0.identifier.replacingOccurrences(
                of: "workspace.file.tab.selected.", with: "workspace.file.tab."
            )
        })
    }

    @MainActor
    private func assertSelectedFileTabVisible(_ name: String) {
        let title = element("workspace.activeFile.name")
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        let selectedName = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "native-\(name).txt"),
            object: title
        )
        XCTAssertEqual(XCTWaiter().wait(for: [selectedName], timeout: 15), .completed)
        let path = element("workspace.activeFile.path").label
        let tab = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@",
            "workspace.file.tab.selected.", path
        )).firstMatch
        let strip = app.scrollViews["workspace.file.tabs"]
        let group = app.otherElements.matching(NSPredicate(
            format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@",
            "workspace.file.tab.container.", path
        )).firstMatch
        let close = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@",
            "workspace.file.close.", path
        )).firstMatch
        let visible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard strip.exists, tab.exists else { return false }
            let viewport = strip.frame.intersection(self.app.frame)
            guard group.exists, close.exists, viewport.width > 0,
                  group.frame.width > 0 else { return false }
            return viewport.insetBy(dx: -1, dy: -1).contains(group.frame)
                && tab.isHittable && close.isHittable
        }, object: nil)
        let result = XCTWaiter().wait(for: [visible], timeout: 15)
        if result != .completed {
            print("Selected tab: \(path), tab=\(tab.exists), group=\(group.exists), close=\(close.exists)")
            print(app.debugDescription)
            attachScreenshot(named: "file-tab-visibility-failure")
        }
        XCTAssertEqual(result, .completed)
        XCTAssertEqual(element("workspace.activeFile.name").label, "native-\(name).txt")
    }

    @MainActor
    private func openTabTestFile(_ name: String, fullWorkspace: Bool) {
        if !fullWorkspace {
            openFileFixture(name)
            return
        }
        XCTAssertTrue(element("workspace.view").waitForExistence(timeout: 20))
        let files = app.segmentedControls["workspace.panePicker"].buttons["Files"]
        XCTAssertTrue(files.waitForExistence(timeout: 5))
        if !files.isSelected { files.tap() }
        let entry = app.buttons.matching(NSPredicate(
            format: "identifier == %@ AND label CONTAINS %@",
            "workspace.directory.entry", "native-\(name).txt"
        )).firstMatch
        for _ in 0..<5 {
            if entry.exists, entry.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(entry.waitForExistence(timeout: 10))
        entry.tap()
        XCTAssertTrue(app.textViews["workspace.editor.content"].waitForExistence(timeout: 10))
    }

    @MainActor
    private func openWorkspaceIfNeeded() {
        if element("workspace.inline.save").exists, hostAddButton().exists {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.35)).tap()
        }
        if !element("workspace.inline.save").exists {
            ensureSidebarVisible()
            let editorButton = sessionEditorButton()
            XCTAssertTrue(editorButton.waitForExistence(timeout: 10))
            editorButton.tap()
        }
    }

    @MainActor
    private func openFileFixture(_ name: String) {
        waitForShellReady()
        openWorkspaceIfNeeded()
        let file = app.descendants(matching: .any).matching(NSPredicate(
            format: "identifier == %@ AND label CONTAINS %@",
            "workspace.directory.entry", "native-\(name).txt"
        )).firstMatch
        let browser = app.scrollViews.containing(
            .button, identifier: "workspace.directory.entry"
        ).firstMatch
        if browser.exists {
            browser.swipeDown()
            browser.swipeDown()
            for _ in 0..<5 {
                if file.exists, file.isHittable { break }
                browser.swipeUp()
            }
        }
        XCTAssertTrue(file.waitForExistence(timeout: 10))
        file.tap()
        XCTAssertTrue(app.textViews["workspace.editor.content"].waitForExistence(timeout: 10))
    }

    @MainActor
    private func waitForDocumentState(_ state: String) {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", state),
            object: element("workspace.document.state")
        )
        XCTAssertEqual(XCTWaiter().wait(for: [expectation], timeout: 15), .completed)
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
        // Fresh simulators may present the system's first-use keyboard sheet.
        let keyboardContinue = app.buttons["Continue"]
        if keyboardContinue.waitForExistence(timeout: 2) {
            keyboardContinue.tap()
        }
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

        let loginError = app.staticTexts.matching(
            identifier: "login.error"
        ).firstMatch
        print("=== UI TREE BEGIN ===")
        print(app.debugDescription)
        print("=== UI TREE END ===")
        attachScreenshot(named: "shell-launch-failure")
        let message = loginError.exists ? loginError.label : "none"
        XCTFail("Shell did not appear. Login error: \(message)")
    }

    @MainActor
    private func ensureSidebarVisible() {
        if hostAddButton().exists {
            return
        }

        let toggle = element("shell.sidebarToggle")
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
