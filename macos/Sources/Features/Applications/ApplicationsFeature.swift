import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Installed applications: scans `settings.appDirectories` (depth 2, like src/main/sources/apps.ts) and keeps
/// the list fresh with an NSMetadataQuery on application bundles (live updates, debounced rescan).
/// Item ids `app:<path>` match the Electron app so usage/favorites/aliases carry over.
@MainActor public final class ApplicationsFeature: Feature, FeatureUI {
    public let id = "apps"
    public let title = "Applications"
    private weak var context: FeatureContext?
    private var apps: [SearchItem] = []
    private var query: NSMetadataQuery?
    private var observers: [NSObjectProtocol] = []
    private var rescanTask: Task<Void, Never>?
    private var lastDirectories: [String] = []
    nonisolated static let extraApps = ["/System/Library/CoreServices/Finder.app", "/System/Applications/System Settings.app"]
    nonisolated static let maxDepth = 2

    public init() {}

    public func start(context: FeatureContext) async {
        self.context = context
        await rescan()
        startLiveUpdates()
    }

    public func stop() async {
        query?.stop()
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers = []
    }

    public func items() -> [SearchItem] {
        // The directory list is a setting: rescan when it changes.
        if let dirs = context?.store.settings.appDirectories, dirs != lastDirectories, !lastDirectories.isEmpty {
            scheduleRescan(after: .milliseconds(10))
        }
        return apps
    }

    public var appCount: Int { apps.count }

    // MARK: scanning

    public nonisolated static func scan(directories: [String]) -> [SearchItem] {
        let fm = FileManager.default
        var found: [String] = []
        func walk(_ dir: String, _ depth: Int) {
            guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return }
            for name in names where !name.hasPrefix(".") {
                let full = (dir as NSString).appendingPathComponent(name)
                if name.hasSuffix(".app") { found.append(full) }
                else if depth < maxDepth {
                    var isDir: ObjCBool = false
                    if fm.fileExists(atPath: full, isDirectory: &isDir), isDir.boolValue { walk(full, depth + 1) }
                }
            }
        }
        for d in directories { walk((d as NSString).expandingTildeInPath, 0) }
        for e in extraApps where fm.fileExists(atPath: e) { found.append(e) }
        var seenPaths = Set<String>()
        var seenIds = Set<String>()
        var out: [SearchItem] = []
        for path in found where seenPaths.insert(path).inserted {
            let info = NSDictionary(contentsOfFile: (path as NSString).appendingPathComponent("Contents/Info.plist")) as? [String: Any] ?? [:]
            if let bid = info["CFBundleIdentifier"] as? String {
                if seenIds.contains(bid) { continue }
                seenIds.insert(bid)
            }
            out.append(item(path: path, info: info))
        }
        out.sort { $0.title.localizedCompare($1.title) == .orderedAscending }
        return out
    }

    nonisolated static func item(path: String, info: [String: Any]) -> SearchItem {
        let title = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        var keywords: [String] = []
        for k in [info["CFBundleDisplayName"] as? String, info["CFBundleName"] as? String] {
            if let k, k != title, !keywords.contains(k) { keywords.append(k) }
        }
        if let tail = (info["CFBundleIdentifier"] as? String)?.split(separator: ".").last.map(String.init), tail.lowercased() != title.lowercased(), !keywords.contains(tail) {
            keywords.append(tail)
        }
        return SearchItem(id: "app:\(path)", kind: .app, title: title, icon: .app(path), keywords: keywords, path: path, source: "apps", feature: "apps")
    }

    private func rescan() async {
        let dirs = context?.store.settings.appDirectories ?? Settings.defaults.appDirectories
        lastDirectories = dirs
        let next = await Task.detached(priority: .utility) { ApplicationsFeature.scan(directories: dirs) }.value
        if next.map(\.id) != apps.map(\.id) {
            apps = next
            context?.refreshCatalogue()
        }
    }

    private func scheduleRescan(after delay: Duration) {
        rescanTask?.cancel()
        rescanTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.rescan()
        }
    }

    /// Spotlight live updates (Raycast does the same: MDQuery on com.apple.application-bundle).
    private func startLiveUpdates() {
        let q = NSMetadataQuery()
        q.predicate = NSPredicate(format: "kMDItemContentTypeTree == 'com.apple.application-bundle'")
        q.searchScopes = lastDirectories.map { (($0 as NSString).expandingTildeInPath) }.filter { FileManager.default.fileExists(atPath: $0) }
        q.notificationBatchingInterval = 1
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: .NSMetadataQueryDidUpdate, object: q, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.scheduleRescan(after: .seconds(2)) }
        })
        q.start()
        query = q
    }

    // MARK: actions

    public func actions(for item: SearchItem) -> [ItemAction] {
        [ItemAction(id: "open", title: "Open", shortcut: "↩", icon: "arrow.up.forward.app"),
         ItemAction(id: "reveal", title: "Show in Finder", shortcut: "⌘↩", icon: "folder"),
         ItemAction(id: "copyPath", title: "Copy Path", shortcut: "⇧⌘C", icon: "doc.on.doc")]
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        guard let ctx = context, let path = scored.item.path else { return .error("Item has no path") }
        switch action {
        case "open":
            let r = ctx.services.workspace.open(path: path)
            return r.ok ? .hide() : .error(r.error ?? "Could not open")
        case "reveal":
            ctx.services.workspace.reveal(path: path)
            return .hide()
        case "copyPath":
            ctx.services.pasteboard.setString(path, html: nil, transient: false)
            return .hide(message: "Path copied")
        default: return .error("Unknown action \(action)")
        }
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "count": return .int(Int64(apps.count))
        case "rescan":
            await rescan()
            return .int(Int64(apps.count))
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Applications", symbol: "square.grid.2x2", order: 20) { [weak self] in
            AnyView(AppsSettingsView(directories: self?.context?.store.settings.appDirectories ?? [], count: self?.apps.count ?? 0))
        }
    }
}

struct AppsSettingsView: View {
    let directories: [String]
    let count: Int
    var body: some View {
        Form {
            Section("Folders scanned for applications") {
                ForEach(directories, id: \.self) { Text($0).font(.system(.body, design: .monospaced)) }
            }
            Section { Text("\(count) applications indexed. New apps appear automatically (Spotlight live query).").foregroundStyle(.secondary) }
        }
        .formStyle(.grouped)
    }
}
