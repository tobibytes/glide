import Foundation
import GlideCore
import GlideSystem

/// `invoke` methods (other features and the test channel), mirroring the Electron feature's `methods`.
extension ClipboardFeature {
    func summary(_ e: ClipEntry) -> JSONValue {
        var o: [String: JSONValue] = [
            "id": .string(e.id), "type": .string(e.type.rawValue), "title": .string(ClipModel.title(e)), "preview": .string(String((e.text ?? "").prefix(400))),
            "createdAt": .double(e.createdAt), "lastCopiedAt": .double(e.lastCopiedAt), "count": .int(Int64(e.count)), "pinned": .bool(e.pinned),
            "chars": .int(Int64((e.text ?? "").count)), "words": .int(Int64(ClipModel.countWords(e.text ?? ""))),
        ]
        if let f = e.files { o["files"] = .array(f.map(JSONValue.string)) }
        if let i = e.image { o["image"] = ["sha1": .string(i.sha1), "width": .int(Int64(i.width)), "height": .int(Int64(i.height)), "bytes": .int(Int64(i.bytes))] }
        if let s = e.source { o["source"] = ["name": .string(s.name), "bundleId": s.bundleId.map(JSONValue.string) ?? .null] } else { o["source"] = .null }
        if e.type == .link, let d = ClipModel.linkDomain(e.text ?? "") { o["domain"] = .string(d) }
        if let ocr = e.ocrText, !ocr.isEmpty { o["ocr"] = .string(String(ocr.prefix(400))) }
        if e.html != nil { o["rich"] = true }
        return .object(o)
    }

    func stackState() -> JSONValue {
        ["collecting": .bool(stack.collecting), "limit": .int(Int64(stack.limit)), "collected": .int(Int64(stack.collected)), "order": .string(stack.order.rawValue),
         "items": .array(stack.items.compactMap(entry).map(summary)), "intercepts": .bool(settings.stackInterceptPaste && stack.interceptsPaste)]
    }

    static func result(_ r: ActionResult) -> JSONValue {
        switch r {
        case let .hide(m): return ["ok": true, "hide": true, "message": m.map(JSONValue.string) ?? .null]
        case let .stay(m): return ["ok": true, "hide": false, "message": m.map(JSONValue.string) ?? .null]
        case let .error(m): return ["ok": false, "error": .string(m)]
        case let .pushView(v, _): return ["ok": true, "view": .string(v.rawValue)]
        case let .openSettings(p): return ["ok": true, "settings": p.map(JSONValue.string) ?? .null]
        }
    }

