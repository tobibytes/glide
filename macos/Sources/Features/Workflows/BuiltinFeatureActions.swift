import Foundation
import GlideCore

/// Workflow actions for other features, registered by the Workflows feature on their behalf
/// (src/main/workflows/builtin-actions.ts). Each calls the owning feature's public methods so that feature's
/// state stays authoritative. A feature that registers its own action with the same id wins.
@MainActor enum BuiltinFeatureActions {
    static func registerAll(_ registry: WorkflowActionRegistry, context: FeatureContext) {
        for t in transformActions() { registry.registerDefault(feature: "transforms", t) }
        registry.registerDefault(feature: "timers", startTimer(context))
        registry.registerDefault(feature: "layouts", restoreLayout(context))
        registry.registerDefault(feature: "ocr", captureText(context))
        registry.registerDefault(feature: "automations", runAutomation(context))
        registry.registerDefault(feature: "convert", convert(context))
    }

    /// Interprets a feature method's return value: `{ok:false,error}` throws, `{message}` / a string is returned.
    static func unwrap(_ v: JSONValue, fallback: String) throws -> String {
        if case let .object(o) = v {
            if o["ok"]?.boolValue == false { throw WorkflowStepError(o["error"]?.stringValue ?? "The action failed") }
            if let m = o["message"]?.stringValue, !m.isEmpty { return m }
            if let t = o["text"]?.stringValue { return t }
        }
        if let s = v.stringValue, !s.isEmpty { return s }
        return fallback
    }

    /// By id, else exact (case-insensitive) name, else unique name prefix (pickByName).
    static func pick(_ list: [(id: String, name: String)], _ wanted: String) -> (id: String, name: String)? {
        let w = wanted.trimmingCharacters(in: .whitespaces).lowercased()
        guard !w.isEmpty else { return nil }
        if let x = list.first(where: { $0.id == wanted.trimmingCharacters(in: .whitespaces) }) { return x }
        if let x = list.first(where: { $0.name.lowercased() == w }) { return x }
        let prefix = list.filter { $0.name.lowercased().hasPrefix(w) }
        return prefix.count == 1 ? prefix[0] : nil
    }

    static func list(_ state: JSONValue, _ key: String) -> [(id: String, name: String)] {
        (state[key]?.arrayValue ?? []).compactMap { v in
            guard let id = v["id"]?.stringValue, let name = v["name"]?.stringValue else { return nil }
            return (id, name)
        }
    }

    static func transformActions() -> [FeatureWorkflowAction] {
        TextTransforms.all.map { t in
            var params: [WorkflowParamSpec] = []
            if t.usesInput { params.append(WorkflowParamSpec("text", "Text", .multiline, placeholder: "{{result}}", default: "{{result}}")) }
            if t.id == "wrap" { params.append(WorkflowParamSpec("width", "Line width", .number, default: "80")) }
            let id = t.id
            return FeatureWorkflowAction(
                id: id, title: "Transform: \(t.title)",
                description: t.usesInput ? "\(t.category.rawValue) transform of the text; the output becomes {{result}}" : "Generates a value into {{result}}",
                emoji: "🔀", symbol: "textformat", category: .text, params: params
            ) { p, _ in
                let width = p["width"].flatMap { Int($0.trimmingCharacters(in: .whitespaces)) }
                switch TextTransforms.apply(id, p["text"] ?? "", TransformOptions(width: width)) {
                case let .ok(out): return FeatureActionOutput(result: out)
                case let .failure(e): throw WorkflowStepError(e)
                }
            }
        }
    }

