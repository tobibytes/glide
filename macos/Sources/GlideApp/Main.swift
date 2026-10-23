import AppKit
import Foundation
import GlideCore
import GlideFeatures
import GlideSystem

@main
struct GlideMain {
    @MainActor static func main() {
        signal(SIGPIPE, SIG_IGN)
        let args = CommandLine.arguments
        // N5: stdio ⇄ HTTP bridge to the running app's MCP server (no UI, no NSApplication).
        if args.contains(MCPStdioBridge.flag) { MCPStdioBridge.runAndExit(arguments: args) }
        // Offline self-tests kept from glide-helper (never create taps, post events or touch the pasteboard).
        if let i = args.firstIndex(of: "--selftest-keys"), let path = args.dropFirst(i + 1).first {
            guard let data = FileManager.default.contents(atPath: path), let out = KeysSelfTest.run(fixture: data),
                  let json = try? JSONSerialization.data(withJSONObject: out) else { exit(2) }
            StdoutWriter.shared.line(String(decoding: json, as: UTF8.self))
            exit(0)
        }
        if let i = args.firstIndex(of: "--selftest-hotkeys"), let path = args.dropFirst(i + 1).first {
            guard let data = FileManager.default.contents(atPath: path) else { exit(2) }
            let r = KeyLayout().selftest(cases: data)
            let out: [String: Any] = ["ok": r.failures.isEmpty, "checked": r.checked, "failures": r.failures]
            StdoutWriter.shared.line(String(decoding: (try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])) ?? Data(), as: UTF8.self))
            exit(r.failures.isEmpty ? 0 : 1)
        }

        let config = AppConfig.current()
        let app = NSApplication.shared
        // LSUIElement agent; headless runs are .prohibited (no Dock icon, no menu bar, cannot activate).
        app.setActivationPolicy(config.headless ? .prohibited : .accessory)
        let delegate = AppDelegate(config: config)
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
