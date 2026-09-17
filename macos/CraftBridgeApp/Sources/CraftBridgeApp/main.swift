import AppKit
import SwiftUI
import Foundation
import CoreGraphics
import Darwin
import ServiceManagement
import CraftBridgeCore

private enum BridgeDiagnostics {
    private static let lock = NSLock()
    private static let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static var logURL: URL { BridgeAppPaths.stateDirectory.appendingPathComponent("CraftBridgeApp.log") }

    static func log(_ message: String) {
        let line = "\(formatter.string(from: Date())) \(message)\n"
        lock.lock()
        defer { lock.unlock() }
        do {
            let directory = logURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            if FileManager.default.fileExists(atPath: logURL.path) {
                let handle = try FileHandle(forWritingTo: logURL)
                try handle.seekToEnd()
                try handle.write(contentsOf: Data(line.utf8))
                try handle.close()
            } else {
                try Data(line.utf8).write(to: logURL, options: .atomic)
            }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: logURL.path)
        } catch {
            NSLog("Craft Bridge diagnostics failed: %@", error.localizedDescription)
        }
    }
}

@main
struct CraftBridgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    var body: some Scene { Settings { EmptyView() } }
}

private enum BridgeAppPaths {
    static let applicationSupport: URL = {
        if let override = ProcessInfo.processInfo.environment["CRAFT_BRIDGE_APPLICATION_SUPPORT"], !override.isEmpty {
            return URL(fileURLWithPath: NSString(string: override).expandingTildeInPath, isDirectory: true)
        }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }()
    static let stateDirectory = applicationSupport.appendingPathComponent("craft-obsidian-bridge", isDirectory: true)
    static let configuration = BridgeUserConfiguration.configurationURL(applicationSupportDirectory: applicationSupport)
    static let token = stateDirectory.appendingPathComponent("bridge.token", isDirectory: false)
}

@MainActor
final class BridgeAppModel: ObservableObject {
    @Published private(set) var configuration: BridgeUserConfiguration?
    @Published private(set) var configurationError = ""
    @Published private(set) var requiresUpgrade = false
    @Published var craftAPIConnection = ""
    @Published var portText = String(BridgeUserConfiguration.defaultPort)
    @Published private(set) var message = ""
    @Published private(set) var rpcStatus = "未检查"
    @Published private(set) var craftStatus = "未检查"
    @Published private(set) var indexedFiles = "未检查"
    @Published private(set) var accessibilityStatus = "未检查"
    @Published private(set) var shortcutStatus = "未检查"
    @Published private(set) var pluginStatus = "尚未安装"
    var onConfigurationChanged: (() -> Void)?
    var onLaunchAtLoginChanged: ((Bool) throws -> Void)?

    init() {
        do {
            configuration = try BridgeUserConfiguration.load(from: BridgeAppPaths.configuration)
            portText = String(configuration?.port ?? BridgeUserConfiguration.defaultPort)
            if let configuration { updatePluginStatus(for: configuration) }
        } catch let error as BridgeConfigurationError {
            if case .unsupportedSchemaVersion = error {
                configurationError = "当前配置文件版本较新，请升级 Craft Bridge 后再继续。"
                requiresUpgrade = true
            }
            else { configurationError = "配置文件无法读取：\(error.localizedDescription)" }
        } catch {
            if FileManager.default.fileExists(atPath: BridgeAppPaths.configuration.path) {
                configurationError = "配置文件无法读取：\(error.localizedDescription)"
            }
        }
    }

    func saveVault(_ url: URL) {
        guard !requiresUpgrade else { message = "配置版本较新，请升级后再修改。"; return }
        do {
            try BridgeUserConfiguration.validateVault(at: url)
            var next = configuration ?? BridgeUserConfiguration(vaultPath: url.path, vaultName: url.lastPathComponent)
            next.vaultPath = url.path
            next.vaultName = url.lastPathComponent
            try next.save(to: BridgeAppPaths.configuration)
            configuration = next
            configurationError = ""
            updatePluginStatus(for: next)
            message = "Vault 已保存。请安装插件并完成连接设置。"
            onConfigurationChanged?()
        } catch {
            message = "Vault 未保存：\(error.localizedDescription)"
        }
    }

    func savePort() {
        guard var next = configuration else { message = "请先选择 Obsidian Vault。"; return }
        guard let port = Int(portText), (1_024...65_535).contains(port) else {
            message = "端口必须是 1024–65535 之间的整数。"
            return
        }
        next.port = port
        do {
            try next.save(to: BridgeAppPaths.configuration)
            configuration = next
            message = "RPC 端口已保存为 \(port)。"
            onConfigurationChanged?()
        } catch {
            message = "端口未保存：\(error.localizedDescription)"
        }
    }

