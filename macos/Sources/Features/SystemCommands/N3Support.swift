import AppKit
import GlideCore
import GlideSystem
import GlideUI
import SwiftUI

// Shared helpers for the session-N3 features (windows, layouts, menus, keyboard, finder, processes, sysmon,
// syscmds): argv command steps with a headless recorder, `[headless]` side-effect lines, and keyboard
// navigation + rendering for pushed launcher lists.

// MARK: - command steps

/// One argv invocation (no shell). Planned by pure code so tests can assert exactly what would run.
public struct CommandStep: Hashable, Sendable, Codable {
    public var cmd: String
    public var args: [String]
    /// Written to stdin (osascript -).
    public var input: String?
    public var cwd: String?
    /// A non-zero exit is fine (killall when the process is not running, `defaults read` of a missing key).
    public var allowFail: Bool
    public init(cmd: String, args: [String], input: String? = nil, cwd: String? = nil, allowFail: Bool = false) {
        self.cmd = cmd
        self.args = args
        self.input = input
        self.cwd = cwd
        self.allowFail = allowFail
    }

    var json: JSONValue {
        var o: [String: JSONValue] = ["cmd": .string(cmd), "args": .array(args.map(JSONValue.string))]
        if let input { o["input"] = .string(input) }
        if let cwd { o["cwd"] = .string(cwd) }
        return .object(o)
    }
}

public struct StepOutput: Hashable, Sendable {
    public var status: Int32
    public var stdout: String
    public var stderr: String
    public init(status: Int32, stdout: String, stderr: String) {
        self.status = status
        self.stdout = stdout
        self.stderr = stderr
    }
}

public enum StepError: Error, LocalizedError, Equatable {
    case failed(String)
    public var errorDescription: String? { if case let .failed(m) = self { return m }; return nil }
}

@MainActor public protocol StepRunning: AnyObject {
    func run(_ step: CommandStep) async -> StepOutput
}

public extension StepRunning {
    /// Runs every step; throws on the first failure that is not `allowFail`. Returns the last stdout.
    @discardableResult
    func runAll(_ steps: [CommandStep]) async throws -> String {
        var last = ""
        for s in steps {
            let r = await run(s)
            if r.status != 0 && !s.allowFail {
                let msg = (r.stderr.isEmpty ? r.stdout : r.stderr).trimmingCharacters(in: .whitespacesAndNewlines)
                throw StepError.failed(msg.isEmpty ? "\((s.cmd as NSString).lastPathComponent) exited with \(r.status)" : msg)
            }
            last = r.stdout
        }
        return last
    }
}

/// Prints `[headless] <kind> <json>` (the driver collects these lines like SideEffectLog's).
public enum HeadlessRecord {
    public static func line(_ kind: String, _ detail: JSONValue) {
        SideEffectLog.recordShared(kind, detail) // integration: also lands in headless/effects
    }
}

/// Headless: never runs anything; records `[headless] exec {…}` and answers with `canned` (status 0, "").
@MainActor public final class HeadlessStepRunner: StepRunning {
    public private(set) var recorded: [CommandStep] = []
    public var canned: [String: StepOutput] = [:]
    public var echo: Bool
    public init(echo: Bool = true) { self.echo = echo }
    public func run(_ step: CommandStep) async -> StepOutput {
        recorded.append(step)
        if echo { HeadlessRecord.line("exec", step.json) }
        return canned[([step.cmd] + step.args).joined(separator: " ")] ?? StepOutput(status: 0, stdout: "", stderr: "")
    }
}

/// Real runner: Process off the main thread, 2 min timeout.
@MainActor public final class ProcessStepRunner: StepRunning {
    public init() {}
    public func run(_ step: CommandStep) async -> StepOutput {
        await Task.detached(priority: .userInitiated) { Self.exec(step, timeout: 120) }.value
    }

    nonisolated static func exec(_ step: CommandStep, timeout: TimeInterval) -> StepOutput {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: step.cmd)
        p.arguments = step.args
        if let cwd = step.cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        let out = Pipe(), err = Pipe(), inp = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = step.input == nil ? FileHandle.nullDevice : inp
        do { try p.run() } catch { return StepOutput(status: -1, stdout: "", stderr: error.localizedDescription) }
        if let input = step.input {
            inp.fileHandleForWriting.write(Data(input.utf8))
            try? inp.fileHandleForWriting.close()
        }
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
        let o = out.fileHandleForReading.readDataToEndOfFile()
        let e = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        killer.cancel()
        return StepOutput(status: p.terminationStatus, stdout: String(decoding: o, as: UTF8.self), stderr: String(decoding: e, as: UTF8.self))
    }
}

