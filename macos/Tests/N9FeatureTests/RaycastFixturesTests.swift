import Foundation
@testable import GlideFeatures
import GlideCore
import Testing

private func items(_ v: JSONValue?) -> [JSONValue] { v?["items"]?.arrayValue ?? [] }
private func titles(_ v: JSONValue?) -> [String] { items(v).compactMap { $0["title"]?.stringValue } }
private func action(_ item: JSONValue, _ title: String) -> JSONValue? { (item["actions"]?.arrayValue ?? []).first { $0["title"]?.stringValue == title } }

@Suite("Raycast fixtures on JavaScriptCore", .serialized)
@MainActor struct RaycastFixturesTests {
    init() throws {
        try #require(RaycastBuilder.esbuildBinary() != nil, "esbuild (node_modules) is needed to build the .tsx fixtures")
    }

    @Test func fruitsListSectionsAccessoriesPushDetail() async throws {
        let h = Harness()
        let ext = try h.install("raycast-fixtures/rc-fruits")
        #expect(ext.manifest?.runtime == "raycast")
        #expect(FileManager.default.fileExists(atPath: ext.dir.appendingPathComponent(".glide-build/browse-fruits.cjs").path))
        let s = try h.run(ext, "browse-fruits", prefs: ["greeting": "Hello"])
        #expect(await waitUntil { items(s.view(0)).count == 7 }, "\(s.logs) \(s.view(0) ?? .null)")
        let v = try #require(s.view(0))
        #expect(v["type"] == "list")
        #expect(v["searchPlaceholder"] == "Search fruits…")
        #expect(titles(v) == ["Apple", "Cherry", "Strawberry", "Banana", "Lemon", "Kiwi", "Pear"])
        let apple = items(v)[0]
        #expect(apple["section"] == "Red Fruits")
        #expect("\(apple["accessories"] ?? .null)".contains("$1.20"))
        #expect((v["dropdown"]?["options"]?.arrayValue ?? []).count == 4)
        // Eat Fruit (destructive) removes the item and toasts.
        let eat = try #require(action(apple, "Eat Fruit"))
        #expect(eat["destructive"] == true)
        #expect(eat["shortcut"] == "⌃X")
        s.invoke(depth: 0, handler: try #require(eat["handler"]?.stringValue))
        #expect(await waitUntil { titles(s.view(0)).first == "Cherry" })
        #expect(await waitUntil { h.delegate.requests.contains { $0.method == "showToast" && $0.params[1] == "Ate Apple" } })
        // Push the detail of Cherry.
        let push = try #require(action(items(s.view(0))[0], "Show Fruit"))
        #expect(push["kind"] == "push")
        s.invoke(depth: 0, handler: try #require(push["handler"]?.stringValue))
        #expect(await waitUntil { s.view(1)?["type"] == "detail" })
        let d = try #require(s.view(1))
        #expect(d["markdown"]?.stringValue?.contains("Hello, **Cherry**!") == true)
        #expect((d["metadata"]?.arrayValue ?? []).count >= 3)
        #expect(h.delegate.events.contains(.push(depth: 1)))
        // The dropdown filters by colour.
        let dd = try #require(v["dropdown"]?["handler"]?.stringValue)
        s.invoke(depth: 0, handler: dd, args: ["Green"])
        #expect(await waitUntil { titles(s.view(0)) == ["Kiwi", "Pear"] }, "\(titles(s.view(0)))")
        s.kill()
    }

    @Test func fruitsNoViewCopiesWithArgument() async throws {
        let h = Harness()
        let ext = try h.install("raycast-fixtures/rc-fruits")
        let s = try h.run(ext, "copy-fruit", args: ["fruit": " Mango "])
        let c = await s.waitForCompletion()
        #expect(c.ok, "\(s.logs)")
        #expect(h.delegate.requests.first { $0.method == "clipboard.copy" }?.params.first == "🍽️ Mango")
        #expect(h.delegate.requests.contains { $0.method == "showHUD" && $0.params.first == "Copied Mango" })
    }

    @Test func notesFormValidationSubmitLocalStorage() async throws {
        let h = Harness()
        let ext = try h.install("raycast-fixtures/rc-notes")
        let s = try h.run(ext, "new-note")
        #expect(await waitUntil { s.view(0)?["type"] == "form" }, "\(s.logs)")
        let form = try #require(s.view(0))
        let fields = form["fields"]?.arrayValue ?? []
        #expect(fields.compactMap { $0["type"]?.stringValue } == ["description", "text", "textarea", "separator", "checkbox", "dropdown", "date", "tags"])
        let submit = try #require(form["actions"]?.arrayValue?.first)
        #expect(submit["kind"] == "submit")
        #expect(submit["title"] == "Save Note")
        let handler = try #require(submit["handler"]?.stringValue)
        // Missing title: validation error shown on the field.
        s.invoke(depth: 0, handler: handler, args: [["title": "", "body": "x", "pinned": false, "priority": "normal", "tags": []]])
        #expect(await waitUntil { (s.view(0)?["fields"]?.arrayValue ?? []).contains { $0["error"]?.stringValue?.isEmpty == false } }, "\(s.view(0) ?? .null)")
        s.invoke(depth: 0, handler: handler, args: [["title": "Milk", "body": "2 litres", "pinned": true, "priority": "high", "due": "2026-10-24T00:00:00.000Z", "tags": ["home"]]])
        #expect(await waitUntil { s.view(1)?["type"] == "detail" }, "\(s.logs)")
        #expect(s.view(1)?["markdown"]?.stringValue?.contains("**Milk**") == true)
        let stored = h.delegate.storage.values.first.map { "\($0)" } ?? ""
        #expect(stored.contains("Milk") && stored.contains("home"), "\(h.delegate.storage)")
        // Integration: the toast is sent after the detail push; under full-suite load it can land a beat later.
        #expect(await waitUntil { h.delegate.requests.contains { $0.method == "showToast" && $0.params[1] == "Saved \"Milk\"" } }, "\(h.delegate.requests.map(\.method))")
        s.kill()
    }

    @Test func colorsGridAndCache() async throws {
        let h = Harness()
        let ext = try h.install("raycast-fixtures/rc-colors")
        let s = try h.run(ext, "color-grid")
        #expect(await waitUntil { s.view(0)?["type"] == "grid" }, "\(s.logs)")
        let g = try #require(s.view(0))
        #expect(g["columns"] == 4)
        #expect(items(g).count == 14)
        #expect(items(g)[0]["content"] == "#FF6347")
        #expect(g["title"] == "Last copied: none")
        let copy = try #require(action(items(g)[0], "Copy Hex"))
        #expect(copy["kind"] == "copy" && copy["text"] == "#FF6347")
        s.invoke(depth: 0, handler: try #require(copy["callback"]?.stringValue))
        #expect(await waitUntil { s.view(0)?["title"] == "Last copied: #FF6347" })
        s.kill()
        // Cache persisted in the support dir: a new run reads it.
        let s2 = try h.run(ext, "color-grid")
        #expect(await waitUntil { s2.view(0)?["title"] == "Last copied: #FF6347" }, "\(s2.view(0)?["title"] ?? .null)")
        s2.kill()
    }

    @Test func fetchUseFetchSearchPagination() async throws {
        let server = try LocalHTTPServer { _, path, q in
            guard path == "/items" else { return (404, "text/plain", Data()) }
            let query = q["q"] ?? ""
            let page = Int(q["page"] ?? "0") ?? 0
            let all = (0..<12).map { ["id": "i\($0)", "name": "\(query.isEmpty ? "Item" : query) \($0)", "kind": $0 % 2 == 0 ? "even" : "odd"] }
            let slice = Array(all.dropFirst(page * 5).prefix(5))
            let body = try! JSONSerialization.data(withJSONObject: ["items": slice, "hasMore": (page + 1) * 5 < all.count])
            return (200, "application/json", body)
        }
        defer { server.stop() }
        let h = Harness()
        let ext = try h.install("raycast-fixtures/rc-fetch")
        let s = try h.run(ext, "search-items", prefs: ["baseUrl": .string(server.base)])
        #expect(await waitUntil { items(s.view(0)).count == 5 && s.view(0)?["isLoading"] == false }, "\(s.logs) \(s.view(0) ?? .null)")
        #expect(titles(s.view(0)).first == "Item 0")
        let v = try #require(s.view(0))
        #expect(v["pagination"]?["hasMore"] == true)
        s.invoke(depth: 0, handler: try #require(v["pagination"]?["handler"]?.stringValue))
        #expect(await waitUntil { items(s.view(0)).count == 10 }, "\(items(s.view(0)).count)")
        s.invoke(depth: 0, handler: try #require(v["searchHandler"]?.stringValue), args: ["kiwi"])
        #expect(await waitUntil { titles(s.view(0)).first == "kiwi 0" }, "\(titles(s.view(0)))")
        #expect(server.requests.contains("/items?q=kiwi&page=0"))
        s.kill()
    }
}
