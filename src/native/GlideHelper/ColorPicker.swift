import AppKit

/// color.pick: the system color sampler (magnifier loupe). Click picks, Esc cancels.
/// NSColorSampler needs no Screen Recording permission. The helper normally runs with the
/// .prohibited activation policy, which cannot show UI, so it switches to .accessory while sampling.
enum ColorPicker {
    private static var sampler: NSColorSampler?

    static func pick(timeout: TimeInterval) -> [String: Any] {
        let done = DispatchSemaphore(value: 0)
        let box = ColorBox()
        DispatchQueue.main.async {
            NSApp.setActivationPolicy(.accessory)
            NSApp.activate(ignoringOtherApps: true)
            let s = NSColorSampler()
            sampler = s
            s.show { color in
                box.color = color
                done.signal()
            }
        }
        let waited = done.wait(timeout: .now() + timeout)
        onMain {
            sampler = nil
            NSApp.setActivationPolicy(.prohibited)
        }
        if waited == .timedOut { return ["hex": NSNull(), "reason": "timeout"] }
        guard let c = box.color?.usingColorSpace(.sRGB) else { return ["hex": NSNull(), "reason": "cancelled"] }
        let r = Int((c.redComponent * 255).rounded())
        let g = Int((c.greenComponent * 255).rounded())
        let b = Int((c.blueComponent * 255).rounded())
        return ["hex": String(format: "#%02X%02X%02X", r, g, b), "r": r, "g": g, "b": b, "a": Double(c.alphaComponent)]
    }
}

private final class ColorBox: @unchecked Sendable {
    var color: NSColor?
}
