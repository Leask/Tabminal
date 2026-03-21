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
private typealias GhosttySurfaceSizeFn = @convention(c) (
    ghostty_surface_t?
) -> ghostty_surface_size_s
private typealias GhosttySurfaceProcessOutputFn = @convention(c) (
    ghostty_surface_t?,
    UnsafePointer<CChar>?,
    UInt
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
    let surfaceDraw: GhosttySurfaceDrawFn
    let surfaceSetSize: GhosttySurfaceSetSizeFn
    let surfaceSetContentScale: GhosttySurfaceSetContentScaleFn
    let surfaceSetFocus: GhosttySurfaceSetFocusFn
    let surfaceSize: GhosttySurfaceSizeFn
    let surfaceProcessOutput: GhosttySurfaceProcessOutputFn

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
        let surfaceSize = loader.resolveSymbol(
            named: "ghostty_surface_size",
            as: GhosttySurfaceSizeFn.self
        ),
        let surfaceProcessOutput = loader.resolveSymbol(
            named: "ghostty_surface_process_output",
            as: GhosttySurfaceProcessOutputFn.self
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
        self.surfaceDraw = surfaceDraw
        self.surfaceSetSize = surfaceSetSize
        self.surfaceSetContentScale = surfaceSetContentScale
        self.surfaceSetFocus = surfaceSetFocus
        self.surfaceSize = surfaceSize
        self.surfaceProcessOutput = surfaceProcessOutput
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
) -> Bool {
    _ = surface
    _ = clipboard
    _ = request
    return false
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
        runtimeConfig.confirm_read_clipboard_cb = tabminalGhosttyConfirmReadClipboard
        runtimeConfig.write_clipboard_cb = tabminalGhosttyWriteClipboard
        runtimeConfig.close_surface_cb = nil

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
        config.font_size = 0
        config.wait_after_command = false
        config.manual_io = true
        config.context = GHOSTTY_SURFACE_CONTEXT_WINDOW

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
    func feedOutput(_ surface: ghostty_surface_t?, text: String) {
        guard let symbols, let surface, !text.isEmpty else {
            return
        }

        let data = Array(text.utf8)
        data.withUnsafeBufferPointer { buffer in
            guard let baseAddress = buffer.baseAddress else {
                return
            }
            let raw = UnsafeRawPointer(baseAddress)
                .assumingMemoryBound(to: CChar.self)
            symbols.surfaceProcessOutput(surface, raw, UInt(buffer.count))
        }
        symbols.surfaceDraw(surface)
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

@MainActor
protocol GhosttySurfaceHosting: AnyObject {
    func applyRenderFeed(_ feed: TerminalRenderFeed)
}

#if canImport(UIKit)
@MainActor
final class GhosttyUIKitHostView: UIView, GhosttySurfaceHosting {
    private let runtime = GhosttyEmbeddedAppRuntime.shared
    private var surface: ghostty_surface_t?
    private var lastSnapshotSequence: UInt64 = .max
    private var lastOutputSequence: UInt64 = .max
    private var pendingFeed = TerminalRenderFeed()

    override class var layerClass: AnyClass {
        CAMetalLayer.self
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(
            red: 0.05,
            green: 0.06,
            blue: 0.08,
            alpha: 1.0
        )
        clipsToBounds = true
        layer.cornerRadius = 22
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            runtime.freeSurface(surface)
            surface = nil
            return
        }
        scheduleSurfaceInitialization()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        scheduleSurfaceInitialization()
    }

    func applyRenderFeed(_ feed: TerminalRenderFeed) {
        pendingFeed = feed
        initializeSurfaceIfNeeded()
        guard surface != nil else {
            return
        }

        if feed.snapshotSequence != lastSnapshotSequence {
            rebuildSurface()
            runtime.feedOutput(surface, text: feed.snapshotText)
            lastSnapshotSequence = feed.snapshotSequence
            lastOutputSequence = feed.outputSequence
            if !feed.outputText.isEmpty {
                runtime.feedOutput(surface, text: feed.outputText)
            }
            return
        }

        if feed.outputSequence != lastOutputSequence {
            runtime.feedOutput(surface, text: feed.outputText)
            lastOutputSequence = feed.outputSequence
        }
    }

    private func initializeSurfaceIfNeeded() {
        guard surface == nil,
              window != nil,
              bounds.width > 1,
              bounds.height > 1 else {
            return
        }
        surface = runtime.makeSurface(for: self)
        syncGeometry()
        runtime.setSurfaceFocus(surface, focused: true)
    }

    private func rebuildSurface() {
        runtime.freeSurface(surface)
        surface = nil
        initializeSurfaceIfNeeded()
    }

    private func syncGeometry() {
        runtime.updateSurfaceGeometry(
            surface,
            width: bounds.width,
            height: bounds.height,
            scale: contentScaleFactor
        )
    }

    private func scheduleSurfaceInitialization() {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                return
            }
            self.initializeSurfaceIfNeeded()
            self.syncGeometry()
            self.runtime.setSurfaceFocus(self.surface, focused: self.window != nil)
            if self.surface != nil,
               !self.pendingFeed.isEmpty {
                self.applyRenderFeed(self.pendingFeed)
            }
        }
    }
}
#endif

#if canImport(AppKit)
@MainActor
final class GhosttyAppKitHostView: NSView, GhosttySurfaceHosting {
    private let runtime = GhosttyEmbeddedAppRuntime.shared
    private var surface: ghostty_surface_t?
    private var lastSnapshotSequence: UInt64 = .max
    private var lastOutputSequence: UInt64 = .max
    private var pendingFeed = TerminalRenderFeed()

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
            runtime.freeSurface(surface)
            surface = nil
            return
        }
        scheduleSurfaceInitialization()
    }

    override func layout() {
        super.layout()
        scheduleSurfaceInitialization()
    }

    func applyRenderFeed(_ feed: TerminalRenderFeed) {
        pendingFeed = feed
        initializeSurfaceIfNeeded()
        guard surface != nil else {
            return
        }

        if feed.snapshotSequence != lastSnapshotSequence {
            rebuildSurface()
            runtime.feedOutput(surface, text: feed.snapshotText)
            lastSnapshotSequence = feed.snapshotSequence
            lastOutputSequence = feed.outputSequence
            if !feed.outputText.isEmpty {
                runtime.feedOutput(surface, text: feed.outputText)
            }
            return
        }

        if feed.outputSequence != lastOutputSequence {
            runtime.feedOutput(surface, text: feed.outputText)
            lastOutputSequence = feed.outputSequence
        }
    }

    private func initializeSurfaceIfNeeded() {
        guard surface == nil,
              window != nil,
              bounds.width > 1,
              bounds.height > 1 else {
            return
        }
        surface = runtime.makeSurface(for: self)
        syncGeometry()
        runtime.setSurfaceFocus(surface, focused: true)
    }

    private func rebuildSurface() {
        runtime.freeSurface(surface)
        surface = nil
        initializeSurfaceIfNeeded()
    }

    private func syncGeometry() {
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
    }

    private func scheduleSurfaceInitialization() {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                return
            }
            self.initializeSurfaceIfNeeded()
            self.syncGeometry()
            self.runtime.setSurfaceFocus(self.surface, focused: self.window != nil)
            if self.surface != nil,
               !self.pendingFeed.isEmpty {
                self.applyRenderFeed(self.pendingFeed)
            }
        }
    }
}
#endif
#endif
