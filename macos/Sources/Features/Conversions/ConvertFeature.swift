import Foundation
import GlideCore
import GlideUI
import SwiftUI

/// Inline conversions in the root search (units, currency, time zones, dates), shown in the Calculator section.
/// Network: only the exchange-rate API, only after a currency query is typed, only while "Fetch exchange rates"
/// is on. Headless runs never touch the network unless `GLIDE_CONVERT_RATES_BASE_URL` points at a local stub.
@MainActor public final class ConvertFeature: Feature, FeatureUI {
    public let id = "convert"
    public let title = "Conversions"
    private weak var context: FeatureContext?
    public private(set) var rates: ConvertRatesStore?
    private var networkAllowed = true
    /// Injectable clock/zone (tests).
    public var nowMs: () -> Double = { Date().timeIntervalSince1970 * 1000 }
    public var localZone: () -> String = { TimeZone.current.identifier }
    static let score: Double = 1000
    static let firstFetchWait: Duration = .milliseconds(180)

    public init() {}

    public var dynamicItemsBudget: Duration { .milliseconds(250) }

    public func start(context: FeatureContext) async {
        self.context = context
        let env = ProcessInfo.processInfo.environment
        let override = env["GLIDE_CONVERT_RATES_BASE_URL"]
        networkAllowed = !context.services.isHeadless || (override?.isEmpty == false)
        rates = ConvertRatesStore(file: context.dataDirectory().appendingPathComponent("rates.json"), providers: ConvertRatesStore.defaultProviders(environment: env),
                                  fetcher: ConvertRatesStore.urlSessionFetcher)
    }

    /// For tests: a store with injected providers/fetcher.
    public func useRatesStore(_ store: ConvertRatesStore, networkAllowed: Bool = true) {
        rates = store
        self.networkAllowed = networkAllowed
    }

    public struct Prefs: Equatable {
        public var enabled = true
        public var currencyNetwork = true
        public var defaultCurrency = "USD"
    }

    public var prefs: Prefs {
        let s = context?.settings(defaults: ["enabled": true, "currencyNetwork": true, "defaultCurrency": "USD"]) ?? [:]
        var p = Prefs()
        p.enabled = s["enabled"]?.boolValue != false
        p.currencyNetwork = s["currencyNetwork"]?.boolValue != false
        if let c = s["defaultCurrency"]?.stringValue, c.count == 3, c.allSatisfy({ $0.isASCII && $0.isUppercase }) { p.defaultCurrency = c }
        return p
    }

    func makeContext(loading: Bool) -> ConvertEngine.Context {
        let p = prefs
        let t = rates?.current
        let fetchable = p.currencyNetwork && networkAllowed
        return ConvertEngine.Context(nowMs: nowMs(), localZone: localZone(), rates: t, ratesStale: t != nil && !(rates?.isFresh ?? false),
                                     ratesLoading: loading, defaultCurrency: p.defaultCurrency, currencyEnabled: fetchable || t != nil)
    }

    public func results(for query: String) async -> [ConvertEngine.Conversion] {
        guard prefs.enabled, let rates else { return [] }
        var out = ConvertEngine.convert(query, makeContext(loading: false))
        if out.wantsRates && prefs.currencyNetwork && networkAllowed && !rates.isFresh {
            let hadTable = rates.current != nil
            let pending = Task { @MainActor in await rates.refresh() }
            if !hadTable {
                let waiter = Task { try? await Task.sleep(for: Self.firstFetchWait) }
                // Whichever finishes first: the fetch, or the first-fetch wait.
                await withTaskGroup(of: Void.self) { g in
                    g.addTask { _ = await pending.value }
                    g.addTask { await waiter.value }
                    await g.next()
                    g.cancelAll()
                }
                out = ConvertEngine.convert(query, makeContext(loading: rates.current == nil))
            }
            Task { @MainActor [weak self] in
                _ = await pending.value
                if !hadTable { self?.context?.refreshCatalogue() }
            }
        }
        return out.results
    }

    public func dynamicItems(for query: DynamicQuery) async -> [ScoredItem] {
        let list = await results(for: query.text)
        let key = query.trimmed.lowercased()
        return list.enumerated().map { i, c in
            var data: [String: JSONValue] = ["copy": .string(c.copy), "category": .string(c.category.rawValue), "noUsage": true]
            data["more"] = .array(c.more.map { ["id": .string($0.id), "title": .string($0.title), "text": .string($0.text)] })
            let item = SearchItem(id: "convert:\(c.category.rawValue):\(i):\(key)", kind: .calculator, title: c.title, subtitle: c.subtitle, icon: .emoji(c.icon),
                                  text: c.copy, feature: id, data: data, kindLabel: "Convert")
            return ScoredItem(item: item, score: Self.score - Double(i), matchScore: Self.score, matchKind: .exact)
        }
    }

