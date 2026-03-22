import Foundation
import CGhosttyShim
#if canImport(Darwin)
import Darwin
#endif
#if canImport(UIKit)
import UIKit
import QuartzCore
#endif
#if canImport(AppKit)
import AppKit
import QuartzCore
#endif

#if canImport(Darwin)
private typealias GhosttyInitFn = @convention(c) (
    UInt,
    UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32
private typealias GhosttyConfigNewFn = @convention(c) () -> ghostty_config_t?
private typealias GhosttyConfigFinalizeFn = @convention(c) (ghostty_config_t?) -> Void
private typealias GhosttyConfigFreeFn = @convention(c) (ghostty_config_t?) -> Void
private typealias GhosttyAppNewFn = @convention(c) (
    UnsafePointer<ghostty_runtime_config_s>?,
    ghostty_config_t?
) -> ghostty_app_t?
private typealias GhosttyAppFreeFn = @convention(c) (ghostty_app_t?) -> Void
private typealias GhosttyAppTickFn = @convention(c) (ghostty_app_t?) -> Void
private typealias GhosttySurfaceConfigNewFn = @convention(c) () -> ghostty_surface_config_s
private typealias GhosttySurfaceNewFn = @convention(c) (
    ghostty_app_t?,
    UnsafePointer<ghostty_surface_config_s>?
) -> ghostty_surface_t?
private typealias GhosttySurfaceFreeFn = @convention(c) (ghostty_surface_t?) -> Void
private typealias GhosttySurfaceRefreshFn = @convention(c) (
    ghostty_surface_t?
) -> Void
private typealias GhosttySurfaceDrawFn = @convention(c) (ghostty_surface_t?) -> Void
private typealias GhosttySurfaceSetSizeFn = @convention(c) (
    ghostty_surface_t?,
    UInt32,
    UInt32
) -> Void
private typealias GhosttySurfaceSetContentScaleFn = @convention(c) (
    ghostty_surface_t?,
    Double,
    Double
) -> Void
private typealias GhosttySurfaceSetFocusFn = @convention(c) (
    ghostty_surface_t?,
    Bool
) -> Void
private typealias GhosttySurfaceSetOcclusionFn = @convention(c) (
    ghostty_surface_t?,
    Bool
) -> Void
private typealias GhosttySurfaceSizeFn = @convention(c) (
    ghostty_surface_t?
) -> ghostty_surface_size_s
private typealias GhosttySurfaceTextFn = @convention(c) (
    ghostty_surface_t?,
    UnsafePointer<CChar>?,
    UInt
) -> Void
private typealias GhosttySurfaceFeedDataFn = @convention(c) (
    ghostty_surface_t?,
    UnsafePointer<UInt8>?,
    Int
) -> Void
private typealias GhosttySurfaceSetWriteCallbackFn = @convention(c) (
    ghostty_surface_t?,
    ghostty_surface_write_fn?,
    UnsafeMutableRawPointer?
) -> Void

private final class GhosttyEmbeddedSymbols {
    let ghosttyInit: GhosttyInitFn
    let configNew: GhosttyConfigNewFn
    let configFinalize: GhosttyConfigFinalizeFn
    let configFree: GhosttyConfigFreeFn
    let appNew: GhosttyAppNewFn
    let appFree: GhosttyAppFreeFn
    let appTick: GhosttyAppTickFn
    let surfaceConfigNew: GhosttySurfaceConfigNewFn
    let surfaceNew: GhosttySurfaceNewFn
    let surfaceFree: GhosttySurfaceFreeFn
    let surfaceRefresh: GhosttySurfaceRefreshFn
    let surfaceDraw: GhosttySurfaceDrawFn
    let surfaceSetSize: GhosttySurfaceSetSizeFn
    let surfaceSetContentScale: GhosttySurfaceSetContentScaleFn
    let surfaceSetFocus: GhosttySurfaceSetFocusFn
    let surfaceSetOcclusion: GhosttySurfaceSetOcclusionFn
    let surfaceSize: GhosttySurfaceSizeFn
    let surfaceText: GhosttySurfaceTextFn
    let surfaceFeedData: GhosttySurfaceFeedDataFn
    let surfaceSetWriteCallback: GhosttySurfaceSetWriteCallbackFn

    init?(loader: GhosttyRuntimeLoader = .shared) {
        guard let ghosttyInit = loader.resolveSymbol(
            named: "ghostty_init",
            as: GhosttyInitFn.self
        ),
        let configNew = loader.resolveSymbol(
            named: "ghostty_config_new",
            as: GhosttyConfigNewFn.self
        ),
        let configFinalize = loader.resolveSymbol(
            named: "ghostty_config_finalize",
            as: GhosttyConfigFinalizeFn.self
        ),
        let configFree = loader.resolveSymbol(
            named: "ghostty_config_free",
            as: GhosttyConfigFreeFn.self
        ),
        let appNew = loader.resolveSymbol(
            named: "ghostty_app_new",
            as: GhosttyAppNewFn.self
        ),
        let appFree = loader.resolveSymbol(
            named: "ghostty_app_free",
            as: GhosttyAppFreeFn.self
        ),
        let appTick = loader.resolveSymbol(
            named: "ghostty_app_tick",
            as: GhosttyAppTickFn.self
        ),
        let surfaceConfigNew = loader.resolveSymbol(
            named: "ghostty_surface_config_new",
            as: GhosttySurfaceConfigNewFn.self
        ),
        let surfaceNew = loader.resolveSymbol(
            named: "ghostty_surface_new",
            as: GhosttySurfaceNewFn.self
        ),
        let surfaceFree = loader.resolveSymbol(
            named: "ghostty_surface_free",
            as: GhosttySurfaceFreeFn.self
        ),
        let surfaceRefresh = loader.resolveSymbol(
            named: "ghostty_surface_refresh",
            as: GhosttySurfaceRefreshFn.self
        ),
        let surfaceDraw = loader.resolveSymbol(
            named: "ghostty_surface_draw",
            as: GhosttySurfaceDrawFn.self
        ),
        let surfaceSetSize = loader.resolveSymbol(
            named: "ghostty_surface_set_size",
            as: GhosttySurfaceSetSizeFn.self
        ),
        let surfaceSetContentScale = loader.resolveSymbol(
            named: "ghostty_surface_set_content_scale",
            as: GhosttySurfaceSetContentScaleFn.self
        ),
        let surfaceSetFocus = loader.resolveSymbol(
            named: "ghostty_surface_set_focus",
            as: GhosttySurfaceSetFocusFn.self
        ),
        let surfaceSetOcclusion = loader.resolveSymbol(
            named: "ghostty_surface_set_occlusion",
            as: GhosttySurfaceSetOcclusionFn.self
        ),
        let surfaceSize = loader.resolveSymbol(
            named: "ghostty_surface_size",
            as: GhosttySurfaceSizeFn.self
        ),
        let surfaceText = loader.resolveSymbol(
            named: "ghostty_surface_text",
            as: GhosttySurfaceTextFn.self
        ),
        let surfaceFeedData = loader.resolveSymbol(
            named: "ghostty_surface_feed_data",
            as: GhosttySurfaceFeedDataFn.self
        ),
        let surfaceSetWriteCallback = loader.resolveSymbol(
            named: "ghostty_surface_set_write_callback",
            as: GhosttySurfaceSetWriteCallbackFn.self
        ) else {
            return nil
        }

        self.ghosttyInit = ghosttyInit
        self.configNew = configNew
        self.configFinalize = configFinalize
        self.configFree = configFree
        self.appNew = appNew
        self.appFree = appFree
        self.appTick = appTick
        self.surfaceConfigNew = surfaceConfigNew
        self.surfaceNew = surfaceNew
        self.surfaceFree = surfaceFree
        self.surfaceRefresh = surfaceRefresh
        self.surfaceDraw = surfaceDraw
        self.surfaceSetSize = surfaceSetSize
        self.surfaceSetContentScale = surfaceSetContentScale
        self.surfaceSetFocus = surfaceSetFocus
        self.surfaceSetOcclusion = surfaceSetOcclusion
        self.surfaceSize = surfaceSize
        self.surfaceText = surfaceText
        self.surfaceFeedData = surfaceFeedData
        self.surfaceSetWriteCallback = surfaceSetWriteCallback
    }
}

private func tabminalGhosttyWakeup(_ userdata: UnsafeMutableRawPointer?) {
    _ = userdata
    GhosttyEmbeddedAppRuntime.shared.scheduleTick()
}

private func tabminalGhosttyAction(
    _ app: ghostty_app_t?,
    _ target: ghostty_target_s,
    _ action: ghostty_action_s
) -> Bool {
    _ = app
    _ = target
    _ = action
    return false
}

private func tabminalGhosttyReadClipboard(
    _ surface: UnsafeMutableRawPointer?,
    _ clipboard: ghostty_clipboard_e,
    _ request: UnsafeMutableRawPointer?
) {
    _ = surface
    _ = clipboard
    _ = request
}

private func tabminalGhosttyConfirmReadClipboard(
    _ surface: UnsafeMutableRawPointer?,
    _ text: UnsafePointer<CChar>?,
    _ request: UnsafeMutableRawPointer?,
    _ kind: ghostty_clipboard_request_e
) {
    _ = surface
    _ = text
    _ = request
    _ = kind
}

private func tabminalGhosttyWriteClipboard(
    _ surface: UnsafeMutableRawPointer?,
    _ clipboard: ghostty_clipboard_e,
    _ contents: UnsafePointer<ghostty_clipboard_content_s>?,
    _ count: Int,
    _ confirmed: Bool
) {
    _ = surface
    _ = clipboard
    _ = contents
    _ = count
    _ = confirmed
}

private func tabminalGhosttyCloseSurface(
    _ surface: UnsafeMutableRawPointer?,
    _ processAlive: Bool
) {
    guard let surface else {
        return
    }

    let ownerAddress = Int(bitPattern: surface)
    DispatchQueue.main.async {
        guard let ownerPointer = UnsafeMutableRawPointer(
            bitPattern: ownerAddress
        ) else {
            return
        }
        let owner = Unmanaged<AnyObject>
            .fromOpaque(ownerPointer)
            .takeUnretainedValue()
        guard let handler = owner as? GhosttySurfaceLifecycleHandling else {
            return
        }
        handler.handleGhosttySurfaceClosed(processAlive: processAlive)
    }
}

@MainActor
private protocol GhosttySurfaceWriteHandling: AnyObject {
    func handleGhosttyWrite(_ data: Data)
}

@MainActor
private protocol GhosttySurfaceLifecycleHandling: AnyObject {
    func handleGhosttySurfaceClosed(processAlive: Bool)
}

private func tabminalGhosttyWriteToRemote(
    _ userdata: UnsafeMutableRawPointer?,
    _ data: UnsafePointer<UInt8>?,
    _ len: Int
) {
    guard let userdata, let data, len > 0 else {
        return
    }

    let payload = Data(
        bytes: UnsafeRawPointer(data),
        count: len
    )
    let ownerAddress = Int(bitPattern: userdata)

    DispatchQueue.main.async {
        guard let ownerPointer = UnsafeMutableRawPointer(
            bitPattern: ownerAddress
        ) else {
            return
        }
        let owner = Unmanaged<AnyObject>
            .fromOpaque(ownerPointer)
            .takeUnretainedValue()
        guard let handler = owner as? GhosttySurfaceWriteHandling else {
            return
        }
        handler.handleGhosttyWrite(payload)
    }
}

private final class GhosttyEmbeddedAppRuntime: @unchecked Sendable {
    static let shared = GhosttyEmbeddedAppRuntime()

    private let symbols: GhosttyEmbeddedSymbols?
    private let app: ghostty_app_t?
    private let config: ghostty_config_t?
    private var tickScheduled = false

    private init(
        loader: GhosttyRuntimeLoader = .shared
    ) {
        guard loader.status.canProcessRemoteOutput,
              let symbols = GhosttyEmbeddedSymbols(loader: loader) else {
            self.symbols = nil
            self.app = nil
            self.config = nil
            return
        }

        _ = CommandLine.argc
        let argv = CommandLine.unsafeArgv
        guard symbols.ghosttyInit(UInt(CommandLine.argc), argv) == GHOSTTY_SUCCESS else {
            self.symbols = nil
            self.app = nil
            self.config = nil
            return
        }

        let config = symbols.configNew()
        symbols.configFinalize(config)

        var runtimeConfig = ghostty_runtime_config_s()
        runtimeConfig.userdata = nil
        runtimeConfig.supports_selection_clipboard = false
        runtimeConfig.wakeup_cb = tabminalGhosttyWakeup
        runtimeConfig.action_cb = tabminalGhosttyAction
        runtimeConfig.read_clipboard_cb = tabminalGhosttyReadClipboard
        runtimeConfig.confirm_read_clipboard_cb =
            tabminalGhosttyConfirmReadClipboard
        runtimeConfig.write_clipboard_cb = tabminalGhosttyWriteClipboard
        runtimeConfig.close_surface_cb = tabminalGhosttyCloseSurface

        guard let app = symbols.appNew(&runtimeConfig, config) else {
            symbols.configFree(config)
            self.symbols = nil
            self.app = nil
            self.config = nil
            return
        }

        self.symbols = symbols
        self.app = app
        self.config = config
    }

    deinit {
        symbols?.appFree(app)
        symbols?.configFree(config)
    }

    var isAvailable: Bool {
        symbols != nil && app != nil
    }

    @MainActor
    func makeSurface(for hostView: AnyObject) -> ghostty_surface_t? {
        guard let symbols, let app else {
            return nil
        }

        var config = symbols.surfaceConfigNew()
        config.userdata = Unmanaged.passUnretained(hostView).toOpaque()
        config.wait_after_command = false
        config.context = GHOSTTY_SURFACE_CONTEXT_WINDOW
        config.use_custom_io = true

#if canImport(AppKit) && !targetEnvironment(macCatalyst)
        if let view = hostView as? NSView {
            config.platform_tag = GHOSTTY_PLATFORM_MACOS
            config.platform.macos.nsview = Unmanaged.passUnretained(view).toOpaque()
            config.scale_factor = Double(
                view.window?.backingScaleFactor
                    ?? NSScreen.main?.backingScaleFactor
                    ?? 1
            )
        }
#endif
#if canImport(UIKit)
        if let view = hostView as? UIView {
            config.platform_tag = GHOSTTY_PLATFORM_IOS
            config.platform.ios.uiview = Unmanaged.passUnretained(view).toOpaque()
            config.scale_factor = view.contentScaleFactor
        }
#endif

        return symbols.surfaceNew(app, &config)
    }

    func freeSurface(_ surface: ghostty_surface_t?) {
        guard let symbols else {
            return
        }
        symbols.surfaceFree(surface)
    }

    @MainActor
    func updateSurfaceGeometry(
        _ surface: ghostty_surface_t?,
        width: CGFloat,
        height: CGFloat,
        scale: CGFloat
    ) {
        guard let symbols, width > 0, height > 0 else {
            return
        }

        symbols.surfaceSetContentScale(surface, scale, scale)
        symbols.surfaceSetSize(
            surface,
            UInt32(max(1, Int(width * scale))),
            UInt32(max(1, Int(height * scale)))
        )
    }

    @MainActor
    func setSurfaceFocus(_ surface: ghostty_surface_t?, focused: Bool) {
        guard let symbols else {
            return
        }
        symbols.surfaceSetFocus(surface, focused)
    }

    @MainActor
    func setSurfaceOcclusion(_ surface: ghostty_surface_t?, visible: Bool) {
        guard let symbols else {
            return
        }
        symbols.surfaceSetOcclusion(surface, visible)
    }

    @MainActor
    func setWriteCallback(
        _ surface: ghostty_surface_t?,
        owner: GhosttySurfaceWriteHandling?
    ) {
        guard let symbols else {
            return
        }

        let userdata = owner.map {
            Unmanaged.passUnretained($0 as AnyObject).toOpaque()
        }
        symbols.surfaceSetWriteCallback(
            surface,
            owner == nil ? nil : tabminalGhosttyWriteToRemote,
            userdata
        )
    }

    @MainActor
    func feedOutput(_ surface: ghostty_surface_t?, text: String) {
        guard let data = text.data(using: .utf8) else {
            return
        }
        feedOutput(surface, data: data)
    }

    @MainActor
    func feedOutput(_ surface: ghostty_surface_t?, data: Data) {
        guard let symbols, let surface, !data.isEmpty else {
            return
        }

        data.withUnsafeBytes { buffer in
            guard let baseAddress = buffer.baseAddress?
                .assumingMemoryBound(to: UInt8.self) else {
                return
            }
            symbols.surfaceFeedData(surface, baseAddress, buffer.count)
        }
    }

    @MainActor
    func requestRender(_ surface: ghostty_surface_t?) {
        guard let symbols, let surface else {
            return
        }
        scheduleTick()
        symbols.surfaceRefresh(surface)
        symbols.surfaceDraw(surface)
    }

    @MainActor
    func sendInput(_ surface: ghostty_surface_t?, text: String) {
        guard let symbols, let surface, !text.isEmpty else {
            return
        }

        let bytes = text.utf8CString
        bytes.withUnsafeBufferPointer { buffer in
            guard let baseAddress = buffer.baseAddress else {
                return
            }
            let length = max(buffer.count - 1, 0)
            symbols.surfaceText(surface, baseAddress, UInt(length))
        }
    }

    @MainActor
    func surfaceSize(_ surface: ghostty_surface_t?) -> ghostty_surface_size_s? {
        guard let symbols, let surface else {
            return nil
        }
        return symbols.surfaceSize(surface)
    }

    func scheduleTick() {
        guard !tickScheduled else {
            return
        }
        tickScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                return
            }
            self.tickScheduled = false
            self.tick()
        }
    }

    private func tick() {
        guard let symbols, let app else {
            return
        }
        symbols.appTick(app)
    }
}

