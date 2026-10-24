import AppKit
import Foundation
import GlideCore
import GlideSystem
import Observation
import SwiftUI

/// The iCloud Drive relay for Shortcuts, the clipboard mirror and the generated
/// Shortcuts. Plugs into PhoneFeature through `install` only: settings section, test-channel methods, stop handler.
@MainActor enum PhoneRelay {
    static func install(_ feature: PhoneFeature) async {
        guard let ctx = feature.context else { return }
        let c = PhoneRelayController(feature: feature, context: ctx)
        c.registerMethods()
        feature.addSettingsSection(id: "relay", order: 40) { [weak c] in
            guard let c else { return AnyView(EmptyView()) }
            return AnyView(PhoneRelaySettingsSection(controller: c))
        }
        await c.reconcile()
        // The stop handler owns the controller (PhoneFeature keeps it until quit).
        feature.onStop { await c.shutdown() }
    }
}

/// Keys in the phone settings bag (`settings.features.phone`) owned by phone-relay.
enum PhoneRelaySettings {
    /// Settings → iPhone → "Shortcuts and iCloud".
    static let relay = "relay"
    /// "Share the Mac clipboard" (needs the Clipboard group too).
    static let clipboardMirror = "clipboardMirror"
}

@MainActor @Observable final class PhoneRelayController {
    @ObservationIgnored weak var feature: PhoneFeature?
    @ObservationIgnored weak var context: FeatureContext?
    @ObservationIgnored let roots: [URL]
    @ObservationIgnored private(set) var service: PhoneRelayService?
    @ObservationIgnored private(set) var mirror: PhoneClipboardMirror?
    @ObservationIgnored private var observation: StoreObservation?
    @ObservationIgnored private var reconciling = false
    @ObservationIgnored private var reconcileAgain = false

    /// Shown in Settings.
    var revision = 0
    var exportMessage: String?
    var exporting = false

    init(feature: PhoneFeature, context: FeatureContext) {
        self.feature = feature
        self.context = context
        roots = PhoneRelayPaths.roots()
        observation = context.store.observe { [weak self] _ in Task { @MainActor in await self?.reconcile() } }
    }

    var relayOn: Bool { bag[PhoneRelaySettings.relay]?.boolValue == true }
    var mirrorWanted: Bool { bag[PhoneRelaySettings.clipboardMirror]?.boolValue == true }
    var clipboardGroupOn: Bool { feature?.isGroupEnabled("clipboard") ?? false }
    var mirrorOn: Bool { relayOn && mirrorWanted && clipboardGroupOn }

    private var bag: [String: JSONValue] {
        context?.settings(defaults: [PhoneRelaySettings.relay: false, PhoneRelaySettings.clipboardMirror: false]) ?? [:]
    }

    func set(_ key: String, _ on: Bool) {
        context?.setSettings([key: .bool(on)])
        Task { await reconcile() }
    }

    /// Starts or stops the relay and the mirror to match Settings. Safe to call often.
    func reconcile() async {
        if reconciling { reconcileAgain = true; return }
        reconciling = true
        defer { reconciling = false }
        repeat {
            reconcileAgain = false
            if relayOn {
                if service == nil, let feature {
                    let s = PhoneRelayService(roots: roots, createRoots: ProcessInfo.processInfo.environment[PhoneRelayPaths.envOverride] != nil) { [weak feature] action, args, caller in
                        guard let feature else { return PhoneGate.fail(PhoneError("unavailable", "Glide is quitting. Try again in a moment.")) }
                        return await feature.perform(action, args: args, caller: caller)
                    }
                    s.log = { [weak self] m in self?.context?.log(m) }
                    s.onActivity = { [weak self] in self?.revision &+= 1 }
                    if let ms = ProcessInfo.processInfo.environment["GLIDE_PHONE_RELAY_POLL_MS"].flatMap(Int.init), ms > 0 {
                        s.pollInterval = .milliseconds(ms)
                    }
                    service = s
                    s.start()
                }
            } else if let s = service {
                s.stop()
                service = nil
            }
            if mirrorOn {
                if mirror == nil, let ctx = context {
                    let store = ctx.store
                    let m = PhoneClipboardMirror(roots: roots, services: ctx.services) {
                        ClipSettings(bag: store.settings.featureSettings("clipboard", defaults: ClipSettings.defaultsBag))
                    }
                    mirror = m
                    await m.setOn(true)
                }
            } else if let m = mirror {
                await m.setOn(false)
                mirror = nil
            }
            revision &+= 1
        } while reconcileAgain
    }

    func shutdown() async {
        observation?.cancel()
        observation = nil
        service?.stop()
        service = nil
        // Leave clipboard.json in place on quit: the phone can still read the last text. Turning it off removes it.
        mirror = nil
    }

    // MARK: Shortcuts

