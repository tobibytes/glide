import Foundation
import GlideCore

struct SessionInfo: Hashable, Sendable {
    var id: String
    var extName: String
    var extTitle: String
    var commandName: String
    var commandTitle: String
    /// "view" | "no-view" | "menu-bar"
    var mode: String
    /// "glide" | "raycast"
    var runtime: String
    /// "userInitiated" | "background"
    var launchType: String
    var assetsPath: String
}

@MainActor protocol ExtensionSessionDelegate: AnyObject {
    /// An extension request (RequestMethod in src/extension-api/types.ts). Throw to reject.
    func session(_ s: ExtensionSession, request method: String, params: [JSONValue]) async throws -> JSONValue
    func sessionDidChange(_ s: ExtensionSession, _ event: ExtensionSession.Event)
}

/// One running command: a JSHost plus the view stack it rendered (port of sessions.ts).
@MainActor final class ExtensionSession {
    enum Event: Equatable {
        case render(depth: Int)
        case push(depth: Int)
        case pop(depth: Int)
        case failureToast(String)
        case ended
    }

    struct Completion: Equatable, Sendable {
        var ok: Bool
        var error: String?
    }

    let info: SessionInfo
    private let host: JSHost
    private weak var delegate: ExtensionSessionDelegate?
    private(set) var views: [JSONValue] = []
    private(set) var alive = true
    private(set) var done = false
    private var completion: Completion?
    private var waiters: [CheckedContinuation<Completion, Never>] = []
    private(set) var logs: [String] = []
    private(set) var lastActivity = Date()
    var inFlight = 0
    /// Depths currently shown in the launcher.
    var mounted: Set<Int> = []
    private var closeTask: Task<Void, Never>?

