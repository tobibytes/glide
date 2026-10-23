import GlideCore
import GlideUI

/// Inline calculator (src/main/sources/calculator.ts, extended by CalcEngine: hex/bin/oct, bitwise, factorial,
/// multi-argument functions, constants). Honours `settings.calculator`. ⏎ copies, ⌘⏎ pastes into the app
/// behind the (non-activating) launcher, ⌘K offers the other representations.
@MainActor public final class CalculatorFeature: Feature, FeatureUI {
    public let id = "calculator"
    public let title = "Calculator"
    private weak var context: FeatureContext?
    public init() {}
    public func start(context: FeatureContext) async { self.context = context }

    public func dynamicItems(for query: DynamicQuery) async -> [ScoredItem] {
        guard context?.store.settings.calculator ?? true else { return [] }
        return CalcEngine.items(for: query.text, featureId: id)
    }

    static func more(_ item: SearchItem) -> [(id: String, title: String, text: String)] {
        (item.data?["more"]?.arrayValue ?? []).compactMap { m in
            guard let i = m["id"]?.stringValue, let t = m["title"]?.stringValue, let x = m["text"]?.stringValue else { return nil }
            return (i, t, x)
        }
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        [ItemAction(id: "copy", title: "Copy Result", shortcut: "↩", icon: "doc.on.doc"), ItemAction(id: "paste", title: "Paste Result", shortcut: "⌘↩", icon: "doc.on.clipboard")]
            + Self.more(item).map { ItemAction(id: "more:\($0.id)", title: $0.title, icon: "number") }
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        guard let ctx = context, var text = scored.item.text else { return .error("No result") }
        if action.hasPrefix("more:"), let m = Self.more(scored.item).first(where: { "more:\($0.id)" == action }) { text = m.text }
        if action == "paste" {
            ctx.hideLauncher()
            ctx.services.paste.paste(text: text, html: nil)
            return .hide(message: "Pasted")
        }
        ctx.services.pasteboard.setString(text, html: nil, transient: false)
        return .hide(message: "Copied \(text)")
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "evaluate":
            guard let r = CalcEngine.compute(args.stringValue ?? args["query"]?.stringValue ?? "") else { return .null }
            return ["value": .double(r.value), "text": .string(r.text), "alternatives": .array(r.alternatives.map { ["label": .string($0.label), "text": .string($0.text)] })]
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}
