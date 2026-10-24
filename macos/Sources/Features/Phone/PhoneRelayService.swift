import Foundation
import GlideCore

/// The iCloud Drive relay (docs/PHONE.md, "Transport 2"): watches `<root>/inbox`, runs each request through the
/// shared gate with the relay caller, writes `<root>/outbox/<id>.json` atomically and removes the inbox file.
///
/// - Wake-ups: a vnode DispatchSource per inbox (PhoneRelayFolderWatcher) plus a slow safety poll, because iCloud
///   sometimes lands files without an event the source sees.
/// - iCloud placeholders (`.<name>.icloud`) are asked to download; the real file shows up later.
/// - A file that is not valid JSON yet is a write in progress: retried until `partialGrace`, then answered with an error.
/// - Duplicate ids (a phone retried, iCloud delivered twice) are answered with the earlier reply and never run again.
@MainActor final class PhoneRelayService {
    typealias Perform = @MainActor (_ action: String, _ args: JSONValue, _ caller: PhoneCaller) async -> JSONValue

    let roots: [URL]
    private let perform: Perform
    /// Asks iCloud to download a placeholder's file (FileManager.startDownloadingUbiquitousItem). Tests replace it.
    var download: (URL) -> Void = { url in try? FileManager.default.startDownloadingUbiquitousItem(at: url) }
    var now: () -> Date = { Date() }
    var log: (String) -> Void = { _ in }
    var pollInterval: Duration = .seconds(5)

    private(set) var isRunning = false
    private var watchers: [String: PhoneRelayFolderWatcher] = [:]
    private var pollTask: Task<Void, Never>?
    private var scanTask: Task<Void, Never>?
    private var rescanRequested = false
    private var inFlight: Set<String> = []
    /// id → (when, the reply bytes), for duplicates.
    private var seen: [String: (at: Date, reply: Data)] = [:]
    private var downloadsRequested: [String: Date] = [:]
    private var lastPrune = Date.distantPast
    /// Counters for Settings and tests.
    private(set) var handled = 0
    private(set) var lastActivity: Date?
    var onActivity: () -> Void = {}

    /// `createRoots`: create the folders even when their iCloud container is missing (the test override).
    private let createRoots: Bool

    init(roots: [URL], createRoots: Bool, perform: @escaping Perform) {
        self.roots = roots
        self.createRoots = createRoots
        self.perform = perform
    }

    // MARK: lifecycle