    init(info: SessionInfo, delegate: ExtensionSessionDelegate, options: JSHost.Options) {
        self.info = info
        self.delegate = delegate
        host = JSHost(label: "\(info.extName).\(info.commandName).\(info.id)", options: options)
        host.onMessage = { [weak self] json in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.receive(json) } }
        }
        host.onLog = { [weak self] level, text in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.appendLog(level, text) } }
        }
    }

    func start(initPayload: JSONValue) {
        host.start(initPayload: Self.encode(initPayload))
    }

    static func encode(_ v: JSONValue) -> String { String(decoding: (try? JSONEncoder.glideCompact.encode(v)) ?? Data("null".utf8), as: UTF8.self) }

    func view(_ depth: Int) -> JSONValue? { depth >= 0 && depth < views.count ? views[depth] : nil }
    var depth: Int { views.count - 1 }

    private func appendLog(_ level: String, _ text: String) {
        logs.append("[\(level)] \(text)")
        if logs.count > 300 { logs.removeFirst(logs.count - 300) }
    }

    // MARK: host → extension

    private func post(_ msg: JSONValue) {
        guard alive else { return }
        host.send(Self.encode(msg))
    }

    @discardableResult
    func invoke(depth: Int, handler: String, args: [JSONValue] = []) -> Bool {
        guard alive else { return false }
        lastActivity = Date()
        post(["type": "invoke", "depth": .int(Int64(depth)), "handler": .string(handler), "args": .array(args)])
        return true
    }

    /// The launcher shows `depth` on top: deeper views were popped.
    func mount(_ depth: Int) {
        mounted.insert(depth)
        mounted = mounted.filter { $0 <= depth }
        lastActivity = Date()
        closeTask?.cancel()
        closeTask = nil
        if views.count > depth + 1 {
            views.removeLast(views.count - depth - 1)
            post(["type": "closeView", "depth": .int(Int64(depth + 1))])
        }
    }

    /// A view left the screen; with none left the session stops after a grace period.
    func unmount(_ depth: Int, grace: Duration = .milliseconds(1500)) {
        mounted.remove(depth)
        lastActivity = Date()
        guard mounted.isEmpty else { return }
        closeTask?.cancel()
        closeTask = Task { [weak self] in
            try? await Task.sleep(for: grace)
            guard !Task.isCancelled, let self, self.mounted.isEmpty else { return }
            self.kill()
        }
    }

    func kill() {
        guard alive else { return }
        alive = false
        closeTask?.cancel()
        host.stop()
        finish(Completion(ok: done, error: done ? nil : "Stopped"))
        delegate?.sessionDidChange(self, .ended)
    }

    private func finish(_ c: Completion) {
        guard completion == nil else { return }
        completion = c
        for w in waiters { w.resume(returning: c) }
        waiters = []
    }

    /// Resolves when the command function returns or throws (no-view commands), or the session stops.
    func waitForCompletion() async -> Completion {
        if let completion { return completion }
        return await withCheckedContinuation { waiters.append($0) }
    }

    // MARK: extension → host

    private func receive(_ json: String) {
        guard alive, let msg = try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)) else { return }
        let type = msg["type"]?.stringValue ?? ""
        if type != "render" { lastActivity = Date() }
        let depth = msg["depth"]?.intValue ?? 0
        switch type {
        case "render":
            if info.mode == "no-view" { appendLog("warn", "render() ignored in a no-view command"); return }
            if depth > 0 && view(depth) == nil { return }
            setView(depth, msg["view"] ?? .null)
            delegate?.sessionDidChange(self, .render(depth: depth))
        case "push":
            if depth > views.count { return }
            views = Array(views.prefix(depth))
            setView(depth, msg["view"] ?? .null)
            delegate?.sessionDidChange(self, .push(depth: depth))
        case "pop":
            delegate?.sessionDidChange(self, .pop(depth: depth))
        case "request":
            handleRequest(msg)
        case "done":
            done = true
            finish(Completion(ok: true))
            if info.mode == "no-view" || views.isEmpty {
                kill()
            }
        case "error":
            let message = msg["message"]?.stringValue ?? "Error"
            appendLog("error", msg["stack"]?.stringValue ?? message)
            if info.mode == "no-view" {
                finish(Completion(ok: false, error: message))
                kill()
            } else if views.isEmpty {
                setView(0, Self.errorView(info, message, msg["stack"]?.stringValue))
                finish(Completion(ok: false, error: message))
                delegate?.sessionDidChange(self, .render(depth: 0))
            } else {
                delegate?.sessionDidChange(self, .failureToast(message))
            }
        case "log":
            appendLog(msg["level"]?.stringValue ?? "log", msg["text"]?.stringValue ?? "")
        default: break
        }
    }

    private func setView(_ depth: Int, _ v: JSONValue) {
        if depth < views.count { views[depth] = v } else {
            while views.count < depth { views.append(.null) }
            views.append(v)
        }
    }

    private func handleRequest(_ msg: JSONValue) {
        guard let id = msg["id"]?.intValue else { return }
        let method = msg["method"]?.stringValue ?? ""
        let params = msg["params"]?.arrayValue ?? []
        inFlight += 1
        Task { @MainActor [weak self] in
            guard let self else { return }
            var res: JSONValue = ["type": "response", "id": .int(Int64(id))]
            do {
                let r = try await self.delegate?.session(self, request: method, params: params) ?? .null
                if case var .object(o) = res { o["result"] = r; res = .object(o) }
            } catch {
                if case var .object(o) = res { o["error"] = .string(error.localizedDescription); res = .object(o) }
            }
            self.inFlight -= 1
            self.lastActivity = Date()
            if id >= 0 { self.post(res) }
        }
    }

    static func errorView(_ info: SessionInfo, _ message: String, _ stack: String?) -> JSONValue {
        let trace = stack.map { "\n\n```\n" + $0.split(separator: "\n").prefix(12).joined(separator: "\n") + "\n```" } ?? ""
        return [
            "type": "detail", "title": "Extension error", "markdown": .string("# \(info.commandTitle) failed\n\n\(message)\(trace)"),
            "metadata": [["label": "Extension", "text": .string(info.extTitle)], ["label": "Command", "text": .string(info.commandName)]],
            "actions": [], "isLoading": false,
        ]
    }
}
