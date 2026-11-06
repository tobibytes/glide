import Foundation
import GlideCore
@testable import GlideFeatures
import Testing

/// A feature whose start never finishes (a stuck Spotlight query, a slow network volume, a permission sheet).
@MainActor private final class StuckFeature: Feature {
    let id = "stuck"
    let title = "Stuck"
    func start(context: FeatureContext) async { try? await Task.sleep(for: .seconds(60)) }
}

@MainActor private final class QuickFeature: Feature {
    let id: String
    let title = "Quick"
    var started = false
    init(_ id: String) { self.id = id }
    func start(context: FeatureContext) async { started = true }
}

@Suite("Startup and hotkey rules")
@MainActor struct LaunchAndHotkeyTests {
    /// One stuck feature used to hold up every feature after it (and Glide's whole startup).
    @Test func aStuckFeatureDoesNotBlockTheOthers() async throws {
        let ctx = try N4TestContext(featureId: "registry")
        defer { ctx.cleanup() }
        let after = QuickFeature("after")
        let registry = FeatureRegistry(features: [QuickFeature("before"), StuckFeature(), after])
        var reports: [(String, Bool)] = []
        let t0 = ContinuousClock.now
        await registry.startAll(context: { _ in ctx }, stallAfter: .milliseconds(200)) { id, _, finished in reports.append((id, finished)) }
        #expect(ContinuousClock.now - t0 < .seconds(30)) // the stuck start alone would take 60 s (generous for a loaded test run)
        #expect(after.started)
        #expect(reports.contains { $0.0 == "stuck" && $0.1 == false })
    }

    @Test func hotkeyRules() {
        // Would swallow normal typing.
        #expect(HotkeyAdvice.problem("A", spotlightEnabled: false) != nil)
        #expect(HotkeyAdvice.problem("Shift+A", spotlightEnabled: false) != nil)
        // Fine.
        #expect(HotkeyAdvice.problem("Alt+Space", spotlightEnabled: true) == nil)
        #expect(HotkeyAdvice.problem("Control+Alt+K", spotlightEnabled: false) == nil)
        #expect(HotkeyAdvice.problem("F5", spotlightEnabled: false) == nil)
        // ⌘Space only once Spotlight hands it over.
        #expect(HotkeyAdvice.problem("Command+Space", spotlightEnabled: true) == HotkeyAdvice.spotlightMessage)
        #expect(HotkeyAdvice.problem("Cmd+Space", spotlightEnabled: false) == nil)
        // Known clashes.
        #expect(HotkeyAdvice.problem("Command+Q", spotlightEnabled: false) != nil)
    }

    @Test func keyboardRecorderNeedsCommandOptionOrControl() {
        var logic = HotkeyRecorderLogic()
        #expect(logic.feed(.keyDown(key: "A", mods: [.shift], time: 0)) == .none)
        #expect(logic.preview == "Add ⌘, ⌥ or ⌃")
        #expect(logic.feed(.keyDown(key: "K", mods: [.alt, .shift], time: 0)) == .recorded("Alt+Shift+K"))
        #expect(logic.feed(.keyDown(key: "F6", mods: [], time: 0)) == .recorded("F6"))
    }
}
