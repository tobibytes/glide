import AppKit
import GlideCore

/// The system color sampler loupe (helper ColorPicker.swift). No Screen Recording permission needed.
@MainActor public final class SamplerColorPicker: ColorPickerService {
    private var sampler: NSColorSampler?
    public init() {}

    public func pick(timeout: TimeInterval) async -> PickedColor {
        let s = NSColorSampler()
        sampler = s
        defer { sampler = nil }
        let color: NSColor?? = await withCheckedContinuation { cont in
            let once = OnceFlag()
            s.show { c in if once.take() { cont.resume(returning: .some(c)) } }
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { if once.take() { cont.resume(returning: .none) } }
        }
        guard let picked = color else { return PickedColor(hex: nil, reason: "timeout") }
        guard let c = picked?.usingColorSpace(.sRGB) else { return PickedColor(hex: nil, reason: "cancelled") }
        let r = Int((c.redComponent * 255).rounded()), g = Int((c.greenComponent * 255).rounded()), b = Int((c.blueComponent * 255).rounded())
        return PickedColor(hex: String(format: "#%02X%02X%02X", r, g, b), r: r, g: g, b: b, a: Double(c.alphaComponent))
    }
}

final class OnceFlag: @unchecked Sendable {
    private var done = false
    private let lock = NSLock()
    func take() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}
