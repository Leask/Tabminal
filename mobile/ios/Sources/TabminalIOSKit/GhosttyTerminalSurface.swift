import SwiftUI

public struct GhosttyTerminalSurface: View {
    private let host: String
    private let connectionState: String

    public init(host: String, connectionState: String) {
        self.host = host
        self.connectionState = connectionState
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .strokeBorder(.white.opacity(0.14), lineWidth: 1)
                )

            VStack(alignment: .leading, spacing: 10) {
                Label("Ghostty Surface", systemImage: "terminal")
                    .font(.headline)
                Text(host)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text(connectionState)
                    .font(.caption)
                    .foregroundStyle(.tertiary)

#if canImport(libghostty)
                Text("libghostty linked; renderer host view goes here.")
                    .font(.footnote)
#else
                Text("libghostty bridge pending. This surface owns the")
                    .font(.footnote)
                Text("native renderer lifecycle, resize, and input bridge.")
                    .font(.footnote)
#endif
            }
            .padding(20)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.001))
    }
}
