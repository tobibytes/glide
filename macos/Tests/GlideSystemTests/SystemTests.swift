import CoreGraphics
import Foundation
import Testing
@testable import GlideCore
@testable import GlideSystem

private func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")))
}

@Suite("KeysLogic decision table (was glide-helper --selftest-keys)")
struct KeysLogicTests {
    @Test func everyFixtureCase() throws {
        let data = try fixture("keys-selftest")
        let fixtureRoot = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let cases = try #require(fixtureRoot["cases"] as? [[String: Any]])
        let out = try #require(KeysSelfTest.run(fixture: data))
        let got = try #require(out["cases"] as? [[String: Any]])
        #expect(got.count == cases.count)
        for (i, c) in cases.enumerated() {
            let name = c["name"] as? String ?? "?"
            #expect(got[i]["name"] as? String == name)
            #expect(got[i]["decisions"] as? [String] == c["expect"] as? [String], "\(name)")
        }
        let backspaces = ((out["extra"] as? [String: Any])?["backspaces"] as? [[String: Any]])?.compactMap { $0["count"] as? Int }
        #expect(backspaces == fixtureRoot["expectBackspaces"] as? [Int])
    }
}

@Suite("hotkey accelerators (was glide-helper --selftest-hotkeys)")
@MainActor
struct HotkeyTests {
    @Test func sharedTable() throws {
        let r = KeyLayout().selftest(cases: try fixture("hotkey-accelerators"))
        #expect(r.checked > 40)
        #expect(r.failures.isEmpty, "\(r.failures)")
    }
    @Test func storedSettingsParse() {
        #expect(HotkeyParser.canonical(try! HotkeyParser.parse("Alt+Space").get()) == "Alt+Space")
        #expect(HotkeyParser.canonical(try! HotkeyParser.parse("Command+Space").get()) == "Cmd+Space")
        if case .success = HotkeyParser.parse("Cmd") { Issue.record("modifier alone must fail") }
    }
}

@Suite("window geometry")
struct GeometryTests {
    let v = CGRect(x: 0, y: 25, width: 1440, height: 875)
    var screens: [ScreenInfo] { [ScreenInfo(frame: CGRect(x: 0, y: 0, width: 1440, height: 900), visible: v)] }
    @Test func halvesAndThirds() {
        let f = CGRect(x: 100, y: 100, width: 600, height: 400)
        #expect(WindowGeometry.target(action: "left-half", frame: f, visible: v, screens: screens, screenIndex: 0) == CGRect(x: 0, y: 25, width: 720, height: 875))
        #expect(WindowGeometry.target(action: "right-third", frame: f, visible: v, screens: screens, screenIndex: 0) == CGRect(x: 960, y: 25, width: 480, height: 875))
        #expect(WindowGeometry.target(action: "maximize", frame: f, visible: v, screens: screens, screenIndex: 0) == v)
        #expect(WindowGeometry.target(action: "center", frame: f, visible: v, screens: screens, screenIndex: 0)?.midX == v.midX)
        #expect(WindowGeometry.target(action: "next-display", frame: f, visible: v, screens: screens, screenIndex: 0) == nil)
        #expect(WindowGeometry.target(action: "bogus", frame: f, visible: v, screens: screens, screenIndex: 0) == nil)
    }
    @Test func nextDisplayKeepsProportions() {
        let s2 = ScreenInfo(frame: CGRect(x: 1440, y: 0, width: 1920, height: 1080), visible: CGRect(x: 1440, y: 0, width: 1920, height: 1080))
        let r = WindowGeometry.target(action: "next-display", frame: CGRect(x: 0, y: 25, width: 720, height: 875), visible: v, screens: screens + [s2], screenIndex: 0)
        #expect(r == CGRect(x: 1440, y: 0, width: 960, height: 1080))
    }
}

@Suite("helper pure bits")
struct HelperBits {
    @Test func menuShortcuts() {
        #expect(MenuReader.shortcut(char: "N", modifiers: 0, virtualKey: nil, glyph: nil) == "⌘N")
        #expect(MenuReader.shortcut(char: "z", modifiers: 1, virtualKey: nil, glyph: nil) == "⇧⌘Z")
        #expect(MenuReader.shortcut(char: nil, modifiers: 8 | 4, virtualKey: nil, glyph: 0x1B) == "⌃⎋")
        #expect(MenuReader.shortcut(char: nil, modifiers: 0, virtualKey: nil, glyph: nil) == nil)
    }
    @Test func hidutilParsing() {
        let text = "(\n    {\n    HIDKeyboardModifierMappingDst = 30064771181;\n    HIDKeyboardModifierMappingSrc = 30064771129;\n}\n)"
        let m = HIDMapping.parse(text)
        #expect(m.count == 1 && m[0].0 == 30_064_771_129 && m[0].1 == 30_064_771_181)
        #expect(HIDMapping.json([(1, 2)]) == "{\"UserKeyMapping\":[{\"HIDKeyboardModifierMappingSrc\":1,\"HIDKeyboardModifierMappingDst\":2}]}")
    }
}

@Suite("headless fakes")
@MainActor
struct HeadlessTests {
    @Test func recordsSideEffects() async throws {
        let log = SideEffectLog(echo: false)
        let s = SystemServicesFactory.headless(log: log, environment: ["GLIDE_HEADLESS_SELECTION": "hello"])
        #expect(s.isHeadless)
        _ = s.workspace.open(url: URL(string: "https://example.com")!)
        s.pasteboard.setString("x", html: nil, transient: true)
        #expect(s.pasteboard.string() == "x")
        s.paste.paste(text: "y", html: nil)
        _ = try await s.scripts.runAppleScript("tell application \"Finder\" to empty trash")
        #expect(await s.confirmation.confirm(title: "t", message: "m", confirmButton: "OK"))
        #expect(await s.selection.selectedText().text == "hello")
        let reg = s.hotkeys.set([HotkeyBinding(id: "launcher", accelerator: "Alt+Space"), HotkeyBinding(id: "bad", accelerator: "Cmd")])
        #expect(reg.registered == ["launcher"])
        #expect(reg.failed.map(\.id) == ["bad"])
        #expect(log.all.map(\.kind) == ["open-url", "pasteboard-set", "paste", "applescript", "confirm", "hotkeys-set"])
    }
}

@Suite("integration: pasteboard image/file API") @MainActor
struct PasteboardRichTests {
    @Test func fakeImageAndFiles() {
        let log = SideEffectLog(echo: false)
        let pb: any PasteboardService = FakePasteboard(log: log)
        #expect(pb.imagePNG() == nil && pb.fileURLs().isEmpty)
        let png = Data([0x89, 0x50, 0x4E, 0x47])
        pb.setImagePNG(png, transient: false)
        #expect(pb.imagePNG() == png && pb.string() == nil)
        pb.setFileURLs([URL(fileURLWithPath: "/tmp/a.png")])
        #expect(pb.fileURLs().map(\.path) == ["/tmp/a.png"] && pb.imagePNG() == nil)
        pb.setString("x", html: nil, transient: false)
        #expect(pb.fileURLs().isEmpty && pb.string() == "x")
        #expect(log.all.map(\.kind) == ["pasteboard-image", "pasteboard-files", "pasteboard-set"])
    }
    @Test func sharedRecorderUsesTheAppLog() {
        let log = SideEffectLog(echo: false)
        let prev = SideEffectLog.current
        SideEffectLog.current = log
        defer { SideEffectLog.current = prev }
        SideEffectLog.recordShared("finder.newFile", ["name": "a.md"])
        #expect(log.all.first?.kind == "finder.newFile")
    }
}
