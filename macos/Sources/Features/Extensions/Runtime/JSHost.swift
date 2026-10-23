import CryptoKit
import Darwin
import Foundation
import JavaScriptCore

/// One extension command running in its own `JSContext` on a dedicated serial queue (JSC objects are only
/// touched on that queue). Implements the native half of the bridge used by `entry.ts` (`__native`):
/// messages, logging, timers, fs, crypto, URL parsing, fetch (URLSession) and a limited execFile.
/// Messages to/from the extension use the Electron wire protocol (ChildMessage / ParentMessage JSON).
final class JSHost: @unchecked Sendable {
    struct Options: Sendable {
        /// process.env inside the extension.
        var environment: [String: String] = JSHost.defaultEnvironment()
        /// fetch() transport (tests inject a URLProtocol-backed session).
        var urlSession: URLSession = .shared
        /// nil: execFile/exec run natively. Otherwise the error every exec gets (headless runs).
        var execDenied: String?
        /// execFile("/usr/bin/osascript", …, stdin script) is routed here instead of a process.
        var appleScript: (@Sendable (String) async -> Result<String, Error>)?
        var execTimeout: TimeInterval = 30
        init() {}
    }

    static func defaultEnvironment() -> [String: String] {
        let e = ProcessInfo.processInfo.environment
        var out: [String: String] = [:]
        for k in ["HOME", "USER", "LOGNAME", "PATH", "LANG", "TMPDIR", "SHELL", "TZ"] { if let v = e[k] { out[k] = v } }
        if out["PATH"] == nil { out["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin" }
        return out
    }

    let label: String
    let queue: DispatchQueue
    private let options: Options
    private var context: JSContext?
    private var timers: [Int: Int] = [:]
    private var timerGeneration = 0
    private var tasks: [Int: URLSessionDataTask] = [:]
    private var processes: [Int: Process] = [:]
    private var stopped = false
    /// Extension → host messages (JSON text), delivered on the JS queue.
    var onMessage: (@Sendable (String) -> Void)?
    /// (level, text) console output and uncaught errors.
    var onLog: (@Sendable (String, String) -> Void)?

    init(label: String, options: Options = Options()) {
        self.label = label
        self.options = options
        queue = DispatchQueue(label: "glide.extension.\(label)", qos: .userInitiated)
    }

    deinit {
        for t in tasks.values { t.cancel() }
    }

    /// Creates the context, evaluates the runtime bundle and sends `init` (an InitPayload JSON object).
    func start(initPayload: String) {
        queue.async { [self] in
            guard !stopped else { return }
            let vm = JSVirtualMachine()
            guard let ctx = JSContext(virtualMachine: vm) else { return }
            ctx.name = "Glide Extension \(label)"
            context = ctx
            installNative(ctx)
            ctx.evaluateScript(ExtensionRuntimeJS.source, withSourceURL: URL(string: "glide://runtime/extension-runtime.js"))
            if checkException(ctx, "runtime") { return }
            call("start", [initPayload])
        }
    }

    /// Host → extension message (ParentMessage JSON).
    func send(_ json: String) {
        queue.async { [self] in call("receive", [json]) }
    }

    /// Runs `body` on the JS queue (tests).
    func sync<T>(_ body: (JSContext?) -> T) -> T { queue.sync { body(context) } }

    /// Stops timers, network and processes and drops the context. A JS busy loop cannot be interrupted
    /// (no public JSC termination API); its queue is simply abandoned.
    func stop() {
        queue.async { [self] in
            stopped = true
            timers = [:]
            for t in tasks.values { t.cancel() }
            tasks = [:]
            for p in processes.values where p.isRunning { p.terminate() }
            processes = [:]
            context = nil
        }
    }

    var isStopped: Bool { queue.sync { stopped } }

    // MARK: calling into JS

    private func call(_ fn: String, _ args: [Any]) {
        guard !stopped, let ctx = context else { return }
        guard let host = ctx.objectForKeyedSubscript("__glideHost"), !host.isUndefined else { return }
        host.invokeMethod(fn, withArguments: args)
        _ = checkException(ctx, fn)
    }

    @discardableResult
    private func checkException(_ ctx: JSContext, _ whereFrom: String) -> Bool {
        guard let e = ctx.exception else { return false }
        ctx.exception = nil
        let stack = e.objectForKeyedSubscript("stack")?.toString() ?? ""
        onLog?("error", "Uncaught (\(whereFrom)) \(e.toString() ?? "error")\(stack.isEmpty || stack == "undefined" ? "" : "\n\(stack)")")
        return true
    }

    // MARK: native bridge

    private func installNative(_ ctx: JSContext) {
        guard let native = JSValue(newObjectIn: ctx) else { return }
        func set(_ name: String, _ block: Any) { native.setObject(block, forKeyedSubscript: name as NSString) }

        let post: @convention(block) (String) -> Void = { [weak self] json in self?.onMessage?(json) }
        set("post", post)
        let log: @convention(block) (String, String) -> Void = { [weak self] level, text in self?.onLog?(level, text) }
        set("log", log)
        let monotonic: @convention(block) () -> Double = { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }
        set("monotonic", monotonic)
        let envBlock: @convention(block) () -> [String: String] = { [options] in options.environment }
        set("env", envBlock)
        let arch: @convention(block) () -> String = {
            #if arch(arm64)
            "arm64"
            #else
            "x64"
            #endif
        }
        set("arch", arch)
        let pid: @convention(block) () -> Int32 = { getpid() }
        set("pid", pid)
        let hostname: @convention(block) () -> String = { ProcessInfo.processInfo.hostName }
        set("hostname", hostname)
        let osRelease: @convention(block) () -> String = {
            var u = utsname()
            uname(&u)
            return withUnsafePointer(to: &u.release) { $0.withMemoryRebound(to: CChar.self, capacity: 256) { String(cString: $0) } }
        }
        set("osRelease", osRelease)

        let setTimer: @convention(block) (Int, Double) -> Void = { [weak self] id, ms in self?.scheduleTimer(id, ms) }
        set("setTimer", setTimer)
        let clearTimer: @convention(block) (Int) -> Void = { [weak self] id in
            self?.timers.removeValue(forKey: id)
        }
        set("clearTimer", clearTimer)

        let evaluate: @convention(block) (String, String) -> JSValue? = { source, file in
            guard let c = JSContext.current() else { return nil }
            let v = c.evaluateScript(source, withSourceURL: URL(fileURLWithPath: file))
            // A syntax error stays in c.exception and is rethrown to the caller when the block returns.
            return v
        }
        set("evaluate", evaluate)

        let randomBytes: @convention(block) (Int) -> String = { n in
            var b = [UInt8](repeating: 0, count: max(0, min(n, 1 << 20)))
            _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
            return Data(b).base64EncodedString()
        }
        set("randomBytes", randomBytes)
        let digest: @convention(block) (String, String) -> String = { alg, b64 in
            JSHost.digest(alg, Data(base64Encoded: b64) ?? Data()).base64EncodedString()
        }
        set("digest", digest)
        let hmac: @convention(block) (String, String, String) -> String = { alg, key, b64 in
            JSHost.hmac(alg, key: Data(base64Encoded: key) ?? Data(), data: Data(base64Encoded: b64) ?? Data()).base64EncodedString()
        }
        set("hmac", hmac)
        let urlParse: @convention(block) (String, JSValue) -> [String: String] = { input, base in
            JSHost.parseURL(input, base: base.isString ? base.toString() : nil) ?? ["error": "invalid"]
        }
        set("urlParse", urlParse)

        installFS(set)

        let fetch: @convention(block) (Int, String, String, String, JSValue, String) -> Void = { [weak self] id, url, method, headers, body, redirect in
            self?.startFetch(id: id, url: url, method: method, headersJSON: headers, bodyB64: body.isString ? body.toString() : nil, redirect: redirect)
        }
        set("fetch", fetch)
        let fetchAbort: @convention(block) (Int) -> Void = { [weak self] id in self?.tasks.removeValue(forKey: id)?.cancel() }
        set("fetchAbort", fetchAbort)
        let exec: @convention(block) (Int, String, String, String, JSValue) -> Void = { [weak self] id, file, args, opts, input in
            self?.startExec(id: id, file: file, argsJSON: args, optsJSON: opts, input: input.isString ? input.toString() : nil)
        }
        set("exec", exec)

        ctx.setObject(native, forKeyedSubscript: "__native" as NSString)
    }

    private func scheduleTimer(_ id: Int, _ ms: Double) {
        timerGeneration += 1
        let gen = timerGeneration
        timers[id] = gen
        queue.asyncAfter(deadline: .now() + .milliseconds(Int(max(0, ms.isFinite ? min(ms, 1e9) : 0)))) { [weak self] in
            guard let self, !self.stopped, self.timers[id] == gen else { return }
            self.timers[id] = nil
            self.call("timerFired", [id])
        }
    }

    // MARK: fs

    private static func errDict(_ error: Error) -> [String: Any] {
        let ns = error as NSError
        var code = "EIO"
        var posix: Int32 = Int32(ns.code)
        if ns.domain == NSPOSIXErrorDomain { posix = Int32(ns.code) }
        else if let u = ns.userInfo[NSUnderlyingErrorKey] as? NSError, u.domain == NSPOSIXErrorDomain { posix = Int32(u.code) }
        else if ns.domain == NSCocoaErrorDomain {
            switch ns.code {
            case NSFileNoSuchFileError, NSFileReadNoSuchFileError: posix = ENOENT
            case NSFileWriteFileExistsError: posix = EEXIST
            case NSFileReadNoPermissionError, NSFileWriteNoPermissionError: posix = EACCES
            default: posix = EIO
            }
        }
        switch posix {
        case ENOENT: code = "ENOENT"
        case EEXIST: code = "EEXIST"
        case EACCES, EPERM: code = "EACCES"
        case ENOTDIR: code = "ENOTDIR"
        case EISDIR: code = "EISDIR"
        case ENOTEMPTY: code = "ENOTEMPTY"
        default: break
        }
        return ["error": code == "ENOENT" ? "no such file or directory" : ns.localizedDescription, "code": code]
    }

    private static func posixErr(_ code: String, _ msg: String) -> [String: Any] { ["error": msg, "code": code] }

    private func installFS(_ set: (String, Any) -> Void) {
        let fm = FileManager.default
        let exists: @convention(block) (String) -> Bool = { fm.fileExists(atPath: $0) }
        set("fsExists", exists)
        let read: @convention(block) (String) -> [String: Any] = { p in
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: p, isDirectory: &isDir), isDir.boolValue { return JSHost.posixErr("EISDIR", "illegal operation on a directory") }
            do { return ["data": try Data(contentsOf: URL(fileURLWithPath: p)).base64EncodedString()] } catch { return JSHost.errDict(error) }
        }
        set("fsRead", read)
        let write: @convention(block) (String, String, Bool, Int) -> [String: Any] = { p, b64, append, mode in
            let data = Data(base64Encoded: b64) ?? Data()
            let dir = (p as NSString).deletingLastPathComponent
            var isDir: ObjCBool = false
            if !dir.isEmpty, !(fm.fileExists(atPath: dir, isDirectory: &isDir) && isDir.boolValue) { return JSHost.posixErr("ENOENT", "no such file or directory") }
            do {
                if append, let h = FileHandle(forWritingAtPath: p) {
                    defer { try? h.close() }
                    try h.seekToEnd()
                    try h.write(contentsOf: data)
                } else {
                    try data.write(to: URL(fileURLWithPath: p))
                }
                if mode >= 0 { try? fm.setAttributes([.posixPermissions: mode], ofItemAtPath: p) }
                return [:]
            } catch { return JSHost.errDict(error) }
        }
        set("fsWrite", write)
        let mkdir: @convention(block) (String, Bool) -> [String: Any] = { p, recursive in
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: p, isDirectory: &isDir) {
                return recursive && isDir.boolValue ? [:] : JSHost.posixErr("EEXIST", "file already exists")
            }
            do {
                try fm.createDirectory(atPath: p, withIntermediateDirectories: recursive)
                return ["created": p]
            } catch { return JSHost.errDict(error) }
        }
        set("fsMkdir", mkdir)
        let readdir: @convention(block) (String) -> [String: Any] = { p in
            do { return ["names": try fm.contentsOfDirectory(atPath: p).sorted()] } catch { return JSHost.errDict(error) }
        }
        set("fsReaddir", readdir)
        let stat: @convention(block) (String, Bool) -> [String: Any] = { p, follow in
            var st = Darwin.stat()
            let r: Int32
            if follow { r = cStat(p, &st) } else { r = lstat(p, &st) }
            if r != 0 { return JSHost.posixErr(errno == ENOENT ? "ENOENT" : "EIO", String(cString: strerror(errno))) }
            let fmt = st.st_mode & S_IFMT
            let type = fmt == S_IFDIR ? "dir" : fmt == S_IFLNK ? "link" : fmt == S_IFREG ? "file" : "other"
            let mtime = Double(st.st_mtimespec.tv_sec) * 1000 + Double(st.st_mtimespec.tv_nsec) / 1e6
            let birth = Double(st.st_birthtimespec.tv_sec) * 1000 + Double(st.st_birthtimespec.tv_nsec) / 1e6
            return ["type": type, "size": Int(st.st_size), "mode": Int(st.st_mode), "mtimeMs": mtime, "birthtimeMs": birth]
        }
        set("fsStat", stat)
        let rm: @convention(block) (String, Bool, Bool) -> [String: Any] = { p, recursive, force in
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: p, isDirectory: &isDir) else { return force ? [:] : JSHost.posixErr("ENOENT", "no such file or directory") }
            if isDir.boolValue, !recursive, ((try? fm.contentsOfDirectory(atPath: p))?.isEmpty == false) { return JSHost.posixErr("ENOTEMPTY", "directory not empty") }
            do { try fm.removeItem(atPath: p); return [:] } catch { return JSHost.errDict(error) }
        }
        set("fsRm", rm)
        let rename: @convention(block) (String, String) -> [String: Any] = { a, b in
            Darwin.rename(a, b) == 0 ? [:] : JSHost.posixErr(errno == ENOENT ? "ENOENT" : "EIO", String(cString: strerror(errno)))
        }
        set("fsRename", rename)
        let copy: @convention(block) (String, String) -> [String: Any] = { a, b in
            do {
                if fm.fileExists(atPath: b) { try fm.removeItem(atPath: b) }
                try fm.copyItem(atPath: a, toPath: b)
                return [:]
            } catch { return JSHost.errDict(error) }
        }
        set("fsCopy", copy)
        let realpath: @convention(block) (String) -> String? = { p in
            guard fm.fileExists(atPath: p) else { return nil }
            return URL(fileURLWithPath: p).resolvingSymlinksInPath().path
        }
        set("fsRealpath", realpath)
    }

    // MARK: crypto, URL

    static func digest(_ alg: String, _ d: Data) -> Data {
        switch alg {
        case "sha1": return Data(Insecure.SHA1.hash(data: d))
        case "md5": return Data(Insecure.MD5.hash(data: d))
        case "sha384": return Data(SHA384.hash(data: d))
        case "sha512": return Data(SHA512.hash(data: d))
        default: return Data(SHA256.hash(data: d))
        }
    }

    static func hmac(_ alg: String, key: Data, data: Data) -> Data {
        let k = SymmetricKey(data: key)
        switch alg {
        case "sha1": return Data(HMAC<Insecure.SHA1>.authenticationCode(for: data, using: k))
        case "md5": return Data(HMAC<Insecure.MD5>.authenticationCode(for: data, using: k))
        case "sha384": return Data(HMAC<SHA384>.authenticationCode(for: data, using: k))
        case "sha512": return Data(HMAC<SHA512>.authenticationCode(for: data, using: k))
        default: return Data(HMAC<SHA256>.authenticationCode(for: data, using: k))
        }
    }

    /// WHATWG-ish URL components via Foundation (enough for extension code: scheme, host, port, path, query).
    static func parseURL(_ input: String, base: String?) -> [String: String]? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        var url: URL?
        if let base {
            guard let b = URL(string: base, encodingInvalidCharacters: true), b.scheme != nil else { return nil }
            let rel = URL(string: trimmed, relativeTo: b) ?? trimmed.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed).flatMap { URL(string: $0, relativeTo: b) }
            url = rel?.absoluteURL
        } else {
            url = URL(string: trimmed, encodingInvalidCharacters: true)
        }
        guard let u = url, let scheme = u.scheme?.lowercased(), let c = URLComponents(url: u, resolvingAgainstBaseURL: true) else { return nil }
        let special = ["http", "https", "ws", "wss", "ftp", "file"].contains(scheme)
        if special && scheme != "file" && (c.host ?? "").isEmpty { return nil }
        var port = c.port.map(String.init) ?? ""
        if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") { port = "" }
        var pathname = c.percentEncodedPath
        if special && pathname.isEmpty { pathname = "/" }
        if special {
            // Resolve dot segments like WHATWG does.
            var out: [String] = []
            let parts = pathname.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
            for (i, p) in parts.enumerated() {
                if p == "." { if i == parts.count - 1 { out.append("") }; continue }
                if p == ".." { if !out.isEmpty { out.removeLast() }; if i == parts.count - 1 { out.append("") }; continue }
                out.append(String(p))
            }
            pathname = "/" + out.joined(separator: "/")
        }
        return [
            "protocol": "\(scheme):",
            "username": c.percentEncodedUser ?? "",
            "password": c.percentEncodedPassword ?? "",
            "hostname": (c.percentEncodedHost ?? "").lowercased(),
            "port": port,
            "pathname": pathname,
            "search": c.percentEncodedQuery.map { "?\($0)" } ?? "",
            "hash": c.percentEncodedFragment.map { "#\($0)" } ?? "",
        ]
    }

    // MARK: fetch

    private func startFetch(id: Int, url: String, method: String, headersJSON: String, bodyB64: String?, redirect: String) {
        guard let u = URL(string: url), let scheme = u.scheme?.lowercased(), ["http", "https", "data"].contains(scheme) else {
            deliverFetch(id, ["error": "unsupported URL \(url)"])
            return
        }
        var req = URLRequest(url: u, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        req.httpMethod = method
        if let data = headersJSON.data(using: .utf8), let pairs = try? JSONSerialization.jsonObject(with: data) as? [[String]] {
            for p in pairs where p.count == 2 { req.addValue(p[1], forHTTPHeaderField: p[0]) }
        }
        if let bodyB64, let body = Data(base64Encoded: bodyB64) { req.httpBody = body }
        if req.value(forHTTPHeaderField: "User-Agent") == nil { req.setValue("Glide-Extension/1.0", forHTTPHeaderField: "User-Agent") }
        let task = options.urlSession.dataTask(with: req) { [weak self] data, response, error in
            guard let self else { return }
            self.queue.async {
                guard self.tasks.removeValue(forKey: id) != nil else { return }
                if let error {
                    self.deliverFetch(id, ["error": error.localizedDescription])
                    return
                }
                let http = response as? HTTPURLResponse
                var headers: [[String]] = []
                for (k, v) in http?.allHeaderFields ?? [:] { headers.append(["\(k)".lowercased(), "\(v)"]) }
                self.deliverFetch(id, [
                    "status": http?.statusCode ?? 200,
                    "statusText": HTTPURLResponse.localizedString(forStatusCode: http?.statusCode ?? 200),
                    "url": response?.url?.absoluteString ?? url,
                    "headers": headers,
                    "body": (data ?? Data()).base64EncodedString(),
                ])
            }
        }
        tasks[id] = task
        _ = redirect
        task.resume()
    }

    private func deliverFetch(_ id: Int, _ result: [String: Any]) {
        let json = (try? JSONSerialization.data(withJSONObject: result)).map { String(decoding: $0, as: UTF8.self) } ?? #"{"error":"encode"}"#
        call("fetchDone", [id, json])
    }

    // MARK: exec (child_process.execFile / exec)

    private func deliverExec(_ id: Int, _ result: [String: Any]) {
        let json = (try? JSONSerialization.data(withJSONObject: result)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        queue.async { [self] in call("execDone", [id, json]) }
    }

    private func startExec(id: Int, file: String, argsJSON: String, optsJSON: String, input: String?) {
        let args = (try? JSONSerialization.jsonObject(with: Data(argsJSON.utf8)) as? [String]) ?? []
        let opts = (try? JSONSerialization.jsonObject(with: Data(optsJSON.utf8)) as? [String: Any]) ?? [:]
        if (file == "/usr/bin/osascript" || file == "osascript"), let runAS = options.appleScript {
            let script = input ?? args.split(separator: "-e").dropFirst().compactMap(\.first).joined(separator: "\n")
            Task {
                switch await runAS(script) {
                case let .success(out): deliverExec(id, ["code": 0, "stdout": out + "\n", "stderr": ""])
                case let .failure(err): deliverExec(id, ["code": 1, "stdout": "", "stderr": err.localizedDescription, "error": err.localizedDescription])
                }
            }
            return
        }
        if let denied = options.execDenied {
            deliverExec(id, ["code": -1, "error": denied, "stdout": "", "stderr": denied])
            return
        }
        let p = Process()
        if file.contains("/") { p.executableURL = URL(fileURLWithPath: file); p.arguments = args }
        else { p.executableURL = URL(fileURLWithPath: "/usr/bin/env"); p.arguments = [file] + args }
        var env = options.environment
        if let extra = opts["env"] as? [String: Any] { for (k, v) in extra { env[k] = "\(v)" } }
        p.environment = env
        if let cwd = opts["cwd"] as? String { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        let out = Pipe(), err = Pipe(), inp = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = inp
        let outBuf = LockedData(), errBuf = LockedData()
        out.fileHandleForReading.readabilityHandler = { h in outBuf.append(h.availableData) }
        err.fileHandleForReading.readabilityHandler = { h in errBuf.append(h.availableData) }
        let timeout = (opts["timeout"] as? Double).flatMap { $0 > 0 ? $0 / 1000 : nil } ?? options.execTimeout
        let killed = LockedFlag()
        p.terminationHandler = { [weak self] proc in
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil
            outBuf.append(out.fileHandleForReading.readDataToEndOfFile())
            errBuf.append(err.fileHandleForReading.readDataToEndOfFile())
            guard let host = self else { return }
            host.queue.async { host.processes[id] = nil }
            host.deliverExec(id, ["code": Int(proc.terminationStatus), "stdout": outBuf.string, "stderr": errBuf.string, "killed": killed.value])
        }
        do {
            try p.run()
            processes[id] = p
            if let input { inp.fileHandleForWriting.write(Data(input.utf8)) }
            try? inp.fileHandleForWriting.close()
            queue.asyncAfter(deadline: .now() + timeout) { if p.isRunning { killed.set(); p.terminate() } }
        } catch {
            deliverExec(id, ["code": -1, "error": error.localizedDescription, "stdout": "", "stderr": ""])
        }
    }
}

final class LockedData: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    func append(_ d: Data) { lock.lock(); data.append(d); lock.unlock() }
    var string: String { lock.lock(); defer { lock.unlock() }; return String(decoding: data.prefix(16 << 20), as: UTF8.self) }
}

final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    func set() { lock.lock(); flag = true; lock.unlock() }
    var value: Bool { lock.lock(); defer { lock.unlock() }; return flag }
}

private func cStat(_ p: String, _ st: inout Darwin.stat) -> Int32 { stat(p, &st) }
