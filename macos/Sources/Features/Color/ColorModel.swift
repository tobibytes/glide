import Foundation
import GlideCore

/// Color parsing and formatting (port of src/main/features/color/colors.ts). 0–255 channels, alpha 0–1.
public struct ColorRGBA: Hashable, Codable, Sendable {
    public var r: Double
    public var g: Double
    public var b: Double
    public var a: Double
    public init(r: Double, g: Double, b: Double, a: Double = 1) {
        self.r = r
        self.g = g
        self.b = b
        self.a = a
    }
}

public enum ColorFormat: String, CaseIterable, Sendable {
    case hex, hexLower, rgb, hsl, swiftui, nscolor, css

    public var title: String {
        switch self {
        case .hex: return "HEX"
        case .hexLower: return "HEX (lowercase)"
        case .rgb: return "RGB"
        case .hsl: return "HSL"
        case .swiftui: return "SwiftUI"
        case .nscolor: return "NSColor"
        case .css: return "CSS"
        }
    }

    /// Order of the "Copy …" actions.
    public static let all: [ColorFormat] = [.hex, .rgb, .hsl, .swiftui, .css, .nscolor, .hexLower]
}

public enum ColorMath {
    static func clamp(_ n: Double, _ lo: Double, _ hi: Double) -> Double { min(hi, max(lo, n)) }

    static func hslToRgb(_ h: Double, _ s: Double, _ l: Double) -> (Double, Double, Double) {
        let hue = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
        let c = (1 - abs(2 * l - 1)) * s
        let x = c * (1 - abs((hue / 60).truncatingRemainder(dividingBy: 2) - 1))
        let m = l - c / 2
        let (r, g, b): (Double, Double, Double) = hue < 60 ? (c, x, 0) : hue < 120 ? (x, c, 0) : hue < 180 ? (0, c, x) : hue < 240 ? (0, x, c) : hue < 300 ? (x, 0, c) : (c, 0, x)
        return (jsRound((r + m) * 255), jsRound((g + m) * 255), jsRound((b + m) * 255))
    }

    /// JavaScript Math.round (half up).
    static func jsRound(_ v: Double) -> Double { (v + 0.5).rounded(.down) }

    public static func hsl(_ c: ColorRGBA) -> (h: Int, s: Int, l: Int) {
        let rn = c.r / 255, gn = c.g / 255, bn = c.b / 255
        let mx = max(rn, gn, bn), mn = min(rn, gn, bn)
        let l = (mx + mn) / 2
        let d = mx - mn
        if d == 0 { return (0, 0, Int(jsRound(l * 100))) }
        let s = d / (1 - abs(2 * l - 1))
        var h: Double
        if mx == rn { h = ((gn - bn) / d).truncatingRemainder(dividingBy: 6) } else if mx == gn { h = (bn - rn) / d + 2 } else { h = (rn - gn) / d + 4 }
        h = jsRound(h * 60)
        if h < 0 { h += 360 }
        return (Int(h), Int(jsRound(s * 100)), Int(jsRound(l * 100)))
    }

    static func num(_ s: String, _ maxV: Double) -> Double? {
        let t = s.trimmingCharacters(in: .whitespaces)
        if t.hasSuffix("%") {
            guard let v = Double(t.dropLast()), v.isFinite else { return nil }
            return clamp(v, 0, 100) / 100 * maxV
        }
        guard !t.isEmpty, let v = Double(t), v.isFinite else { return nil }
        return clamp(v, 0, maxV)
    }

    /// "#f80", "#ff8800", "#ff880080", "rgb(255, 136, 0)", "rgba(255 136 0 / 50%)", "hsl(32, 100%, 50%)".
    public static func parse(_ input: String) -> ColorRGBA? {
        let t = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if t.hasPrefix("#") {
            var h = String(t.dropFirst())
            guard [3, 4, 6, 8].contains(h.count), h.allSatisfy(\.isHexDigit) else { return nil }
            if h.count <= 4 { h = h.map { "\($0)\($0)" }.joined() }
            func byte(_ i: Int) -> Double {
                let s = h.index(h.startIndex, offsetBy: i)
                return Double(Int(h[s..<h.index(s, offsetBy: 2)], radix: 16) ?? 0)
            }
            return ColorRGBA(r: byte(0), g: byte(2), b: byte(4), a: h.count == 8 ? jsRound(byte(6) / 255 * 100) / 100 : 1)
        }
        guard let open = t.firstIndex(of: "("), t.hasSuffix(")") else { return nil }
        let fn = String(t[..<open])
        guard ["rgb", "rgba", "hsl", "hsla"].contains(fn) else { return nil }
        let inner = String(t[t.index(after: open)..<t.index(before: t.endIndex)])
        let parts = inner.split(whereSeparator: { $0 == "," || $0 == "/" || $0 == " " }).map(String.init).filter { !$0.isEmpty }
        guard parts.count == 3 || parts.count == 4 else { return nil }
        let alpha = parts.count == 4 ? num(parts[3], 1) : 1
        guard let alpha else { return nil }
        if fn.hasPrefix("rgb") {
            guard let r = num(parts[0], 255), let g = num(parts[1], 255), let b = num(parts[2], 255) else { return nil }
            return ColorRGBA(r: jsRound(r), g: jsRound(g), b: jsRound(b), a: alpha)
        }
        let hs = parts[0].hasSuffix("deg") ? String(parts[0].dropLast(3)) : parts[0]
        guard let h = Double(hs), h.isFinite, parts[1].hasSuffix("%"), parts[2].hasSuffix("%"), let s = num(parts[1], 1), let l = num(parts[2], 1) else { return nil }
        let (r, g, b) = hslToRgb(h, s, l)
        return ColorRGBA(r: r, g: g, b: b, a: alpha)
    }

