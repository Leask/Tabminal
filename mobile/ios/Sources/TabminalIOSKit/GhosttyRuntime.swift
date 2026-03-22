import Foundation
import CGhosttyShim
#if canImport(Darwin)
import Darwin
#endif

public enum GhosttyRuntimeAvailability: String, Sendable {
    case unavailable
    case publicSurfaceAPI
    case remoteIOReady
}

public struct GhosttyRuntimeStatus: Sendable, Equatable {
    public let availability: GhosttyRuntimeAvailability
    public let libraryPath: String?
    public let missingSymbols: [String]
    public let detail: String

    public var canCreateSurface: Bool {
        availability != .unavailable
    }

    public var canProcessRemoteOutput: Bool {
        availability == .remoteIOReady
    }

    static let requiredSurfaceSymbols = [
        "ghostty_init",
        "ghostty_config_new",
        "ghostty_config_finalize",
        "ghostty_config_free",
        "ghostty_app_new",
        "ghostty_app_free",
        "ghostty_app_tick",
        "ghostty_surface_config_new",
        "ghostty_surface_new",
        "ghostty_surface_free",
        "ghostty_surface_refresh",
        "ghostty_surface_draw",
        "ghostty_surface_set_size",
        "ghostty_surface_set_content_scale",
        "ghostty_surface_set_focus",
        "ghostty_surface_set_occlusion",
        "ghostty_surface_size",
        "ghostty_surface_text"
    ]

    static let requiredRemoteIOSymbols = [
        String(cString: tabminal_ghostty_feed_data_symbol()),
        String(cString: tabminal_ghostty_write_callback_symbol())
    ]

    static func evaluate(
        libraryPath: String?,
        loadedSymbols: Set<String>
    ) -> GhosttyRuntimeStatus {
        let missing = requiredSurfaceSymbols.filter { !loadedSymbols.contains($0) }
        let missingRemote = requiredRemoteIOSymbols.filter {
            !loadedSymbols.contains($0)
        }

        guard missing.isEmpty else {
            let detail: String
            if libraryPath == nil {
                detail = "GhosttyKit runtime is not linked into the app."
            } else {
                detail = "Ghostty runtime is present but missing required embedded surface symbols."
            }
            return GhosttyRuntimeStatus(
                availability: .unavailable,
                libraryPath: libraryPath,
                missingSymbols: missing,
                detail: detail
            )
        }

        if missingRemote.isEmpty {
            return GhosttyRuntimeStatus(
                availability: .remoteIOReady,
                libraryPath: libraryPath,
                missingSymbols: [],
                detail: "Ghostty runtime exports embedded surface symbols and the custom-I/O bridge."
            )
        }

        return GhosttyRuntimeStatus(
            availability: .publicSurfaceAPI,
            libraryPath: libraryPath,
            missingSymbols: missingRemote,
            detail: "Ghostty runtime exports embedded surface APIs, but custom-I/O bridging is not available."
        )
    }
}

public final class GhosttyRuntimeLoader: @unchecked Sendable {
    public static let shared = GhosttyRuntimeLoader()

    public let status: GhosttyRuntimeStatus

    private let handle: UnsafeMutableRawPointer?
    private let shouldCloseHandle: Bool

    private init() {
#if canImport(Darwin)
        let loaded = Self.loadRuntime()
        handle = loaded.handle
        shouldCloseHandle = loaded.shouldCloseHandle
        status = loaded.status
#else
        handle = nil
        shouldCloseHandle = false
        status = GhosttyRuntimeStatus(
            availability: .unavailable,
            libraryPath: nil,
            missingSymbols: [],
            detail: "Ghostty runtime loading is only supported on Apple platforms."
        )
#endif
    }

    deinit {
#if canImport(Darwin)
        if shouldCloseHandle, let handle {
            dlclose(handle)
        }
#endif
    }

    public var defaultRenderer: TerminalRenderer {
        if status.canProcessRemoteOutput,
           GhosttyPlatformPolicy.prefersGhosttyByDefault {
            return .ghostty
        }

        return .text
    }

