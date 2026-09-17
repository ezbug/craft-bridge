public struct BridgeApplyOutcome: Equatable, Sendable {
    public let message: String
    public let isSuccess: Bool

    public static func from(status: String?, detail: String?) -> Self {
        let detail = detail?.trimmingCharacters(in: .whitespacesAndNewlines)
        let suffix = detail.flatMap { $0.isEmpty ? nil : "：\($0)" } ?? ""

        switch status {
        case "applied":
            return Self(message: "双向链接已验证", isSuccess: true)
        case "awaiting_editor":
            return Self(message: "已写入 Craft Card，等待 Obsidian 插件插入链接", isSuccess: true)
        case "failed", "rolled_back":
            return Self(message: "双向连接失败，已回滚\(suffix)", isSuccess: false)
        case "conflict":
            return Self(message: "双向连接发生冲突，未宣称完成\(suffix)", isSuccess: false)
        case "verification_pending":
            return Self(message: "双向连接待验证，请勿重复执行\(suffix)", isSuccess: false)
        default:
            return Self(message: "Bridge 返回未知状态，未宣称完成\(suffix)", isSuccess: false)
        }
    }
}
