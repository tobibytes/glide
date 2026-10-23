import AppKit
import GlideCore
import GlideSystem
import SwiftUI

/// Pure hotkey-recorder state machine: key presses with modifiers become combos ("Control+Alt+K"); a modifier
/// pressed and released alone twice within `doubleWindow` becomes "Double+Command"; a single right-side
/// modifier tap becomes "Right+Alt" once the double window has passed. Output uses the Electron accelerator
/// grammar (HotkeyParser accepts it). Escape alone cancels.
public struct HotkeyRecorderLogic: Equatable, Sendable {
    public enum Event: Equatable, Sendable {
        case keyDown(key: String, mods: [HotkeyMod], time: Double)
        /// One modifier changed (side "left" | "right").
        case modifier(HotkeyMod, side: String, down: Bool, time: Double)
        /// Clock tick (resolves a pending single tap).
        case tick(time: Double)
    }

    public enum Outcome: Equatable, Sendable { case none, recorded(String), cancelled }

    public static let doubleWindow: Double = 0.4
    static let names: [HotkeyMod: String] = [.ctrl: "Control", .alt: "Alt", .shift: "Shift", .cmd: "Command", .hyper: "Hyper"]
    static let order: [HotkeyMod] = [.ctrl, .alt, .shift, .cmd]

    private var held: [HotkeyMod] = []
    /// A modifier that went down alone (no key, no other modifier) and is still clean.
    private var cleanMod: (mod: HotkeyMod, side: String)?
    private var lastTap: (mod: HotkeyMod, side: String, time: Double)?
    public private(set) var preview: String = ""

    public init() {}

    public static func == (a: Self, b: Self) -> Bool { a.held == b.held && a.preview == b.preview && a.lastTap?.time == b.lastTap?.time }

    public static func combo(_ mods: [HotkeyMod], key: String) -> String {
        (order.filter { mods.contains($0) }.compactMap { names[$0] } + [key]).joined(separator: "+")
    }

    public mutating func feed(_ e: Event) -> Outcome {
        switch e {
        case let .keyDown(key, mods, _):
            cleanMod = nil
            lastTap = nil
            if mods.isEmpty && key == "Escape" { return .cancelled }
            guard !mods.isEmpty || key.hasPrefix("F") && key.count > 1 else {
                preview = "Add a modifier (⌘ ⌥ ⌃ ⇧)"
                return .none
            }
            let accel = Self.combo(mods, key: key)
            if case .failure = HotkeyParser.parse(accel) { preview = "\(key) can’t be a global hotkey"; return .none }
            return .recorded(accel)
        case let .modifier(mod, side, down, time):
            if down {
                held.append(mod)
                cleanMod = held.count == 1 ? (mod, side) : nil
                preview = Self.order.filter { held.contains($0) }.compactMap { Self.names[$0] }.joined(separator: "+") + "+…"
                return .none
            }
            held.removeAll { $0 == mod }
            defer { if held.isEmpty { preview = "" } }
            guard let c = cleanMod, c.mod == mod else { cleanMod = nil; return .none }
            cleanMod = nil
            if let t = lastTap, t.mod == mod, time - t.time <= Self.doubleWindow {
                lastTap = nil
                return .recorded("Double+\(Self.names[mod] ?? "Command")")
            }
            lastTap = (mod, side, time)
            return .none
        case let .tick(time):
            guard let t = lastTap, time - t.time > Self.doubleWindow else { return .none }
            lastTap = nil
            // A single tap only makes sense on one side (Right+Alt); a left tap is too easy to hit by accident.
            if t.side == "right" { return .recorded("Right+\(Self.names[t.mod] ?? "Alt")") }
            preview = "Tap \(Self.names[t.mod] ?? "") twice for a double-tap shortcut"
            return .none
        }
    }