    func saveCraftAPIConnection() {
        do {
            try CraftAPIConnectionKeychain.save(craftAPIConnection)
            craftAPIConnection = ""
            message = "Craft API Connection 已安全保存到 macOS Keychain。"
            onConfigurationChanged?()
        } catch BridgeConfigurationError.invalidCraftAPIConnection {
            message = "请输入 Craft Imagine/API 页面提供的 HTTPS Full Space API Connection。"
        } catch BridgeConfigurationError.keychainFailure(let status) {
            message = "Keychain 保存失败（错误码 \(status)）；没有写入普通配置或日志。"
        } catch {
            message = "无法保存 Craft API Connection：\(error.localizedDescription)"
        }
    }

    func installPlugin() {
        guard let configuration else { message = "请先选择 Obsidian Vault。"; return }
        guard let pluginSource = Bundle.main.resourceURL?.appendingPathComponent("ObsidianPlugin", isDirectory: true) else {
            message = "应用发行包中没有 Obsidian 插件资源。"
            return
        }
        do {
            try BridgeUserConfiguration.installPlugin(vaultURL: URL(fileURLWithPath: configuration.vaultPath), pluginSourceURL: pluginSource)
            pluginStatus = "已安装；请在 Obsidian 设置 → 第三方插件中手动启用"
            message = pluginStatus
        } catch {
            message = "插件安装失败：\(error.localizedDescription)"
        }
    }

    private func updatePluginStatus(for configuration: BridgeUserConfiguration) {
        let plugin = URL(fileURLWithPath: configuration.vaultPath)
            .appendingPathComponent(".obsidian/plugins/craft-obsidian-bridge", isDirectory: true)
        let hasManifest = FileManager.default.fileExists(atPath: plugin.appendingPathComponent("manifest.json").path)
        let hasMain = FileManager.default.fileExists(atPath: plugin.appendingPathComponent("main.js").path)
        pluginStatus = hasManifest && hasMain ? "已安装；请在 Obsidian 中手动启用" : "尚未安装"
    }

