import AppKit
import Foundation
import GlideCore
import GlideSystem

/// The app's WorkflowEnvironment: OS effects go through `SystemServices` (headless fakes record them);
/// shell, AppleScript, HTTP and sounds use native runners when not headless.
@MainActor final class ServicesWorkflowEnvironment: WorkflowEnvironment {
    weak var context: FeatureContext?
    /// Launcher prompts and result views (owned by the feature).
    let prompts: WorkflowPrompts
    /// Records effects the SystemServices fakes do not cover (`[headless] http …` lines).
    let headlessLog: SideEffectLog?

    init(context: FeatureContext, prompts: WorkflowPrompts) {
        self.context = context
        self.prompts = prompts
        headlessLog = context.services.isHeadless ? (SideEffectLog.current ?? SideEffectLog(echo: true)) : nil // integration: the app's log
    }

    private var services: SystemServices {
        get throws {
            guard let s = context?.services else { throw WorkflowStepError("Glide is shutting down") }
            return s
        }
    }
    private var headless: Bool { context?.services.isHeadless ?? true }

    func workflow(id: String) -> Workflow? { context?.store.data.workflows.first { $0.id == id } }

    func openApp(_ app: String) async throws {
        let r = try services.workspace.launchApplication(app)
        if !r.ok { throw WorkflowStepError(r.error ?? "Could not open \(app)") }
    }

    func openURL(_ url: URL) async throws {
        let r = try services.workspace.open(url: url, withApp: nil)
        if !r.ok { throw WorkflowStepError(r.error ?? "Could not open \(url.absoluteString)") }
    }

    func openFile(_ path: String) async throws {
        guard headless || FileManager.default.fileExists(atPath: path) else { throw WorkflowStepError("No such file: \(path)") }
        let r = try services.workspace.open(path: path)
        if !r.ok { throw WorkflowStepError(r.error ?? "Could not open \(path)") }
    }

    func runShell(_ command: String, shell: String, timeout: TimeInterval) async throws -> ShellResult {
        if headless { return try await services.scripts.runShell(command, shell: shell, timeout: timeout) }
        return try await LoginShellRunner.run(command, shell: shell, timeout: timeout)
    }

    func runAppleScript(_ source: String) async throws -> String {
        if headless { return try await services.scripts.runAppleScript(source) }
        return try await AppleScriptRunner.shared.run(source)
    }

    func typeText(_ text: String) async throws {
        context?.hideLauncher()
        try await Task.sleep(for: .milliseconds(headless ? 0 : 150))
        try services.paste.paste(text: text, html: nil)
    }

    func readClipboard() -> String { context?.services.pasteboard.string() ?? "" }
    func writeClipboard(_ text: String) { context?.services.pasteboard.setString(text, html: nil, transient: false) }

    func notify(title: String, body: String) async throws { try services.notifications.notify(title: title, body: body) }

    func sleep(seconds: Double) async throws {
        guard seconds > 0 else { return }
        try await Task.sleep(for: .milliseconds(Int(seconds * 1000)))
    }

    func askInput(prompt: String, placeholder: String?) async -> String? { await prompts.ask(prompt: prompt, placeholder: placeholder) }
    func showResult(text: String, title: String?) { prompts.showResult(text: text, title: title) }

    func http(method: String, url: URL, headers: [String: String], body: String?, timeout: TimeInterval) async throws -> (status: Int, body: String) {
        if let log = headlessLog {
            // Headless runs never reach the network: recorded, answered with an empty 200.
            log.record("http", ["method": .string(method), "url": .string(url.absoluteString), "body": body.map(JSONValue.string) ?? .null])
            return (200, "")
        }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if let body { req.httpBody = Data(body.utf8) }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            return ((resp as? HTTPURLResponse)?.statusCode ?? 0, String(decoding: data, as: UTF8.self))
        } catch let e as URLError where e.code == .timedOut {
            throw WorkflowStepError("Request timed out after \(Int(timeout)) s")
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        }
    }

    func playSound(_ name: String) async throws {
        if let log = headlessLog {
            log.record("sound", ["name": .string(name)])
            return
        }
        guard let s = NSSound(named: NSSound.Name(name)) ?? NSSound(contentsOfFile: "/System/Library/Sounds/\(name).aiff", byReference: true) else {
            throw WorkflowStepError("No system sound called \(name)")
        }
        s.play()
    }

    func selectedText() async -> String { await context?.services.selection.selectedText().text ?? "" }
    func now() -> Date { Date() }
}

