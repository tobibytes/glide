import AppKit
import Darwin
import Foundation
import GlideTestHarness
import Testing

/// Memory and idle-CPU budgets for the headless app, so a change can't quietly make Glide heavier.
/// Footprint = the kernel's phys_footprint (what Activity Monitor shows as "Memory"). Debug builds are bigger than
/// release, so the budgets leave room; growth is what catches leaks.
private struct Usage {
    var footprintMB: Double
    var cpuSeconds: Double
    static func of(_ pid: pid_t) -> Usage? {
        var info = rusage_info_v4()
        let ok = withUnsafeMutablePointer(to: &info) { ptr in
            ptr.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
        }
        guard ok == 0 else { return nil }
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        let ns = Double(info.ri_user_time + info.ri_system_time) * Double(tb.numer) / Double(tb.denom)
        return Usage(footprintMB: Double(info.ri_phys_footprint) / 1_048_576, cpuSeconds: ns / 1e9)
    }
}

private let tmpRoot = ProcessInfo.processInfo.environment["GLIDE_E2E_TMP"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory

/// A screenshot-sized PNG with 40 lines of text (Vision's accurate model is what used to cost ~100–200 MB).
@MainActor private func textImage() throws -> URL {
    let size = NSSize(width: 2880, height: 1800)
    let img = NSImage(size: size)
    img.lockFocus()
    NSColor.white.setFill()
    NSRect(origin: .zero, size: size).fill()
    let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 28), .foregroundColor: NSColor.black]
    for i in 0..<40 { ("Line \(i): The quick brown fox jumps over the lazy dog 0123456789" as NSString).draw(at: NSPoint(x: 40, y: 1760 - CGFloat(i) * 44), withAttributes: attrs) }
    img.unlockFocus()
    let url = tmpRoot.appendingPathComponent("budget-ocr-\(UUID().uuidString).png")
    guard let tiff = img.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
    try png.write(to: url)
    return url
}

@Suite("resource budgets", .serialized)
struct ResourceBudgetE2ETests {
    @Test func searchingDoesNotLeakMemory() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        let pid = d.process.processIdentifier
        _ = try d.show()
        let queries = ["saf", "timer 25m", "clip", "window left", "what can glide do", "emoji", "2+2*3", "notes", "#ff8800", "theme", "a", "calendar"]
        let views = ["glide.commands", "clipboard.history", "emoji.picker", "notes.search", "timers.list", "appearance.switch", "glide.shortcuts"]
        func round(_ r: Int) throws {
            for i in 0..<200 {
                _ = try d.send(["cmd": "setQuery", "text": queries[(i + r) % queries.count]])
                if i % 10 == 0 {
                    _ = try d.invoke("launcher", "push", ["view": views[(i / 10) % views.count], "payload": NSNull()])
                    _ = try d.invoke("launcher", "pop")
                }
            }
            _ = try d.send(["cmd": "setQuery", "text": ""])
        }
        try round(0) // warm-up: catalogue, views and caches load once
        try round(1)
        let warm = try #require(Usage.of(pid)).footprintMB
        for r in 2..<5 { try round(r) }
        let after = try #require(Usage.of(pid)).footprintMB
        #expect(warm < 250, "footprint after warm-up \(warm) MB")
        #expect(after - warm < 20, "grew \(after - warm) MB over 600 more searches (\(warm) → \(after) MB)")
    }

    @Test func idleUsesAlmostNoCPU() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        let pid = d.process.processIdentifier
        _ = try d.show()
        _ = try d.hide()
        usleep(2_000_000) // let start-up work finish
        let a = try #require(Usage.of(pid))
        usleep(5_000_000)
        let b = try #require(Usage.of(pid))
        let percent = (b.cpuSeconds - a.cpuSeconds) / 5 * 100
        #expect(percent < 2, "idle CPU \(percent)%")
    }

    /// Text recognition runs in a short-lived `--ocr-worker` process, so Vision's memory never stays in Glide.
    @Test @MainActor func textRecognitionDoesNotGrowTheApp() throws {
        let image = try textImage()
        defer { try? FileManager.default.removeItem(at: image) }
        let d = try GlideDriver()
        defer { d.stop() }
        let pid = d.process.processIdentifier
        _ = try d.show()
        let before = try #require(Usage.of(pid)).footprintMB
        for _ in 0..<3 {
            let r = try d.invoke("ocr", "recognizeImage", ["file": image.path])
            #expect((r["result"] as? [String: Any])?["lines"] as? Int == 40)
        }
        let after = try #require(Usage.of(pid)).footprintMB
        #expect(after - before < 30, "OCR grew the app \(after - before) MB (\(before) → \(after) MB)")
    }
}
