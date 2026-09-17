import Foundation
import CoreGraphics

public enum AccessibilityGate {
    public static func shouldRequestAccess(preflight: Bool) -> Bool {
        !preflight
    }

    public static func requiresEventTapAccess(post: Bool, listen: Bool) -> Bool {
        !post || !listen
    }

    @discardableResult
    public static func requestIfNeeded() -> Bool {
        let post = CGPreflightPostEventAccess()
        let listen = CGPreflightListenEventAccess()
        if shouldRequestAccess(preflight: post) { _ = CGRequestPostEventAccess() }
        if !listen { _ = CGRequestListenEventAccess() }
        return post && listen
    }
}

public enum GlobalShortcut {
    public static let keyCode: Int64 = 31 // macOS virtual key code for O
    public static let displayLabel = "⌘⌥O"

    public static func matches(keyCode: Int64, flags: CGEventFlags) -> Bool {
        keyCode == Self.keyCode && flags.contains(.maskCommand) && flags.contains(.maskAlternate)
    }
}
