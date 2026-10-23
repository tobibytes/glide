import Foundation
import GlideCore

// Port of src/main/features/extensions/manifest.ts + raycast-manifest.ts (same validation rules and
// messages, so an extension that installs in the Electron app installs here and vice versa).

struct ExtArgument: Hashable, Sendable {
    var name: String
    var placeholder: String?
    var required: Bool
    /// "text" | "password" | "dropdown"
    var type: String = "text"
    var data: [ExtOption] = []
}

struct ExtOption: Hashable, Sendable {
    var value: String
    var title: String
}

struct ExtCommand: Hashable, Sendable {
    var name: String
    var title: String
    var subtitle: String?
    var description: String?
    /// "view" | "no-view" | "menu-bar"
    var mode: String
    var arguments: [ExtArgument]
    var keywords: [String]
    /// Entry file relative to the extension root.
    var entry: String
    var icon: String?
    var intervalMs: Int?
    var interval: String?
}

struct ExtPreference: Hashable, Sendable {
    var name: String
    var title: String
    var description: String?
    /// "textfield" | "password" | "checkbox" | "dropdown"
    var type: String
    var defaultValue: JSONValue?
    var required: Bool
    var data: [ExtOption]
    /// Raycast command-scoped preference.
    var command: String?

    /// Storage key ("<command>/<name>" for command-scoped preferences).
    var key: String { command.map { "\($0)/\(name)" } ?? name }
}

struct ExtManifest: Hashable, Sendable {
    var name: String
    var version: String
    var title: String
    var description: String
    var author: String?
    var icon: String?
    var commands: [ExtCommand]
    var preferences: [ExtPreference]
    /// "glide" | "raycast"
    var runtime: String = "glide"
    var warnings: [String] = []
}

enum ManifestResult {
    case ok(ExtManifest)
    case failed([String])

    var manifest: ExtManifest? { if case let .ok(m) = self { return m }; return nil }
    var errors: [String] { if case let .failed(e) = self { return e }; return [] }
}

enum Manifest {
    static let raycastBuildDir = ".glide-build"
    static let preferenceTypes = ["textfield", "password", "checkbox", "dropdown"]
    static let minIntervalMs = 10_000

    static func isValidName(_ v: JSONValue?) -> Bool {
        guard let s = v?.stringValue else { return false }
        return isValidName(s)
    }

    static func isValidName(_ s: String) -> Bool {
        guard s != ".", s != "..", (1...64).contains(s.count), let first = s.unicodeScalars.first else { return false }
        func ok(_ c: Unicode.Scalar) -> Bool { c.isASCII && (CharacterSet.alphanumerics.contains(c) || c == "." || c == "_" || c == "-") }
        return first.isASCII && CharacterSet.alphanumerics.contains(first) && s.unicodeScalars.allSatisfy(ok)
    }

    static func entryCandidates(_ command: String) -> [String] {
        ["dist/\(command).js", "dist/\(command).cjs", "\(command).js", "\(command).cjs", "src/\(command).js", "src/\(command).cjs"]
    }

    static func raycastSourceCandidates(_ command: String) -> [String] { ["tsx", "ts", "jsx", "js"].map { "src/\(command).\($0)" } }
    static func raycastEntryCandidates(_ command: String) -> [String] { ["\(raycastBuildDir)/\(command).cjs", "dist/\(command).js"] }

    private static func optStr(_ v: JSONValue?) -> String? {
        guard let s = v?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }

    private static func options(_ v: JSONValue?) -> [ExtOption] {
        (v?.arrayValue ?? []).compactMap { d in
            guard let o = d.objectValue else { return nil }
            let value = o["value"].map { $0.stringValue ?? $0.description } ?? ""
            return ExtOption(value: value, title: o["title"]?.stringValue ?? value)
        }
    }

