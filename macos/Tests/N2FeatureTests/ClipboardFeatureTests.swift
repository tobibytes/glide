import Foundation
import Testing
@testable import GlideCore
@testable import GlideFeatures
@testable import GlideSystem
import GlideUI

/// Minimal FeatureContext over a temp store and HEADLESS services (fake pasteboard, recorded side effects).
@MainActor final class N2TestContext: FeatureContext {
    let featureId: String
    let store: Store
    let services: SystemServices
    let log: SideEffectLog
    var toasts: [String] = []
    var hidden = 0
    var hotkeys: [String: String] = [:]
    init(featureId: String, store: Store, services: SystemServices, log: SideEffectLog) {
        self.featureId = featureId
        self.store = store
        self.services = services
        self.log = log
    }
    func dataDirectory() -> URL {
        let d = GlidePaths.featureDirectory(featureId, root: store.directory)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    func settings(defaults: [String: JSONValue]) -> [String: JSONValue] { store.settings.featureSettings(featureId, defaults: defaults) }
    func setSettings(_ patch: [String: JSONValue]) { store.setFeatureSettings(featureId, patch) }
    func refreshCatalogue() {}
    func showLauncher() {}
    func hideLauncher() { hidden += 1 }
    func push(_ view: ViewID, payload: JSONValue) {}
    func openSettings(page: String?) {}
    func toast(_ message: String, style: ToastStyle) { toasts.append(message) }
    func registerHotkey(key: String, accelerator: String?, handler: @escaping @MainActor () -> Void) -> Bool { hotkeys[key] = accelerator; return true }
    func executeItem(id: String, argument: String?) async -> ActionResult { .stay(message: nil) }
    func search(_ query: String) async -> [ScoredItem] { [] }
    func findItem(id: String) -> SearchItem? { nil }
    /// Calls to other features (the Keyboard feature owns the tap config): (feature.method, args).
    var calls: [(String, JSONValue)] = []
    func callFeature(_ featureId: String, method: String, args: JSONValue) async throws -> JSONValue {
        calls.append(("\(featureId).\(method)", args))
        return .null
    }
    func last(_ call: String) -> JSONValue? { calls.last { $0.0 == call }?.1 }
    /// Let fire-and-forget `callFeature` tasks run.
    func settle() async { for _ in 0..<5 { await Task.yield() } }
    func log(_ message: String) {}
}

@MainActor final class N2Env {
    /// Features hold their context weakly (the app owns contexts), so the test env keeps them alive.
    private var contexts: [N2TestContext] = []
    let dir: URL
    let store: Store
    let log: SideEffectLog
    let services: SystemServices
    init() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("n2-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        store = Store(directory: dir)
        _ = try store.load()
        log = SideEffectLog(echo: false)
        services = SystemServicesFactory.headless(log: log, environment: ["GLIDE_HEADLESS_SELECTION": "picked"])
    }
    func context(_ id: String) -> N2TestContext {
        let c = N2TestContext(featureId: id, store: store, services: services, log: log)
        contexts.append(c)
        return c
    }
    var fake: FakePasteboardWatcher? { PasteboardWatcherFactory.watcher(for: services) as? FakePasteboardWatcher }
    func cleanup() { try? FileManager.default.removeItem(at: dir) }
}

private let onePixelPNG = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!

@Suite("clipboard feature (headless)", .serialized)
@MainActor struct ClipboardFeatureTests {
    @Test func capturesTextSkipsConcealedIgnoredAndOwnWrites() async throws {
        let env = try N2Env()
        defer { env.cleanup() }
        let ctx = env.context("clipboard")
        let f = ClipboardFeature()
        await f.start(context: ctx)
        let fake = try #require(env.fake)
        #expect(env.services.isHeadless)

        fake.simulateCopy(PasteboardSnapshot(types: ["public.utf8-plain-text"], text: "hello world", html: "<b>hello</b> world"))
        fake.poll()
        fake.simulateCopy(PasteboardSnapshot(types: ["public.utf8-plain-text", "org.nspasteboard.ConcealedType"], text: "secret"))
        fake.poll()
        f.debugSource = SourceApp(name: "1Password", bundleId: "com.1password.1password")
        fake.simulateCopy(PasteboardSnapshot(types: ["public.utf8-plain-text"], text: "pw"))
        fake.poll()
        fake.simulateCopy(PasteboardSnapshot(types: ["public.utf8-plain-text"], text: "https://raycast.com"))
        fake.poll()
        #expect(f.entries.map(\.text) == ["https://raycast.com", "hello world"])
        #expect(f.entries[0].type == .link)
        #expect(f.entries[1].html == "<b>hello</b> world")
        // Another feature writing plain text through services.pasteboard is captured…
        env.services.pasteboard.setString("from Copy Path", html: nil, transient: false)
        fake.poll()
        #expect(f.entries.first?.text == "from Copy Path")
        // …but our own write is not re-captured, and copying moves the entry to the top.
        let hello = try #require(f.entries.first { $0.text == "hello world" })
        _ = f.copyEntry(hello)
        fake.poll()
        #expect(f.entries.count == 3)
        #expect(f.entries.first?.id == hello.id && f.entries.first?.count == 2)
        #expect(env.services.pasteboard.string() == "hello world")
        await f.stop()
    }

