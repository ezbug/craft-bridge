public enum FrontmostRoute: Equatable {
    case craft
    case obsidian
    case other

    public static func from(bundleIdentifier: String) -> FrontmostRoute {
        switch bundleIdentifier.lowercased() {
        case "com.lukilabs.lukiapp", "do.craft.docs": return .craft
        case "md.obsidian": return .obsidian
        default: return .other
        }
    }
}