    /// Raycast manifest: no "glide" block, a top-level commands array, and a Raycast marker.
    static func isRaycastPackage(_ pkg: JSONValue) -> Bool {
        guard let o = pkg.objectValue, o["glide"]?.objectValue == nil, let cmds = o["commands"]?.arrayValue else { return false }
        var deps: [String: JSONValue] = o["dependencies"]?.objectValue ?? [:]
        deps.merge(o["devDependencies"]?.objectValue ?? [:]) { a, _ in a }
        return deps["@raycast/api"] != nil || (o["$schema"]?.stringValue?.contains("raycast") ?? false) || cmds.contains { $0["mode"]?.stringValue != nil }
    }

    static func read(dir: URL) -> ManifestResult {
        let pkgURL = dir.appendingPathComponent("package.json")
        let pkg: JSONValue
        do { pkg = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: pkgURL)) } catch {
            return .failed(["Cannot read package.json: \(error.localizedDescription)"])
        }
        let exists: (String) -> Bool = { FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path) }
        return isRaycastPackage(pkg) ? translateRaycast(pkg, exists: exists) : validate(pkg, exists: exists)
    }

    static func author(_ o: [String: JSONValue]) -> String? {
        if let s = o["author"]?.stringValue { return s }
        return optStr(o["author"]?["name"])
    }

    // MARK: Glide manifest

    static func validate(_ pkg: JSONValue, exists: (String) -> Bool = { _ in true }) -> ManifestResult {
        var errors: [String] = []
        guard let o = pkg.objectValue else { return .failed(["package.json must be a JSON object"]) }
        if !isValidName(o["name"]) { errors.append("\"name\" must be 1–64 letters, digits, \".\", \"_\" or \"-\" (got \(o["name"]?.description ?? "undefined"))") }
        guard let g = o["glide"]?.objectValue else {
            return .failed(errors + ["package.json needs a \"glide\" object with title, description and commands"])
        }
        let title = optStr(g["title"])
        if title == nil { errors.append("\"glide.title\" is required") }
        if let icon = g["icon"], icon.stringValue == nil { errors.append("\"glide.icon\" must be a string") }
        var commands: [ExtCommand] = []
        if let list = g["commands"]?.arrayValue, !list.isEmpty {
            var names = Set<String>()
            for (i, c) in list.enumerated() {
                let at = "glide.commands[\(i)]"
                guard let co = c.objectValue else { errors.append("\(at) must be an object"); continue }
                guard isValidName(co["name"]), let name = co["name"]?.stringValue else { errors.append("\(at).name is missing or invalid"); continue }
                if names.contains(name) { errors.append("\(at).name \"\(name)\" is duplicated") }
                names.insert(name)
                let ctitle = optStr(co["title"])
                if ctitle == nil { errors.append("\(at).title is required") }
                let mode = co["mode"]?.stringValue ?? "view"
                if mode != "view" && mode != "no-view" { errors.append("\(at).mode must be \"view\" or \"no-view\"") }
                var args: [ExtArgument] = []
                if let a = co["arguments"] {
                    if let arr = a.arrayValue {
                        for (j, x) in arr.enumerated() {
                            guard isValidName(x["name"]), let n = x["name"]?.stringValue else { errors.append("\(at).arguments[\(j)].name is missing or invalid"); continue }
                            args.append(ExtArgument(name: n, placeholder: optStr(x["placeholder"]), required: x["required"]?.boolValue == true))
                        }
                    } else { errors.append("\(at).arguments must be an array") }
                }
                let keywords = (co["keywords"]?.arrayValue ?? []).compactMap(\.stringValue)
                let entry = entryCandidates(name).first(where: exists)
                if entry == nil { errors.append("\(at): no entry file found (expected one of \(entryCandidates(name).joined(separator: ", ")))") }
                commands.append(ExtCommand(name: name, title: ctitle ?? name, subtitle: optStr(co["subtitle"]), description: optStr(co["description"]),
                                           mode: mode == "no-view" ? "no-view" : "view", arguments: args, keywords: keywords, entry: entry ?? ""))
            }
        } else {
            errors.append("\"glide.commands\" must be a non-empty array")
        }
        var prefs: [ExtPreference] = []
        if let p = g["preferences"] {
            if let arr = p.arrayValue {
                for (i, x) in arr.enumerated() {
                    let at = "glide.preferences[\(i)]"
                    guard isValidName(x["name"]), let n = x["name"]?.stringValue else { errors.append("\(at).name is missing or invalid"); continue }
                    let type = x["type"]?.stringValue ?? ""
                    guard preferenceTypes.contains(type) else { errors.append("\(at).type must be one of \(preferenceTypes.joined(separator: ", "))"); continue }
                    let data = options(x["data"])
                    if type == "dropdown" && data.isEmpty { errors.append("\(at): dropdown preferences need \"data\" options") }
                    prefs.append(ExtPreference(name: n, title: optStr(x["title"]) ?? n, description: optStr(x["description"]), type: type,
                                               defaultValue: defaultValue(type, x["default"]), required: x["required"]?.boolValue == true, data: data))
                }
            } else { errors.append("\"glide.preferences\" must be an array") }
        }
        if !errors.isEmpty { return .failed(errors) }
        return .ok(ExtManifest(name: o["name"]?.stringValue ?? "", version: o["version"]?.stringValue ?? "0.0.0", title: title ?? "",
                               description: optStr(g["description"]) ?? optStr(o["description"]) ?? "",
                               author: optStr(g["author"]) ?? author(o), icon: optStr(g["icon"]), commands: commands, preferences: prefs))
    }

    private static func defaultValue(_ type: String, _ v: JSONValue?) -> JSONValue? {
        if type == "checkbox" { return v?.boolValue.map(JSONValue.bool) }
        return v?.stringValue.map(JSONValue.string)
    }

    // MARK: Raycast manifest

    private static func raycastPrefType(_ t: String?) -> (type: String, note: String?)? {
        switch t {
        case "textfield", "password", "checkbox", "dropdown": return (t!, nil)
        case "appPicker": return ("textfield", "Application name or path")
        case "file": return ("textfield", "File path")
        case "directory": return ("textfield", "Folder path")
        default: return nil
        }
    }

    private static func raycastPreferences(_ list: JSONValue?, at: String, errors: inout [String], command: String? = nil) -> [ExtPreference] {
        guard let list else { return [] }
        guard let arr = list.arrayValue else { errors.append("\(at) must be an array"); return [] }
        var out: [ExtPreference] = []
        for (i, p) in arr.enumerated() {
            guard isValidName(p["name"]), let name = p["name"]?.stringValue else { errors.append("\(at)[\(i)].name is missing or invalid"); continue }
            guard let t = raycastPrefType(p["type"]?.stringValue) else { errors.append("\(at)[\(i)].type \"\(p["type"]?.stringValue ?? "undefined")\" is not supported"); continue }
            let data = options(p["data"])
            if t.type == "dropdown" && data.isEmpty { errors.append("\(at)[\(i)]: dropdown preferences need \"data\" options") }
            let desc = [optStr(p["description"]), t.note].compactMap { $0 }.joined(separator: " — ")
            out.append(ExtPreference(name: name, title: optStr(p["title"]) ?? optStr(p["label"]) ?? name,
                                     description: t.type == "checkbox" ? (optStr(p["label"]) ?? (desc.isEmpty ? nil : desc)) : (desc.isEmpty ? nil : desc),
                                     type: t.type, defaultValue: defaultValue(t.type, p["default"]), required: p["required"]?.boolValue == true, data: data, command: command))
        }
        return out
    }

    static func translateRaycast(_ pkg: JSONValue, exists: (String) -> Bool = { _ in true }) -> ManifestResult {
        var errors: [String] = []
        var warnings: [String] = []
        guard let o = pkg.objectValue else { return .failed(["package.json must be a JSON object"]) }
        if !isValidName(o["name"]) { errors.append("\"name\" must be 1–64 letters, digits, \".\", \"_\" or \"-\" (got \(o["name"]?.description ?? "undefined"))") }
        let title = optStr(o["title"]) ?? o["name"]?.stringValue
        if title == nil { errors.append("\"title\" is required") }
        var prefs = raycastPreferences(o["preferences"], at: "preferences", errors: &errors)
        var commands: [ExtCommand] = []
        var names = Set<String>()
        for (i, c) in (o["commands"]?.arrayValue ?? []).enumerated() {
            let at = "commands[\(i)]"
            guard c.objectValue != nil else { errors.append("\(at) must be an object"); continue }
            guard isValidName(c["name"]), let name = c["name"]?.stringValue else { errors.append("\(at).name is missing or invalid"); continue }
            if names.contains(name) { errors.append("\(at).name \"\(name)\" is duplicated") }
            names.insert(name)
            let mode = c["mode"]?.stringValue ?? "view"
            guard ["view", "no-view", "menu-bar"].contains(mode) else { errors.append("\(at).mode must be \"view\", \"no-view\" or \"menu-bar\""); continue }
            let entry = raycastEntryCandidates(name).first(where: exists)
            if entry == nil { errors.append("\(at): \"\(name)\" has not been built (re-import the extension folder)") }
            var args: [ExtArgument] = []
            if let a = c["arguments"] {
                if let arr = a.arrayValue {
                    for (j, x) in arr.enumerated() {
                        guard isValidName(x["name"]), let n = x["name"]?.stringValue else { errors.append("\(at).arguments[\(j)].name is missing or invalid"); continue }
                        let type = ["password", "dropdown"].contains(x["type"]?.stringValue ?? "") ? x["type"]!.stringValue! : "text"
                        args.append(ExtArgument(name: n, placeholder: optStr(x["placeholder"]), required: x["required"]?.boolValue == true, type: type,
                                                data: type == "dropdown" ? options(x["data"]) : []))
                    }
                } else { errors.append("\(at).arguments must be an array") }
            }
            var cmd = ExtCommand(name: name, title: optStr(c["title"]) ?? name, subtitle: optStr(c["subtitle"]), description: optStr(c["description"]),
                                 mode: mode, arguments: args, keywords: (c["keywords"]?.arrayValue ?? []).compactMap(\.stringValue), entry: entry ?? "",
                                 icon: optStr(c["icon"]))
            if let iv = c["interval"] {
                if let ms = parseInterval(iv.stringValue) {
                    if mode == "view" { warnings.append("\"\(name)\": interval only applies to no-view and menu-bar commands; it was ignored.") }
                    else {
                        cmd.intervalMs = ms
                        cmd.interval = iv.stringValue?.trimmingCharacters(in: .whitespaces)
                    }
                } else {
                    warnings.append("\"\(name)\": interval \(iv.description) is not valid (use e.g. \"10s\", \"5m\", \"1h\", \"1d\"; at least 10s); background refresh is off.")
                }
            }
            prefs += raycastPreferences(c["preferences"], at: "\(at).preferences", errors: &errors, command: name)
            commands.append(cmd)
        }
        if commands.isEmpty && errors.isEmpty { errors.append("This extension has no commands Glide can run") }
        if !errors.isEmpty { return .failed(errors) }
        return .ok(ExtManifest(name: o["name"]?.stringValue ?? "", version: o["version"]?.stringValue ?? "0.0.0", title: title ?? "",
                               description: optStr(o["description"]) ?? "", author: author(o), icon: optStr(o["icon"]), commands: commands,
                               preferences: prefs, runtime: "raycast", warnings: warnings))
    }

    // MARK: preferences / arguments

    static func parseInterval(_ v: String?) -> Int? {
        guard let s = v?.trimmingCharacters(in: .whitespaces), let unit = s.last, let n = Int(s.dropLast()), n >= 0 else { return nil }
        let mult: Int
        switch unit {
        case "s": mult = 1000
        case "m": mult = 60_000
        case "h": mult = 3_600_000
        case "d": mult = 86_400_000
        default: return nil
        }
        let ms = n * mult
        return ms >= minIntervalMs ? ms : nil
    }

    static func preferences(_ m: ExtManifest, command: String?) -> [ExtPreference] {
        guard let command else { return m.preferences }
        return m.preferences.filter { $0.command == nil || $0.command == command }
    }

    private static func saved(_ p: ExtPreference, _ saved: [String: JSONValue]) -> JSONValue? {
        if let v = saved[p.key] { return v }
        return p.command != nil ? saved[p.name] : nil
    }

    private static func valueOf(_ p: ExtPreference, _ s: [String: JSONValue]) -> JSONValue {
        let v = saved(p, s)
        if p.type == "checkbox" { return .bool(v?.boolValue ?? p.defaultValue?.boolValue ?? false) }
        return .string(v?.stringValue ?? p.defaultValue?.stringValue ?? "")
    }

    static func missingPreferences(_ m: ExtManifest, saved s: [String: JSONValue], command: String?) -> [ExtPreference] {
        preferences(m, command: command).filter { p in
            guard p.required else { return false }
            let v = saved(p, s) ?? p.defaultValue
            return v == nil || v == .string("") || v == .null
        }
    }

    /// What getPreferenceValues returns (by name; command-scoped wins), or all by key (command nil).
    static func resolvePreferences(_ m: ExtManifest, saved s: [String: JSONValue], command: String?) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        guard let command else {
            for p in m.preferences { out[p.key] = valueOf(p, s) }
            return out
        }
        let visible = preferences(m, command: command)
        for p in visible where p.command == nil { out[p.name] = valueOf(p, s) }
        for p in visible where p.command != nil { out[p.name] = valueOf(p, s) }
        return out
    }

    /// One word per argument; the last takes the rest (manifest.ts splitArguments).
    static func splitArguments(_ args: [ExtArgument], _ text: String?) -> [String: String] {
        var out: [String: String] = [:]
        let rest = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if args.count == 1 { out[args[0].name] = rest; return out }
        let words = rest.isEmpty ? [] : rest.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        for (i, a) in args.enumerated() {
            out[a.name] = i == args.count - 1 ? words.dropFirst(i).joined(separator: " ") : (i < words.count ? words[i] : "")
        }
        return out
    }
}

