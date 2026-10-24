import Foundation
import Testing
@testable import GlideCore
@testable import GlideFeatures
@testable import GlideSystem

@Suite("phone clipboard mirror", .serialized)
@MainActor struct PhoneClipboardMirrorTests {
    let nowMs = Date().timeIntervalSince1970 * 1000

    @Test func rulesFollowClipboardHistory() {
        let s = ClipSettings()
        func text(_ snap: PasteboardSnapshot, _ settings: ClipSettings = ClipSettings()) -> String? {
            PhoneClipboardMirror.mirrorText(snap, settings: settings, nowMs: nowMs)
        }
        #expect(text(PasteboardSnapshot(types: ["public.utf8-plain-text"], text: "hello")) == "hello")
        // Password managers mark their copies concealed / transient: never mirrored.
        #expect(text(PasteboardSnapshot(types: ["public.utf8-plain-text", "org.nspasteboard.ConcealedType"], text: "hunter2")) == nil)
        #expect(text(PasteboardSnapshot(types: ["org.nspasteboard.TransientType"], text: "tmp")) == nil)
        #expect(text(PasteboardSnapshot(types: ["com.agilebits.onepassword"], text: "pw")) == nil)
        // Ignored apps (1Password by default).
        let fromIgnored = PasteboardSnapshot(types: ["public.utf8-plain-text"], text: "x", source: RunningAppInfo(name: "1Password", bundleId: "com.1password.1password", pid: 1, path: nil))
        #expect(text(fromIgnored) == nil)
        // Size cap: 64 KB of UTF-8.
        #expect(text(PasteboardSnapshot(text: String(repeating: "a", count: PhoneRelayLimits.maxClipboardBytes))) != nil)
        #expect(text(PasteboardSnapshot(text: String(repeating: "a", count: PhoneRelayLimits.maxClipboardBytes + 1))) == nil)
        #expect(text(PasteboardSnapshot(text: String(repeating: "é", count: PhoneRelayLimits.maxClipboardBytes / 2 + 1))) == nil)
        // Paused clipboard history, whitespace, files, images: left alone.
        var paused = s
        paused.paused = true
        #expect(text(PasteboardSnapshot(text: "x"), paused) == nil)
        #expect(text(PasteboardSnapshot(text: "  \n")) == nil)
        #expect(text(PasteboardSnapshot(text: "/a/b", files: ["/a/b"])) == nil)
        #expect(text(PasteboardSnapshot(png: Data([1]))) == nil)
    }

    @Test func mirrorsCopiesAndRemovesTheFileWhenTurnedOff() async throws {
        let env = try await RelayEnv()
        let root = RelayScratch.fresh("mirror")
        let m = PhoneClipboardMirror(roots: [root], services: env.services) { ClipSettings() }
        m.fallbackInterval = .milliseconds(30)
        let fake = try #require(PasteboardWatcherFactory.watcher(for: env.services) as? FakePasteboardWatcher)
        let file = PhoneRelayPaths.clipboard(root)
        await m.setOn(true)
        // Clipboard History's watcher is not running here: the fallback change-count check picks the copy up.
        fake.simulateCopy(PasteboardSnapshot(types: ["public.utf8-plain-text"], text: "copied on the Mac"))
        var mirrored: JSONValue?
        for _ in 0..<100 {
            try await Task.sleep(for: .milliseconds(20))
            if let d = try? Data(contentsOf: file), let v = JSONValue.parse(d), v["text"]?.stringValue == "copied on the Mac" { mirrored = v; break }
        }
        #expect(mirrored?["at"]?.intValue != nil)
        // A concealed copy leaves the last text in place.
        fake.simulateCopy(PasteboardSnapshot(types: ["org.nspasteboard.ConcealedType"], text: "password"))
        try await Task.sleep(for: .milliseconds(150))
        #expect((try? Data(contentsOf: file)).flatMap(JSONValue.parse)?["text"]?.stringValue == "copied on the Mac")
        // The shared watcher's fan-out (what ClipboardFeature posts) updates it too.
        PasteboardChangeObservers.notify(PasteboardSnapshot(types: ["public.utf8-plain-text"], text: "via the clipboard feature"))
        #expect((try? Data(contentsOf: file)).flatMap(JSONValue.parse)?["text"]?.stringValue == "via the clipboard feature")
        // Too big: not mirrored.
        PasteboardChangeObservers.notify(PasteboardSnapshot(text: String(repeating: "b", count: 70_000)))
        #expect((try? Data(contentsOf: file)).flatMap(JSONValue.parse)?["text"]?.stringValue == "via the clipboard feature")
        await m.setOn(false)
        #expect(!FileManager.default.fileExists(atPath: file.path))
        // Off means off.
        PasteboardChangeObservers.notify(PasteboardSnapshot(text: "after"))
        #expect(!FileManager.default.fileExists(atPath: file.path))
        await env.stop()
    }

    @Test func clipboardFeaturePostsToTheMirror() async throws {
        // The Clipboard feature's own watcher drives the mirror (no second poller).
        let env = try await RelayEnv()
        let clip = ClipboardFeature()
        await clip.start(context: env.context("clipboard"))
        var seen: [String] = []
        let token = PasteboardChangeObservers.add { s in if let t = s.text { seen.append(t) } }
        _ = try await clip.invoke(method: "debugSetClipboard", args: ["text": "from history"])
        PasteboardChangeObservers.remove(token)
        #expect(seen.contains("from history"))
        await clip.stop()
        await env.stop()
    }

    @Test func mirrorNeedsRelayClipboardGroupAndItsOwnSwitch() async throws {
        let env = try await RelayEnv()
        let file = PhoneRelayPaths.clipboard(URL(fileURLWithPath: try #require(ProcessInfo.processInfo.environment[PhoneRelayPaths.envOverride])))
        var r = try await env.feature.invoke(method: "relay.set", args: ["relay": true, "clipboardMirror": true])
        #expect(r["mirror"]?.boolValue == false) // Clipboard group is off
        env.store.setFeatureSettings("phone", ["groups": ["clipboard": true]])
        r = try await env.feature.invoke(method: "relay.set", args: [:])
        #expect(r["mirror"]?.boolValue == true)
        r = try await env.feature.invoke(method: "relay.set", args: ["clipboardMirror": false])
        #expect(r["mirror"]?.boolValue == false)
        #expect(!FileManager.default.fileExists(atPath: file.path))
        _ = try await env.feature.invoke(method: "relay.set", args: ["relay": false])
        await env.stop()
    }
}