public enum StepRunners {
    @MainActor public static func make(headless: Bool) -> any StepRunning { headless ? HeadlessStepRunner() : ProcessStepRunner() }
}

/// Deep links shared by several features.
public enum SettingsPanes {
    public static let accessibility = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    public static let inputMonitoring = "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
    public static let keyboardShortcuts = "x-apple.systempreferences:com.apple.Keyboard-Settings.extension?Shortcuts"
    public static let automation = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"

    @MainActor static func open(_ pane: String, _ ctx: FeatureContext?) -> ActionResult {
        guard let ctx, let url = URL(string: pane) else { return .error("Not ready") }
        let r = ctx.services.workspace.open(url: url)
        return r.ok ? .hide() : .error(r.error ?? "Could not open System Settings")
    }
}

// MARK: - keyboard navigation for pushed lists

/// Selection for a pushed launcher list. The launcher runs the shared vim state machine and offers each
/// command to the top view (FeatureCommandHandling); `apply` moves the selection or names the activation.
@MainActor @Observable public final class SysListNav {
    public var index = 0
    @ObservationIgnored private var lastQuery = ""

    public enum Outcome: Equatable, Sendable { case moved, activate(ActionModifiers), secondary, actions, delete, copy }

    public init() {}

    public func reset() {
        index = 0
        lastQuery = ""
    }

    /// Call with the current query: a changed query moves the selection back to the first row.
    public func sync(query: String, count: Int) {
        if query != lastQuery {
            lastQuery = query
            if index != 0 { index = 0 }
        }
        if count == 0 { if index != 0 { index = 0 } } else if index >= count { index = count - 1 }
    }

    /// nil = not ours (the launcher handles it).
    public func apply(_ c: VimCommand, count: Int) -> Outcome? {
        if c.isNavigation {
            index = Vim.applyNav(c, index: index, shape: Vim.NavShape(length: count, halfPage: 5))
            return .moved
        }
        switch c {
        case let .activate(m): return .activate(m)
        case .secondary: return .secondary
        case .actions: return .actions
        case .delete: return .delete
        case .copy: return .copy
        default: return nil
        }
    }
}

/// The launcher host (for the current query) even before the pushed view rendered.
@MainActor func n3Host(_ stored: (any LauncherViewHost)?) -> (any LauncherViewHost)? { stored ?? LauncherHosts.current }

// MARK: - rendering

/// A pushed list of rows rendered with the launcher's ResultRow (same look as root search).
struct SysRowsView: View {
    @Environment(\.glideTheme) private var theme
    let header: String?
    let rows: [ScoredItem]
    let selected: Int
    let emptySymbol: String
    let emptyTitle: String
    let emptySubtitle: String?
    var onActivate: (Int) -> Void = { _ in }

    var body: some View {
        if rows.isEmpty {
            EmptyState(symbol: emptySymbol, title: emptyTitle, subtitle: emptySubtitle)
        } else {
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if let header { SectionHeader(header, trailing: "\(rows.count)").frame(height: 30, alignment: .bottom) }
                        ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                            ResultRow(row, selected: i == selected)
                                .id(row.id)
                                .onTapGesture { onActivate(i) }
                        }
                    }
                    .padding(.horizontal, CGFloat(theme.tokens.listPadding.h))
                    .padding(.top, 6)
                    .padding(.bottom, 8)
                }
                .scrollIndicators(.never)
                .onChange(of: selected) { _, i in if i < rows.count { proxy.scrollTo(rows[i].id) } }
            }
        }
    }
}

/// Fuzzy filter (launcher matcher) over titles + keywords, best first; query "" keeps the order.
func sysFilter<T>(_ list: [T], query: String, text: (T) -> String, keywords: (T) -> [String] = { _ in [] }) -> [(T, [MatchRange])] {
    let q = query.trimmingCharacters(in: .whitespaces)
    if q.isEmpty { return list.map { ($0, []) } }
    var scored: [(T, Double, [MatchRange], Int)] = []
    for (i, el) in list.enumerated() {
        if let m = fuzzyMatch(text(el), q) { scored.append((el, m.score, m.ranges, i)); continue }
        if keywords(el).contains(where: { fuzzyMatch($0, q) != nil }) { scored.append((el, -1, [], i)) }
    }
    scored.sort { $0.1 != $1.1 ? $0.1 > $1.1 : $0.3 < $1.3 }
    return scored.map { ($0.0, $0.2) }
}

extension FeatureContext {
    var vimEnabled: Bool { store.settings.vimMode }
}

extension ScoredItem {
    static func row(_ item: SearchItem, ranges: [MatchRange] = []) -> ScoredItem { ScoredItem(item: item, score: 0, ranges: ranges) }
}