/// Extension `IconSource` string → ItemIcon (src/extension-api/icons.ts).
func extIcon(_ src: String?, assets: String?) -> ItemIcon? {
    guard let raw = src?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
    let lower = raw.lowercased()
    if lower.hasPrefix("http://") || lower.hasPrefix("https://") || lower.hasPrefix("data:image/") { return ItemIcon(kind: "url", value: raw) }
    if lower.hasPrefix("file://") {
        let p = String(raw.dropFirst(7)).removingPercentEncoding ?? String(raw.dropFirst(7))
        return p.hasPrefix("/") && !p.split(separator: "/").contains("..") ? .file(p) : nil
    }
    if raw.hasPrefix("#"), raw.count >= 4, raw.count <= 9, raw.dropFirst().allSatisfy(\.isHexDigit) { return ItemIcon(kind: "color", value: raw) }
    let exts = ["png", "jpg", "jpeg", "gif", "svg", "webp", "icns", "tif", "tiff"]
    if let dot = raw.lastIndex(of: "."), exts.contains(raw[raw.index(after: dot)...].lowercased()) {
        guard let assets, !raw.split(separator: "/").contains(".."), !raw.hasPrefix("/") else { return nil }
        let rel = raw.hasPrefix("./") ? String(raw.dropFirst(2)) : raw
        return .file((assets as NSString).appendingPathComponent(rel))
    }
    return .emoji(raw.count <= 16 ? raw : String(raw.prefix(2)))
}