    /// "Add Shortcuts to iPhone": sign the shortcuts into ~/Downloads/Glide Shortcuts and show them in Finder.
    /// Headless runs never sign: they write the unsigned files and record an effect.
    func addShortcutsToiPhone() async {
        guard let ctx = context, !exporting else { return }
        exporting = true
        defer { exporting = false }
        if ctx.services.isHeadless {
            ctx.recordEffect(kind: "phone-shortcuts-export", detail: ["signed": false, "count": .int(Int64(PhoneShortcuts.all().count))])
            exportMessage = "Signing is skipped in test runs."
            return
        }
        let folder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads/Glide Shortcuts", isDirectory: true)
        let r = await PhoneShortcutsExport.exportSigned(to: folder)
        if r.files.isEmpty {
            exportMessage = "Glide could not sign the shortcuts. Check that the Shortcuts app is installed, then try again."
        } else {
            exportMessage = r.failures.isEmpty
                ? "Saved \(r.files.count) shortcuts to Downloads/Glide Shortcuts. AirDrop them to your iPhone, or put them in iCloud Drive and open them there."
                : "Saved \(r.files.count) shortcuts. Glide could not sign \(r.failures.joined(separator: ", ")). Try again."
            NSWorkspace.shared.activateFileViewerSelecting(r.files)
        }
    }

    // MARK: test-channel methods (`invoke phone relay.*`)

    func registerMethods() {
        guard let feature else { return }
        feature.addMethod("relay.status") { [weak self] _ in
            guard let self else { return .null }
            return ["relay": .bool(self.relayOn), "running": .bool(self.service?.isRunning ?? false), "mirror": .bool(self.mirror?.isOn ?? false),
                    "handled": .int(Int64(self.service?.handled ?? 0)), "roots": .array(self.roots.map { .string($0.path) })]
        }
        feature.addMethod("relay.set") { [weak self] a in
            guard let self else { return .null }
            for k in [PhoneRelaySettings.relay, PhoneRelaySettings.clipboardMirror] {
                if let b = a[k]?.boolValue { self.context?.setSettings([k: .bool(b)]) }
            }
            await self.reconcile()
            return ["relay": .bool(self.relayOn), "mirror": .bool(self.mirror?.isOn ?? false)]
        }
        feature.addMethod("relay.scan") { [weak self] _ in
            await self?.service?.scanOnce()
            return ["handled": .int(Int64(self?.service?.handled ?? 0))]
        }
        feature.addMethod("relay.prune") { [weak self] _ in
            self?.service?.prune()
            return true
        }
        /// Unsigned shortcuts into `dir` (tests; never signs).
        feature.addMethod("relay.writeShortcuts") { a in
            guard let dir = a["dir"]?.stringValue else { throw PhoneError.badArgs("Give a folder.") }
            let files = try PhoneShortcutsExport.writeUnsigned(PhoneShortcuts.all(), to: URL(fileURLWithPath: dir, isDirectory: true))
            return ["files": .array(files.map { .string($0.path) })]
        }
    }
}

/// Settings → iPhone → "Shortcuts and iCloud" (embedded by phone-core through `addSettingsSection`).
struct PhoneRelaySettingsSection: View {
    let controller: PhoneRelayController

    var body: some View {
        let _ = controller.revision
        Section {
            Toggle(isOn: Binding(get: { controller.relayOn }, set: { controller.set(PhoneRelaySettings.relay, $0) })) {
                Label {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Shortcuts and iCloud")
                        Text("Run Glide from iPhone Shortcuts, Siri and automations, even away from home. Requests travel through your iCloud Drive.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } icon: { Image(systemName: "icloud") }
            }
            Toggle(isOn: Binding(get: { controller.mirrorWanted }, set: { controller.set(PhoneRelaySettings.clipboardMirror, $0) })) {
                Label {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Share the Mac clipboard")
                        Text(controller.clipboardGroupOn
                             ? "Keeps a copy of the clipboard text in iCloud Drive for \"Get Mac Clipboard\". Passwords and text over 64 KB are never copied."
                             : "Turn on Clipboard above first.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } icon: { Image(systemName: "doc.on.clipboard") }
            }
            .disabled(!controller.relayOn || !controller.clipboardGroupOn)
            HStack {
                Button(controller.exporting ? "Signing…" : "Add Shortcuts to iPhone") { Task { await controller.addShortcutsToiPhone() } }
                    .disabled(controller.exporting)
                if let m = controller.exportMessage { Text(m).font(.caption).foregroundStyle(.secondary) }
            }
        } header: { Text("Shortcuts and iCloud") } footer: {
            Text("Adds Send to Glide, Send Clipboard to Mac, Get Mac Clipboard, Run Glide Workflow and Ask Glide Agent. They use the Glide/Phone folder in iCloud Drive. Actions that only work on the same Wi-Fi, like the trackpad, are never available here.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