    func copyBridgeToken() {
        guard let token = try? String(contentsOf: BridgeAppPaths.token, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
            message = "Bridge 尚未启动，暂时没有连接 Token。请先选择 Vault 并重启 Bridge。"
            return
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(token, forType: .string)
        message = "Token 已复制到剪贴板。插件设置可能随 Vault 同步；请确认同步范围符合你的隐私要求。"
    }

    func refreshDiagnostics() {
        let post = CGPreflightPostEventAccess()
        let listen = CGPreflightListenEventAccess()
        accessibilityStatus = post && listen ? "已授权" : "未授权；仍可从菜单栏手动打开搜索器"
        shortcutStatus = post && listen ? "⌘⌥O 可用" : "等待辅助功能权限"
        guard let configuration else {
            rpcStatus = "未配置 Vault"
            craftStatus = "待配置"
            indexedFiles = "0 篇 Markdown"
            return
        }
        Task {
            do {
                let status = try await BridgeClient(port: configuration.port).get(path: "/status")
                let obsidian = status["obsidian"] as? [String: Any]
                rpcStatus = "RPC 正常（127.0.0.1:\(configuration.port)）"
                if let count = obsidian?["indexedFiles"] { indexedFiles = "\(count) 篇 Markdown" }
                craftStatus = (status["craft"] as? [String: Any])?["configured"] as? Bool == true ? "已配置；尚未验证连接" : "未配置 API Connection"
            } catch {
                rpcStatus = "RPC 未连接：\(error.localizedDescription)"
                craftStatus = "未检查"
            }
        }
    }

    func reportPortConflict(_ port: Int) {
        rpcStatus = "端口 \(port) 已被占用；请更换本机端口后重试"
        message = "Craft Bridge 未启动，因为所选 RPC 端口已被其他进程使用。"
    }

    func verifyCraftConnection() {
        guard let configuration else { message = "请先选择 Obsidian Vault。"; return }
        Task {
            do {
                let result = try await BridgeClient(port: configuration.port).post(path: "/craft/refresh", body: [:])
                if result["configured"] as? Bool == true {
                    let count = result["documents"] ?? "未知"
                    craftStatus = "已连接；已读取 \(count) 篇文档"
                    message = "Craft Full Space API 连接测试通过。"
                } else {
                    craftStatus = "未配置 API Connection"
                    message = "Craft API 尚未配置。"
                }
            } catch {
                craftStatus = "连接失败：\(error.localizedDescription)"
                message = "Craft API 连通性检查失败。请确认 API Connection 有效，并重试。"
            }
        }
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        guard var next = configuration else { message = "请先选择 Obsidian Vault。"; return }
        do {
            try onLaunchAtLoginChanged?(enabled)
            next.launchAtLogin = enabled
            try next.save(to: BridgeAppPaths.configuration)
            configuration = next
            message = enabled ? "已启用登录时启动。" : "已关闭登录时启动。"
        } catch {
            message = "登录启动设置未更改：\(error.localizedDescription)"
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var panel: SearchPanelController!
    private var settings: SettingsWindowController!
    private var eventTap: CFMachPort?
    private var eventTapSource: CFRunLoopSource?
    private var daemonProcess: Process?
    private var terminationSignalSource: DispatchSourceSignal?
    private let model = BridgeAppModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        installTerminationSignalHandler()
        BridgeDiagnostics.log("launch pid=\(ProcessInfo.processInfo.processIdentifier) preflight=\(CGPreflightPostEventAccess())")
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "🔗"
        let menu = NSMenu()
        let open = NSMenuItem(title: "打开 Craft Bridge", action: #selector(showPanel), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)
        let settingsItem = NSMenuItem(title: "设置", action: #selector(showSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)
        menu.addItem(NSMenuItem.separator())
        let quit = NSMenuItem(title: "退出", action: #selector(terminate), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu
        panel = SearchPanelController()
        settings = SettingsWindowController(model: model)
        model.onConfigurationChanged = { [weak self] in self?.restartLocalDaemon() }
        model.onLaunchAtLoginChanged = { enabled in
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
        }
        if model.configuration != nil { startLocalDaemon() }
        else { settings.show() }
        installGlobalShortcut()
    }

    @objc private func showPanel() { panel.show() }
    @objc private func showSettings() { settings.show() }
    @objc private func terminate() { NSApp.terminate(nil) }

    private func installTerminationSignalHandler() {
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { [weak self] in self?.terminate() }
        source.resume()
        terminationSignalSource = source
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopLocalDaemon()
    }

    private func startLocalDaemon() {
        guard let configuration = model.configuration else {
            BridgeDiagnostics.log("daemon skipped: first-run configuration is missing")
            return
        }
        guard BridgePortAvailability.isAvailable(port: configuration.port) else {
            model.reportPortConflict(configuration.port)
            BridgeDiagnostics.log("daemon skipped: local RPC port is unavailable")
            return
        }
        let runtime = BridgeRuntimeLayout(applicationSupportDirectory: BridgeAppPaths.applicationSupport)
        if let seed = Bundle.main.resourceURL?.appendingPathComponent("bridge-runtime-seed", isDirectory: true) {
            do {
                let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
                try runtime.installBundledSeed(from: seed, releaseIdentifier: "v\(version)")
            } catch {
                BridgeDiagnostics.log("bundled runtime install failed error=\(error.localizedDescription)")
                return
            }
        }
        let daemonPath = runtime.daemon.path
        let nodePath = ProcessInfo.processInfo.environment["CRAFT_BRIDGE_NODE"] ?? runtime.node.path
        guard FileManager.default.isExecutableFile(atPath: nodePath), FileManager.default.fileExists(atPath: daemonPath) else {
            BridgeDiagnostics.log("daemon skipped node=\(nodePath) exists=\(FileManager.default.fileExists(atPath: daemonPath)) executable=\(FileManager.default.isExecutableFile(atPath: nodePath))")
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [daemonPath]
        process.currentDirectoryURL = runtime.currentRuntime
        process.environment = ProcessInfo.processInfo.environment.merging([
            "OBSIDIAN_BRIDGE_CONFIG": BridgeAppPaths.configuration.path,
            "OBSIDIAN_BRIDGE_STATE_DIR": BridgeAppPaths.stateDirectory.path,
            "OBSIDIAN_VAULT": configuration.vaultPath,
            "OBSIDIAN_VAULT_NAME": configuration.vaultName,
            "CRAFT_BRIDGE_PORT": String(configuration.port),
        ]) { _, new in new }
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            BridgeDiagnostics.log("daemon started pid=\(process.processIdentifier) runtime=\(runtime.currentRuntime.path)")
        } catch {
            BridgeDiagnostics.log("daemon failed error=\(error.localizedDescription)")
        }
        daemonProcess = process
    }

    private func restartLocalDaemon() {
        stopLocalDaemon()
        startLocalDaemon()
        model.refreshDiagnostics()
    }

    private func stopLocalDaemon() {
        guard let daemonProcess else { return }
        if DaemonProcessLifecycle.shouldTerminate(isRunning: daemonProcess.isRunning) {
            BridgeDiagnostics.log("daemon stopping pid=\(daemonProcess.processIdentifier)")
            daemonProcess.terminate()
            daemonProcess.waitUntilExit()
        }
        self.daemonProcess = nil
    }

    private func installGlobalShortcut() {
        guard eventTap == nil else { return }
        let postAccess = CGPreflightPostEventAccess()
        let listenAccess = CGPreflightListenEventAccess()
        BridgeDiagnostics.log("install shortcut post=\(postAccess) listen=\(listenAccess)")
        if AccessibilityGate.requiresEventTapAccess(post: postAccess, listen: listenAccess) {
            BridgeDiagnostics.log("shortcut unavailable; manual menu search remains available")
            return
        }
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
        let userData = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
        eventTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: craftBridgeEventTapCallback,
            userInfo: userData
        )
        guard let eventTap else {
            NSLog("Craft Bridge: Accessibility event tap could not be created")
            BridgeDiagnostics.log("event tap create failed")
            return
        }
        BridgeDiagnostics.log("event tap created enabled=\(CGEvent.tapIsEnabled(tap: eventTap))")
        eventTapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
        if let eventTapSource { CFRunLoopAddSource(CFRunLoopGetMain(), eventTapSource, .commonModes) }
        CGEvent.tapEnable(tap: eventTap, enable: true)
        BridgeDiagnostics.log("event tap enabled=\(CGEvent.tapIsEnabled(tap: eventTap))")
    }

    func handleGlobalShortcut(craftContext: [String: Any]? = nil) {
        BridgeDiagnostics.log("shortcut handler invoked")
        panel.show(craftContext: craftContext)
    }

}

private func craftBridgeEventTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    _ = proxy
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        return Unmanaged.passUnretained(event)
    }
    guard type == .keyDown else { return Unmanaged.passUnretained(event) }
    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    let flags = event.flags
    guard GlobalShortcut.matches(keyCode: keyCode, flags: flags) else { return Unmanaged.passUnretained(event) }
    BridgeDiagnostics.log("shortcut callback keyCode=\(keyCode) flags=\(flags.rawValue)")
    let delegate = Unmanaged<AppDelegate>.fromOpaque(userInfo).takeUnretainedValue()
    let route = FrontmostRoute.from(bundleIdentifier: NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "")
    let craftContext: [String: Any]?
    if route == .craft {
        do {
            craftContext = try CraftContextProvider.capture()
            BridgeDiagnostics.log("craft context captured in shortcut callback")
        } catch {
            craftContext = nil
            BridgeDiagnostics.log("craft context capture failed in shortcut callback: \(error.localizedDescription)")
        }
    } else {
        craftContext = nil
    }
    DispatchQueue.main.async { delegate.handleGlobalShortcut(craftContext: craftContext) }
    return nil
}

final class SearchPanelController: NSWindowController {
    private let controller = BridgeController()
    private var localMonitor: Any?

    init() {
        let view = SearchPanelView(controller: controller)
        let hosting = NSHostingView(rootView: view)
        let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 720, height: 560), styleMask: [.titled, .fullSizeContentView, .closable], backing: .buffered, defer: false)
        window.title = "Craft Bridge"
        window.isFloatingPanel = true
        window.level = .floating
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.contentView = hosting
        super.init(window: window)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func show(craftContext: [String: Any]? = nil) {
        // Capture Craft while it still owns focus. Activating this panel first would
        // clear the user's paragraph selection before the transaction preview reads it.
        let context = craftContext ?? (FrontmostApp.current == .craft ? captureCraftContext() : nil)
        controller.resetForFrontmostApp(craftContext: context)
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if localMonitor == nil {
            localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self else { return event }
                if event.keyCode == 36 && event.modifierFlags.contains(.command) { self.controller.openSelected(); return nil }
                return event
            }
        }
    }