    static func more(_ item: SearchItem) -> [ConvertEngine.CopyOption] {
        (item.data?["more"]?.arrayValue ?? []).compactMap { m in
            guard let id = m["id"]?.stringValue, let t = m["title"]?.stringValue, let x = m["text"]?.stringValue else { return nil }
            return ConvertEngine.CopyOption(id: id, title: t, text: x)
        }
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        guard item.data?["copy"]?.stringValue?.isEmpty == false else { return [] }
        return [ItemAction(id: "copy", title: "Copy Result", shortcut: "↩", icon: "doc.on.doc"),
                ItemAction(id: "paste", title: "Paste Result", shortcut: "⌘↩", icon: "doc.on.clipboard")]
            + Self.more(item).map { ItemAction(id: "more:\($0.id)", title: $0.title, icon: "doc.on.doc") }
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        guard let ctx = context else { return .error("Not ready") }
        guard let copy = scored.item.data?["copy"]?.stringValue, !copy.isEmpty else { return .error("Nothing to copy yet") }
        switch action {
        case "copy":
            ctx.services.pasteboard.setString(copy, html: nil, transient: false)
            return .hide(message: "Copied \(copy.count > 40 ? String(copy.prefix(40)) + "…" : copy)")
        case "paste":
            ctx.hideLauncher()
            ctx.services.paste.paste(text: copy, html: nil)
            return .hide(message: "Pasted")
        default:
            if action.hasPrefix("more:"), let m = Self.more(scored.item).first(where: { "more:\($0.id)" == action }) {
                ctx.services.pasteboard.setString(m.text, html: nil, transient: false)
                return .hide(message: "Copied \(m.text)")
            }
            return .error("Unknown action \(action)")
        }
    }

    func stateJSON() -> JSONValue {
        let p = prefs
        var o: [String: JSONValue] = ["settings": ["enabled": .bool(p.enabled), "currencyNetwork": .bool(p.currencyNetwork), "defaultCurrency": .string(p.defaultCurrency)],
                                      "networkAllowed": .bool(networkAllowed), "requests": .int(Int64(rates?.requestCount ?? 0))]
        if let t = rates?.current {
            o["rates"] = ["date": .string(t.date), "fetchedAt": .double(t.fetchedAt), "source": .string(t.source), "count": .int(Int64(t.rates.count + 1)), "fresh": .bool(rates?.isFresh ?? false)]
        } else { o["rates"] = .null }
        if let e = rates?.lastError { o["error"] = .string(e) }
        return .object(o)
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "state": return stateJSON()
        case "preview":
            let list = await results(for: args.stringValue ?? args["query"]?.stringValue ?? "")
            return .array(list.map { ["title": .string($0.title), "subtitle": .string($0.subtitle), "copy": .string($0.copy)] })
        case "refreshRates":
            guard prefs.currencyNetwork, networkAllowed else { return stateJSON() }
            await rates?.refresh(force: true)
            return stateJSON()
        case "clearRates":
            rates?.clear()
            return stateJSON()
        case "setSettings":
            var clean: [String: JSONValue] = [:]
            if let b = args["enabled"]?.boolValue { clean["enabled"] = .bool(b) }
            if let b = args["currencyNetwork"]?.boolValue { clean["currencyNetwork"] = .bool(b) }
            if let c = args["defaultCurrency"]?.stringValue?.trimmingCharacters(in: .whitespaces), c.count == 3, c.allSatisfy({ $0.isLetter }) { clean["defaultCurrency"] = .string(c.uppercased()) }
            context?.setSettings(clean)
            return stateJSON()
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Conversions", symbol: "arrow.left.arrow.right", order: 62) { [weak self] in
            AnyView(ConvertSettingsView(feature: self))
        }
    }
}

struct ConvertSettingsView: View {
    weak var feature: ConvertFeature?
    @State private var prefs = ConvertFeature.Prefs()
    @State private var currency = "USD"
    @State private var status = ""

    var body: some View {
        Form {
            Section {
                Toggle("Show conversions in root search", isOn: Binding(get: { prefs.enabled }, set: { v in prefs.enabled = v; save(["enabled": .bool(v)]) }))
                Toggle("Fetch exchange rates (open.er-api.com, ECB fallback)", isOn: Binding(get: { prefs.currencyNetwork }, set: { v in prefs.currencyNetwork = v; save(["currencyNetwork": .bool(v)]) }))
                TextField("Default currency", text: $currency).onSubmit { save(["defaultCurrency": .string(currency)]) }
            } footer: {
                Text("Try “5 km in miles”, “100 usd in eur”, “5pm london in tokyo”, “days until dec 25”. Rates are only fetched after you type a currency query and are cached for 6 hours.")
            }
            Section("Exchange rates") {
                Text(status).foregroundStyle(.secondary)
                HStack {
                    Button("Refresh Now") { Task { _ = try? await feature?.invoke(method: "refreshRates", args: .null); reload() } }
                    Button("Clear Cache") { Task { _ = try? await feature?.invoke(method: "clearRates", args: .null); reload() } }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: reload)
    }

    private func save(_ patch: [String: JSONValue]) {
        Task { _ = try? await feature?.invoke(method: "setSettings", args: .object(patch)); reload() }
    }

    private func reload() {
        guard let f = feature else { return }
        prefs = f.prefs
        currency = prefs.defaultCurrency
        if let t = f.rates?.current {
            status = "\(t.rates.count + 1) currencies · \(t.source) · rates \(t.date)\(f.rates?.isFresh == true ? "" : " (stale)")"
        } else {
            status = f.rates?.lastError ?? "No rates cached yet"
        }
    }
}