    private func ids(_ v: JSONValue?) -> [String] {
        if let a = v?.arrayValue { return a.compactMap(\.stringValue) }
        return v?.stringValue.map { [$0] } ?? []
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        let id = args["id"]?.stringValue ?? args.stringValue
        switch method {
        case "list":
            let list = ClipModel.filter(entries, query: args["query"]?.stringValue ?? "", filter: ClipFilter(args["type"]?.stringValue),
                                        limit: args["limit"]?.intValue ?? 0, source: args["source"]?.stringValue, hay: hay)
            return .array(list.map(summary))
        case "sources":
            return .array(ClipModel.sourceApps(entries).map { ["key": .string($0.key), "name": .string($0.name), "bundleId": $0.bundleId.map(JSONValue.string) ?? .null, "count": .int(Int64($0.count))] })
        case "get":
            guard let e = entry(id) else { return .null }
            return try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(e))
        case "paste":
            guard let e = entry(id) else { return ["ok": false, "error": "Entry not found"] }
            return Self.result(pasteEntry(e, plain: args["plain"]?.boolValue == true))
        case "pasteText":
            guard let t = args["text"]?.stringValue, !t.isEmpty else { return ["ok": false, "error": "Nothing to paste"] }
            return Self.result(pasteEntry(recordText(t), plain: false))
        case "copy":
            guard let e = entry(id) else { return ["ok": false, "error": "Entry not found"] }
            return Self.result(copyEntry(e))
        case "copyMarkdownLink":
            guard let e = entry(id), e.type == .link, let t = e.text else { return ["ok": false, "error": "Not a link"] }
            let md = ClipModel.markdownLink(t)
            watcher?.write(PasteboardContent(text: md))
            return ["ok": true, "text": .string(md)]
        case "update":
            guard let id, let t = args["text"]?.stringValue, let e = update(id, text: t) else { return .null }
            return summary(e)
        case "merge":
            let list = ids(args["ids"])
            guard list.count >= 2 else { return ["ok": false, "error": "Select at least two entries to merge"] }
            guard let m = merge(list, separator: args["separator"]?.stringValue ?? "\n") else { return ["ok": false, "error": "Nothing to merge (images cannot be merged)"] }
            if args["paste"]?.boolValue == true { return Self.result(pasteEntry(m, plain: false)) }
            putOnClipboard(m, plain: false)
            return ["ok": true, "id": .string(m.id), "message": .string("Merged \(list.count) entries and copied")]
        case "saveSnippet":
            return Self.result(saveAsSnippet(id ?? "", name: args["name"]?.stringValue))
        case "openLink":
            guard let e = entry(id), e.type == .link, let t = e.text, let url = URL(string: ClipModel.linkHref(t)) else { return ["ok": false, "error": "Not a link"] }
            let r = context?.services.workspace.open(url: url, withApp: nil)
            return ["ok": .bool(r?.ok ?? false)]
        case "reveal":
            guard let f = entry(id)?.files?.first else { return ["ok": false, "error": "Not a file"] }
            context?.services.workspace.reveal(path: f)
            return ["ok": true]
        case "ignoreApp": return Self.result(ignoreSourceApp(id ?? ""))
        case "pin": return .bool(togglePin(id ?? ""))
        case "delete": return .bool(delete(ids(args["ids"] ?? args["id"] ?? args)) > 0)
        case "clear": return .int(Int64(clearHistory(keepPinned: args["keepPinned"]?.boolValue != false)))
        case "pauseFor": return Self.result(pauseFor(minutes: args["minutes"]?.intValue ?? args.intValue ?? 5))
        case "resume": return Self.result(setPaused(false))
        case "getSettings": return ["settings": .object(settings.bag), "hotkeyOk": .bool(hotkeyOk), "stackHotkeyOk": .bool(stackHotkeyOk)]
        case "setSettings":
            patchSettings(args.objectValue ?? [:])
            return ["settings": .object(settings.bag)]
        case "stats":
            let s = ClipModel.stats(entries, settings, now: now)
            var byType: [String: JSONValue] = [:]
            for (t, n) in s.byType { byType[t.rawValue] = .int(Int64(n)) }
            return ["total": .int(Int64(s.total)), "pinned": .int(Int64(s.pinned)), "byType": .object(byType), "imageBytes": .int(Int64(s.imageBytes)),
                    "paused": .bool(s.paused), "pausedUntil": s.pausedUntil.map(JSONValue.double) ?? .null, "enabled": .bool(s.enabled), "watching": .bool(watcher?.isWatching ?? false)]
        case "thumbPath":
            guard let sha = entry(id)?.image?.sha1 else { return .null }
            return storage?.ensureThumb(sha).map { .string($0.path) } ?? .null
        case "flush":
            flush()
            return true

        // Paste Stack
        case "stackGet": return stackState()
        case "stackStart": _ = startPasteStack(limit: args["limit"]?.intValue ?? args.intValue ?? 0); return stackState()
        case "stackStop": stopPasteStack(); return stackState()
        case "stackAdd": stackAdd(ids(args["ids"] ?? args)); return stackState()
        case "stackRemove": stackRemove(id ?? ""); return stackState()
        case "stackMove": stackMove(id ?? "", by: args["dir"]?.intValue ?? 0); return stackState()
        case "stackClear": stackClear(); return stackState()
        case "stackPasteNext": return Self.result(pasteNextFromStack())
        case "tapConfig":
            return ["pasteStack": sentIntercept.map(JSONValue.bool) ?? .null]

        // Headless test hooks (refuse outside headless mode).
        case "debugStackNext":
            guard isHeadless else { return ["ok": false, "error": "Only available with GLIDE_HEADLESS=1"] }
            let (reply, _) = nextForNativePaste()
            let r: JSONValue
            switch reply {
            case let .text(t, html): r = ["text": .string(t), "html": html.map(JSONValue.string) ?? .null]
            case .passthrough: r = ["passthrough": true]
            case .empty: r = ["empty": true]
            }
            return ["ok": true, "reply": r, "active": .bool(stack.interceptsPaste), "stack": stackState()]
        case "debugSetClipboard":
            guard isHeadless, let fake = watcher as? FakePasteboardWatcher else { return ["ok": false, "error": "Only available with GLIDE_HEADLESS=1"] }
            if let s = args["source"]?.objectValue, let name = s["name"]?.stringValue { debugSource = SourceApp(name: name, bundleId: s["bundleId"]?.stringValue) }
            var types = (args["extraTypes"]?.arrayValue ?? []).compactMap(\.stringValue)
            let png = args["pngBase64"]?.stringValue.flatMap { Data(base64Encoded: $0) } ?? args["pngPath"]?.stringValue.flatMap { try? Data(contentsOf: URL(fileURLWithPath: $0)) }
            let files = (args["files"]?.arrayValue ?? []).compactMap(\.stringValue)
            if args["text"] != nil { types.append("public.utf8-plain-text") }
            if png != nil { types.append("public.png") }
            if !files.isEmpty { types.append("public.file-url") }
            fake.simulateCopy(PasteboardSnapshot(types: types, text: args["text"]?.stringValue, html: args["html"]?.stringValue, png: png, files: files, color: args["color"]?.stringValue))
            fake.poll()
            // Image captures finish asynchronously (hash + thumbnail off the main thread).
            if png != nil { for _ in 0..<100 { try? await Task.sleep(for: .milliseconds(20)); if entries.contains(where: { $0.type == .image && $0.lastCopiedAt > now - 5000 }) { break } } }
            return ["ok": true, "count": .int(Int64(entries.count))]
        case "debugReadClipboard":
            guard isHeadless, let w = watcher else { return .null }
            let s = await w.read()
            return ["types": .array(s.types.map(JSONValue.string)), "text": s.text.map(JSONValue.string) ?? .null, "files": .array(s.files.map(JSONValue.string)), "png": .bool(s.png != nil)]
        case "debugOCR":
            // Wait for queued OCR (tests).
            for _ in 0..<300 where !ocrQueueIdle { try? await Task.sleep(for: .milliseconds(50)) }
            return true
        case "viewState":
            switch args["view"]?.stringValue ?? "history" {
            case "stack": return stackModel.state()
            case "edit": return editModel.state()
            default: return history.state()
            }
        default:
            throw FeatureError.unknownMethod(feature: self.id, method: method)
        }
    }
}