    @Test func pauseAndTimedPauseSkipCopies() async throws {
        let env = try N2Env()
        defer { env.cleanup() }
        let f = ClipboardFeature()
        await f.start(context: env.context("clipboard"))
        let fake = try #require(env.fake)
        _ = f.pauseFor(minutes: 5)
        #expect(f.settings.isPaused(now: f.now))
        fake.simulateCopy(PasteboardSnapshot(types: ["public.utf8-plain-text"], text: "while paused"))
        fake.poll()
        #expect(f.entries.isEmpty)
        _ = f.setPaused(false)
        fake.simulateCopy(PasteboardSnapshot(types: ["public.utf8-plain-text"], text: "after"))
        fake.poll()
        #expect(f.entries.map(\.text) == ["after"])
        #expect(env.store.settings.featureSettings("clipboard")["pausedUntil"]?.doubleValue == 0)
        await f.stop()
    }

    @Test func imagesFilesColorsAndPersistence() async throws {
        let env = try N2Env()
        defer { env.cleanup() }
        let f = ClipboardFeature()
        await f.start(context: env.context("clipboard"))
        let fake = try #require(env.fake)
        fake.simulateCopy(PasteboardSnapshot(types: ["public.file-url"], files: ["/etc/hosts", "/tmp"]))
        fake.poll()
        fake.simulateCopy(PasteboardSnapshot(types: ["com.apple.cocoa.pasteboard.color"], color: "#FF8800"))
        fake.poll()
        fake.simulateCopy(PasteboardSnapshot(types: ["public.png"], png: onePixelPNG))
        fake.poll()
        for _ in 0..<100 where !f.entries.contains(where: { $0.type == .image }) { try await Task.sleep(for: .milliseconds(20)) }
        #expect(f.entries.map(\.type) == [.image, .color, .file])
        let img = try #require(f.entries.first?.image)
        #expect(img.width == 1 && img.height == 1 && img.bytes == onePixelPNG.count)
        #expect(f.entries.first?.key == "i:\(ClipStorage.sha1Hex(onePixelPNG))")
        let st = try #require(f.storage)
        #expect(FileManager.default.fileExists(atPath: st.imageURL(img.sha1).path))
        #expect(FileManager.default.fileExists(atPath: st.thumbURL(img.sha1).path))
        #expect(ClipModel.title(f.entries[2]) == "hosts + 1 more")
        // paste an image → rich write recorded, never the real pasteboard
        _ = f.pasteEntry(f.entries[0], plain: false)
        #expect(env.log.all.contains { $0.kind == "clipboard-paste" && $0.detail["pngBytes"] != nil })
        f.flush()
        let reloaded = ClipStorage(directory: st.directory).loadHistory()
        #expect(reloaded.map(\.type) == [.image, .color, .file])
        // deleting the image removes its files
        f.delete([f.entries[0].id])
        #expect(!FileManager.default.fileExists(atPath: st.imageURL(img.sha1).path))
        await f.stop()
    }