    /// "25m", "1h30m", "90s", "5:00", "1:02:03", "25 min tea", "tea 3m" → (ms, name).
    static func parseDuration(_ text: String) -> (ms: Int, name: String)? {
        var t = text.trimmingCharacters(in: .whitespaces)
        if t.lowercased().hasPrefix("for ") { t = String(t.dropFirst(4)) }
        guard !t.isEmpty else { return nil }
        // clock form
        let parts = t.split(separator: " ", maxSplits: 1).map(String.init)
        if let first = parts.first, first.contains(":") {
            let nums = first.split(separator: ":").map { Int($0) }
            if nums.allSatisfy({ $0 != nil }), (2...3).contains(nums.count) {
                let n = nums.compactMap { $0 }
                let secs = n.count == 2 ? n[0] * 60 + n[1] : n[0] * 3600 + n[1] * 60 + n[2]
                return secs > 0 ? (secs * 1000, parts.count > 1 ? parts[1] : "") : nil
            }
        }
        let units: [(String, Int)] = [("hours", 3600), ("hour", 3600), ("hrs", 3600), ("hr", 3600), ("h", 3600), ("minutes", 60), ("minute", 60), ("mins", 60), ("min", 60), ("m", 60),
                                      ("seconds", 1), ("second", 1), ("secs", 1), ("sec", 1), ("s", 1)]
        let scanner = Scanner(string: t)
        scanner.charactersToBeSkipped = .whitespaces
        var total = 0.0
        var consumed = t.startIndex
        var any = false
        while let n = scanner.scanDouble() {
            var matched = false
            for (u, f) in units {
                let save = scanner.currentIndex
                if scanner.scanString(u) != nil {
                    // unit must end the word
                    if scanner.isAtEnd || t[scanner.currentIndex].isWhitespace || t[scanner.currentIndex].isNumber {
                        total += n * Double(f)
                        matched = true
                        any = true
                        consumed = scanner.currentIndex
                        break
                    }
                    scanner.currentIndex = save
                }
            }
            if !matched {
                // bare number = minutes
                if !any { total += n * 60; any = true; consumed = scanner.currentIndex }
                break
            }
        }
        if any, total > 0 {
            return (Int(total * 1000), String(t[consumed...]).trimmingCharacters(in: .whitespaces))
        }
        // duration at the end: "tea 3m"
        if let space = t.lastIndex(of: " "), let r = parseDuration(String(t[t.index(after: space)...])), r.name.isEmpty {
            return (r.ms, String(t[..<space]).trimmingCharacters(in: .whitespaces))
        }
        return nil
    }

    static func startTimer(_ ctx: FeatureContext) -> FeatureWorkflowAction {
        FeatureWorkflowAction(id: "start", title: "Start Timer", description: "Start a countdown timer (e.g. 25m, 1h30m, 5:00)", emoji: "⏱️", symbol: "timer", category: .system,
                              params: [WorkflowParamSpec("duration", "Duration", placeholder: "25m", required: true), WorkflowParamSpec("name", "Name", placeholder: "Focus")]) { [weak ctx] p, _ in
            guard let parsed = parseDuration(p["duration"] ?? ""), parsed.ms > 0 else {
                throw WorkflowStepError("Not a duration: “\(p["duration"] ?? "")” (try 25m, 1h30m or 5:00)")
            }
            guard let ctx else { throw WorkflowStepError("Glide is shutting down") }
            let name = (p["name"] ?? "").trimmingCharacters(in: .whitespaces).isEmpty ? parsed.name : (p["name"] ?? "")
            let r = try await ctx.callFeature("timers", method: "start", args: ["ms": .int(Int64(parsed.ms)), "name": .string(name)])
            return FeatureActionOutput(result: try unwrap(r, fallback: "Timer started"))
        }
    }

    static func restoreLayout(_ ctx: FeatureContext) -> FeatureWorkflowAction {
        FeatureWorkflowAction(id: "restore", title: "Restore Window Layout", description: "Move windows back to a saved layout", emoji: "🪟", symbol: "rectangle.3.group", category: .apps,
                              params: [WorkflowParamSpec("layout", "Layout (name or id)", placeholder: "Coding", required: true)]) { [weak ctx] p, _ in
            guard let ctx else { throw WorkflowStepError("Glide is shutting down") }
            let state = try await ctx.callFeature("layouts", method: "state", args: .null)
            guard let l = pick(list(state, "layouts"), p["layout"] ?? "") else { throw WorkflowStepError("No saved layout called “\(p["layout"] ?? "")”") }
            let r = try await ctx.callFeature("layouts", method: "restore", args: ["id": .string(l.id)])
            return FeatureActionOutput(result: try unwrap(r, fallback: "Restored “\(l.name)”"))
        }
    }