    private func captureCraftContext() -> [String: Any]? {
        do {
            let value = try CraftContextProvider.capture()
            BridgeDiagnostics.log("craft context captured before panel activation")
            return value
        } catch {
            BridgeDiagnostics.log("craft context capture failed: \(error.localizedDescription)")
            return nil
        }
    }

    override func close() {
        if let localMonitor { NSEvent.removeMonitor(localMonitor); self.localMonitor = nil }
        super.close()
    }
}

final class SettingsWindowController: NSWindowController {
    init(model: BridgeAppModel) {
        let hosting = NSHostingView(rootView: SettingsView(model: model))
        let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 720), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Craft Bridge 设置"
        window.isFloatingPanel = true
        window.contentView = hosting
        super.init(window: window)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func show() { window?.center(); window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
}

struct SettingsView: View {
    @ObservedObject var model: BridgeAppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("欢迎使用 Craft Bridge").font(.title2.bold())
                    Text("完成以下设置后，即可在 Craft 与 Obsidian 之间搜索和安全建立双向链接。")
                        .foregroundStyle(.secondary)
                }

                if !model.configurationError.isEmpty {
                    Label(model.configurationError, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }

                GroupBox("1 · 选择 Obsidian Vault") {
                    VStack(alignment: .leading, spacing: 9) {
                        HStack {
                            Text(model.configuration?.vaultName ?? "尚未选择")
                                .font(.headline)
                            Spacer()
                            Button("选择 Vault…") { chooseVault() }
                                .disabled(model.requiresUpgrade)
                        }
                        if let path = model.configuration?.vaultPath {
                            Text(path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                        Text("会验证 .obsidian 目录和写入权限；内容只在本机建立索引。")
                            .font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                }

                GroupBox("2 · 连接 Craft") {
                    VStack(alignment: .leading, spacing: 9) {
                        SecureField("从 Craft Imagine/API 页面复制 Full Space API Connection", text: $model.craftAPIConnection)
                        HStack {
                            Button("安全保存并连接") { model.saveCraftAPIConnection() }
                                .disabled(model.craftAPIConnection.isEmpty || model.requiresUpgrade)
                            Button("打开 Craft API 指引") {
                                if let url = URL(string: "https://support.craft.do/en/integrate/api") { NSWorkspace.shared.open(url) }
                            }
                        }
                        Text("连接信息只保存到 macOS Keychain，不进入 config.json、日志或发行包。")
                            .font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                }

                GroupBox("3 · 安装 Obsidian 插件") {
                    VStack(alignment: .leading, spacing: 9) {
                        HStack {
                            Button("安装 / 更新插件") { model.installPlugin() }
                                .disabled(model.configuration == nil || model.requiresUpgrade)
                            Button("复制本机连接 Token") { model.copyBridgeToken() }
                        }
                        Text(model.pluginStatus).font(.caption).foregroundStyle(.secondary)
                        Text("安装不会自动启用插件。请手动启用并粘贴 Token。注意：插件设置可能随 Vault 同步；请确认同步范围符合你的隐私要求。")
                            .font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                }

                GroupBox("4 · 诊断与启动偏好") {
                    VStack(alignment: .leading, spacing: 9) {
                        LabeledContent("本机 RPC", value: model.rpcStatus)
                        LabeledContent("索引", value: model.indexedFiles)
                        LabeledContent("Craft", value: model.craftStatus)
                        LabeledContent("辅助功能", value: model.accessibilityStatus)
                        LabeledContent("全局快捷键", value: model.shortcutStatus)
                        HStack {
                            Button("刷新诊断") { model.refreshDiagnostics() }
                            Button("测试 Craft 连接") { model.verifyCraftConnection() }
                            Button("打开辅助功能设置") { openAccessibilitySettings() }
                        }
                        HStack {
                            Text("本机端口")
                            TextField("47832", text: $model.portText).frame(width: 100)
                            Button("保存端口") { model.savePort() }
                        }
                        Text("如更改默认端口，请在 Obsidian 插件设置中填写相同端口。")
                            .font(.caption).foregroundStyle(.secondary)
                        Toggle("登录时自动启动 Craft Bridge", isOn: Binding(
                            get: { model.configuration?.launchAtLogin ?? false },
                            set: { model.setLaunchAtLogin($0) }
                        ))
                        .disabled(model.configuration == nil || model.requiresUpgrade)
                        Text("默认关闭。未授予辅助功能权限时，仍可从菜单栏手动打开搜索器。")
                            .font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                }

                if !model.message.isEmpty {
                    Text(model.message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            .padding(20)
        }
        .frame(minWidth: 600, minHeight: 660)
        .task { model.refreshDiagnostics() }
    }

    private func chooseVault() {
        let panel = NSOpenPanel()
        panel.title = "选择 Obsidian Vault"
        panel.message = "选择一个包含 .obsidian 目录且可写入的 Vault。"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url { model.saveVault(url) }
    }

    private func openAccessibilitySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }
}

@MainActor
final class BridgeController: ObservableObject {
    @Published var query = ""
    @Published var results: [BridgeResult] = []
    @Published var selected: BridgeResult?
    @Published var previewPresentation: BridgePreviewPresentation?
    @Published var phase: Phase = .search
    @Published var sourceApp = FrontmostApp.current
    @Published var message = ""

    private let client = BridgeClient()
    private var lastSearchedQuery = ""
    private var pendingPreviewId: String?

    enum Phase { case search, preview, applied }

    private var capturedCraftContext: [String: Any]?
    private var activeVaultName: String {
        (try? BridgeUserConfiguration.load(from: BridgeAppPaths.configuration).vaultName) ?? "Obsidian"
    }

    func resetForFrontmostApp(craftContext: [String: Any]? = nil) {
        query = ""
        results = []
        selected = nil
        previewPresentation = nil
        pendingPreviewId = nil
        phase = .search
        sourceApp = FrontmostApp.current
        capturedCraftContext = craftContext
        message = sourceApp == .craft ? "搜索 Obsidian" : "搜索 Craft"
    }

    func search() {
        let scope = sourceApp == .craft ? "obsidian" : "craft"
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedQuery.isEmpty else {
            results = []
            selected = nil
            previewPresentation = nil
            pendingPreviewId = nil
            phase = .search
            message = "请输入搜索词"
            return
        }
        lastSearchedQuery = normalizedQuery
        phase = .search
        previewPresentation = nil
        pendingPreviewId = nil
        Task {
            do {
                let next = try await client.search(scope: scope, query: normalizedQuery)
                results = next
                selected = next.first
                message = "找到 \(next.count) 条结果"
            } catch { message = error.localizedDescription }
        }
    }

    func submitQueryOrAction() {
        let intent = BridgeSubmitIntent.decide(
            query: query,
            lastSearchedQuery: lastSearchedQuery,
            hasResults: !results.isEmpty
        )
        if intent == .search {
            search()
        } else {
            handleEnter()
        }
    }

    func select(_ result: BridgeResult) {
        selected = result
        previewPresentation = nil
        pendingPreviewId = nil
        phase = .search
        message = "已选择：\(result.title)，按 Enter 预览"
    }

    func handleEnter() {
        if phase == .search { previewSelected() } else if phase == .preview { applySelected() }
    }

    func openSelected() {
        guard let url = URL(string: selected?.url ?? selected?.uri ?? "") else { return }
        NSWorkspace.shared.open(url)
        windowCloseHint()
    }

    private func previewSelected() {
        guard let target = selected else { message = "先选择一个结果"; return }
        Task {
            do {
                let value: [String: Any]
                if sourceApp == .craft {
                    let context = try capturedCraftContext ?? CraftContextProvider.capture()
                    value = ["context": context, "targetNotePath": target.path ?? "", "targetNoteTitle": target.title, "targetSummary": target.snippet ?? "", "targetVaultName": activeVaultName]
                    let response = try await client.post(path: "/transaction/preview/craft-to-obsidian", body: value)
                    let source = response["source"] as? [String: Any] ?? [:]
                    let destination = response["target"] as? [String: Any] ?? [:]
                    let presentation = BridgePreviewPresentation.craftToObsidian(
                        targetTitle: target.title,
                        targetPath: target.path ?? target.title,
                        bridgeId: response["bridgeId"] as? String ?? "",
                        craftCardMarkdown: source["cardMarkdown"] as? String,
                        obsidianLinkMarkdown: destination["obsidianLink"] as? String
                    )
                    try showPreview(response, presentation: presentation)
                } else {
                    let context = try await client.get(path: "/editor/context")
                    value = ["sourceNotePath": context["path"] as? String ?? "", "sourceNoteTitle": context["title"] as? String ?? "", "sourceSummary": context["lineText"] as? String ?? "", "sourceVaultName": activeVaultName, "targetDocumentId": target.id, "targetDocumentTitle": target.title, "targetDocumentUrl": target.url ?? "", "selectedText": context["selection"] as? String ?? ""]
                    let response = try await client.post(path: "/transaction/preview/obsidian-to-craft", body: value)
                    let source = response["source"] as? [String: Any] ?? [:]
                    let destination = response["target"] as? [String: Any] ?? [:]
                    let link = source["link"] as? [String: Any] ?? [:]
                    let presentation = BridgePreviewPresentation.obsidianToCraft(
                        targetTitle: target.title,
                        bridgeId: response["bridgeId"] as? String ?? "",
                        craftCardMarkdown: destination["cardMarkdown"] as? String,
                        obsidianLinkMarkdown: markdownLink(label: link["label"] as? String, url: link["url"] as? String)
                    )
                    try showPreview(response, presentation: presentation)
                }
                phase = .preview
                message = "再次按 Enter 执行；⌘Enter 只打开目标"
            } catch { message = error.localizedDescription }
        }
    }

    private func applySelected() {
        guard let target = selected else { return }
        _ = target
        Task {
            do {
                guard let id = pendingPreviewId, !id.isEmpty else { throw BridgeError.invalidResponse }
                let path = sourceApp == .craft ? "/transaction/apply/craft-to-obsidian" : "/transaction/apply/obsidian-to-craft-card"
                let result = try await client.post(path: path, body: ["previewId": id])
                phase = .applied
                pendingPreviewId = nil
                let outcome = BridgeApplyOutcome.from(status: result["status"] as? String, detail: result["message"] as? String)
                message = outcome.message
                previewPresentation = previewPresentation?.applied(message: message)
            } catch { message = error.localizedDescription }
        }
    }

    private func showPreview(_ response: [String: Any], presentation: BridgePreviewPresentation) throws {
        guard let id = (response["id"] as? String) ?? (response["previewId"] as? String), !id.isEmpty else { throw BridgeError.invalidResponse }
        pendingPreviewId = id
        previewPresentation = presentation
    }
    private func markdownLink(label: String?, url: String?) -> String? {
        guard let label, let url else { return nil }
        let cleanLabel = label.replacingOccurrences(of: "[\\r\\n\\[\\]]", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanURL = url.replacingOccurrences(of: "[\\r\\n)]", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanURL.isEmpty else { return nil }
        let safeLabel = String(cleanLabel.prefix(300))
        return "[\(safeLabel.isEmpty ? "Craft 文档" : safeLabel)](\(cleanURL))"
    }
    private func windowCloseHint() { NSApp.keyWindow?.orderOut(nil) }
}

struct SearchPanelView: View {
    @ObservedObject var controller: BridgeController
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(GlobalShortcut.displayLabel).font(.caption.monospaced()).foregroundStyle(.secondary)
                TextField(controller.message, text: $controller.query).textFieldStyle(.roundedBorder).onSubmit { controller.submitQueryOrAction() }
                Button("搜索") { controller.search() }
            }.padding(14)
            Divider()
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(controller.sourceApp == .craft ? "Obsidian" : "Craft").font(.headline)
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(controller.results) { result in
                                Button { controller.select(result) } label: {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(result.title).lineLimit(1)
                                        Text(result.snippet ?? result.path ?? result.url ?? "")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 7)
                                }
                                .buttonStyle(.plain)
                                .contentShape(Rectangle())
                                .background(
                                    RoundedRectangle(cornerRadius: 6)
                                        .fill(controller.selected?.id == result.id ? Color.accentColor.opacity(0.22) : Color.clear)
                                )
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }.frame(width: 340)
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("预览").font(.headline)
                        if let preview = controller.previewPresentation {
                            Text(preview.headline).font(.title3.weight(.semibold))
                            Text(preview.executionHint).font(.caption).foregroundStyle(.secondary)
                            PreviewEndpointRow(number: "1", app: preview.firstApp, action: preview.firstAction)
                            PreviewEndpointRow(number: "2", app: preview.secondApp, action: preview.secondAction)
                            if let markdown = preview.craftCardMarkdown {
                                GroupBox("Craft Regular Card 内容") {
                                    Text(markdown).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                                }
                            }
                            if let markdown = preview.obsidianLinkMarkdown {
                                GroupBox("Obsidian 中新增的链接") {
                                    Text(markdown).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                                }
                            }
                            if controller.phase == .preview {
                                Button(preview.actionTitle) { controller.handleEnter() }
                                    .buttonStyle(.borderedProminent)
                            }
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Bridge ID").font(.caption2).foregroundStyle(.tertiary)
                                Text(preview.bridgeId).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                            }
                        } else {
                            Text("选择结果后按 Enter 预览").foregroundStyle(.secondary)
                            Spacer()
                        }
                        Text(controller.message).font(.caption).foregroundStyle(.secondary)
                    }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }.frame(width: 720, height: 560)
    }
}

private struct PreviewEndpointRow: View {
    let number: String
    let app: String
    let action: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(number)
                .font(.caption.bold())
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.accentColor))
            VStack(alignment: .leading, spacing: 3) {
                Text(app).font(.subheadline.weight(.semibold))
                Text(action).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct BridgeResult: Codable, Identifiable {
    let resultId: String?
    let title: String
    let url: String?
    let uri: String?
    let path: String?
    let snippet: String?
    var identity: String { resultId ?? path ?? url ?? title }
    var id: String { identity }
    enum CodingKeys: String, CodingKey { case resultId = "id", title, url, uri, path, snippet }
}

enum FrontmostApp { case craft, obsidian, other
    static var current: FrontmostApp {
        switch FrontmostRoute.from(bundleIdentifier: NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "") {
        case .craft: return .craft
        case .obsidian: return .obsidian
        case .other: return .other
        }
    }
}

final class BridgeClient {
    private let base: URL
    private let token: String
    init(port: Int? = nil) {
        let configuration = try? BridgeUserConfiguration.load(from: BridgeAppPaths.configuration)
        let effectivePort = port ?? configuration?.port ?? BridgeUserConfiguration.defaultPort
        base = URL(string: "http://127.0.0.1:\(effectivePort)")!
        token = (try? String(contentsOf: BridgeAppPaths.token, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)) ?? ""
    }
    func search(scope: String, query: String) async throws -> [BridgeResult] { let payload = try await post(path: "/search/\(scope)", body: ["query": query, "limit": 8]); guard let data = try? JSONSerialization.data(withJSONObject: payload), let response = try? JSONDecoder().decode(SearchResponse.self, from: data) else { throw BridgeError.invalidResponse }; return response.results }
    func get(path: String) async throws -> [String: Any] { try await request(path: path, method: "GET", body: nil) }
    func post(path: String, body: [String: Any]) async throws -> [String: Any] { try await request(path: path, method: "POST", body: body) }
    private func request(path: String, method: String, body: [String: Any]?) async throws -> [String: Any] { var request = URLRequest(url: base.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))); request.httpMethod = method; request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization"); if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }; let (data, response) = try await URLSession.shared.data(for: request); guard let http = response as? HTTPURLResponse else { throw BridgeError.http(status: 0, detail: "无 HTTP 响应") }; guard (200..<300).contains(http.statusCode) else { let detail = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? String ?? String(data: data, encoding: .utf8) ?? ""; throw BridgeError.http(status: http.statusCode, detail: String(detail.prefix(200))) }; guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw BridgeError.invalidResponse }; if let error = value["error"] as? String { throw BridgeError.message(error) }; return value }
}

struct SearchResponse: Codable { let results: [BridgeResult] }
enum BridgeError: LocalizedError { case http(status: Int, detail: String), invalidResponse, message(String); var errorDescription: String? { switch self { case .http(let status, let detail): return detail.isEmpty ? "Bridge RPC 请求失败（HTTP \(status)）" : "Bridge RPC 请求失败（HTTP \(status)：\(detail)）"; case .invalidResponse: return "Bridge RPC 响应无效"; case .message(let value): return value } } }

enum CraftContextProvider {
    static func capture() throws -> [String: Any] {
        guard let app = NSWorkspace.shared.frontmostApplication else { throw BridgeError.message("无法识别 Craft 前台应用") }
        let pasteboard = NSPasteboard.general
        let snapshot = pasteboard.pasteboardItems?.flatMap { item in item.types.compactMap { type in item.data(forType: type).map { (type, $0) } } } ?? []
        sendCopyDeepLink(to: app.processIdentifier)
        Thread.sleep(forTimeInterval: 0.25)
        let link = pasteboard.string(forType: .string) ?? ""
        restore(snapshot, to: pasteboard)
        guard let url = URL(string: link), let blockId = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { ["blockId", "id"].contains($0.name) })?.value, !blockId.isEmpty else { throw BridgeError.message("无法从 Craft 获取当前文档/段落深链；请把光标放在正文块中重试") }
        let selected = selectedText(app.processIdentifier)
        let selection = selected?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let title = selection.isEmpty ? "Craft 文档" : selection
        return ["app": "Craft", "documentId": blockId, "focusedBlockId": blockId, "documentUrl": link, "documentTitle": title, "selection": selection, "contextHash": "accessibility"]
    }

    private static func sendCopyDeepLink(to pid: pid_t) { let source = CGEventSource(stateID: .hidSystemState); let key = CGEvent(keyboardEventSource: source, virtualKey: 37, keyDown: true); key?.flags = [.maskCommand, .maskAlternate]; key?.postToPid(pid); CGEvent(keyboardEventSource: source, virtualKey: 37, keyDown: false)?.postToPid(pid) }
    private static func selectedText(_ pid: pid_t) -> String? { let app = AXUIElementCreateApplication(pid); var focused: CFTypeRef?; guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focused) == .success, let focused else { return nil }; var value: CFTypeRef?; guard AXUIElementCopyAttributeValue(focused as! AXUIElement, kAXSelectedTextAttribute as CFString, &value) == .success else { return nil }; return value as? String }
    private static func restore(_ snapshot: [(NSPasteboard.PasteboardType, Data)], to pasteboard: NSPasteboard) { pasteboard.clearContents(); for (type, data) in snapshot { pasteboard.setData(data, forType: type) } }
}
