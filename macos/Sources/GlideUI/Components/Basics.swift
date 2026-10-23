import AppKit
import GlideCore
import SwiftUI

/// Behind-window vibrancy (NSVisualEffectView); falls back to the panel color when opaque.
public struct VibrancyBackground: NSViewRepresentable {
    public var material: NSVisualEffectView.Material
    public init(material: NSVisualEffectView.Material = .hudWindow) { self.material = material }
    public func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = .behindWindow
        v.state = .active
        return v
    }
    public func updateNSView(_ v: NSVisualEffectView, context: Context) { v.material = material }
}

/// A keycap: "⌘K" renders as two caps.
public struct Kbd: View {
    @Environment(\.glideTheme) private var theme
    let keys: [String]
    public init(_ shortcut: String) { keys = Kbd.split(shortcut) }

    static func split(_ s: String) -> [String] {
        let named = ["Space", "Tab", "Esc", "Enter", "Return"]
        if named.contains(s) { return [s] }
        var out: [String] = []
        var rest = Substring(s)
        while let c = rest.first, "⌘⌥⌃⇧".contains(c) {
            out.append(String(c))
            rest = rest.dropFirst()
        }
        if !rest.isEmpty { out.append(String(rest)) }
        return out
    }

    public var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(keys.enumerated()), id: \.offset) { _, k in
                Text(k)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(theme.kbdText)
                    .frame(minWidth: 18, minHeight: 18)
                    .padding(.horizontal, k.count > 1 ? 4 : 0)
                    .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(theme.kbdBg))
            }
        }
    }
}

/// Small rounded tag (alias, argument, kind).
public struct Tag: View {
    @Environment(\.glideTheme) private var theme
    let text: String
    let accent: Bool
    public init(_ text: String, accent: Bool = false) {
        self.text = text
        self.accent = accent
    }
    public var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .medium))
            .lineLimit(1)
            .foregroundStyle(accent ? theme.accentText : theme.text2)
            .padding(.horizontal, 6)
            .frame(height: 18)
            .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(accent ? theme.accentSoft : theme.tagBg))
    }
}

/// Cached icons for app bundles and files (NSWorkspace). Reading icon files is side-effect free.
@MainActor public final class IconCache {
    public static let shared = IconCache()
    private let cache = NSCache<NSString, NSImage>()
    public func icon(forPath path: String) -> NSImage {
        let key = path as NSString
        if let hit = cache.object(forKey: key) { return hit }
        let img = NSWorkspace.shared.icon(forFile: URL(fileURLWithPath: (path as NSString).expandingTildeInPath).resolvingSymlinksInPath().path)
        img.size = NSSize(width: 64, height: 64)
        cache.setObject(img, forKey: key)
        return img
    }
}

/// Renders an `ItemIcon` (emoji | symbol | app | file | url | color).
public struct ItemIconView: View {
    @Environment(\.glideTheme) private var theme
    let icon: ItemIcon?
    let size: CGFloat
    let fallbackSymbol: String
    public init(_ icon: ItemIcon?, size: CGFloat, fallbackSymbol: String = "app.dashed") {
        self.icon = icon
        self.size = size
        self.fallbackSymbol = fallbackSymbol
    }

    public var body: some View {
        Group {
            switch icon?.kind {
            case "app", "file":
                Image(nsImage: IconCache.shared.icon(forPath: icon!.value)).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
            case "emoji":
                Text(icon!.value).font(.system(size: size * 0.78)).frame(width: size, height: size)
            case "color":
                RoundedRectangle(cornerRadius: size * 0.25, style: .continuous).fill(Color(RGBA(hex: icon!.value) ?? theme.tokens.accent)).padding(size * 0.1)
            case "symbol":
                symbolTile(icon!.value, tint: icon!.tint.flatMap { RGBA(hex: $0) }.map(Color.init))
            case "url":
                URLIconView(url: icon!.value, size: size) { symbolTile("globe", tint: nil) }
            default:
                symbolTile(fallbackSymbol, tint: nil)
            }
        }
        .frame(width: size, height: size)
    }

    private func symbolTile(_ name: String, tint: Color?) -> some View {
        let resolved = NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil ? name : fallbackSymbol
        return ZStack {
            RoundedRectangle(cornerRadius: size * 0.26, style: .continuous).fill(tint.map { $0.opacity(0.18) } ?? theme.iconBg)
            Image(systemName: resolved).font(.system(size: size * 0.5, weight: .medium)).foregroundStyle(tint ?? theme.text2)
        }
    }
}