    @Test func pasteStackNativeReplies() async throws {
        let env = try N2Env()
        defer { env.cleanup() }
        let ctx = env.context("clipboard")
        let f = ClipboardFeature()
        await f.start(context: ctx)
        let fake = try #require(env.fake)
        func intercept() async -> Bool? { await ctx.settle(); return ctx.last("keyboard.setPasteStack")?.boolValue }
        #expect(await intercept() == false) // empty stack: ⌘V is never intercepted
        // ⌘V interception is opt-in (off by default): with items waiting but the setting off, ⌘V is untouched.
        _ = f.startPasteStack(limit: 2)
        fake.simulateCopy(PasteboardSnapshot(types: ["public.utf8-plain-text"], text: "opt-in check"))
        fake.poll()
        #expect(await intercept() == false)
        f.stackClear()
        f.patchSettings(["stackInterceptPaste": true])
        _ = f.startPasteStack(limit: 2)
        for t in ["first", "second", "third"] { fake.simulateCopy(PasteboardSnapshot(types: ["public.utf8-plain-text"], text: t)); fake.poll() }
        #expect(!f.stack.collecting)
        #expect(f.stack.items.compactMap { f.entry($0)?.text } == ["first", "second"])
        #expect(await intercept() == true)
        #expect(f.nextForNativePaste().reply == .text("first", html: nil))
        #expect(await intercept() == true)
        #expect(f.nextForNativePaste().reply == .text("second", html: nil))
        #expect(await intercept() == false)
        #expect(f.nextForNativePaste().reply == .empty)
        // file entries are put on the pasteboard and the original ⌘V passes through
        fake.simulateCopy(PasteboardSnapshot(types: ["public.file-url"], files: ["/etc/hosts"]))
        fake.poll()
        f.stackAdd([f.entries[0].id])
        #expect(f.nextForNativePaste().reply == .passthrough)
        // the opt-out setting turns interception off even with items waiting
        f.stackAdd([f.entries[1].id])
        #expect(await intercept() == true)
        f.patchSettings(["stackInterceptPaste": false])
        #expect(await intercept() == false)
        // LIFO switch reverses waiting items
        f.patchSettings(["stackInterceptPaste": true])
        f.stackAdd([f.entries[2].id])
        let before = f.stack.items
        f.stackSetOrder(.lifo)
        #expect(f.stack.items == before.reversed())
        // ⌘V events from the tap reach the feature through the hub; the headless tap refuses the reply,
        // so the item is put back at the head (the watchdog semantics).
        let head = f.stack.items.first
        KeyboardTapComposer.shared(for: env.services).dispatch(.stackNext(reqId: 7))
        #expect(f.stack.items.first == head)
        await f.stop()
    }

    @Test func mergeEditSnippetAndRetention() async throws {
        let env = try N2Env()
        defer { env.cleanup() }
        let f = ClipboardFeature()
        await f.start(context: env.context("clipboard"))
        let fake = try #require(env.fake)
        for t in ["one", "two"] { fake.simulateCopy(PasteboardSnapshot(types: ["public.utf8-plain-text"], text: t)); fake.poll(); try await Task.sleep(for: .milliseconds(3)) }
        let merged = try #require(f.merge(f.entries.map(\.id), separator: " + "))
        #expect(merged.text == "one + two")
        #expect(merged.source?.name == "Glide")
        let edited = try #require(f.update(merged.id, text: "edited"))
        #expect(edited.key == ClipStorage.textKey("edited"))
        _ = f.saveAsSnippet(edited.id)
        #expect(env.store.data.snippets.contains { $0.text == "edited" })
        #expect(f.togglePin(edited.id))
        #expect(f.clearHistory(keepPinned: true) == 2)
        #expect(f.entries.map(\.text) == ["edited"])
        await f.stop()
    }

