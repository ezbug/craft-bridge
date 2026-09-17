public struct BridgePreviewPresentation: Equatable, Sendable {
    public let headline: String
    public let firstApp: String
    public let firstAction: String
    public let secondApp: String
    public let secondAction: String
    public let bridgeId: String
    public let craftCardMarkdown: String?
    public let obsidianLinkMarkdown: String?
    public let executionHint = "以下 1、2 两步会一起执行，无需选择"
    public let actionTitle = "执行双向连接"

    public static func craftToObsidian(targetTitle: String, targetPath: String, bridgeId: String, craftCardMarkdown: String? = nil, obsidianLinkMarkdown: String? = nil) -> Self {
        Self(
            headline: "将建立双向连接",
            firstApp: "Craft",
            firstAction: "在当前段落后插入 Regular Card：\(targetTitle)",
            secondApp: "Obsidian",
            secondAction: "在 \(targetPath) 末尾添加返回 Craft 的链接",
            bridgeId: bridgeId,
            craftCardMarkdown: craftCardMarkdown,
            obsidianLinkMarkdown: obsidianLinkMarkdown
        )
    }

    public static func obsidianToCraft(targetTitle: String, bridgeId: String, craftCardMarkdown: String? = nil, obsidianLinkMarkdown: String? = nil) -> Self {
        Self(
            headline: "将建立双向连接",
            firstApp: "Obsidian",
            firstAction: "在当前光标处插入 Craft 链接：\(targetTitle)",
            secondApp: "Craft",
            secondAction: "在目标文档末尾添加 Regular Card",
            bridgeId: bridgeId,
            craftCardMarkdown: craftCardMarkdown,
            obsidianLinkMarkdown: obsidianLinkMarkdown
        )
    }

    public func applied(message: String) -> Self {
        Self(
            headline: message,
            firstApp: firstApp,
            firstAction: firstAction,
            secondApp: secondApp,
            secondAction: secondAction,
            bridgeId: bridgeId,
            craftCardMarkdown: craftCardMarkdown,
            obsidianLinkMarkdown: obsidianLinkMarkdown
        )
    }
}