    static func captureText(_ ctx: FeatureContext) -> FeatureWorkflowAction {
        FeatureWorkflowAction(id: "captureText", title: "Capture Text (OCR)", description: "Recognise text in a screen region you select, or in an image file; the text becomes {{result}}",
                              emoji: "🔍", symbol: "text.viewfinder", category: .text,
                              params: [WorkflowParamSpec("source", "Source", .select, options: ["screen", "file"], required: true, default: "screen"),
                                       WorkflowParamSpec("path", "Image file (source = file)", .file, placeholder: "~/Desktop/shot.png")],
                              outputVar: "ocrText") { [weak ctx] p, _ in
            guard let ctx else { throw WorkflowStepError("Glide is shutting down") }
            if (p["source"].flatMap { $0.isEmpty ? nil : $0 } ?? "screen") == "file" {
                let file = WorkflowRuntime.expandHome(p["path"] ?? "")
                guard !file.isEmpty else { throw WorkflowStepError("Choose an image file") }
                let r = try await ctx.services.ocr.recognize(path: file, languages: [], fast: false, languageCorrection: true)
                return FeatureActionOutput(result: r.lines.map(\.text).joined(separator: "\n"))
            }
            // Interactive region capture puts UI on screen: never in headless/test runs.
            if ctx.services.isHeadless { throw WorkflowStepError("Interactive screen capture is disabled in headless mode") }
            let r = try await ctx.callFeature("ocr", method: "captureText", args: [:])
            let text = try r.stringValue ?? r["text"]?.stringValue ?? unwrap(r, fallback: "")
            return FeatureActionOutput(result: text)
        }
    }

    static func runAutomation(_ ctx: FeatureContext) -> FeatureWorkflowAction {
        FeatureWorkflowAction(id: "runNow", title: "Run Automation Now", description: "Run an automation immediately, ignoring its trigger", emoji: "⚡", symbol: "bolt", category: .control,
                              params: [WorkflowParamSpec("automation", "Automation (name or id)", placeholder: "Morning routine", required: true)]) { [weak ctx] p, _ in
            guard let ctx else { throw WorkflowStepError("Glide is shutting down") }
            let state = try await ctx.callFeature("automations", method: "state", args: .null)
            guard let a = pick(list(state, "automations"), p["automation"] ?? "") else { throw WorkflowStepError("No automation called “\(p["automation"] ?? "")”") }
            let r = try await ctx.callFeature("automations", method: "runNow", args: ["id": .string(a.id)])
            return FeatureActionOutput(result: try unwrap(r, fallback: "Ran “\(a.name)”"))
        }
    }

    static func convert(_ ctx: FeatureContext) -> FeatureWorkflowAction {
        FeatureWorkflowAction(id: "convert", title: "Convert Units / Currency", description: "Evaluate a conversion like “10 km in mi” or “25 usd to eur”; the answer becomes {{result}}",
                              emoji: "📐", symbol: "arrow.left.arrow.right", category: .text,
                              params: [WorkflowParamSpec("query", "Conversion", placeholder: "{{input}} usd to eur", required: true)], outputVar: "converted") { [weak ctx] p, _ in
            guard let ctx else { throw WorkflowStepError("Glide is shutting down") }
            let q = (p["query"] ?? "").trimmingCharacters(in: .whitespaces)
            guard !q.isEmpty else { throw WorkflowStepError("Nothing to convert") }
            let hits = await ctx.search(q)
            let hit = hits.first { $0.item.feature == "convert" || $0.item.feature == "conversions" }
            guard let text = hit?.item.text ?? hit?.item.data?["copy"]?.stringValue else { throw WorkflowStepError("Can't convert “\(q)”") }
            return FeatureActionOutput(result: text)
        }
    }
}