#if canImport(UIKit)
@MainActor
final class GhosttyUIKitHostView: UIView,
    GhosttyTerminalSurfaceDriver,
    GhosttySurfaceWriteHandling,
    GhosttySurfaceLifecycleHandling {
    private static let renderPassByteBudget = 4 * 1024

    private let runtime = GhosttyEmbeddedAppRuntime.shared
    private var surface: ghostty_surface_t?
    private var surfaceGeneration: UInt64 = 0
    private var isShuttingDown = false
    private var isPaused = true
    private var customIORedrawScheduled = false
    private var surfaceInitializationScheduled = false
    private var hasAppliedSnapshot = false
    private var currentSnapshotText: String = ""
    private var currentOutputText: String = ""
    private var pendingInputTexts: [String] = []
    private var pendingRenderChunks: [Data] = []
    private var renderDispatchScheduled = false
    private var writeFilter = GhosttyWriteFilter()
    private var onGhosttyWrite: ((String) -> Void)?
    private var lastPixelSize: CGSize = .zero
    private var lastContentScale: CGFloat = 0

    override class var layerClass: AnyClass {
        CALayer.self
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentScaleFactor = resolvedDisplayScale
        backgroundColor = UIColor(
            red: 0.05,
            green: 0.06,
            blue: 0.08,
            alpha: 1.0
        )
        clipsToBounds = true
        layer.cornerRadius = 22
        layer.masksToBounds = true
        setupLifecycleObservers()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard !isShuttingDown else {
            return
        }

        if window == nil {
            pauseRendering()
            destroySurface()
            return
        }

        if isSurfaceVisible {
            resumeRendering()
        } else {
            pauseRendering()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard !isShuttingDown else {
            return
        }

        sizeDidChange(bounds.size)
    }

    func updateGhosttyWriteHandler(
        _ onGhosttyWrite: ((String) -> Void)?
    ) {
        self.onGhosttyWrite = onGhosttyWrite
    }

    func replaceGhosttySnapshot(
        _ snapshotText: String,
        outputText: String
    ) {
        currentSnapshotText = snapshotText
        currentOutputText = outputText

        guard !snapshotText.isEmpty || !outputText.isEmpty else {
            pendingRenderChunks.removeAll(keepingCapacity: false)
            hasAppliedSnapshot = false
            return
        }

        _ = initializeSurfaceIfNeeded()
        if surface != nil && hasAppliedSnapshot {
            rebuildSurface()
        }
        hasAppliedSnapshot = true
        replayCurrentState()
    }

    func appendGhosttyOutput(_ text: String) {
        guard !text.isEmpty else {
            return
        }

        currentOutputText.append(text)
        _ = initializeSurfaceIfNeeded()
        guard surface != nil else {
            return
        }

        enqueueRenderTexts([text], replacingPending: false)
    }

    func enqueueGhosttyInput(_ text: String) {
        guard !text.isEmpty else {
            return
        }

        _ = initializeSurfaceIfNeeded()
        guard surface != nil else {
            pendingInputTexts.append(text)
            return
        }

        runtime.sendInput(surface, text: text)
    }

    func handleGhosttyWrite(_ data: Data) {
        let filtered = writeFilter.consume(data)
        guard !filtered.isEmpty else {
            return
        }

        let text = String(decoding: filtered, as: UTF8.self)
        guard !text.isEmpty else {
            return
        }
        onGhosttyWrite?(text)
    }

    func handleGhosttySurfaceClosed(processAlive: Bool) {
        _ = processAlive
        surface = nil
        surfaceGeneration &+= 1
        renderDispatchScheduled = false
        customIORedrawScheduled = false
        lastPixelSize = .zero
        lastContentScale = 0
        writeFilter.reset()

        if !isShuttingDown && isSurfaceVisible {
            scheduleSurfaceInitializationIfNeeded()
        }
    }

    func cleanup() {
        isShuttingDown = true
        onGhosttyWrite = nil
        NotificationCenter.default.removeObserver(self)
        runtime.setSurfaceFocus(surface, focused: false)
        runtime.setSurfaceOcclusion(surface, visible: false)
        runtime.setWriteCallback(surface, owner: nil)
        destroySurface()
    }

    private func configureIOSurfaceLayers() {
        let targetBounds = bounds
        let scale = contentScaleFactor
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.sublayers?.forEach { sublayer in
            sublayer.frame = targetBounds
            sublayer.contentsScale = scale
        }
        CATransaction.commit()
    }

    private func markIOSurfaceLayersForDisplay() {
        layer.setNeedsDisplay()
        layer.sublayers?.forEach { $0.setNeedsDisplay() }
    }

    private func updateContentScaleIfNeeded() {
        let targetScale = resolvedDisplayScale
        if contentScaleFactor != targetScale {
            contentScaleFactor = targetScale
        }
    }

    private var resolvedDisplayScale: CGFloat {
        let windowScale = window?.traitCollection.displayScale ?? 0
        if windowScale > 0 {
            return windowScale
        }

        let traitScale = traitCollection.displayScale
        if traitScale > 0 {
            return traitScale
        }

        return 1
    }

    private func refreshSurface() {
        sizeDidChange(bounds.size)
    }

    private func initializeSurfaceIfNeeded() -> Bool {
        guard surface == nil,
              window != nil,
              bounds.width > 1,
              bounds.height > 1 else {
            return false
        }
        surface = runtime.makeSurface(for: self)
        surfaceGeneration &+= 1
        runtime.setWriteCallback(
            surface,
            owner: onGhosttyWrite == nil ? nil : self
        )
        runtime.setSurfaceFocus(surface, focused: isSurfaceVisible)
        runtime.setSurfaceOcclusion(surface, visible: isSurfaceVisible)
        sizeDidChange(bounds.size)
        return surface != nil
    }

    private func rebuildSurface() {
        destroySurface()
        if initializeSurfaceIfNeeded() {
            replayCurrentState()
            flushPendingInputIfNeeded()
        }
    }

    private func destroySurface() {
        let currentSurface = surface
        surface = nil
        surfaceInitializationScheduled = false
        customIORedrawScheduled = false
        pendingRenderChunks.removeAll(keepingCapacity: false)
        pendingInputTexts.removeAll(keepingCapacity: false)
        renderDispatchScheduled = false
        runtime.setSurfaceOcclusion(currentSurface, visible: false)
        runtime.setWriteCallback(currentSurface, owner: nil)
        runtime.freeSurface(currentSurface)
        surfaceGeneration &+= 1
        lastPixelSize = .zero
        lastContentScale = 0
        writeFilter.reset()
    }

    private func enqueueRenderTexts(
        _ texts: [String],
        replacingPending: Bool
    ) {
        let payloads: [Data] = texts.compactMap { text in
            guard !text.isEmpty else {
                return nil
            }
            return text.data(using: .utf8)
        }
        guard !payloads.isEmpty else {
            return
        }

        if replacingPending {
            pendingRenderChunks = payloads
        } else {
            pendingRenderChunks.append(contentsOf: payloads)
        }
        scheduleRenderDispatch()
    }

    private func scheduleRenderDispatch() {
        guard !renderDispatchScheduled else {
            return
        }
        renderDispatchScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                return
            }
            self.renderDispatchScheduled = false
            self.processPendingRenderPass()
        }
    }

    private func processPendingRenderPass() {
        guard let surface,
              window != nil,
              bounds.width > 1,
              bounds.height > 1 else {
            return
        }

        if var chunk = pendingRenderChunks.first {
            let consume = min(Self.renderPassByteBudget, chunk.count)
            runtime.feedOutput(surface, data: chunk.prefix(consume))

            if consume < chunk.count {
                chunk.removeFirst(consume)
                pendingRenderChunks[0] = chunk
            } else {
                pendingRenderChunks.removeFirst()
            }
        }

        scheduleCustomIORedraw()

        if !pendingRenderChunks.isEmpty {
            scheduleRenderDispatch()
        }
    }

    private func replayCurrentState() {
        guard surface != nil else {
            return
        }
        enqueueRenderTexts(
            currentOutputText.isEmpty
                ? [currentSnapshotText]
                : [currentSnapshotText, currentOutputText],
            replacingPending: true
        )
    }

    private func flushPendingInputIfNeeded() {
        guard let surface,
              !pendingInputTexts.isEmpty else {
            return
        }

        let buffered = pendingInputTexts
        pendingInputTexts.removeAll(keepingCapacity: false)
        for item in buffered {
            runtime.sendInput(surface, text: item)
        }
    }

    private func pauseRendering() {
        isPaused = true
        runtime.setSurfaceFocus(surface, focused: false)
        runtime.setSurfaceOcclusion(surface, visible: false)
    }

    private func resumeRendering() {
        guard !isShuttingDown else {
            return
        }

        isPaused = false
        if initializeSurfaceIfNeeded() {
            replayCurrentState()
            flushPendingInputIfNeeded()
        }
        sizeDidChange(bounds.size)
        runtime.setSurfaceFocus(surface, focused: true)
        runtime.setSurfaceOcclusion(surface, visible: true)
        if !pendingRenderChunks.isEmpty {
            scheduleRenderDispatch()
        }
        requestRender()
    }

    private func requestRender() {
        guard !isShuttingDown,
              !isPaused,
              surface != nil,
              bounds.width > 0,
              bounds.height > 0 else {
            return
        }
        markIOSurfaceLayersForDisplay()
    }

    private func scheduleCustomIORedraw() {
        guard !customIORedrawScheduled else {
            return
        }

        customIORedrawScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                return
            }

            self.customIORedrawScheduled = false
            guard !self.isShuttingDown,
                  !self.isPaused,
                  let surface = self.surface,
                  self.bounds.width > 0,
                  self.bounds.height > 0 else {
                return
            }

            self.updateContentScaleIfNeeded()
            self.configureIOSurfaceLayers()
            self.runtime.requestRender(surface)
            self.markIOSurfaceLayersForDisplay()
        }
    }

    private func sizeDidChange(_ size: CGSize) {
        guard !isShuttingDown else {
            return
        }

        guard let surface = surface ?? {
            initializeSurfaceIfNeeded() ? self.surface : nil
        }(), size.width > 0, size.height > 0 else {
            return
        }

        updateContentScaleIfNeeded()
        configureIOSurfaceLayers()

        let scale = contentScaleFactor
        let pixelWidth = floor(size.width * scale)
        let pixelHeight = floor(size.height * scale)
        guard pixelWidth > 0, pixelHeight > 0 else {
            return
        }

        let pixelSize = CGSize(width: pixelWidth, height: pixelHeight)
        let sizeChanged = pixelSize != lastPixelSize || scale != lastContentScale
        if sizeChanged {
            lastPixelSize = pixelSize
            lastContentScale = scale
            runtime.updateSurfaceGeometry(
                surface,
                width: size.width,
                height: size.height,
                scale: scale
            )
        }

        if !isPaused {
            runtime.requestRender(surface)
            markIOSurfaceLayersForDisplay()
        }
    }

    private var isSurfaceVisible: Bool {
        guard window != nil, !isHidden, alpha > 0.01 else {
            return false
        }

        if UIApplication.shared.applicationState != .active {
            return false
        }

        return true
    }

    private func setupLifecycleObservers() {
        let center = NotificationCenter.default
        center.addObserver(
            self,
            selector: #selector(handleApplicationDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleApplicationWillResignActive),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleApplicationDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleApplicationWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
    }

    @objc private func handleApplicationDidBecomeActive() {
        scheduleSurfaceInitializationIfNeeded()
    }

    @objc private func handleApplicationWillResignActive() {
        pauseRendering()
    }

    @objc private func handleApplicationDidEnterBackground() {
        pauseRendering()
    }

    @objc private func handleApplicationWillEnterForeground() {
        scheduleSurfaceInitializationIfNeeded()
    }

    private func scheduleSurfaceInitialization() {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                return
            }
            self.surfaceInitializationScheduled = false
            guard !self.isShuttingDown else {
                return
            }

            if self.isSurfaceVisible {
                self.resumeRendering()
            } else {
                self.pauseRendering()
            }
        }
    }

    private func scheduleSurfaceInitializationIfNeeded() {
        guard !surfaceInitializationScheduled else {
            return
        }
        surfaceInitializationScheduled = true
        scheduleSurfaceInitialization()
    }
}
#endif