    /// NSEvent key code → accelerator key name (layout-independent keys), else the typed character.
    public static func keyName(keyCode: UInt16, characters: String?) -> String? {
        let named: [UInt16: String] = [49: "Space", 36: "Return", 76: "Return", 48: "Tab", 53: "Escape", 51: "Backspace", 117: "Delete",
                                       123: "Left", 124: "Right", 125: "Down", 126: "Up", 115: "Home", 119: "End", 116: "PageUp", 121: "PageDown"]
        if let n = named[keyCode] { return n }
        let f: [UInt16] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90]
        if let i = f.firstIndex(of: keyCode) { return "F\(i + 1)" }
        guard let c = characters?.trimmingCharacters(in: .whitespaces), c.count == 1 else { return nil }
        return c == "+" ? "Plus" : c.uppercased()
    }

    /// Display form ("Command+Space" → "⌘Space", "Double+Command" → "⌘⌘").
    public static func display(_ accel: String) -> String { Accelerator.display(accel) }
}

/// Settings control: shows the current hotkey; "Record" listens to key events of the Settings window only
/// (a local NSEvent monitor while recording — no global tap).
struct KeyboardHotkeyField: View {
    let current: String
    let onRecord: (String) -> Void
    @State private var recording = false
    @State private var logic = HotkeyRecorderLogic()
    @State private var monitor: Any?
    @State private var ticker: Timer?

    var body: some View {
        HStack(spacing: 10) {
            Text(recording ? (logic.preview.isEmpty ? "Press a shortcut…" : logic.preview) : HotkeyRecorderLogic.display(current))
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .frame(minWidth: 140)
                .padding(.vertical, 4).padding(.horizontal, 10)
                .background(RoundedRectangle(cornerRadius: 6).fill(recording ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.12)))
            Button(recording ? "Cancel" : "Record…") { recording ? stop() : start() }
        }
        .onDisappear(perform: stop)
    }

    private func start() {
        logic = HotkeyRecorderLogic()
        recording = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged]) { ev in
            handle(ev)
            return nil
        }
        ticker = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            MainActor.assumeIsolated { apply(logic.feeding(.tick(time: ProcessInfo.processInfo.systemUptime))) }
        }
    }

    private func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        ticker?.invalidate()
        ticker = nil
        recording = false
    }

    private func handle(_ ev: NSEvent) {
        let t = ev.timestamp
        if ev.type == .keyDown {
            guard let key = HotkeyRecorderLogic.keyName(keyCode: ev.keyCode, characters: ev.charactersIgnoringModifiers) else { return }
            var mods: [HotkeyMod] = []
            let f = ev.modifierFlags
            if f.contains(.control) { mods.append(.ctrl) }
            if f.contains(.option) { mods.append(.alt) }
            if f.contains(.shift) { mods.append(.shift) }
            if f.contains(.command) { mods.append(.cmd) }
            apply(logic.feeding(.keyDown(key: key, mods: mods, time: t)))
        } else {
            let map: [UInt16: (HotkeyMod, String, NSEvent.ModifierFlags)] = [55: (.cmd, "left", .command), 54: (.cmd, "right", .command), 58: (.alt, "left", .option),
                                                                            61: (.alt, "right", .option), 59: (.ctrl, "left", .control), 62: (.ctrl, "right", .control),
                                                                            56: (.shift, "left", .shift), 60: (.shift, "right", .shift)]
            guard let (mod, side, flag) = map[ev.keyCode] else { return }
            apply(logic.feeding(.modifier(mod, side: side, down: ev.modifierFlags.contains(flag), time: t)))
        }
    }

    private func apply(_ r: (HotkeyRecorderLogic, HotkeyRecorderLogic.Outcome)) {
        logic = r.0
        switch r.1 {
        case .none: break
        case .cancelled: stop()
        case let .recorded(a):
            stop()
            onRecord(a)
        }
    }
}

extension HotkeyRecorderLogic {
    func feeding(_ e: Event) -> (HotkeyRecorderLogic, Outcome) {
        var c = self
        let o = c.feed(e)
        return (c, o)
    }
}
