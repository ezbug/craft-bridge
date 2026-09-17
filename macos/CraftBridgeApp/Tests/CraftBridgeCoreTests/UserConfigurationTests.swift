import Foundation
import Darwin
import CryptoKit
import CraftBridgeCore

enum UserConfigurationChecks {
    static func run() throws {
        try configurationURLUsesApplicationSupportDirectory()
        try configurationRoundTripsAndPreservesUserPreferences()
        try unknownSchemaVersionIsRejected()
        try invalidPortIsRejected()
        try validVaultIsAccepted()
        try vaultValidationRequiresAnObsidianVault()
        try vaultWritePermissionIsChecked()
        try craftAPIConnectionMustBeHTTPSOnOfficialHost()
        try keychainFailureIsReportedWithoutSavingConfiguration()
        try portConflictIsDetectedOnLoopback()
        try pluginInstallCopiesOnlyRuntimeFiles()
        try bundledRuntimeInstallsAndSwitchesAtomically()
        print("UserConfigurationTests: PASS")
    }

    private static func configurationURLUsesApplicationSupportDirectory() throws {
        let support = URL(fileURLWithPath: "/tmp/craft-bridge-test", isDirectory: true)
        let url = BridgeUserConfiguration.configurationURL(applicationSupportDirectory: support)
        try expect(url.path == "/tmp/craft-bridge-test/craft-obsidian-bridge/config.json", "configuration URL is portable")
    }

