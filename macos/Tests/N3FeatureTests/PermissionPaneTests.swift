import Foundation
@testable import GlideCore
@testable import GlideFeatures
@testable import GlideSystem
import Testing

@Suite("permission panes: ask once before opening, valid deep links")
@MainActor struct PermissionPaneTests {
    /// Until Glide has asked for Accessibility it is not listed in the pane: "Open Accessibility Settings" asks
    /// first (headless: recorded, never prompts), then opens the pane.
    @Test func openAccessibilityAsksFirstWhenNotTrusted() async {
        for featureId in ["windows", "layouts"] {
            let ctx = N3Context(featureId)
            let feature: any Feature = featureId == "windows" ? WindowsFeature() : LayoutsFeature()
            await feature.start(context: ctx)
            let item = SearchItem(id: "\(featureId).x", kind: .command, title: "X", feature: featureId)
            _ = await feature.run(action: "open-accessibility", on: .row(item), modifiers: [])
            let trusted = ctx.services.permissions.status().accessibility
            let kinds = ctx.log.all.map(\.kind).filter { $0 == "permission-request" || $0 == "open-url" }
            #expect(kinds == (trusted ? ["open-url"] : ["permission-request", "open-url"]), "\(featureId)")
            if !trusted { #expect(ctx.effects("permission-request").first == ["kind": "accessibility"]) }
            #expect(ctx.effects("open-url").first?["url"]?.stringValue == SettingsPanes.accessibility)
        }
    }

    /// Every x-apple.systempreferences privacy anchor Glide opens exists in this macOS's System Settings
    /// (read-only look at the Privacy & Security extension's search terms; skipped where it's missing).
    @Test func privacyDeepLinksUseExistingAnchors() throws {
        let terms = URL(fileURLWithPath: "/System/Library/ExtensionKit/Extensions/SecurityPrivacyExtension.appex/Contents/Resources/en.lproj/PrivacySecurity.searchTerms")
        guard let data = FileManager.default.contents(atPath: terms.path),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) else { return }
        let known = String(describing: plist)
        let urls = [SettingsPanes.accessibility, SettingsPanes.inputMonitoring, SettingsPanes.automation] + OnboardingPermission.allCases.map(\.paneURL)
        for u in urls {
            #expect(u.hasPrefix("x-apple.systempreferences:com.apple.preference.security?"), "\(u)")
            let anchor = String(u.split(separator: "?").last ?? "")
            #expect(known.contains(anchor), "\(anchor) is not a Privacy & Security anchor on this macOS")
        }
    }
}