/// Title with matched UTF-16 ranges highlighted in the accent color.
public struct HighlightedText: View {
    @Environment(\.glideTheme) private var theme
    let text: String
    let ranges: [MatchRange]
    let font: Font
    public init(_ text: String, ranges: [MatchRange], font: Font) {
        self.text = text
        self.ranges = ranges
        self.font = font
    }

    public static func attributed(_ text: String, ranges: [MatchRange], base: Color, highlight: Color) -> AttributedString {
        var out = AttributedString()
        let units = Array(text.utf16)
        var cursor = 0
        func piece(_ a: Int, _ b: Int) -> String { String(utf16CodeUnits: Array(units[a..<b]), count: b - a) }
        for r in ranges.sorted(by: { $0.start < $1.start }) {
            let start = max(r.start, cursor), end = min(r.end, units.count)
            guard start < end else { continue }
            if start > cursor {
                var plain = AttributedString(piece(cursor, start))
                plain.foregroundColor = base
                out += plain
            }
            var mark = AttributedString(piece(start, end))
            mark.foregroundColor = highlight
            mark.inlinePresentationIntent = .stronglyEmphasized
            out += mark
            cursor = end
        }
        if cursor < units.count {
            var tail = AttributedString(piece(cursor, units.count))
            tail.foregroundColor = base
            out += tail
        }
        return out
    }

    public var body: some View {
        Text(Self.attributed(text, ranges: ranges, base: theme.text, highlight: theme.accentText)).font(font).lineLimit(1).truncationMode(.tail)
    }
}

/// Images for `ItemIcon` kind "url" (integration). `data:` and `file:` URLs decode synchronously; http(s) URLs
/// load the site's favicon (`<scheme>://<host>/favicon.ico`, or the URL itself when it names an image) only when
/// `networkAllowed` (the app sets it; headless runs never touch the network) and are cached in memory.
@MainActor public final class FaviconCache {
    public static let shared = FaviconCache()
    public static var networkAllowed = false
    private var images: [String: NSImage] = [:]
    private var failed: Set<String> = []
    private var loading: Set<String> = []

    public func cached(_ url: String) -> NSImage? {
        if let i = images[url] { return i }
        guard let u = URL(string: url) else { return nil }
        var img: NSImage?
        if u.scheme == "data", let comma = url.firstIndex(of: ",") {
            let meta = url[..<comma]
            let payload = String(url[url.index(after: comma)...])
            let data = meta.hasSuffix(";base64") ? Data(base64Encoded: payload) : payload.removingPercentEncoding.map { Data($0.utf8) }
            img = data.flatMap(NSImage.init(data:))
        } else if u.isFileURL {
            img = NSImage(contentsOf: u)
        }
        if let img { images[url] = img }
        return img
    }

    public static func faviconURL(for url: URL) -> URL? {
        guard let scheme = url.scheme, ["http", "https"].contains(scheme), let host = url.host else { return nil }
        if ["ico", "png", "svg", "jpg", "jpeg", "gif", "webp"].contains(url.pathExtension.lowercased()) { return url }
        return URL(string: "\(scheme)://\(host)/favicon.ico")
    }

    func load(_ url: String, done: @escaping @MainActor (NSImage?) -> Void) {
        if let i = cached(url) { done(i); return }
        guard Self.networkAllowed, !failed.contains(url), !loading.contains(url), let u = URL(string: url), let fav = Self.faviconURL(for: u) else { done(nil); return }
        loading.insert(url)
        Task { @MainActor in
            let data = try? await URLSession.shared.data(from: fav).0
            self.loading.remove(url)
            if let data, let img = NSImage(data: data) { self.images[url] = img } else { self.failed.insert(url) }
            done(self.images[url])
        }
    }
}

struct URLIconView<Placeholder: View>: View {
    let url: String
    let size: CGFloat
    @ViewBuilder let placeholder: () -> Placeholder
    @State private var image: NSImage?
    var body: some View {
        Group {
            if let img = image ?? FaviconCache.shared.cached(url) {
                Image(nsImage: img).resizable().interpolation(.high).aspectRatio(contentMode: .fit).padding(size * 0.08)
            } else {
                placeholder()
            }
        }
        .task(id: url) { FaviconCache.shared.load(url) { image = $0 } }
    }
}
