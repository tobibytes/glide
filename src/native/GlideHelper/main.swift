import AppKit
import Foundation

// glide-helper: see src/native/PROTOCOL.md. Main thread runs the run loop (event tap, workspace
// notifications, timers); stdin is read on a background thread; requests run on a global queue.

let helperVersion = "1.0.0"

signal(SIGPIPE, SIG_IGN)
_ = NSApplication.shared
NSApp.setActivationPolicy(.prohibited)

func cleanupAndExit(_ code: Int32) -> Never {
    onMain { Keys.shared.shutdown() }
    exit(code)
}

func int32(_ v: Any?) -> pid_t? { (v as? NSNumber).map { pid_t(truncating: $0) } }

func dispatch(_ method: String, _ p: Params) throws -> Any {
    switch method {
    case "ping":
        return ["version": helperVersion]
    case "permissions.status":
        return Permissions.status()
    case "permissions.request":
        guard let kind = p["kind"] as? String else { throw HelperError("Missing kind") }
        if kind == "accessibility" || kind == "inputMonitoring" { return try onMain { try Permissions.request(kind) } }
        return try Permissions.request(kind)
    case "app.frontmost":
        return Apps.shared.target().map(Apps.describe) ?? NSNull()
    case "selection.text":
        return Selection.text()
    case "windows.apply":
        guard let action = p["action"] as? String else { throw HelperError("Missing action") }
        return Windows.apply(action)
    case "menus.list":
        return try Menus.list(pid: int32(p["pid"]))
    case "menus.press":
        guard let path = p["path"] as? [String] else { throw HelperError("Missing path") }
        return Menus.press(pid: int32(p["pid"]), path: path)
    case "keys.configure":
        let raw = (p["snippets"] as? [[String: Any]]) ?? []
        let snippets = raw.compactMap { s -> (String, String)? in
            guard let k = s["keyword"] as? String, let t = s["text"] as? String else { return nil }
            return (k, t)
        }
        let hyper = (p["hyperKey"] as? String) == "capslock"
        let error = onMain { Keys.shared.configure(snippets: snippets, hyper: hyper) }
        return error.map { ["ok": false, "error": $0] } ?? ["ok": true]
    case "keys.paste":
        guard let text = p["text"] as? String else { throw HelperError("Missing text") }
        onMain { Paste.paste(text) }
        return ["ok": true]
    case "calendar.events":
        guard let from = p["from"] as? String, let to = p["to"] as? String else { throw HelperError("Missing from/to") }
        return try CalendarService.events(from: from, to: to)
    case "finder.selection":
        return FinderSelection.selection()
    case "finder.selectionViaAutomation":
        return FinderSelection.selectionViaAutomation()
    case "reminders.lists":
        return try RemindersService.lists()
    case "reminders.list":
        return try RemindersService.list(listId: p["listId"] as? String, includeCompleted: (p["includeCompleted"] as? Bool) ?? false)
    case "reminders.create":
        return try RemindersService.create(p)
    case "reminders.complete":
        guard let id = p["id"] as? String else { throw HelperError("Missing id") }
        return try RemindersService.complete(id: id, completed: (p["completed"] as? Bool) ?? true)
    case "wifi.info":
        return WiFi.info()
    case "color.pick":
        return ColorPicker.pick(timeout: (p["timeoutMs"] as? Double).map { $0 / 1000 } ?? 120)
    case "system.spotlightShortcut":
        return ["enabled": Spotlight.enabled()]
    case "system.setSpotlightShortcut":
        guard let enabled = p["enabled"] as? Bool else { throw HelperError("Missing enabled") }
        return Spotlight.setEnabled(enabled)
    case "layouts.displays":
        return WindowLayouts.displays()
    case "layouts.apps":
        return WindowLayouts.runningApps()
    case "layouts.capture":
        return WindowLayouts.capture(includeHidden: (p["includeHidden"] as? Bool) ?? false)
    case "layouts.move":
        guard let moves = p["moves"] as? [[String: Any]] else { throw HelperError("Missing moves") }
        return WindowLayouts.move(moves)
    case "apps.quit":
        guard let ids = p["bundleIds"] as? [String] else { throw HelperError("Missing bundleIds") }
        return WindowLayouts.quit(ids)
    case "ocr.recognize":
        guard let path = p["path"] as? String else { throw HelperError("Missing path") }
        return try OCR.recognize(path: path, languages: (p["languages"] as? [String]) ?? [], fast: (p["fast"] as? Bool) ?? false, correction: (p["languageCorrection"] as? Bool) ?? true)
    case "ocr.barcodes":
        guard let path = p["path"] as? String else { throw HelperError("Missing path") }
        return try OCR.barcodes(path: path)
    case "debug.hyperDryRun" where HID.dryRun:
        // Test hook: exercises enable → disable without touching the real key mapping.
        return onMain { () -> [String: Any] in
            HID.dryRunLog = []
            HID.enable()
            let active = HID.active
            HID.disable()
            return ["activeWhileEnabled": active, "commands": HID.dryRunLog, "restored": !HID.active]
        }
    default:
        throw HelperError("Unknown method \(method)")
    }
}

/// Requests still running when stdin closes get a few seconds to answer.
let inFlight = DispatchGroup()

func handleLine(_ line: String) {
    guard let data = line.data(using: .utf8),
          let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let id = msg["id"], let method = msg["method"] as? String
    else {
        log("ignoring malformed line")
        return
    }
    let params = (msg["params"] as? Params) ?? [:]
    inFlight.enter()
    DispatchQueue.global(qos: .userInitiated).async {
        defer { inFlight.leave() }
        do {
            Output.result(id, try dispatch(method, params))
        } catch {
            Output.error(id, "\(error)")
        }
    }
}

HID.recoverStale()
Apps.shared.start()
Permissions.startWatching()

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { cleanupAndExit(0) }
    src.resume()
    signalSources.append(src)
}

Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        if !line.isEmpty { handleLine(line) }
    }
    _ = inFlight.wait(timeout: .now() + 5)
    DispatchQueue.main.async { cleanupAndExit(0) }
}

CFRunLoopRun()
