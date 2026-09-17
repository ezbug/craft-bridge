import Foundation
import Darwin
import CryptoKit

public enum BridgeRuntimeError: Error, Equatable {
    case incompleteSeed(String)
    case invalidReleaseIdentifier
    case currentRuntimeIsNotSymbolicLink
    case atomicSwitchFailed(Int32)
    case integrityMismatch(String)
}

private struct RuntimeManifest: Decodable {
    struct File: Decodable {
        let path: String
        let sha256: String
    }
    let schemaVersion: Int
    let files: [File]
}

public struct BridgeRuntimeLayout: Equatable {
    public let runtimeRoot: URL

    public init(
        applicationSupportDirectory: URL,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        if let override = environment["CRAFT_BRIDGE_RUNTIME_ROOT"], !override.isEmpty {
            runtimeRoot = URL(fileURLWithPath: NSString(string: override).expandingTildeInPath, isDirectory: true)
        } else {
            runtimeRoot = applicationSupportDirectory
                .appendingPathComponent("craft-obsidian-bridge", isDirectory: true)
                .appendingPathComponent("runtime", isDirectory: true)
        }
    }

    public var currentRuntime: URL {
        runtimeRoot.appendingPathComponent("current", isDirectory: true)
    }

    public var daemon: URL {
        currentRuntime.appendingPathComponent("dist/src/daemon.js", isDirectory: false)
    }

    public var node: URL {
        currentRuntime.appendingPathComponent("node/bin/node", isDirectory: false)
    }

    public func installBundledSeed(from seedURL: URL, releaseIdentifier: String) throws {
        guard releaseIdentifier.range(of: #"^[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil else {
            throw BridgeRuntimeError.invalidReleaseIdentifier
        }
        let fileManager = FileManager.default
        let requiredPaths = ["node/bin/node", "dist/src/daemon.js", "node_modules/better-sqlite3/package.json", "runtime-manifest.json"]
        for path in requiredPaths where !fileManager.fileExists(atPath: seedURL.appendingPathComponent(path).path) {
            throw BridgeRuntimeError.incompleteSeed(path)
        }
        let fingerprint = try manifestFingerprint(for: seedURL)

        let releases = runtimeRoot.appendingPathComponent("releases", isDirectory: true)
        let fingerprintedIdentifier = "\(releaseIdentifier)-\(fingerprint.prefix(16))"
        let release = releases.appendingPathComponent(fingerprintedIdentifier, isDirectory: true)
        try fileManager.createDirectory(at: releases, withIntermediateDirectories: true)
        if fileManager.fileExists(atPath: release.path) {
            guard try verifiedFingerprint(for: release) == fingerprint else {
                throw BridgeRuntimeError.integrityMismatch("现有运行时与发行包指纹不匹配")
            }
        } else {
            guard try verifiedFingerprint(for: seedURL) == fingerprint else {
                throw BridgeRuntimeError.integrityMismatch("应用内运行时校验失败")
            }
            let staging = releases.appendingPathComponent(".stage-\(UUID().uuidString)", isDirectory: true)
            try fileManager.copyItem(at: seedURL, to: staging)
            do {
                guard try verifiedFingerprint(for: staging) == fingerprint else {
                    throw BridgeRuntimeError.integrityMismatch("暂存运行时校验失败")
                }
                try fileManager.moveItem(at: staging, to: release)
            } catch {
                try? fileManager.removeItem(at: staging)
                throw error
            }
        }

        try fileManager.createDirectory(at: runtimeRoot, withIntermediateDirectories: true)
        let currentPath = currentRuntime.path
        var isDirectory = ObjCBool(false)
        if fileManager.fileExists(atPath: currentPath, isDirectory: &isDirectory),
           (try? fileManager.destinationOfSymbolicLink(atPath: currentPath)) == nil {
            throw BridgeRuntimeError.currentRuntimeIsNotSymbolicLink
        }

        let temporaryLink = runtimeRoot.appendingPathComponent(".current-\(UUID().uuidString)")
        try fileManager.createSymbolicLink(atPath: temporaryLink.path, withDestinationPath: "releases/\(fingerprintedIdentifier)")
        let result = temporaryLink.path.withCString { source in
            currentPath.withCString { destination in Darwin.rename(source, destination) }
        }
        guard result == 0 else {
            let code = errno
            try? fileManager.removeItem(at: temporaryLink)
            throw BridgeRuntimeError.atomicSwitchFailed(code)
        }
    }

    private func manifestFingerprint(for root: URL) throws -> String {
        let manifestData = try Data(contentsOf: root.appendingPathComponent("runtime-manifest.json"))
        let manifest: RuntimeManifest
        do { manifest = try JSONDecoder().decode(RuntimeManifest.self, from: manifestData) }
        catch { throw BridgeRuntimeError.integrityMismatch("运行时清单无法读取") }
        guard manifest.schemaVersion == 1, !manifest.files.isEmpty else {
            throw BridgeRuntimeError.integrityMismatch("运行时清单版本无效")
        }
        return SHA256.hash(data: manifestData).map { String(format: "%02x", $0) }.joined()
    }

    private func verifiedFingerprint(for root: URL) throws -> String {
        let manifestURL = root.appendingPathComponent("runtime-manifest.json")
        let manifestData = try Data(contentsOf: manifestURL)
        let manifest: RuntimeManifest
        do { manifest = try JSONDecoder().decode(RuntimeManifest.self, from: manifestData) }
        catch { throw BridgeRuntimeError.integrityMismatch("运行时清单无法读取") }
        guard manifest.schemaVersion == 1, !manifest.files.isEmpty else {
            throw BridgeRuntimeError.integrityMismatch("运行时清单版本无效")
        }

        var expectedPaths = Set<String>()
        for entry in manifest.files {
            let components = entry.path.split(separator: "/", omittingEmptySubsequences: false)
            guard !entry.path.hasPrefix("/"), !entry.path.unicodeScalars.contains(where: { $0.value == 0 }),
                  !components.isEmpty, !components.contains("."), !components.contains(".."),
                  entry.path != "runtime-manifest.json", expectedPaths.insert(entry.path).inserted else {
                throw BridgeRuntimeError.integrityMismatch("运行时清单包含无效或重复路径")
            }
            let fileURL = root.appendingPathComponent(entry.path)
            let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else {
                throw BridgeRuntimeError.integrityMismatch("运行时文件缺失或不是普通文件：\(entry.path)")
            }
            let digest = SHA256.hash(data: try Data(contentsOf: fileURL)).map { String(format: "%02x", $0) }.joined()
            guard digest == entry.sha256 else {
                throw BridgeRuntimeError.integrityMismatch("运行时文件校验失败：\(entry.path)")
            }
        }

        var actualPaths = Set<String>()
        let rootPath = root.standardizedFileURL.path
        let rootPrefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey],
            options: []
        ) else { throw BridgeRuntimeError.integrityMismatch("无法枚举运行时文件") }
        for case let fileURL as URL in enumerator {
            let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else { continue }
            let childPath = fileURL.standardizedFileURL.path
            guard childPath.hasPrefix(rootPrefix) else {
                throw BridgeRuntimeError.integrityMismatch("运行时清单包含根目录之外的路径")
            }
            let relativePath = String(childPath.dropFirst(rootPrefix.count))
            if relativePath != "runtime-manifest.json" { actualPaths.insert(relativePath) }
        }
        guard actualPaths == expectedPaths else {
            throw BridgeRuntimeError.integrityMismatch("运行时文件清单与实际内容不一致")
        }
        return SHA256.hash(data: manifestData).map { String(format: "%02x", $0) }.joined()
    }
}
