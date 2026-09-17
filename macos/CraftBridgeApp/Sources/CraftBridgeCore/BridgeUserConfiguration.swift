import Foundation
import Security

public enum BridgeConfigurationError: Error, Equatable {
    case unsupportedSchemaVersion(Int)
    case invalidConfiguration
    case invalidPort
    case notObsidianVault
    case vaultNotWritable
    case missingPluginAsset(String)
    case invalidCraftAPIConnection
    case keychainFailure(Int32)
}

public struct BridgeUserConfiguration: Codable, Equatable {
    public static let currentSchemaVersion = 1
    public static let defaultPort = 47_832

    public var schemaVersion: Int
    public var vaultPath: String
    public var vaultName: String
    public var port: Int
    public var launchAtLogin: Bool

    public init(vaultPath: String, vaultName: String, port: Int = defaultPort, launchAtLogin: Bool = false) {
        schemaVersion = Self.currentSchemaVersion
        self.vaultPath = vaultPath
        self.vaultName = vaultName
        self.port = port
        self.launchAtLogin = launchAtLogin
    }

    public static func configurationURL(applicationSupportDirectory: URL) -> URL {
        applicationSupportDirectory
            .appendingPathComponent("craft-obsidian-bridge", isDirectory: true)
            .appendingPathComponent("config.json", isDirectory: false)
    }

    public static func load(from url: URL) throws -> BridgeUserConfiguration {
        let config = try JSONDecoder().decode(BridgeUserConfiguration.self, from: Data(contentsOf: url))
        guard config.schemaVersion == currentSchemaVersion else {
            throw BridgeConfigurationError.unsupportedSchemaVersion(config.schemaVersion)
        }
        guard !config.vaultPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !config.vaultName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw BridgeConfigurationError.invalidConfiguration
        }
        guard (1_024...65_535).contains(config.port) else { throw BridgeConfigurationError.invalidPort }
        return config
    }

    public func save(to url: URL) throws {
        guard schemaVersion == Self.currentSchemaVersion else {
            throw BridgeConfigurationError.unsupportedSchemaVersion(schemaVersion)
        }
        guard !vaultPath.isEmpty, !vaultName.isEmpty else { throw BridgeConfigurationError.invalidConfiguration }
        guard (1_024...65_535).contains(port) else { throw BridgeConfigurationError.invalidPort }
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(self).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    public static func validateVault(at url: URL, isWritable: (String) -> Bool = FileManager.default.isWritableFile(atPath:)) throws {
        var isDirectory = ObjCBool(false)
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue,
              fileManager.fileExists(atPath: url.appendingPathComponent(".obsidian", isDirectory: true).path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw BridgeConfigurationError.notObsidianVault
        }
        guard isWritable(url.path), isWritable(url.appendingPathComponent(".obsidian", isDirectory: true).path) else {
            throw BridgeConfigurationError.vaultNotWritable
        }
    }

    public static func validateCraftAPIConnection(_ value: String) throws {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "https", url.host == "connect.craft.do",
              url.pathComponents.contains(where: { $0 != "/" }) else {
            throw BridgeConfigurationError.invalidCraftAPIConnection
        }
    }

    public static func installPlugin(vaultURL: URL, pluginSourceURL: URL) throws {
        try validateVault(at: vaultURL)
        let fileManager = FileManager.default
        let requiredAssets = ["manifest.json", "main.js"]
        for name in requiredAssets where !fileManager.fileExists(atPath: pluginSourceURL.appendingPathComponent(name).path) {
            throw BridgeConfigurationError.missingPluginAsset(name)
        }

        let destination = vaultURL
            .appendingPathComponent(".obsidian", isDirectory: true)
            .appendingPathComponent("plugins/craft-obsidian-bridge", isDirectory: true)
        try fileManager.createDirectory(at: destination, withIntermediateDirectories: true)
        let assets = requiredAssets + (fileManager.fileExists(atPath: pluginSourceURL.appendingPathComponent("styles.css").path) ? ["styles.css"] : [])
        for name in assets {
            let source = pluginSourceURL.appendingPathComponent(name)
            let target = destination.appendingPathComponent(name)
            if fileManager.fileExists(atPath: target.path) { try fileManager.removeItem(at: target) }
            try fileManager.copyItem(at: source, to: target)
        }
    }
}

public enum CraftAPIConnectionKeychain {
    public static let service = "craft-obsidian-bridge"
    public static let account = "full-space"

    public static func save(_ value: String, write: ((Data) -> Int32)? = nil) throws {
        try BridgeUserConfiguration.validateCraftAPIConnection(value)
        let data = Data(value.trimmingCharacters(in: .whitespacesAndNewlines).utf8)
        let status = write?(data) ?? writeToKeychain(data)
        guard status == errSecSuccess else { throw BridgeConfigurationError.keychainFailure(status) }
    }

    private static func writeToKeychain(_ data: Data) -> Int32 {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard updated == errSecItemNotFound else { return Int32(updated) }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return Int32(SecItemAdd(item as CFDictionary, nil))
    }
}
