import Foundation
import Testing
@testable import GlideCore

private func fixture(_ name: String) throws -> Data {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try Data(contentsOf: url)
}

private func tempDir() -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("glide-core-tests-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

@Suite("data.json / usage.json compatibility")
struct DataCompat {
    @Test func dataRoundTripIsLossless() throws {
        let raw = try fixture("data")
        let original = try JSONDecoder().decode(JSONValue.self, from: raw)
        let model = try JSONDecoder().decode(UserData.self, from: raw)
        // typed fields
        #expect(model.settings.hotkey == "Command+Space")
        #expect(model.settings.sectionLimit == 6)
        #expect(model.settings.frecencyHalfLifeDays == 14)
        #expect(model.settings.features["appearance"]?["darkTheme"] == "nord")
        #expect(model.workflows.count == 2)
        #expect(model.workflows[0].actions[2].then?.first?.param("url") == "{{clipboard}}")
        #expect(model.workflows[0].actions[3].param("delayMs") == "250")
        #expect(model.quicklinks[1].openWith == "com.google.Chrome")
        #expect(model.snippets[2].html == "<b>Hello</b> world")
        #expect(model.favorites == ["app:/System/Applications/Calendar.app", "workflow:wf-morning-setup"])
        #expect(model.aliases["system:lockScreen"] == "lock")
        // unknown fields are carried
        #expect(model.extra["schemaVersion"] == 3)
        #expect(model.settings.extra["onboardingDone"] == true)
        #expect(model.workflows[0].extra["runCount"] == 42)
        #expect(model.workflows[0].actions[3].extra["uiCollapsed"] == true)
        #expect(model.snippets[2].extra["folder"] == "Greetings")
        // encode → identical JSON value
        let reencoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.glide.encode(model))
        #expect(reencoded == original)
    }

    @Test func usageRoundTrip() throws {
        let raw = try fixture("usage")
        let values = try JSONDecoder().decode([JSONValue].self, from: raw)
        let records = values.compactMap { v -> UsageRecord? in
            guard let d = try? JSONEncoder().encode(v) else { return nil }
            return try? JSONDecoder().decode(UsageRecord.self, from: d)
        }
        #expect(records.count == 3) // the record without itemId is dropped, like the Electron store
        #expect(records[0].searchTerms == ["saf", "s"])
        #expect(records[0].count == 17)
        #expect(records[2].extra["pinned"] == true)
        let back = try JSONDecoder().decode([JSONValue].self, from: JSONEncoder.glide.encode(records))
        #expect(back == Array(values.prefix(3)))
    }

    @Test func toleratesWrongTypesAndMissingFields() throws {
        let raw = Data(#"{"settings":{"sectionLimit":"lots","vimMode":false},"workflows":[{"id":"w","name":"W","actions":[{"id":"a","type":"notify","params":{"title":"x"}}, 7]}], "favorites":["a",3]}"#.utf8)
        let d = try JSONDecoder().decode(UserData.self, from: raw)
        #expect(d.settings.sectionLimit == 8)
        #expect(d.settings.vimMode == false)
        #expect(d.settings.hotkey == "Alt+Space")
        #expect(d.workflows[0].actions.count == 1)
        #expect(d.favorites == ["a"])
        #expect(d.quicklinks.isEmpty)
    }

    @Test func settingsDefaultsMatchElectron() {
        let s = Settings()
        #expect(s.hotkey == "Alt+Space")
        #expect(s.appDirectories == ["/Applications", "/System/Applications", "/System/Applications/Utilities", "~/Applications"])
        #expect(s.sectionLimit == 8 && s.frecencyHalfLifeDays == 10 && s.vimMode && s.hideOnBlur && s.keepOpenAfterRun && !s.launchAtLogin)
    }
}

@Suite("Store")
struct StoreTests {
    @Test func seedsFreshDirectory() throws {
        let dir = tempDir()
        let store = Store(directory: dir, debounce: 0.01)
        #expect(try store.load())
        #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("data.json").path))
        #expect(store.data.workflows.map(\.id) == ["wf-morning-setup", "wf-search-clipboard", "wf-quick-note"])
        #expect(store.data.quicklinks.first?.alias == "g")
    }

    @Test func loadsExistingAndWritesLosslessly() throws {
        let dir = tempDir()
        try fixture("data").write(to: dir.appendingPathComponent("data.json"))
        try fixture("usage").write(to: dir.appendingPathComponent("usage.json"))
        let store = Store(directory: dir, debounce: 0.01)
        #expect(try !store.load())
        #expect(store.usage.count == 3)
        store.setAlias("app:/Applications/Notes.app", "n")
        store.setFeatureSettings("clipboard", ["maxItems": 900])
        store.flush()
        let written = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: dir.appendingPathComponent("data.json")))
        #expect(written["aliases"]?["app:/Applications/Notes.app"] == "n")
        #expect(written["settings"]?["features"]?["clipboard"]?["maxItems"] == 900)
        #expect(written["settings"]?["features"]?["clipboard"]?["ignoreApps"] == ["com.1password.1password"])
        #expect(written["schemaVersion"] == 3)
        #expect(written["settings"]?["onboardingDone"] == true)
    }

    @Test func debouncedWritesAndObservers() async throws {
        let dir = tempDir()
        let store = Store(directory: dir, debounce: 0.05)
        try store.load()
        final class Counter: @unchecked Sendable { var n = 0 }
        let counter = Counter()
        let token = store.observe { _ in counter.n += 1 }
        store.toggleFavorite("x")
        store.toggleFavorite("y")
        #expect(counter.n == 2)
        try await Task.sleep(for: .milliseconds(300))
        let written = try JSONDecoder().decode(UserData.self, from: Data(contentsOf: store.dataURL))
        #expect(written.favorites == ["x", "y"])
        token.cancel()
        store.toggleFavorite("x")
        #expect(counter.n == 2)
    }

    @Test func usagePersists() throws {
        let dir = tempDir()
        let store = Store(directory: dir, debounce: 0.01)
        try store.load()
        var e = SearchEngine(now: { 1_700_000_000_000 })
        e.recordUsage("app:/Applications/Safari.app", searchTerm: "saf")
        store.setUsage(e.usageRecords)
        store.flush()
        let back = try JSONDecoder().decode([UsageRecord].self, from: Data(contentsOf: store.usageURL))
        #expect(back.first?.itemId == "app:/Applications/Safari.app")
        #expect(back.first?.searchTerms == ["saf"])
        let text = try String(contentsOf: store.usageURL, encoding: .utf8)
        #expect(text.contains("1700000000000"))
        #expect(!text.contains("1700000000000.0"))
    }

    @Test func corruptDataIsBackedUp() throws {
        let dir = tempDir()
        try Data("{not json".utf8).write(to: dir.appendingPathComponent("data.json"))
        let store = Store(directory: dir, debounce: 0.01)
        store.onError = { _ in }
        #expect(try store.load())
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        #expect(files.contains { $0.hasPrefix("data.json.corrupt-") })
    }
}

