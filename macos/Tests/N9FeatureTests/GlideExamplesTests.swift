import Foundation
@testable import GlideFeatures
import GlideCore
import Testing

@Suite("bundled Glide examples on JavaScriptCore", .serialized)
@MainActor struct GlideExamplesTests {
    @Test func uuidGeneratorCopiesAndShowsHUD() async throws {
        let h = Harness()
        let ext = try h.install("uuid-generator")
        let s = try h.run(ext, "generate-uuid", prefs: ["uppercase": true])
        let c = await s.waitForCompletion()
        #expect(c.ok, "\(c.error ?? "") \(s.logs)")
        let copy = try #require(h.delegate.requests.first { $0.method == "clipboard.copy" })
        let id = copy.params.first?.stringValue ?? ""
        #expect(id.count == 36 && id == id.uppercased(), "\(id)")
        #expect(h.delegate.methods().contains("showHUD"))
        #expect(!s.alive)
    }

    @Test func colorConverterRendersListAndSearches() async throws {
        let h = Harness()
        let ext = try h.install("color-converter")
        let s = try h.run(ext, "convert-color", args: ["color": "#ff8800"])
        #expect(await waitUntil { s.view(0)?["type"]?.stringValue == "list" }, "\(s.logs)")
        let items = s.view(0)?["items"]?.arrayValue ?? []
        #expect(!items.isEmpty, "\(s.view(0) ?? .null)")
        #expect(items.contains { ($0["title"]?.stringValue ?? "").lowercased().contains("ff8800") || ($0["subtitle"]?.stringValue ?? "").contains("HEX") }, "\(items)")
        let handler = try #require(s.view(0)?["searchHandler"]?.stringValue)
        s.invoke(depth: 0, handler: handler, args: ["rgb(0, 128, 255)"])
        #expect(await waitUntil { (s.view(0)?["items"]?.arrayValue ?? []).contains { "\($0)".contains("0080ff") || "\($0)".contains("0080FF") } }, "\(s.view(0) ?? .null)")
        s.kill()
    }
}