    public var canUseGhosttyOverride: Bool {
        status.canProcessRemoteOutput
            && GhosttyPlatformPolicy.allowsGhosttyOverride
    }

#if canImport(Darwin)
    func resolveSymbol<T>(named name: String, as type: T.Type) -> T? {
        guard let handle else {
            return nil
        }
        guard let symbol = dlsym(handle, name) else {
            return nil
        }
        return unsafeBitCast(symbol, to: type)
    }
#endif
}

private enum GhosttyPlatformPolicy {
    static let prefersGhosttyByDefault = true
    static let allowsGhosttyOverride = true
}

#if canImport(Darwin)
private extension GhosttyRuntimeLoader {
    static func loadRuntime() -> (
        handle: UnsafeMutableRawPointer?,
        shouldCloseHandle: Bool,
        status: GhosttyRuntimeStatus
    ) {
        if let mainHandle = dlopen(nil, RTLD_NOW) {
            let mainPath = Bundle.main.executableURL?.path
            let mainSymbols = exportedSymbols(
                in: mainHandle,
                names: requiredSymbols()
            )
            let mainStatus = GhosttyRuntimeStatus.evaluate(
                libraryPath: mainPath,
                loadedSymbols: mainSymbols
            )
            if mainStatus.canCreateSurface {
                return (mainHandle, false, mainStatus)
            }
        }

        for candidate in candidateLibraryPaths() {
            guard FileManager.default.fileExists(atPath: candidate) else {
                continue
            }

            guard let handle = dlopen(candidate, RTLD_NOW | RTLD_LOCAL) else {
                continue
            }

            let symbolNames = exportedSymbols(
                in: handle,
                names: requiredSymbols()
            )
            let status = GhosttyRuntimeStatus.evaluate(
                libraryPath: candidate,
                loadedSymbols: symbolNames
            )
            return (handle, true, status)
        }

        let status = GhosttyRuntimeStatus.evaluate(
            libraryPath: nil,
            loadedSymbols: []
        )
        return (nil, false, status)
    }

    static func requiredSymbols() -> [String] {
        GhosttyRuntimeStatus.requiredSurfaceSymbols
            + GhosttyRuntimeStatus.requiredRemoteIOSymbols
    }

    static func exportedSymbols(
        in handle: UnsafeMutableRawPointer,
        names: [String]
    ) -> Set<String> {
        var result = Set<String>()
        for name in names {
            if dlsym(handle, name) != nil {
                result.insert(name)
            }
        }
        return result
    }

    static func candidateLibraryPaths() -> [String] {
        var candidates: [String] = []

        if let envPath = ProcessInfo.processInfo.environment[
            "TABMINAL_GHOSTTY_FRAMEWORK_PATH"
        ]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !envPath.isEmpty {
            candidates.append(contentsOf: normalizedCandidates(for: envPath))
        }

        let bundleCandidates = [
            Bundle.main.privateFrameworksURL,
            Bundle.main.bundleURL.appendingPathComponent("Frameworks"),
            Bundle.main.bundleURL
        ].compactMap(\.self)

        for base in bundleCandidates {
            candidates.append(
                base
                    .appendingPathComponent(
                        String(cString: tabminal_ghostty_framework_name())
                    )
                    .appendingPathComponent(
                        String(cString: tabminal_ghostty_executable_name())
                    )
                    .path
            )
            candidates.append(
                base
                    .appendingPathComponent("Ghostty.framework")
                    .appendingPathComponent("Ghostty")
                    .path
            )
            candidates.append(
                base.appendingPathComponent("libghostty.dylib").path
            )
        }

        var deduped: [String] = []
        var seen = Set<String>()
        for candidate in candidates where seen.insert(candidate).inserted {
            deduped.append(candidate)
        }
        return deduped
    }

    static func normalizedCandidates(for rawPath: String) -> [String] {
        let url = URL(fileURLWithPath: rawPath)
        var candidates = [url.path]

        if url.pathExtension == "framework" {
            let name = url.deletingPathExtension().lastPathComponent
            candidates.insert(url.appendingPathComponent(name).path, at: 0)
        }

        return candidates
    }
}
#endif