    private static func configurationRoundTripsAndPreservesUserPreferences() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("config.json")
        let config = BridgeUserConfiguration(vaultPath: "/tmp/Demo Vault", vaultName: "Demo Vault", port: 47832, launchAtLogin: true)
        try config.save(to: url)
        try expect(try BridgeUserConfiguration.load(from: url) == config, "configuration round-trips")
        let filePermissions = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber
        try expect(filePermissions?.intValue == 0o600, "configuration file is private to the current user")
        let directoryPermissions = try FileManager.default.attributesOfItem(atPath: url.deletingLastPathComponent().path)[.posixPermissions] as? NSNumber
        try expect(directoryPermissions?.intValue == 0o700, "configuration directory is private to the current user")
        let storedJSON = try String(contentsOf: url, encoding: .utf8)
        try expect(!storedJSON.contains("craftAPI") && !storedJSON.contains("apiConnection"), "Craft credentials are excluded from ordinary configuration")
        let defaultConfig = BridgeUserConfiguration(vaultPath: "/tmp/Demo Vault", vaultName: "Demo Vault")
        try expect(!defaultConfig.launchAtLogin, "login launch is off by default")
    }

    private static func unknownSchemaVersionIsRejected() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let url = root.appendingPathComponent("config.json")
        try Data("{\"schemaVersion\":99,\"vaultPath\":\"/tmp/Vault\",\"vaultName\":\"Vault\",\"port\":47832,\"launchAtLogin\":false}".utf8).write(to: url)
        do {
            _ = try BridgeUserConfiguration.load(from: url)
            throw TestFailure(message: "unknown configuration schema must be rejected")
        } catch BridgeConfigurationError.unsupportedSchemaVersion(99) {
            return
        }
    }

    private static func invalidPortIsRejected() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let url = root.appendingPathComponent("config.json")
        try Data("{\"schemaVersion\":1,\"vaultPath\":\"/tmp/Vault\",\"vaultName\":\"Vault\",\"port\":80,\"launchAtLogin\":false}".utf8).write(to: url)
        do {
            _ = try BridgeUserConfiguration.load(from: url)
            throw TestFailure(message: "privileged ports must be rejected")
        } catch BridgeConfigurationError.invalidPort {
            return
        }
    }

    private static func vaultValidationRequiresAnObsidianVault() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        do {
            try BridgeUserConfiguration.validateVault(at: root)
            throw TestFailure(message: "a regular folder must not be accepted as an Obsidian Vault")
        } catch BridgeConfigurationError.notObsidianVault {
            return
        }
    }

    private static func validVaultIsAccepted() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".obsidian", isDirectory: true), withIntermediateDirectories: true)
        try BridgeUserConfiguration.validateVault(at: root)
    }

    private static func vaultWritePermissionIsChecked() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".obsidian", isDirectory: true), withIntermediateDirectories: true)
        do {
            try BridgeUserConfiguration.validateVault(at: root, isWritable: { $0 != root.path })
            throw TestFailure(message: "a Vault whose root is read-only must be rejected")
        } catch BridgeConfigurationError.vaultNotWritable {
            return
        }
    }

    private static func craftAPIConnectionMustBeHTTPSOnOfficialHost() throws {
        try BridgeUserConfiguration.validateCraftAPIConnection("https://connect.craft.do/link/demo/api/v1")
        do {
            try BridgeUserConfiguration.validateCraftAPIConnection("http://example.com/api")
            throw TestFailure(message: "an arbitrary API URL must be rejected")
        } catch BridgeConfigurationError.invalidCraftAPIConnection {
            return
        }
    }

    private static func keychainFailureIsReportedWithoutSavingConfiguration() throws {
        do {
            try CraftAPIConnectionKeychain.save("https://connect.craft.do/link/demo/api/v1", write: { _ in -25308 })
            throw TestFailure(message: "Keychain failure must be surfaced to onboarding")
        } catch BridgeConfigurationError.keychainFailure(-25308) {
            return
        }
    }

    private static func portConflictIsDetectedOnLoopback() throws {
        let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        try expect(descriptor >= 0, "test socket can be created")
        defer { _ = Darwin.close(descriptor) }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: in_addr_t(INADDR_LOOPBACK).bigEndian)
        let bindResult = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        try expect(bindResult == 0, "test socket can claim an ephemeral loopback port")
        var addressLength = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.getsockname(descriptor, $0, &addressLength)
            }
        }
        try expect(nameResult == 0, "test socket port can be read")
        let port = Int(UInt16(bigEndian: address.sin_port))
        try expect(!BridgePortAvailability.isAvailable(port: port), "an occupied loopback port is rejected")
    }

    private static func pluginInstallCopiesOnlyRuntimeFiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let vault = root.appendingPathComponent("Demo Vault", isDirectory: true)
        let obsidian = vault.appendingPathComponent(".obsidian", isDirectory: true)
        let source = root.appendingPathComponent("plugin-seed", isDirectory: true)
        try FileManager.default.createDirectory(at: obsidian, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: source.appendingPathComponent("manifest.json"))
        try Data("module.exports = {};".utf8).write(to: source.appendingPathComponent("main.js"))
        let existingPluginSettings = obsidian.appendingPathComponent("plugins/craft-obsidian-bridge", isDirectory: true)
        try FileManager.default.createDirectory(at: existingPluginSettings, withIntermediateDirectories: true)
        try Data("{\"token\":\"user-owned\"}".utf8).write(to: existingPluginSettings.appendingPathComponent("data.json"))
        try BridgeUserConfiguration.installPlugin(vaultURL: vault, pluginSourceURL: source)
        let installed = obsidian.appendingPathComponent("plugins/craft-obsidian-bridge", isDirectory: true)
        try expect(FileManager.default.fileExists(atPath: installed.appendingPathComponent("manifest.json").path), "plugin manifest is installed")
        try expect(FileManager.default.fileExists(atPath: installed.appendingPathComponent("main.js").path), "plugin bundle is installed")
        try expect(!FileManager.default.fileExists(atPath: obsidian.appendingPathComponent("community-plugins.json").path), "plugin install does not enable it automatically")
        let preservedData = try String(contentsOf: installed.appendingPathComponent("data.json"), encoding: .utf8)
        try expect(preservedData == "{\"token\":\"user-owned\"}", "plugin upgrade preserves token settings")
    }

    private static func bundledRuntimeInstallsAndSwitchesAtomically() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let appSupport = root.appendingPathComponent("Application Support", isDirectory: true)
        let seed = root.appendingPathComponent("runtime-seed", isDirectory: true)
        try FileManager.default.createDirectory(at: seed.appendingPathComponent("node/bin", isDirectory: true), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: seed.appendingPathComponent("dist/src", isDirectory: true), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: seed.appendingPathComponent("node_modules/better-sqlite3", isDirectory: true), withIntermediateDirectories: true)
        try Data("node".utf8).write(to: seed.appendingPathComponent("node/bin/node"))
        try Data("daemon".utf8).write(to: seed.appendingPathComponent("dist/src/daemon.js"))
        try Data("{\"name\":\"better-sqlite3\"}".utf8).write(to: seed.appendingPathComponent("node_modules/better-sqlite3/package.json"))
        try writeRuntimeManifest(at: seed)
        let runtime = BridgeRuntimeLayout(applicationSupportDirectory: appSupport, environment: [:])
        try runtime.installBundledSeed(from: seed, releaseIdentifier: "v0.1.0")
        let firstTarget = try FileManager.default.destinationOfSymbolicLink(atPath: runtime.currentRuntime.path)
        try expect(firstTarget.hasPrefix("releases/v0.1.0-"), "runtime current points to an immutable version and content fingerprint")
        try expect(FileManager.default.fileExists(atPath: runtime.node.path), "runtime resolves bundled Node")
        try expect(FileManager.default.fileExists(atPath: runtime.daemon.path), "runtime resolves daemon")
        try runtime.installBundledSeed(from: seed, releaseIdentifier: "v0.1.0")
        let idempotentTarget = try FileManager.default.destinationOfSymbolicLink(atPath: runtime.currentRuntime.path)
        try expect(idempotentTarget == firstTarget, "installing the same version is idempotent")

        let invalidSeed = root.appendingPathComponent("invalid-seed", isDirectory: true)
        try FileManager.default.createDirectory(at: invalidSeed, withIntermediateDirectories: true)
        do {
            try runtime.installBundledSeed(from: invalidSeed, releaseIdentifier: "v0.1.2")
            throw TestFailure(message: "an incomplete seed must be rejected")
        } catch BridgeRuntimeError.incompleteSeed {
            let unchangedTarget = try FileManager.default.destinationOfSymbolicLink(atPath: runtime.currentRuntime.path)
            try expect(unchangedTarget == firstTarget, "rejecting an incomplete seed leaves the current runtime untouched")
        }

        try Data("daemon-v2".utf8).write(to: seed.appendingPathComponent("dist/src/daemon.js"))
        try writeRuntimeManifest(at: seed)
        try runtime.installBundledSeed(from: seed, releaseIdentifier: "v0.1.1")
        let secondTarget = try FileManager.default.destinationOfSymbolicLink(atPath: runtime.currentRuntime.path)
        try expect(secondTarget.hasPrefix("releases/v0.1.1-"), "runtime upgrade atomically switches current by version and content fingerprint")
        let currentDaemon = try String(contentsOf: runtime.daemon, encoding: .utf8)
        try expect(currentDaemon == "daemon-v2", "upgraded runtime is active")

        try Data("tampered".utf8).write(to: runtime.daemon)
        do {
            try runtime.installBundledSeed(from: seed, releaseIdentifier: "v0.1.1")
            throw TestFailure(message: "a corrupted immutable runtime must not be reused")
        } catch BridgeRuntimeError.integrityMismatch {
            let unchangedTarget = try FileManager.default.destinationOfSymbolicLink(atPath: runtime.currentRuntime.path)
            try expect(unchangedTarget == secondTarget, "corrupt runtime rejection must not switch current")
        }
    }

    private static func expect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
        if try !value() { throw TestFailure(message: message) }
    }

    private static func writeRuntimeManifest(at root: URL) throws {
        var files: [[String: String]] = []
        let rootPath = root.standardizedFileURL.path
        let rootPrefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey], options: []) else {
            throw TestFailure(message: "runtime fixture can be enumerated")
        }
        for case let url as URL in enumerator {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true, url.lastPathComponent != "runtime-manifest.json" else { continue }
            let childPath = url.standardizedFileURL.path
            guard childPath.hasPrefix(rootPrefix) else { throw TestFailure(message: "runtime file must remain inside fixture") }
            let path = String(childPath.dropFirst(rootPrefix.count))
            let digest = SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
            files.append(["path": path, "sha256": digest])
        }
        files.sort { $0["path", default: ""] < $1["path", default: ""] }
        let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "files": files], options: [.prettyPrinted, .sortedKeys])
        try data.write(to: root.appendingPathComponent("runtime-manifest.json"))
    }
}

private struct TestFailure: Error { let message: String }
