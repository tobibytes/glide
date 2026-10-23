import Foundation
import GlideCore

/// Headless pasteboard watcher (session N2): never reads or writes the real pasteboard.
///
/// It layers on the headless `FakePasteboard` (services.pasteboard): plain-text writes by any feature show up as
/// changes, and `simulateCopy` stands in for "another app copied this" (images, files, HTML, concealed types, a
/// source app). Rich writes (images, files) are kept here and recorded as `[headless] clipboard-write`; pastes as
/// `[headless] clipboard-paste`. Polls on the main run loop like the real one; tests can call `poll()` directly.
@MainActor public final class FakePasteboardWatcher: PasteboardWatching {
    public var onChange: ((PasteboardSnapshot) -> Void)?
    public private(set) var isWatching = false
    let base: FakePasteboard?
    let log: SideEffectLog
    private var simulated: PasteboardSnapshot?
    private var simulatedAtBase = -1
    private var ownCount = 0
    private var lastSeen = Int.min
    private var ignored: Set<Int> = []
    private var timer: Timer?

    public init(base: FakePasteboard?, log: SideEffectLog) {
        self.base = base
        self.log = log
    }

    public var changeCount: Int { (base?.changeCount ?? 0) + ownCount }

    public func start(interval: TimeInterval) {
        guard timer == nil else { return }
        isWatching = true
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
        poll()
    }

    public func stop() {
        timer?.invalidate()
        timer = nil
        isWatching = false
    }

    /// Deliver a pending change now (tests).
    public func poll() {
        let c = changeCount
        guard c != lastSeen else { return }
        lastSeen = c
        if ignored.contains(c) { return }
        onChange?(current())
    }

    public func current() -> PasteboardSnapshot {
        if var sim = simulated, simulatedAtBase == (base?.changeCount ?? 0) {
            sim.changeCount = changeCount
            return sim
        }
        var types: [String] = []
        if base?.text != nil { types.append("public.utf8-plain-text") }
        if base?.html != nil { types.append("public.html") }
        return PasteboardSnapshot(changeCount: changeCount, types: types, text: base?.text, html: base?.html)
    }

    /// "Another app copied this" (test channel: clipboard.debugSetClipboard).
    public func simulateCopy(_ snapshot: PasteboardSnapshot) {
        ownCount += 1
        simulated = snapshot
        simulatedAtBase = base?.changeCount ?? 0
    }

    @discardableResult
    public func write(_ content: PasteboardContent) -> Int {
        if content.files.isEmpty, content.png == nil, let base {
            base.setString(content.text ?? "", html: content.html, transient: false)
        } else {
            ownCount += 1
            simulated = PasteboardSnapshot(types: content.files.isEmpty ? ["public.png"] : ["public.file-url"], text: content.files.isEmpty ? content.text : content.files.joined(separator: "\n"),
                                           html: content.html, png: content.png, files: content.files)
            simulatedAtBase = base?.changeCount ?? 0
            log.record("clipboard-write", Self.describe(content))
        }
        let c = changeCount
        ignored.insert(c)
        return c
    }

    public func paste(_ content: PasteboardContent) {
        write(content)
        log.record("clipboard-paste", Self.describe(content))
    }

    public func read() async -> PasteboardSnapshot { current() }

    static func describe(_ c: PasteboardContent) -> JSONValue {
        var o: [String: JSONValue] = [:]
        if let t = c.text { o["text"] = .string(String(t.prefix(200))) }
        if let h = c.html { o["html"] = .string(String(h.prefix(200))) }
        if c.rtf != nil { o["rtf"] = true }
        if let p = c.png { o["pngBytes"] = .int(Int64(p.count)) }
        if !c.files.isEmpty { o["files"] = .array(c.files.map(JSONValue.string)) }
        return .object(o)
    }
}
