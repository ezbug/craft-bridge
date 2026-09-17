// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CraftBridgeApp",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "CraftBridgeCore", targets: ["CraftBridgeCore"]),
        .executable(name: "CraftBridgeApp", targets: ["CraftBridgeApp"])
    ],
    targets: [
        .target(name: "CraftBridgeCore"),
        .executableTarget(name: "CraftBridgeApp", dependencies: ["CraftBridgeCore"]),
        .executableTarget(name: "CraftBridgeCoreTests", dependencies: ["CraftBridgeCore"], path: "Tests/CraftBridgeCoreTests")
    ]
)
