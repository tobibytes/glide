import AppKit
import Darwin
import GlideCore
import GlideSystem

/// Newline-delimited JSON test channel on stdin/stdout (`Glide --test-server`, always headless).
/// Every response is one JSON line `{"ok":true,…}` (echoing `"id"` when given); side effects print as
/// `[headless] …` lines. See docs/TESTING.md.
@MainActor final class TestServer {
    let core: AppCore
    private var queue: [JSONValue] = []
    private var busy = false

    init(core: AppCore) { self.core = core }

    func start() {
        // Deterministic rankings under a loaded CPU (see FeatureRegistry.dynamicBudgetScale); override with
        // GLIDE_DYNAMIC_BUDGET_SCALE=1 to test the production budget.
        core.registry.dynamicBudgetScale = ProcessInfo.processInfo.environment["GLIDE_DYNAMIC_BUDGET_SCALE"].flatMap(Double.init) ?? 3
        Thread.detachNewThread { [weak self] in
            while let line = readLine(strippingNewline: true) {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty { continue }
                let parsed = (try? JSONDecoder().decode(JSONValue.self, from: Data(trimmed.utf8))) ?? ["cmd": "invalid", "raw": .string(trimmed)]
                DispatchQueue.main.async { MainActor.assumeIsolated { self?.enqueue(parsed) } }
            }
            // stdin closed: the driver is gone.
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.quit(code: 0) } }
        }
        startWatchdog()
        StdoutWriter.shared.line(#"{"event":"ready","ok":true,"startupMs":\#(Int(core.startupMs))}"#)
    }

    /// Exit when the parent dies (reparented to launchd) or GLIDE_TEST_PARENT_PID disappears.
    private func startWatchdog() {
        let parentPid = ProcessInfo.processInfo.environment["GLIDE_TEST_PARENT_PID"].flatMap { Int32($0) }
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            let orphaned = getppid() == 1
            let parentGone = parentPid.map { kill($0, 0) != 0 && errno == ESRCH } ?? false
            if orphaned || parentGone { exit(3) }
        }
    }

    private func enqueue(_ cmd: JSONValue) {
        queue.append(cmd)
        pump()
    }

    /// Commands run strictly in order.
    private func pump() {
        guard !busy, !queue.isEmpty else { return }
        busy = true
        let cmd = queue.removeFirst()
        Task { @MainActor in
            var response: JSONValue
            do { response = try await self.handle(cmd) } catch { response = ["ok": false, "error": .string(error.localizedDescription)] }
            if case var .object(o) = response {
                if let id = cmd["id"] { o["id"] = id }
                if o["ok"] == nil { o["ok"] = true }
                response = .object(o)
            }
            StdoutWriter.shared.line(String(decoding: (try? JSONEncoder.glideCompact.encode(response)) ?? Data("{}".utf8), as: UTF8.self))
            self.busy = false
            self.pump()
        }
    }

    private var launcher: LauncherController { core.launcher }

    func handle(_ cmd: JSONValue) async throws -> JSONValue {
        switch cmd["cmd"]?.stringValue ?? "" {
        case "ping": return ["pong": true]
        case "show":
            let t0 = DispatchTime.now().uptimeNanoseconds
            launcher.show()
            await launcher.settle()
            core.window.hosting.layoutSubtreeIfNeeded()
            core.window.hosting.displayIfNeeded()
            let ms = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6
            return ["visible": .bool(core.window.isVisible), "showMs": .double(ms), "panelShowMs": .double(core.window.lastShowMs)]
        case "hide":
            launcher.hide()
            return ["visible": .bool(core.window.isVisible)]
        case "type":
            launcher.type(cmd["text"]?.stringValue ?? "")
            await launcher.settle()
            return state()
        case "key":
            guard let raw = cmd["key"]?.stringValue, let k = KeyMapping.parse(raw) else { return ["ok": false, "error": "unknown key"] }
            let consumed = launcher.handleKey(k)
            if !consumed, k.key == "Backspace", !k.meta, !launcher.query.isEmpty { launcher.query.removeLast() }
            else if !consumed, k.key.count == 1, !k.meta, !k.ctrl { launcher.query += k.key }
            try? await Task.sleep(for: .milliseconds(30)) // let spawned action tasks finish
            await launcher.settle()
            var s = state()
            if case var .object(o) = s { o["consumed"] = .bool(consumed); s = .object(o) }
            return s
        case "setQuery":
            launcher.query = cmd["text"]?.stringValue ?? ""
            await launcher.settle()
            return state()
        case "state":
            await launcher.settle()
            return state()
        case "snapshot" where cmd["target"]?.stringValue == "settings":
            // Settings shell rendered offscreen (no window is created, nothing is ordered on screen).
            let path = cmd["path"]?.stringValue ?? FileManager.default.temporaryDirectory.appendingPathComponent("glide-settings.png").path
            let size = try SettingsSnapshot.render(core: core, page: cmd["page"]?.stringValue, to: URL(fileURLWithPath: path))
            return ["path": .string(path), "width": .int(Int64(size.width)), "height": .int(Int64(size.height))]
        case "snapshot":
            let path = cmd["path"]?.stringValue ?? FileManager.default.temporaryDirectory.appendingPathComponent("glide-launcher.png").path
            let t0 = DispatchTime.now().uptimeNanoseconds
            // Let SwiftUI apply pending Observation updates (two run-loop passes + layout).
            core.window.contentHeightChanged()
            try? await Task.sleep(for: .milliseconds(30))
            core.window.hosting.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(30))
            let size = try core.window.snapshot(to: URL(fileURLWithPath: path))
            return ["path": .string(path), "width": .int(Int64(size.width)), "height": .int(Int64(size.height)),
                    "ms": .double(Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6)]
        case "metrics": return metrics()
        case "invoke": return try await invoke(cmd)
        case "shutdownProbe":
            // Stops every feature the way Quit does, one at a time with a deadline, and reports the slow ones.
            var slow: [JSONValue] = []
            for f in core.registry.features.reversed() {
                let started = Date()
                let box = ShutdownFlag()
                Task { @MainActor in await f.stop(); box.done = true }
                while !box.done, Date().timeIntervalSince(started) < 3 { try? await Task.sleep(for: .milliseconds(20)) }
                let ms = Date().timeIntervalSince(started) * 1000
                if !box.done || ms > 500 { slow.append(["feature": .string(f.id), "ms": .double(ms.rounded()), "finished": .bool(box.done)]) }
            }
            return ["slow": .array(slow)]
        case "quit":
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { MainActor.assumeIsolated { self.quit(code: 0) } }
            return ["quitting": true]
        default:
            return ["ok": false, "error": .string("unknown cmd \(cmd["cmd"]?.description ?? "nil")")]
        }
    }

    private func invoke(_ cmd: JSONValue) async throws -> JSONValue {
        let feature = cmd["feature"]?.stringValue ?? ""
        let method = cmd["method"]?.stringValue ?? ""
        let args = cmd["args"] ?? .null
        switch (feature, method) {
        case ("headless", "effects"):
            let entries = core.sideEffects?.all ?? []
            return ["result": .array(entries.map { ["kind": .string($0.kind), "detail": $0.detail] })]
        case ("headless", "clearEffects"):
            core.sideEffects?.clear()
            return ["result": true]
        case ("headless", "pasteboard"):
            return ["result": core.services.pasteboard.string().map(JSONValue.string) ?? .null]
        case ("headless", "hotkeys"):
            let b = (core.services.hotkeys as? HeadlessHotkeys)?.bindings ?? []
            return ["result": .array(b.map { ["id": .string($0.id), "accelerator": .string($0.accelerator)] })]
        case ("headless", "pressHotkey"):
            (core.services.hotkeys as? HeadlessHotkeys)?.simulate(id: args["id"]?.stringValue ?? "launcher")
            await launcher.settle()
            return ["result": .bool(core.window.isVisible)]
        case ("launcher", "push"):
            launcher.push(ViewID(rawValue: args["view"]?.stringValue ?? "glide.shortcuts"), payload: args["payload"] ?? .null)
            return state()
        case ("launcher", "pop"):
            launcher.pop()
            return state()
        case ("launcher", "expireIdle"):
            launcher.expireIdle()
            return ["result": true]
        case ("store", "data"):
            core.store.flush()
            return ["result": try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.glide.encode(core.store.data))]
        case ("store", "usage"):
            return ["result": try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.glide.encode(core.store.usage))]
        case ("store", "setSettings"):
            let patch = args.objectValue ?? [:]
            core.store.mutate { d in
                if let v = patch["vimMode"]?.boolValue { d.settings.vimMode = v }
                if let v = patch["keepOpenAfterRun"]?.boolValue { d.settings.keepOpenAfterRun = v }
                if let v = patch["hideOnBlur"]?.boolValue { d.settings.hideOnBlur = v }
                if let v = patch["theme"]?.stringValue { d.settings.theme = v }
                if let v = patch["hotkey"]?.stringValue { d.settings.hotkey = v }
                if let v = patch["sectionLimit"]?.intValue { d.settings.sectionLimit = v }
                if let v = patch["calculator"]?.boolValue { d.settings.calculator = v }
                if let a = patch["appearance"]?.objectValue { d.settings.features[AppearanceSettings.featureId, default: [:]].merge(a) { $1 } }
            }
            try? await Task.sleep(for: .milliseconds(20))
            launcher.rebuildCatalogue()
            await launcher.settle()
            return ["result": true]
        case ("store", "flush"):
            core.store.flush()
            return ["result": true]
        default:
            return ["result": try await core.registry.invoke(feature: feature, method: method, args: args)]
        }
    }

    func state() -> JSONValue {
        let c = launcher
        let selectedId = c.selected?.id
        let rows: [JSONValue] = c.itemRows.map { r in
            var o: [String: JSONValue] = ["id": .string(r.scored.id), "title": .string(r.scored.item.title), "kind": .string(r.scored.item.kind.rawValue),
                                          "selected": .bool(r.scored.id == selectedId), "section": .string(r.row.section)]
            if let a = r.scored.argument { o["argument"] = .string(a) }
            if let s = r.scored.item.subtitle { o["subtitle"] = .string(s) }
            return .object(o)
        }
        var o: [String: JSONValue] = [
            "query": .string(c.query), "rows": .array(rows), "view": c.top.map { .string($0.id.rawValue) } ?? .null,
            "stackDepth": .int(Int64(c.stack.count)), "toast": c.toast.map { .string($0.message) } ?? .null,
            "toastStyle": c.toast.map { .string($0.style.rawValue) } ?? .null,
            "mode": .string(c.vimEnabled ? c.mode.rawValue : "insert"), "vimEnabled": .bool(c.vimEnabled),
            "visible": .bool(core.window.isVisible), "placeholder": .string(c.placeholder), "primaryAction": c.primaryTitle.map(JSONValue.string) ?? .null,
            "theme": .string(c.theme.tokens.preset.id),
            "contextTitle": c.contextTitle.map(JSONValue.string) ?? .null,
        ]
        if let p = c.actionPanel {
            o["actionPanel"] = ["open": true, "title": .string(p.item.item.title), "filter": .string(p.filter), "selected": .int(Int64(p.selected)),
                                "actions": .array(p.filtered.map { .string($0.title) })]
        } else {
            o["actionPanel"] = ["open": false]
        }
        if let a = c.argument { o["argumentFor"] = .string(a.item.item.title) }
        if let m = c.argument?.multi { o["arguments"] = MultiArgument.json(m, text: c.query) }
        return .object(o)
    }

    func metrics() -> JSONValue {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) { ptr in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        let footprint = kr == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1
        let resident = kr == KERN_SUCCESS ? Double(info.resident_size) / 1_048_576 : -1
        return ["footprintMB": .double((footprint * 10).rounded() / 10), "residentMB": .double((resident * 10).rounded() / 10),
                "items": .int(Int64(launcher.engine.allItems.count)), "startupMs": .double(core.startupMs),
                "uptimeS": .double(Date().timeIntervalSince(core.startedAt)),
                "dynamicMs": .object(FeatureRegistry.lastDynamicMs.mapValues { .double(($0 * 100).rounded() / 100) })]
    }

    func quit(code: Int32) {
        core.store.flush()
        exit(code)
    }
}
