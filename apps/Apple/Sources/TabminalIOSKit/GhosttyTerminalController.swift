import Foundation

@MainActor
protocol GhosttyTerminalSurfaceDriver: AnyObject {
    func updateGhosttyWriteHandler(
        _ handler: ((String) -> Void)?
    )
    func replaceGhosttySnapshot(
        _ snapshotText: String,
        outputText: String
    )
    func appendGhosttyOutput(_ text: String)
    func enqueueGhosttyInput(_ text: String)
}

@MainActor
public final class GhosttyTerminalController {
    private weak var driver: GhosttyTerminalSurfaceDriver?
    private var snapshotText: String = ""
    private var outputText: String = ""
    private var pendingInput: [String] = []
    private var writeHandler: ((String) -> Void)?

    public init() {}

    func attach(to driver: GhosttyTerminalSurfaceDriver) {
        guard self.driver !== driver else {
            driver.updateGhosttyWriteHandler(writeHandler)
            replayState(on: driver)
            flushPendingInput(to: driver)
            return
        }

        self.driver = driver
        driver.updateGhosttyWriteHandler(writeHandler)
        replayState(on: driver)
        flushPendingInput(to: driver)
    }

    func detach(from driver: GhosttyTerminalSurfaceDriver) {
        guard self.driver === driver else {
            return
        }
        self.driver = nil
    }

    public func setWriteHandler(_ handler: ((String) -> Void)?) {
        writeHandler = handler
        driver?.updateGhosttyWriteHandler(handler)
    }

    public func replaceSnapshot(with text: String) {
        snapshotText = text
        outputText = ""
        driver?.replaceGhosttySnapshot(text, outputText: "")
    }

    public func appendOutput(_ text: String) {
        guard !text.isEmpty else {
            return
        }

        outputText.append(text)
        driver?.appendGhosttyOutput(text)
    }

    public func enqueueInput(_ text: String) {
        guard !text.isEmpty else {
            return
        }

        if let driver {
            driver.enqueueGhosttyInput(text)
            return
        }

        pendingInput.append(text)
    }

    public func reset() {
        snapshotText = ""
        outputText = ""
        pendingInput.removeAll(keepingCapacity: false)
        driver?.replaceGhosttySnapshot("", outputText: "")
    }

    private func replayState(on driver: GhosttyTerminalSurfaceDriver) {
        driver.replaceGhosttySnapshot(
            snapshotText,
            outputText: outputText
        )
    }

    private func flushPendingInput(to driver: GhosttyTerminalSurfaceDriver) {
        guard !pendingInput.isEmpty else {
            return
        }

        let buffered = pendingInput
        pendingInput.removeAll(keepingCapacity: false)
        for item in buffered {
            driver.enqueueGhosttyInput(item)
        }
    }
}
