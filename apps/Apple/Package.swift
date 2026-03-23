// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "TabminalMobile",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
        .visionOS(.v2)
    ],
    products: [
        .library(
            name: "TabminalMobileCore",
            targets: ["TabminalMobileCore"]
        ),
        .library(
            name: "TabminalIOSKit",
            targets: ["TabminalIOSKit"]
        )
    ],
    targets: [
        .target(
            name: "TabminalMobileCore"
        ),
        .target(
            name: "TabminalIOSKit",
            dependencies: [
                "CGhosttyShim",
                "TabminalMobileCore"
            ]
        ),
        .target(
            name: "CGhosttyShim",
            publicHeadersPath: "include"
        ),
        .testTarget(
            name: "TabminalMobileCoreTests",
            dependencies: ["TabminalMobileCore"]
        ),
        .testTarget(
            name: "TabminalIOSKitTests",
            dependencies: ["TabminalIOSKit"]
        )
    ]
)
