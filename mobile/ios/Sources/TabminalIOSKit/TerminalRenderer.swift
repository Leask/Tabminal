import Foundation

public enum TerminalRenderer: String, Sendable, CaseIterable {
    case text
    case ghostty

    public static var current: TerminalRenderer {
        if let override = rendererOverride {
            return override
        }

        return GhosttyRuntimeLoader.shared.defaultRenderer
    }

    public static var runtimeStatus: GhosttyRuntimeStatus {
        GhosttyRuntimeLoader.shared.status
    }

    private static var rendererOverride: TerminalRenderer? {
        let environment = ProcessInfo.processInfo.environment

        guard let rawValue = environment["TABMINAL_MOBILE_TERMINAL_RENDERER"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
            !rawValue.isEmpty else {
            return nil
        }

        return TerminalRenderer(rawValue: rawValue)
    }
}
