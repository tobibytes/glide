import AppKit
import GlideCore
import SwiftUI

/// Renders a SwiftUI view to a PNG without ever putting a window on screen (headless snapshots).
@MainActor public enum OffscreenSnapshot {
    @discardableResult
    public static func render<V: View>(_ view: V, size: CGSize, to url: URL, appearance: NSAppearance.Name? = nil) throws -> CGSize {
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
        host.frame = NSRect(origin: .zero, size: size)
        if let appearance { host.appearance = NSAppearance(named: appearance) }
        // A borderless window that is never ordered front gives the hosting view a backing scale and
        // lets Form/List styles resolve; it is not shown.
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        window.contentView = host
        if let appearance { window.appearance = NSAppearance(named: appearance) }
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        // Two passes: SwiftUI settles some layouts (grids, forms) on the second.
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        let bounds = host.bounds
        guard let rep = host.bitmapImageRepForCachingDisplay(in: bounds) else { throw FeatureError.failed("no bitmap") }
        host.cacheDisplay(in: bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { throw FeatureError.failed("png encoding failed") }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try png.write(to: url)
        window.contentView = nil
        return CGSize(width: rep.pixelsWide, height: rep.pixelsHigh)
    }

    public static func result(path: String, size: CGSize) -> JSONValue {
        ["path": .string(path), "width": .int(Int64(size.width)), "height": .int(Int64(size.height))]
    }
}