/// `Process` running `<shell> -l -c <command>` (the user's login environment, like the Electron `zsh()` helper).
/// Output is drained while the process runs (no pipe-buffer deadlock); terminated after `timeout`.
enum LoginShellRunner {
    static func run(_ command: String, shell: String, timeout: TimeInterval) async throws -> ShellResult {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: FileManager.default.isExecutableFile(atPath: shell) ? shell : "/bin/zsh")
        p.arguments = ["-l", "-c", command]
        p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        p.standardInput = FileHandle.nullDevice
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        let outBuf = Buffer(), errBuf = Buffer()
        out.fileHandleForReading.readabilityHandler = { h in outBuf.append(h.availableData) }
        err.fileHandleForReading.readabilityHandler = { h in errBuf.append(h.availableData) }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<ShellResult, Error>) in
                let once = Once()
                p.terminationHandler = { proc in
                    out.fileHandleForReading.readabilityHandler = nil
                    err.fileHandleForReading.readabilityHandler = nil
                    outBuf.append(out.fileHandleForReading.readDataToEndOfFile())
                    errBuf.append(err.fileHandleForReading.readDataToEndOfFile())
                    var stderr = errBuf.string
                    if once.timedOut { stderr = "Timed out after \(Int(timeout)) s" + (stderr.isEmpty ? "" : "\n" + stderr) }
                    once.resume { cont.resume(returning: ShellResult(status: once.timedOut && proc.terminationStatus == 0 ? 124 : proc.terminationStatus, stdout: outBuf.string, stderr: stderr)) }
                }
                do { try p.run() } catch {
                    once.resume { cont.resume(throwing: WorkflowStepError("Could not start \(shell): \(error.localizedDescription)")) }
                    return
                }
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                    if p.isRunning {
                        once.timedOut = true
                        p.terminate()
                    }
                }
            }
        } onCancel: {
            if p.isRunning { p.terminate() }
        }
    }

    final class Buffer: @unchecked Sendable {
        private let lock = NSLock()
        private var data = Data()
        func append(_ d: Data) { lock.lock(); data.append(d); lock.unlock() }
        var string: String { lock.lock(); defer { lock.unlock() }; return String(decoding: data, as: UTF8.self) }
    }

    final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false
        private var _timedOut = false
        var timedOut: Bool {
            get { lock.lock(); defer { lock.unlock() }; return _timedOut }
            set { lock.lock(); _timedOut = newValue; lock.unlock() }
        }
        func resume(_ f: () -> Void) {
            lock.lock()
            let first = !done
            done = true
            lock.unlock()
            if first { f() }
        }
    }
}

/// NSAppleScript on one dedicated serial thread (NSAppleScript is not thread-safe; keeps the UI responsive).
final class AppleScriptRunner: @unchecked Sendable {
    static let shared = AppleScriptRunner()
    private let queue = DispatchQueue(label: "dev.glide.workflows.applescript", qos: .userInitiated)

    func run(_ source: String) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            queue.async {
                guard let script = NSAppleScript(source: source) else {
                    cont.resume(throwing: WorkflowStepError("Could not compile the AppleScript"))
                    return
                }
                var error: NSDictionary?
                let result = script.executeAndReturnError(&error)
                if let error {
                    let msg = error[NSAppleScript.errorMessage] as? String ?? "AppleScript error"
                    let num = error[NSAppleScript.errorNumber] as? Int
                    cont.resume(throwing: WorkflowStepError(num.map { "\(msg) (\($0))" } ?? msg))
                    return
                }
                cont.resume(returning: Self.text(result))
            }
        }
    }

    /// osascript-like rendering of the result descriptor (strings unquoted, lists comma-separated).
    static func text(_ d: NSAppleEventDescriptor) -> String {
        if d.descriptorType == typeAEList {
            guard d.numberOfItems > 0 else { return "" }
            return (1...d.numberOfItems).compactMap { d.atIndex($0).map(text) }.joined(separator: ", ")
        }
        if d.descriptorType == typeNull { return "" }
        return d.stringValue ?? ""
    }
}