@Suite("calculator")
struct CalculatorTests {
    @Test func arithmetic() {
        #expect(Calculator.evaluate("1 + 2 * 3") == 7)
        #expect(Calculator.evaluate("(1 + 2) * 3") == 9)
        #expect(Calculator.evaluate("10 / 4") == 2.5)
        #expect(Calculator.evaluate("2 ^ 3 ^ 2") == 512)
        #expect(Calculator.evaluate("-3 * -2") == 6)
        #expect(Calculator.evaluate("1,000 + 1") == 1001)
        #expect(Calculator.evaluate("3 × 4 ÷ 2") == 6)
    }
    @Test func moduloAndPercent() {
        #expect(Calculator.evaluate("17 % 5") == 2)
        #expect(Calculator.evaluate("17 mod 5") == 2)
        #expect(Calculator.evaluate("15% of 80") == 12)
        #expect(Calculator.evaluate("80 + 15%") == 92)
        #expect(Calculator.evaluate("200 - 10%") == 180)
        #expect(Calculator.evaluate("50% * 4") == 2)
    }
    @Test func functions() {
        #expect(Calculator.evaluate("sqrt(16) + abs(-2)") == 6)
        #expect(Calculator.evaluate("round(2.5)") == 3)
        #expect(abs(Calculator.evaluate("2 * pi")! - Double.pi * 2) < 1e-9)
    }
    @Test func rejects() {
        for q in ["safari", "42", "1 +", "(1 + 2", "2 * foo", ""] { #expect(Calculator.evaluate(q) == nil, "\(q)") }
    }
    @Test func formatting() {
        #expect(Calculator.format(42) == "42")
        #expect(Calculator.format(0.1 + 0.2) == "0.3")
        #expect(Calculator.format(1.0 / 3) == "0.333333333333")
        #expect(Calculator.format(1.0 / 0) == "∞")
    }
    @Test func item() {
        let i = Calculator.items(for: "6 * 7")
        #expect(i.first?.item.kind == .calculator)
        #expect(i.first?.item.title == "= 42")
        #expect(i.first?.item.text == "42")
        #expect(i.first?.item.subtitle == "Press Enter to copy")
        #expect(Calculator.items(for: "hello").isEmpty)
    }
}

@Suite("quicklinks + accelerators")
struct QuicklinkTests {
    @Test func fill() {
        #expect(QuicklinkURL.fill("https://www.google.com/search?q={query}", argument: "swift & c++") == "https://www.google.com/search?q=swift%20%26%20c%2B%2B")
        #expect(QuicklinkURL.fill("https://x.dev/{query}", argument: nil) == "https://x.dev/")
        #expect(QuicklinkURL.acceptsArgument("https://a/{query}"))
        #expect(!QuicklinkURL.acceptsArgument("https://a/"))
    }
    @Test func accelDisplay() {
        #expect(Accelerator.display("Alt+Cmd+K") == "⌥⌘K")
        #expect(Accelerator.display("Shift+Command+V") == "⇧⌘V")
        #expect(Accelerator.display("Alt+Space") == "⌥␣")
    }
}

@Suite("themes")
struct ThemeTests {
    @Test func presets() {
        #expect(Themes.presets.count == 9)
        #expect(Set(Themes.presets.map(\.id)).count == 9)
    }
    @Test func tokensMatchCSSDefaults() {
        let t = Themes.tokens(Themes.preset("glide-dark")!, AppearanceSettings())
        #expect(t.accent.hex == "#f5a524")
        #expect(t.rowHeight == 42 && t.headHeight == 58 && t.fontInput == 20 && t.iconSize == 24 && t.rowRadius == 9)
        let light = Themes.tokens(Themes.preset("glide-light")!, AppearanceSettings())
        #expect(light.accentText.contrast(light.panel.alpha(1)) >= 4.4)
    }
    @Test func normalizesBag() {
        let s = AppearanceSettings(bag: ["darkTheme": "nope", "fontSize": 40, "density": "compact", "accent": "#ABC"])
        #expect(s.darkTheme == "glide-dark")
        #expect(s.fontSize == 17)
        #expect(s.density == .compact)
        #expect(s.accent == "#aabbcc")
        let t = Themes.tokens(mode: "system", systemDark: true, bag: ["darkTheme": "nord"])
        #expect(t.preset.id == "nord")
    }
}