    @Test func historyViewKeysAndCommands() async throws {
        let env = try N2Env()
        defer { env.cleanup() }
        let f = ClipboardFeature()
        await f.start(context: env.context("clipboard"))
        let fake = try #require(env.fake)
        for t in ["alpha", "beta", "gamma"] { fake.simulateCopy(PasteboardSnapshot(types: ["public.utf8-plain-text"], text: t)); fake.poll(); try await Task.sleep(for: .milliseconds(3)) }
        let m = f.history
        m.prepare(payload: ClipboardFeature.freshPayload(), host: nil)
        #expect(m.rows().map(\.text) == ["gamma", "beta", "alpha"])
        #expect(m.handleCommand(.move(delta: 1)))
        #expect(m.selected?.text == "beta")
        #expect(m.handleKey(VimKey(" ")))        // Space marks
        #expect(m.handleKey(VimKey("ArrowDown", shift: true)))
        #expect(m.marked.count == 2 && m.selected?.text == "alpha")
        #expect(m.handleKey(VimKey("k", meta: true)))
        #expect(m.panel?.actions.contains { $0.id == "merge" } == true)
        #expect(m.handleKey(VimKey("Escape")))
        #expect(m.panel == nil)
        #expect(m.handleKey(VimKey("g", meta: true)))
        #expect(m.grid)
        #expect(m.handleKey(VimKey("p", meta: true)))
        #expect(m.menu != nil)
        // pick "Pinned" in the filter menu
        let pinnedIndex = try #require(m.menu?.options.firstIndex { $0.title == "Pinned" })
        for _ in 0..<pinnedIndex { _ = m.handleKey(VimKey("ArrowDown")) }
        _ = m.handleKey(VimKey("Enter"))
        #expect(m.filter == .pinned && m.rows().isEmpty)
        // ⌃X on a plain key never falls through to the root list
        #expect(m.handleKey(VimKey("x", ctrl: true)))
        await f.stop()
    }
}

@Suite("keyboard tap event hub")
@MainActor struct KeysComposerTests {
    @Test func pureMerge() {
        let c = KeyboardTapComposer.merge(["snippets2": .init(snippets: [.init(keyword: ";a", text: "A"), .init(keyword: ";abc", text: "ABC")], excludedBundleIds: ["com.x"]),
                                           "clipboard": .init(pasteStack: true),
                                           "zkeyboard": .init(snippets: [.init(keyword: ";a", text: "other")], excludedBundleIds: ["COM.X", "com.y"], hyperKey: true)])
        #expect(c.snippets.map(\.keyword) == [";abc", ";a"])
        #expect(c.snippets.last?.text == "A")
        #expect(c.excludedBundleIds == ["com.x", "com.y"])
        #expect(c.pasteStack && c.hyperKey)
    }

    @Test func dispatchesTapEventsToSubscribers() {
        let tap = HeadlessKeyboardTap(log: SideEffectLog(echo: false))
        let c = KeyboardTapComposer(tap: tap)
        #expect(tap.onEvent == nil) // the hub never takes the tap's single closure by itself
        c.attachToTap()
        var got: [String] = []
        c.subscribe("a") { e in if case let .stackNext(r) = e { got.append("a\(r)") } }
        c.subscribe("b") { e in if case let .snippetMatched(r, k, _, _) = e { got.append("b\(r)\(k)") } }
        tap.onEvent?(.stackNext(reqId: 1))
        tap.onEvent?(.snippetMatched(reqId: 2, keyword: ";x", id: "s", bundleId: nil))
        tap.onEvent?(.tapFailed(reason: "no permission"))
        #expect(got == ["a1", "b2;x"])
        #expect(c.lastError == "no permission")
    }
}

@Suite("snippets 2.0 feature (headless)", .serialized)
@MainActor struct Snippets2FeatureTests {
    @Test func tapListAndLiveRender() async throws {
        let env = try N2Env()
        defer { env.cleanup() }
        _ = env.store.mutate { d in
            d.snippets = [Snippet(id: "sig", name: "Signature", text: "best,{cursor} olu", keyword: "sig"),
                          Snippet(id: "re", name: "Reply", text: "Re: {clipboard} / {selection} {cursor}!!", keyword: "re", excludedApps: ["com.apple.Terminal"]),
                          Snippet(id: "rich", name: "Rich", text: "hello", keyword: "hi", html: "<b onclick=\"x()\">hello</b>")]
            d.settings.features["snippets"] = ["keywordPrefix": ";", "caseAdaptive": true, "excludedApps": ["com.apple.Notes"]]
        }
        let ctx = env.context("snippets2")
        let f = Snippets2Feature()
        await f.start(context: ctx)
        await ctx.settle()
        let sent = try #require(ctx.last("keyboard.setSnippets")?.arrayValue)
        #expect(Set(sent.compactMap { $0["keyword"]?.stringValue }) == [";sig", ";Sig", ";SIG", ";re", ";Re", ";RE", ";hi", ";Hi", ";HI"])
        let re = try #require(sent.first { $0["keyword"]?.stringValue == ";re" })
        #expect(re["excludedBundleIds"]?.arrayValue?.compactMap(\.stringValue) == ["com.apple.Terminal", "com.apple.Notes"])
        #expect(re["id"]?.stringValue == "re")
        env.services.pasteboard.setString("copied text", html: nil, transient: false)
        let r = try #require(await f.liveRender(keyword: ";Re", id: "re"))
        #expect(r.text == "Re: copied text / picked !!")
        #expect(r.cursorLeft == 2)
        let rich = try #require(await f.liveRender(keyword: ";HI", id: "rich"))
        #expect(rich.text == "HELLO" && rich.html == "<b>hello</b>")
        #expect(await f.liveRender(keyword: ";x", id: "gone") == nil)
        // Expansion on/off goes through the Keyboard feature (it owns the tap config).
        await f.setExpansion(false)
        #expect(ctx.last("keyboard.setExpandSnippets") == false)
        // A tap match is answered in-process: the event reaches the feature through the hub.
        KeyboardTapComposer.shared(for: env.services).dispatch(.snippetMatched(reqId: 3, keyword: ";sig", id: "sig", bundleId: nil))
        await f.stop()
    }