    func start() {
        guard !isRunning else { return }
        isRunning = true
        for r in roots { prepare(r) }
        rewatch()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let interval = self?.pollInterval else { return }
                try? await Task.sleep(for: interval)
                guard let self, self.isRunning else { return }
                self.rewatch()
                self.requestScan()
            }
        }
        requestScan()
    }

    func stop() {
        isRunning = false
        pollTask?.cancel()
        pollTask = nil
        for w in watchers.values { w.cancel() }
        watchers.removeAll()
    }

    /// Creates `inbox/` and `outbox/`. The real iCloud roots are only created when their iCloud container exists,
    /// so a Mac without iCloud Drive (or without Shortcuts) does not get stray folders.
    private func prepare(_ root: URL) {
        let fm = FileManager.default
        if !createRoots {
            // .../com~apple~CloudDocs/Glide/Phone → container is two levels up; Shortcuts: .../Documents/Glide/Phone.
            let container = root.deletingLastPathComponent().deletingLastPathComponent()
            guard fm.fileExists(atPath: container.path) else { return }
        }
        try? fm.createDirectory(at: PhoneRelayPaths.inbox(root), withIntermediateDirectories: true)
        try? fm.createDirectory(at: PhoneRelayPaths.outbox(root), withIntermediateDirectories: true)
    }

    /// (Re)open a watcher for each inbox that exists and has none (or whose folder was replaced).
    private func rewatch() {
        for r in roots {
            let inbox = PhoneRelayPaths.inbox(r)
            if watchers[inbox.path] != nil { continue }
            if !FileManager.default.fileExists(atPath: inbox.path) { prepare(r) }
            guard let w = PhoneRelayFolderWatcher.make(url: inbox, onEvent: { [weak self] gone in
                guard let self else { return }
                if gone { self.watchers.removeValue(forKey: inbox.path)?.cancel() }
                self.requestScan()
            }) else { continue }
            watchers[inbox.path] = w
        }
    }

    // MARK: scanning

    /// Coalesces wake-ups: one scan at a time, and one more if something arrived during it.
    func requestScan() {
        guard isRunning else { return }
        if scanTask != nil { rescanRequested = true; return }
        scanTask = Task { [weak self] in
            guard let self else { return }
            repeat {
                self.rescanRequested = false
                await self.scanOnce(wait: false)
            } while self.rescanRequested && self.isRunning
            self.scanTask = nil
        }
    }

    /// One pass over every inbox. With `wait` it returns when every request found is answered (tests); wake-ups
    /// don't wait, so new files are picked up while a slow request (Glide Agent) is still running.
    func scanOnce(wait: Bool = true) async {
        let t = now()
        if t.timeIntervalSince(lastPrune) > 30 { prune(); lastPrune = t }
        var jobs: [(root: URL, entry: PhoneRelayIO.Entry)] = []
        for r in roots {
            let inbox = PhoneRelayPaths.inbox(r)
            let entries = await Task.detached(priority: .utility) { PhoneRelayIO.list(inbox) }.value
            for e in entries {
                if let target = PhoneRelayProtocol.placeholderTarget(e.name) {
                    requestDownload(inbox.appendingPathComponent(target))
                    continue
                }
                guard PhoneRelayProtocol.isCandidate(e.name), !inFlight.contains(e.url.path) else { continue }
                jobs.append((r, e))
            }
        }
        guard !jobs.isEmpty else { return }
        for j in jobs { inFlight.insert(j.entry.url.path) }
        // Each request runs on its own task, so an agent question does not hold up a clipboard send.
        let tasks = jobs.map { j in
            Task { [weak self] in
                await self?.handle(root: j.root, entry: j.entry)
                self?.inFlight.remove(j.entry.url.path)
            }
        }
        if wait { for t in tasks { await t.value } }
    }

    private func requestDownload(_ url: URL) {
        let t = now()
        if let last = downloadsRequested[url.path], t.timeIntervalSince(last) < 30 { return }
        downloadsRequested[url.path] = t
        if downloadsRequested.count > 256 { downloadsRequested = downloadsRequested.filter { t.timeIntervalSince($0.value) < 300 } }
        download(url)
    }

    private func handle(root: URL, entry e: PhoneRelayIO.Entry) async {
        let outbox = PhoneRelayPaths.outbox(root)
        let fallback = PhoneRelayProtocol.fallbackId(fileName: e.name)
        if e.size > PhoneRelayLimits.maxRequestBytes {
            finish(root: root, inboxFile: e.url, id: fallback, reply: PhoneRelayProtocol.errorReply(
                id: fallback, PhoneError("too-large", "That is too big to send through iCloud (25 MB at most). Try a smaller file or photo.")), remember: false)
            return
        }
        let url = e.url
        guard let data = await Task.detached(priority: .utility, operation: { PhoneRelayIO.read(url, max: PhoneRelayLimits.maxRequestBytes) }).value else {
            return // vanished or unreadable right now; the next scan retries
        }
        if data.count > PhoneRelayLimits.maxRequestBytes {
            finish(root: root, inboxFile: e.url, id: fallback, reply: PhoneRelayProtocol.errorReply(
                id: fallback, PhoneError("too-large", "That is too big to send through iCloud (25 MB at most). Try a smaller file or photo.")), remember: false)
            return
        }
        switch PhoneRelayProtocol.parse(data, fileName: e.name) {
        case let .incomplete(why):
            // Still syncing or being written: leave it, unless it has been sitting there broken for a while.
            if now().timeIntervalSince(e.modified) < PhoneRelayLimits.partialGrace {
                Task { [weak self] in
                    try? await Task.sleep(for: .seconds(1))
                    self?.requestScan()
                }
                return
            }
            finish(root: root, inboxFile: e.url, id: fallback, reply: PhoneRelayProtocol.errorReply(
                id: fallback, PhoneError("bad-request", "\(why) Rebuild the shortcut or add it again from Glide → Settings → iPhone.")), remember: false)
        case let .invalid(id, err):
            finish(root: root, inboxFile: e.url, id: id, reply: PhoneRelayProtocol.errorReply(id: id, err), remember: false)
        case let .request(req):
            if let prior = seen[req.id] {
                // Already answered (or running): never run twice. Put the reply back if the phone already removed it.
                let out = outbox.appendingPathComponent("\(req.id).json")
                if !prior.reply.isEmpty, !FileManager.default.fileExists(atPath: out.path) { PhoneRelayIO.writeAtomic(prior.reply, to: out) }
                PhoneRelayIO.remove(e.url)
                return
            }
            if now().timeIntervalSince(e.modified) > PhoneRelayLimits.maxRequestAge {
                finish(root: root, inboxFile: e.url, id: req.id, reply: PhoneRelayProtocol.errorReply(
                    id: req.id, PhoneError("expired", "This request waited more than an hour for the Mac, so Glide did not run it. Send it again.")), remember: true)
                return
            }
            // Claim the id before running, so a second copy that lands meanwhile is not run too.
            seen[req.id] = (now(), Data())
            log("relay \(req.action) id=\(req.id)")
            let outcome = await perform(req.action, req.args, PhoneRelayProtocol.caller)
            finish(root: root, inboxFile: e.url, id: req.id, reply: PhoneRelayProtocol.reply(id: req.id, outcome: outcome), remember: true)
        }
    }

    private func finish(root: URL, inboxFile: URL, id: String, reply: JSONValue, remember: Bool) {
        var data = PhoneRelayProtocol.encode(reply)
        if data.count > PhoneRelayLimits.maxReplyBytes {
            data = PhoneRelayProtocol.encode(PhoneRelayProtocol.errorReply(id: id, PhoneError("too-large", "The answer is too big to send through iCloud.")))
        }
        PhoneRelayIO.writeAtomic(data, to: PhoneRelayPaths.outbox(root).appendingPathComponent("\(id).json"))
        PhoneRelayIO.remove(inboxFile)
        if remember {
            seen[id] = (now(), data)
            trimSeen()
        }
        handled += 1
        lastActivity = now()
        onActivity()
    }

    private func trimSeen() {
        let t = now()
        if seen.count > PhoneRelayLimits.maxSeen || seen.values.contains(where: { t.timeIntervalSince($0.at) > PhoneRelayLimits.seenTTL }) {
            seen = seen.filter { t.timeIntervalSince($0.value.at) <= PhoneRelayLimits.seenTTL }
            if seen.count > PhoneRelayLimits.maxSeen {
                let keep = seen.sorted { $0.value.at > $1.value.at }.prefix(PhoneRelayLimits.maxSeen)
                seen = Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
            }
        }
    }

    // MARK: pruning

    /// Deletes outbox replies older than 10 minutes and our own temp files left by a crash.
    func prune() {
        let t = now()
        for r in roots {
            for e in PhoneRelayIO.list(PhoneRelayPaths.outbox(r)) {
                let age = t.timeIntervalSince(e.modified)
                if e.name.hasSuffix(".tmp") ? age > 60 : (!e.name.hasPrefix(".") && age > PhoneRelayLimits.outboxTTL) {
                    PhoneRelayIO.remove(e.url)
                }
            }
        }
    }

    /// For tests and Settings: is this id remembered as answered?
    func hasAnswered(_ id: String) -> Bool { seen[id].map { !$0.reply.isEmpty } ?? false }
}
