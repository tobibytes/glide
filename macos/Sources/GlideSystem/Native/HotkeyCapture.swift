import Foundation

/// "A hotkey recorder has the keyboard" (nesting-safe). The app suspends Glide's global hotkeys meanwhile
/// (`CarbonHotkeyService.setSuspended`): a registered combo is consumed by Carbon before any recorder sees it.
@MainActor public enum HotkeyCapture {
    private static var depth = 0
    public static var onChange: ((Bool) -> Void)?
    public static var isCapturing: Bool { depth > 0 }
    public static func begin() {
        depth += 1
        if depth == 1 { onChange?(true) }
    }
    public static func end() {
        guard depth > 0 else { return }
        depth -= 1
        if depth == 0 { onChange?(false) }
    }
}
