// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "TabminalMobile",
    platforms: [
        .iOS(.v18),
        .macOS(.v15)
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
            dependencies: ["TabminalMobileCore"]
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