    @Test func pasteCopyImportAndHooks() async throws {
        let env = try N2Env()
        defer { env.cleanup() }
        _ = env.store.mutate { d in d.snippets = [Snippet(id: "d", name: "Dated", text: "On {date format=\"yyyy\"}: {cursor}x", keyword: ";d")] }
        let f = Snippets2Feature()
        await f.start(context: env.context("snippets2"))
        let s = try #require(env.store.data.snippets.first)
        _ = await f.paste(s)
        let paste = try #require(env.log.all.last(where: { $0.kind == "paste" }))
        #expect(paste.detail["text"]?.stringValue == "On \(Calendar.current.component(.year, from: Date())): x")
        #expect(env.log.all.contains { $0.kind == "cursor-left" && $0.detail["count"]?.intValue == 1 })
        _ = await f.copy(s)
        #expect(env.services.pasteboard.string()?.hasPrefix("On ") == true)
        let rep = try f.importJSON(#"[{"name":"Imported","text":"hi {browser-tab}","keyword":";d"},{"name":"Dated","text":"On {date format=\"yyyy\"}: {cursor}x"}]"#)
        #expect(rep.added == 1 && rep.duplicates == 1 && rep.keywordConflicts == 1 && rep.unsupported == ["{browser-tab}"])
        // `snippet:<id>` rows are Snippets2's own now (the phase-0 SnippetsFeature hook is gone): placeholders rendered
        let res = await f.run(action: "copy", on: ScoredItem(item: SearchItem(id: "snippet:d", kind: .snippet, title: "Dated"), score: 0), modifiers: [])
        #expect(res == .hide(message: "Snippet copied"))
        #expect(env.services.pasteboard.string()?.contains("{date") == false)
        await f.stop()
    }

    @Test func saveValidatesAndSettingsPersist() async throws {
        let env = try N2Env()
        defer { env.cleanup() }
        let f = Snippets2Feature()
        await f.start(context: env.context("snippets2"))
        #expect(throws: (any Error).self) { try f.save(Snippet(id: "", name: " ", text: "x")) }
        let saved = try f.save(Snippet(id: "", name: "Rich", text: "", keyword: " ;r ", html: "<p>Hi<script>x</script></p>"))
        #expect(saved.text == "Hi" && saved.html == "<p>Hi</p>" && saved.keyword == ";r" && saved.id.hasPrefix("sn-"))
        _ = f.setSettings(["keywordPrefix": " ! "])
        #expect(env.store.settings.featureSettings("snippets")["keywordPrefix"]?.stringValue == "!")
        let m = f.search
        m.prepare(payload: ClipboardFeature.freshPayload(), host: nil)
        #expect(m.rows().map(\.name).contains("Rich"))
        await f.stop()
    }
}
