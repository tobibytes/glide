import Foundation

/// Offline self-test (was `glide-helper --selftest-keys`; now `Glide --selftest-keys <file>` and GlideSystemTests): runs synthetic key sequences through
/// KeyEngine and prints one JSON object with the decisions. Never creates a tap, posts events or touches
/// the pasteboard. Fixture format: src/main/features/keyboard/keys-selftest.json (asserted by keys-selftest.test.ts).
///
/// Case: {name, config:{snippets:[{keyword,text,id?,excludedBundleIds?}], hyper?, pasteStack?, excludedBundleIds?},
///        events:[…]}. Events:
///   {kind:"type", text, secure?, bundleId?}             one keyDown per character
///   {kind:"down"|"up", code?, chars?, mods?:["cmd","ctrl","alt","shift"], autorepeat?, secure?, bundleId?}
///   {kind:"flags", mods?} / {kind:"mouse"}
///   {kind:"renderReply", fallback, text?, html?, cursorLeft?}   main's snippet.render (no text = timeout)
///   {kind:"stackReply", text?, html?, passthrough?, empty?, active?}  main's stack.reply
///   {kind:"stackTimeout"}                                       the 500 ms watchdog fired
public enum KeysSelfTest {
    /// Runs a fixture (src/main/features/keyboard/keys-selftest.json format) and returns
    /// {cases:[{name,decisions}], extra:{backspaces:[{keyword,count}]}} — nil when unreadable.
    public static func run(fixture data: Data) -> [String: Any]? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let cases = root["cases"] as? [[String: Any]] else { return nil }
        var out: [[String: Any]] = []
        for c in cases { out.append(runCase(c)) }
        let extra: [String: Any] = [
            "backspaces": ((root["backspaces"] as? [String]) ?? []).map { ["keyword": $0, "count": backspaceCount($0)] },
        ]
        return ["cases": out, "extra": extra]
    }

    private static func mods(_ v: Any?) -> KeyMods {
        var m: KeyMods = []
        for s in (v as? [String]) ?? [] {
            switch s {
            case "cmd": m.insert(.command)
            case "ctrl": m.insert(.control)
            case "alt": m.insert(.option)
            case "shift": m.insert(.shift)
            default: break
            }
        }
        return m
    }

    static func describe(_ d: KeyDecision) -> String {
        switch d {
        case .pass: return "pass"
        case .passHyper: return "passHyper"
        case .swallow: return "swallow"
        case .swallowPostEscape: return "swallowPostEscape"
        case .queue: return "queue"
        case .interceptPaste: return "interceptPaste"
        case let .expand(e, n): return "expand:\(e.keyword):\(n):\(e.id ?? "-")"
        }
    }

    private static func runCase(_ c: [String: Any]) -> [String: Any] {
        var engine = KeyEngine()
        let cfg = (c["config"] as? [String: Any]) ?? [:]
        let entries = ((cfg["snippets"] as? [[String: Any]]) ?? []).compactMap { s -> SnippetEntry? in
            guard let k = s["keyword"] as? String, let t = s["text"] as? String else { return nil }
            return SnippetEntry(keyword: k, text: t, id: s["id"] as? String, excludedBundleIds: (s["excludedBundleIds"] as? [String]) ?? [])
        }
        engine.setEntries(entries)
        engine.hyper = (cfg["hyper"] as? Bool) ?? false
        engine.pasteStack = (cfg["pasteStack"] as? Bool) ?? false
        engine.globalExcluded = (cfg["excludedBundleIds"] as? [String]) ?? []
        var decisions: [String] = []
        for ev in (c["events"] as? [[String: Any]]) ?? [] {
            let env = KeyEnv(secureInput: (ev["secure"] as? Bool) ?? false, bundleId: ev["bundleId"] as? String)
            switch ev["kind"] as? String {
            case "type":
                for ch in (ev["text"] as? String) ?? "" {
                    decisions.append(describe(engine.handle(KeyInput(kind: .down, chars: String(ch)), env)))
                }
            case "down", "up":
                let input = KeyInput(kind: ev["kind"] as? String == "down" ? .down : .up, code: (ev["code"] as? NSNumber)?.int64Value ?? -1,
                                     mods: mods(ev["mods"]), chars: (ev["chars"] as? String) ?? "", autorepeat: (ev["autorepeat"] as? Bool) ?? false)
                decisions.append(describe(engine.handle(input, env)))
            case "flags":
                decisions.append(describe(engine.handle(KeyInput(kind: .flags, mods: mods(ev["mods"])), env)))
            case "mouse":
                decisions.append(describe(engine.handle(KeyInput(kind: .mouse), env)))
            case "renderReply":
                let r = renderDecision(fallback: (ev["fallback"] as? String) ?? "", text: ev["text"] as? String, html: ev["html"] as? String, cursorLeft: (ev["cursorLeft"] as? NSNumber)?.intValue)
                engine.expansionFinished()
                decisions.append("render:\(r.live ? "live" : "fallback"):\(r.text):\(r.html ?? "-"):\(r.cursorLeft)")
            case "stackReply", "stackTimeout":
                let timeout = ev["kind"] as? String == "stackTimeout"
                let d = timeout
                    ? (action: StackReplyAction.passOriginal, pasteStack: engine.pasteStack)
                    : stackReplyDecision(text: ev["text"] as? String, html: ev["html"] as? String, passthrough: (ev["passthrough"] as? Bool) ?? false,
                                         empty: (ev["empty"] as? Bool) ?? false, active: ev["active"] as? Bool, currentlyActive: engine.pasteStack)
                engine.pasteFinished()
                engine.pasteStack = d.pasteStack
                switch d.action {
                case let .paste(text, html): decisions.append("stack:paste:\(text):\(html ?? "-"):\(d.pasteStack ? "on" : "off")")
                case .passOriginal: decisions.append("stack:passOriginal:\(d.pasteStack ? "on" : "off")")
                }
            default:
                decisions.append("unknown-event")
            }
        }
        return ["name": (c["name"] as? String) ?? "", "decisions": decisions]
    }
}