#if canImport(AppKit)
@MainActor
final class GhosttyAppKitHostView: NSView,
    GhosttyTerminalSurfaceDriver,
    GhosttySurfaceWriteHandling {
    private static let renderPassByteBudget = 256 * 1024

    private let runtime = GhosttyEmbeddedAppRuntime.shared
    private var surface: ghostty_surface_t?
    private var surfaceGeneration: UInt64 = 0
    private var hasAppliedSnapshot = false
    private var currentSnapshotText: String = ""
    private var currentOutputText: String = ""
    private var pendingInputTexts: [String] = []
    private var pendingRenderChunks: [Data] = []
    private var renderDispatchScheduled = false
    private var writeFilter = GhosttyWriteFilter()
    private var onGhosttyWrite: ((String) -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer = CAMetalLayer()
        layer?.cornerRadius = 22
        layer?.masksToBounds = true
        layer?.backgroundColor = NSColor(
            red: 0.05,
            green: 0.06,
            blue: 0.08,
            alpha: 1.0
        ).cgColor
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            destroySurface()
            return
        }
        scheduleSurfaceInitialization()
    }

    override func layout() {
        super.layout()
        scheduleSurfaceInitialization()
    }

    func updateGhosttyWriteHandler(
        _ onGhosttyWrite: ((String) -> Void)?
    ) {
        self.onGhosttyWrite = onGhosttyWrite
    }

    func replaceGhosttySnapshot(
        _ snapshotText: String,
        outputText: String
    ) {
        currentSnapshotText = snapshotText
        currentOutputText = outputText

        guard !snapshotText.isEmpty || !outputText.isEmpty else {
            pendingRenderChunks.removeAll(keepingCapacity: false)
            hasAppliedSnapshot = false
            return
        }

        initializeSurfaceIfNeeded()
        if surface != nil && hasAppliedSnapshot {
            rebuildSurface()
        }
        hasAppliedSnapshot = true
        replayCurrentState()
    }

    func appendGhosttyOutput(_ text: String) {
        guard !text.isEmpty else {
            return
        }

        currentOutputText.append(text)
        initializeSurfaceIfNeeded()
        guard surface != nil else {
            return
        }

        enqueueRenderTexts([text], replacingPending: false)
    }

    func enqueueGhosttyInput(_ text: String) {
        guard !text.isEmpty else {
            return
        }

        initializeSurfaceIfNeeded()
        guard surface != nil else {
            pendingInputTexts.append(text)
            return
        }

        runtime.sendInput(surface, text: text)
    }

    func handleGhosttyWrite(_ data: Data) {
        let filtered = writeFilter.consume(data)
        guard !filtered.isEmpty else {
            return
        }

        let text = String(decoding: filtered, as: UTF8.self)
        guard !text.isEmpty else {
            return
        }
        onGhosttyWrite?(text)
    }

    func cleanup() {
        onGhosttyWrite = nil
        runtime.setSurfaceFocus(surface, focused: false)
        runtime.setSurfaceOcclusion(surface, visible: false)
        runtime.setWriteCallback(surface, owner: nil)
        destroySurface()
    }

    private func markSurfaceForDisplay() {
        needsDisplay = true
        layer?.setNeedsDisplay()
    }

    private func refreshSurface() {
        runtime.updateSurfaceGeometry(
            surface,
            width: bounds.width,
            height: bounds.height,
            scale: CGFloat(
                window?.backingScaleFactor
                    ?? NSScreen.main?.backingScaleFactor
                    ?? 1
            )
        )
        markSurfaceForDisplay()
    }

    private func initializeSurfaceIfNeeded() {
        guard surface == nil,
              window != nil,
              bounds.width > 1,
              bounds.height > 1 else {
            return
        }
        surface = runtime.makeSurface(for: self)
        surfaceGeneration &+= 1
        runtime.setWriteCallback(
            surface,
            owner: onGhosttyWrite == nil ? nil : self
        )
        refreshSurface()
        runtime.setSurfaceFocus(surface, focused: true)
        runtime.setSurfaceOcclusion(surface, visible: true)
        replayCurrentState()
        flushPendingInputIfNeeded()
    }

    private func rebuildSurface() {
        destroySurface()
        initializeSurfaceIfNeeded()
    }

    private func destroySurface() {
        pendingRenderChunks.removeAll(keepingCapacity: false)
        pendingInputTexts.removeAll(keepingCapacity: false)
        renderDispatchScheduled = false
        runtime.setSurfaceOcclusion(surface, visible: false)
        runtime.setWriteCallback(surface, owner: nil)
        runtime.freeSurface(surface)
        surface = nil
        surfaceGeneration &+= 1
        writeFilter.reset()
    }

    private func enqueueRenderTexts(
        _ texts: [String],
        replacingPending: Bool
    ) {
        let payloads: [Data] = texts.compactMap { text in
            guard !text.isEmpty else {
                return nil
            }
            return text.data(using: .utf8)
        }
        guard !payloads.isEmpty else {
            return
        }

        if replacingPending {
            pendingRenderChunks = payloads
        } else {
            pendingRenderChunks.append(contentsOf: payloads)
        }
        scheduleRenderDispatch()
    }

    private func scheduleRenderDispatch() {
        guard !renderDispatchScheduled else {
            return
        }
        renderDispatchScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                return
            }
            self.renderDispatchScheduled = false
            self.processPendingRenderPass()
        }
    }

    private func processPendingRenderPass() {
        guard let surface,
              window != nil,
              bounds.width > 1,
              bounds.height > 1 else {
            return
        }

        var remainingBudget = Self.renderPassByteBudget
        while remainingBudget > 0 && !pendingRenderChunks.isEmpty {
            var chunk = pendingRenderChunks.removeFirst()
            let consume = min(remainingBudget, chunk.count)
            runtime.feedOutput(surface, data: chunk.prefix(consume))

            if consume < chunk.count {
                chunk.removeFirst(consume)
                pendingRenderChunks.insert(chunk, at: 0)
            }

            remainingBudget -= consume
        }

        runtime.requestRender(surface)
        markSurfaceForDisplay()

        if !pendingRenderChunks.isEmpty {
            scheduleRenderDispatch()
        }
    }

    private func replayCurrentState() {
        guard surface != nil else {
            return
        }
        enqueueRenderTexts(
            currentOutputText.isEmpty
                ? [currentSnapshotText]
                : [currentSnapshotText, currentOutputText],
            replacingPending: true
        )
    }

    private func flushPendingInputIfNeeded() {
        guard let surface,
              !pendingInputTexts.isEmpty else {
            return
        }

        let buffered = pendingInputTexts
        pendingInputTexts.removeAll(keepingCapacity: false)
        for item in buffered {
            runtime.sendInput(surface, text: item)
        }
    }

    private func scheduleSurfaceInitialization() {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                return
            }
            self.initializeSurfaceIfNeeded()
            self.refreshSurface()
            self.runtime.setWriteCallback(
                self.surface,
                owner: self.onGhosttyWrite == nil ? nil : self
            )
            self.runtime.setSurfaceFocus(
                self.surface,
                focused: self.window != nil
            )
            self.runtime.setSurfaceOcclusion(
                self.surface,
                visible: self.window != nil
            )
            self.replayCurrentState()
            self.flushPendingInputIfNeeded()
            self.markSurfaceForDisplay()
        }
    }
}
#endif
#endif