    static func hex2(_ n: Double) -> String { String(format: "%02x", Int(jsRound(n))) }
    static func f3(_ n: Double) -> String {
        let v = jsRound(n * 1000) / 1000
        return v == v.rounded() ? String(Int(v)) : String(v)
    }

    public static func format(_ c: ColorRGBA, _ format: ColorFormat) -> String {
        let alpha = c.a < 1
        switch format {
        case .hex: return "#\(hex2(c.r))\(hex2(c.g))\(hex2(c.b))\(alpha ? hex2(c.a * 255) : "")".uppercased()
        case .hexLower: return "#\(hex2(c.r))\(hex2(c.g))\(hex2(c.b))\(alpha ? hex2(c.a * 255) : "")"
        case .rgb: return alpha ? "rgba(\(Int(c.r)), \(Int(c.g)), \(Int(c.b)), \(f3(c.a)))" : "rgb(\(Int(c.r)), \(Int(c.g)), \(Int(c.b)))"
        case .hsl:
            let x = hsl(c)
            return alpha ? "hsla(\(x.h), \(x.s)%, \(x.l)%, \(f3(c.a)))" : "hsl(\(x.h), \(x.s)%, \(x.l)%)"
        case .swiftui: return "Color(red: \(f3(c.r / 255)), green: \(f3(c.g / 255)), blue: \(f3(c.b / 255))\(alpha ? ", opacity: \(f3(c.a))" : ""))"
        case .nscolor: return "NSColor(srgbRed: \(f3(c.r / 255)), green: \(f3(c.g / 255)), blue: \(f3(c.b / 255)), alpha: \(f3(c.a)))"
        case .css: return "color: \(Self.format(c, .hexLower));"
        }
    }

    /// WCAG relative luminance (readable text on a swatch).
    public static func luminance(_ c: ColorRGBA) -> Double {
        func ch(_ v: Double) -> Double {
            let s = v / 255
            return s <= 0.03928 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
    }

    /// Opaque "#RRGGBB".
    public static func hexOf(_ c: ColorRGBA) -> String { format(ColorRGBA(r: c.r, g: c.g, b: c.b, a: 1), .hex) }
}

/// history.json entry (same shape as the Electron app).
public struct ColorEntry: Hashable, Codable, Sendable {
    public var hex: String
    public var rgba: ColorRGBA
    public var at: Double
    /// "picker" | "search"
    public var source: String
    public init(hex: String, rgba: ColorRGBA, at: Double, source: String) {
        self.hex = hex
        self.rgba = rgba
        self.at = at
        self.source = source
    }

    public static let maxHistory = 60

    public static func add(_ list: [ColorEntry], _ c: ColorRGBA, source: String, now: Double) -> [ColorEntry] {
        let hex = ColorMath.format(c, .hex)
        return Array(([ColorEntry(hex: hex, rgba: c, at: now, source: source)] + list.filter { $0.hex != hex }).prefix(maxHistory))
    }

    /// Tolerant load: entries without hex/rgba/at are dropped.
    public static func load(_ v: JSONValue?) -> [ColorEntry] {
        guard let arr = v?.arrayValue else { return [] }
        return arr.compactMap { e in
            guard let hex = e["hex"]?.stringValue, let at = e["at"]?.number, let rgba = e["rgba"], let r = rgba["r"]?.number, let g = rgba["g"]?.number, let b = rgba["b"]?.number else { return nil }
            return ColorEntry(hex: hex, rgba: ColorRGBA(r: r, g: g, b: b, a: rgba["a"]?.number ?? 1), at: at, source: e["source"]?.stringValue ?? "search")
        }
    }
}
