import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// The launcher window: a NON-ACTIVATING panel. Glide never becomes the active app while it is shown, so the
/// user's app stays frontmost (selection reading and paste-back target it directly) — Raycast's model.
final class LauncherPanel: NSPanel {
    /// Headless: the panel exists (and renders offscreen for snapshots) but can never be ordered on screen.
    let headless: Bool
    var onKey: ((NSEvent) -> Bool)?
    var onResignKey: (() -> Void)?

    init(headless: Bool) {
        self.headless = headless
        super.init(contentRect: NSRect(x: 0, y: 0, width: 760, height: 474),
                   styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView], backing: .buffered, defer: true)
        isFloatingPanel = true
        level = .floating // Raycast's launcher sits above normal windows, below the menu bar / alerts
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        standardWindowButton(.closeButton)?.isHidden = true
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true
        isMovableByWindowBackground = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        animationBehavior = .utilityWindow
        isReleasedWhenClosed = false
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    // Hard guarantee for headless runs: never on screen.
    override func makeKeyAndOrderFront(_ sender: Any?) { if !headless { super.makeKeyAndOrderFront(sender) } }
    override func orderFront(_ sender: Any?) { if !headless { super.orderFront(sender) } }
    override func orderFrontRegardless() { if !headless { super.orderFrontRegardless() } }
    override func makeKey() { if !headless { super.makeKey() } }

    /// ⌘ shortcuts reach the launcher before the Edit menu (⌘C copies the selected result, not the field text);
    /// whatever the launcher doesn't use falls through to the menu (⌘V / ⌘A / ⌘Z in the search field).
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.type == .keyDown, event.modifierFlags.contains(.command), let onKey, onKey(event) { return true }
        return super.performKeyEquivalent(with: event)
    }

    /// Keys go to the launcher model first; only plain text editing reaches the field.
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown, let onKey, onKey(event) { return }
        super.sendEvent(event)
    }

    override func resignKey() {
        super.resignKey()
        onResignKey?()
    }

    override func cancelOperation(_ sender: Any?) {} // Esc is handled by the model
}

/// Owns the panel + hosting view; implements show/hide/position/snapshot.
@MainActor final class LauncherWindowController: LauncherWindowing {
    let panel: LauncherPanel
    let hosting: NSHostingView<AnyView>
    let controller: LauncherController
    let headless: Bool
    var openSettingsHandler: ((String?) -> Void)?
    private(set) var isVisible = false
    private(set) var lastShowMs: Double = 0

    init(controller: LauncherController, headless: Bool) {
        self.controller = controller
        self.headless = headless
        panel = LauncherPanel(headless: headless)
        let host = ViewHostAdapter(controller)
        LauncherHosts.current = host
        hosting = NSHostingView(rootView: AnyView(LauncherView(controller: controller, host: host)))
        hosting.sizingOptions = []
        hosting.safeAreaRegions = [] // full-size content view: no titlebar inset
        panel.contentView = hosting
        controller.windowing = self
        panel.onKey = { [weak controller] e in
            guard let controller, let k = KeyMapping.vimKey(e) else { return false }
            return controller.handleKey(k)
        }
        panel.onResignKey = { [weak self] in
            guard let self, self.isVisible, controller.settings.hideOnBlur, !self.headless else { return }
            controller.hide()
        }
        layout()
    }

    /// Pre-created and laid out at launch so showing is just ordering front.
    func layout() {
        let size = NSSize(width: CGFloat(controller.theme.tokens.launcherWidth), height: LauncherMetrics.height(controller))
        let screen = activeScreen()
        let vis = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let full = screen?.frame ?? vis
        // Top edge at ~22% from the top of the screen; the panel grows downward.
        let top = full.maxY - full.height * 0.22
        let origin = NSPoint(x: (vis.midX - size.width / 2).rounded(), y: (top - size.height).rounded())
        panel.setFrame(NSRect(origin: origin, size: size), display: isVisible)
        hosting.frame = NSRect(origin: .zero, size: size)
    }

    /// The screen with the mouse (Raycast shows on the active screen).
    private func activeScreen() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
    }

    func showPanel() {
        let t0 = DispatchTime.now().uptimeNanoseconds
        layout()
        isVisible = true
        if !headless {
            panel.makeKeyAndOrderFront(nil) // non-activating: Glide does not become the active app
        }
        hosting.layoutSubtreeIfNeeded()
        lastShowMs = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6
    }

    func hidePanel() {
        guard isVisible else { return }
        isVisible = false
        if !headless { panel.orderOut(nil) }
    }

    func openSettings(page: String?) { openSettingsHandler?(page) }

    func otherVisibleWindows() -> Set<Int> {
        guard !headless else { return [] }
        return Set(NSApp.windows.filter { $0 !== panel && $0.isVisible && $0.canBecomeKey }.map(\.windowNumber))
    }

    var otherWindowIsKey: Bool {
        guard !headless, let k = NSApp.keyWindow else { return false }
        return k !== panel && k.isVisible
    }

    func contentHeightChanged() {
        let h = LauncherMetrics.height(controller)
        guard abs(panel.frame.height - h) > 0.5 || abs(panel.frame.width - CGFloat(controller.theme.tokens.launcherWidth)) > 0.5 else { return }
        var f = panel.frame
        let top = f.maxY
        f.size = NSSize(width: CGFloat(controller.theme.tokens.launcherWidth), height: h)
        f.origin.y = top - h
        panel.setFrame(f, display: isVisible)
        hosting.frame = NSRect(origin: .zero, size: f.size)
    }

    /// Render the launcher to a PNG (works for a panel that was never on screen).
    func snapshot(to url: URL, scale: CGFloat = 2) throws -> NSSize {
        contentHeightChanged()
        hosting.layoutSubtreeIfNeeded()
        hosting.displayIfNeeded()
        let bounds = hosting.bounds
        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: bounds) else { throw FeatureError.failed("no bitmap") }
        hosting.cacheDisplay(in: bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { throw FeatureError.failed("png encoding failed") }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try png.write(to: url)
        return NSSize(width: rep.pixelsWide, height: rep.pixelsHigh)
    }
}
