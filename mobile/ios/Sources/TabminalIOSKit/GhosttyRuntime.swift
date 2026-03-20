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

    static func evaluate(
        libraryPath: String?,
        loadedSymbols: Set<String>
    ) -> GhosttyRuntimeStatus {
        let requiredSurfaceSymbols = [
            "ghostty_init",
            "ghostty_config_new",
            "ghostty_app_new",
            "ghostty_surface_config_new",
            "ghostty_surface_new",
            "ghostty_surface_draw",
            "ghostty_surface_set_size",
            "ghostty_surface_text"
        ]
        let remoteIOSymbol = String(
            cString: tabminal_ghostty_remote_output_symbol()
        )
        let missing = requiredSurfaceSymbols.filter { !loadedSymbols.contains($0) }

        guard missing.isEmpty else {
            let detail: String
            if libraryPath == nil {
                detail = "GhosttyKit runtime not bundled with the app."
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

        if loadedSymbols.contains(remoteIOSymbol) {
            return GhosttyRuntimeStatus(
                availability: .remoteIOReady,
                libraryPath: libraryPath,
                missingSymbols: [],
                detail: "Ghostty runtime exports embedded surface symbols and a remote-output bridge."
            )
        }

        return GhosttyRuntimeStatus(
            availability: .publicSurfaceAPI,
            libraryPath: libraryPath,
            missingSymbols: [remoteIOSymbol],
            detail: "Ghostty runtime exports embedded iOS surface APIs, but remote PTY output injection is not available."
        )
    }
}

public final class GhosttyRuntimeLoader: @unchecked Sendable {
    public static let shared = GhosttyRuntimeLoader()

    public let status: GhosttyRuntimeStatus

    private let handle: UnsafeMutableRawPointer?

    private init() {
#if canImport(Darwin)
        let loaded = Self.loadRuntime()
        handle = loaded.handle
        status = loaded.status
#else
        handle = nil
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
        if let handle {
            dlclose(handle)
        }
#endif
    }

    public var defaultRenderer: TerminalRenderer {
        status.canProcessRemoteOutput ? .ghostty : .text
    }
}

#if canImport(Darwin)
private extension GhosttyRuntimeLoader {
    static func loadRuntime() -> (
        handle: UnsafeMutableRawPointer?,
        status: GhosttyRuntimeStatus
    ) {
        for candidate in candidateLibraryPaths() {
            guard FileManager.default.fileExists(atPath: candidate) else {
                continue
            }

            guard let handle = dlopen(candidate, RTLD_NOW | RTLD_LOCAL) else {
                continue
            }

            let symbolNames = exportedSymbols(
                in: handle,
                names: [
                    "ghostty_init",
                    "ghostty_config_new",
                    "ghostty_app_new",
                    "ghostty_surface_config_new",
                    "ghostty_surface_new",
                    "ghostty_surface_draw",
                    "ghostty_surface_set_size",
                    "ghostty_surface_text",
                    "ghostty_surface_process_output"
                ]
            )
            let status = GhosttyRuntimeStatus.evaluate(
                libraryPath: candidate,
                loadedSymbols: symbolNames
            )
            return (handle, status)
        }

        let status = GhosttyRuntimeStatus.evaluate(
            libraryPath: nil,
            loadedSymbols: []
        )
        return (nil, status)
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
        } else if url.lastPathComponent == "GhosttyKit.xcframework" {
            candidates.insert(
                url
                    .appendingPathComponent("ios-arm64")
                    .appendingPathComponent("GhosttyKit.framework")
                    .appendingPathComponent("GhosttyKit")
                    .path,
                at: 0
            )
            candidates.insert(
                url
                    .appendingPathComponent("ios-arm64_x86_64-simulator")
                    .appendingPathComponent("GhosttyKit.framework")
                    .appendingPathComponent("GhosttyKit")
                    .path,
                at: 1
            )
        }

        return candidates
    }
}
#endif
