import Foundation
import CraftBridgeCore

@main
struct AccessibilityGateTests {
    static func main() {
        let applicationSupport = FileManager.default.temporaryDirectory
            .appendingPathComponent("Craft Bridge Test", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
        let runtimeLayout = BridgeRuntimeLayout(
            applicationSupportDirectory: applicationSupport,
            environment: [:]
        )
        precondition(
            runtimeLayout.runtimeRoot.path == applicationSupport.appendingPathComponent("craft-obsidian-bridge/runtime").path,
            "the mutable runtime must live outside the signed app bundle"
        )
        precondition(
            runtimeLayout.currentRuntime.path == applicationSupport.appendingPathComponent("craft-obsidian-bridge/runtime/current").path,
            "the shell must follow the atomically switched current runtime"
        )
        precondition(
            runtimeLayout.daemon.path == applicationSupport.appendingPathComponent("craft-obsidian-bridge/runtime/current/dist/src/daemon.js").path,
            "the daemon must be resolved from the external current runtime"
        )

        let overriddenRuntime = BridgeRuntimeLayout(
            applicationSupportDirectory: applicationSupport,
            environment: ["CRAFT_BRIDGE_RUNTIME_ROOT": "/tmp/craft-bridge-test-runtime"]
        )
        precondition(
            overriddenRuntime.runtimeRoot.path == "/tmp/craft-bridge-test-runtime",
            "tests and development must be able to override the runtime root"
        )
        precondition(
            DaemonProcessLifecycle.shouldTerminate(isRunning: true),
            "a running owned daemon must be terminated when the shell exits"
        )
        precondition(
            !DaemonProcessLifecycle.shouldTerminate(isRunning: false),
            "an exited daemon needs no termination signal"
        )

        precondition(AccessibilityGate.shouldRequestAccess(preflight: false), "false preflight must request access")
        precondition(!AccessibilityGate.shouldRequestAccess(preflight: true), "true preflight must not request access")
        precondition(AccessibilityGate.requiresEventTapAccess(post: true, listen: false), "listen access must be required")
        precondition(AccessibilityGate.requiresEventTapAccess(post: false, listen: true), "post access must be required")
        precondition(!AccessibilityGate.requiresEventTapAccess(post: true, listen: true), "both permissions must avoid a request")
        precondition(FrontmostRoute.from(bundleIdentifier: "com.lukilabs.lukiapp") == .craft, "Craft must route to Obsidian search")
        precondition(FrontmostRoute.from(bundleIdentifier: "md.obsidian") == .obsidian, "Obsidian must route to Craft search")
        precondition(FrontmostRoute.from(bundleIdentifier: "com.ezbug.craft-bridge") == .other, "Bridge itself must not become a source app")
        precondition(GlobalShortcut.displayLabel == "⌘⌥O", "shortcut label must match the active shortcut")
        precondition(GlobalShortcut.matches(keyCode: 31, flags: [.maskCommand, .maskAlternate]), "Command-Option-O must match")
        precondition(!GlobalShortcut.matches(keyCode: 31, flags: [.maskCommand, .maskShift]), "old Command-Shift-O must not match")

        let craftPreview = BridgePreviewPresentation.craftToObsidian(
            targetTitle: "ComfyUI Bridge Setup",
            targetPath: ".claude/skills/comfyui-bridge-setup/SKILL.md",
            bridgeId: "ocb-5a3f5caa9233b3b8",
            craftCardMarkdown: "[演示 Vault/.claude/skills/comfyui-bridge-setup/SKILL.md](obsidian://open)\n这是用户确认前看到的 Card 正文",
            obsidianLinkMarkdown: "> - [Demo Craft Page](craftdocs://open?blockId=demo)"
        )
        precondition(craftPreview.headline == "将建立双向连接", "preview must lead with the user-visible outcome")
        precondition(craftPreview.firstApp == "Craft", "Craft must be the first endpoint")
        precondition(craftPreview.firstAction == "在当前段落后插入 Regular Card：ComfyUI Bridge Setup", "Craft action must be readable")
        precondition(craftPreview.secondApp == "Obsidian", "Obsidian must be the second endpoint")
        precondition(craftPreview.secondAction == "在 .claude/skills/comfyui-bridge-setup/SKILL.md 末尾添加返回 Craft 的链接", "Obsidian action must name the target path")
        precondition(craftPreview.executionHint == "以下 1、2 两步会一起执行，无需选择", "preview must explain that endpoints are not choices")
        precondition(craftPreview.actionTitle == "执行双向连接", "preview must expose an explicit clickable action")
        precondition(craftPreview.craftCardMarkdown?.contains("Card 正文") == true, "preview must show the exact Craft Card body")
        precondition(craftPreview.obsidianLinkMarkdown == "> - [Demo Craft Page](craftdocs://open?blockId=demo)", "preview must show the exact Obsidian Callout link line")
        let visiblePreview = [craftPreview.headline, craftPreview.firstApp, craftPreview.firstAction, craftPreview.secondApp, craftPreview.secondAction, craftPreview.bridgeId].joined(separator: "\n")
        precondition(!visiblePreview.contains("previewId"), "internal preview id must not be shown")
        precondition(!visiblePreview.contains("\\U"), "escaped Unicode must not be shown")
        let appliedPreview = craftPreview.applied(message: "双向链接已验证")
        precondition(appliedPreview.craftCardMarkdown == craftPreview.craftCardMarkdown, "applied presentation must preserve the reviewed Craft Card")
        precondition(appliedPreview.obsidianLinkMarkdown == craftPreview.obsidianLinkMarkdown, "applied presentation must preserve the reviewed Obsidian link")

        precondition(
            BridgeSubmitIntent.decide(query: "", lastSearchedQuery: "se", hasResults: true) == .advanceSelection,
            "clicking a result must let Enter preview even when the search field is empty"
        )
        precondition(
            BridgeSubmitIntent.decide(query: "new", lastSearchedQuery: "se", hasResults: true) == .search,
            "a changed non-empty query must start a new search"
        )

        let applied = BridgeApplyOutcome.from(status: "applied", detail: nil)
        precondition(applied.isSuccess, "applied must be treated as success")
        precondition(applied.message == "双向链接已验证", "applied must show verified")

        let failed = BridgeApplyOutcome.from(status: "failed", detail: "Craft Card 写入后无法验证 Bridge ID")
        precondition(!failed.isSuccess, "failed must never be treated as success")
        precondition(failed.message.contains("已回滚"), "failed transaction must explain rollback")
        precondition(failed.message.contains("Craft Card 写入后无法验证 Bridge ID"), "failure detail must remain visible")

        let conflict = BridgeApplyOutcome.from(status: "conflict", detail: "文件已变化")
        precondition(!conflict.isSuccess, "conflict must never be treated as success")
        precondition(conflict.message.contains("冲突"), "conflict must be explicit")

        let pending = BridgeApplyOutcome.from(status: "verification_pending", detail: "网络超时")
        precondition(!pending.isSuccess, "verification_pending must never be treated as success")
        precondition(pending.message.contains("待验证"), "pending status must be explicit")

        do {
            try UserConfigurationChecks.run()
        } catch {
            fatalError("User configuration checks failed: \(error)")
        }

        print("AccessibilityGateTests: PASS")
    }
}
