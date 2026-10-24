import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import GlideCore
import GlideUI
import SwiftUI

// phone-core: Settings → iPhone and the `phone.confirm` launcher view.

enum PhoneQR {
    /// A crisp QR code (CoreImage CIQRCodeGenerator, error correction M), scaled without smoothing.
    static func image(_ text: String, size: CGFloat = 220) -> NSImage? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let out = f.outputImage, out.extent.width > 0 else { return nil }
        let scale = max(1, (size / out.extent.width).rounded(.down))
        let scaled = out.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cg = CIContext(options: [.useSoftwareRenderer: true]).createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: scaled.extent.width, height: scaled.extent.height))
    }
}

enum PhoneTime {
    static func ago(_ ms: Double?, now: Date = Date()) -> String {
        guard let ms else { return "Never" }
        let s = max(0, now.timeIntervalSince1970 - ms / 1000)
        if s < 60 { return "Just now" }
        if s < 3600 { return "\(Int(s / 60)) min ago" }
        if s < 86400 { return "\(Int(s / 3600)) h ago" }
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    static func clock(_ ms: Double) -> String {
        let f = DateFormatter()
        f.timeStyle = .medium
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
}

struct PhoneSettingsView: View {
    let feature: PhoneFeature
    @State private var renaming: String?
    @State private var newName = ""
    @State private var confirmRevoke: String?

    var body: some View {
        let core = feature.core
        let _ = core.revision
        let s = feature.phoneSettings
        let running = core.server != nil
        Form {
            Section {
                Toggle("Let my iPhone use Glide", isOn: Binding(get: { s.enabled }, set: { on in Task { @MainActor in await PhoneCore.applySettings(feature, ["enabled": .bool(on)]) } }))
                LabeledContent("Status") {
                    if running, let url = core.server?.baseURL {
                        Text("On at \(url)").textSelection(.enabled)
                    } else if let e = core.lastError {
                        Text(e).foregroundStyle(.red)
                    } else if s.enabled && feature.context?.services.isHeadless == true {
                        Text("Off in test runs").foregroundStyle(.secondary)
                    } else {
                        Text("Off").foregroundStyle(.secondary)
                    }
                }
            } header: { Text("iPhone") } footer: {
                Text("Open Glide Remote in Safari on your iPhone to send text, links and photos to this Mac, run commands and workflows, and more. It works on the same Wi-Fi, without an app. Every message is encrypted with a key that only this Mac and your paired iPhone have. Turn off anything you don't use below.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            pairSection(s: s, running: running)
            devicesSection()
            Section {
                ForEach(PhoneGroups.switchable, id: \.id) { g in
                    Toggle(isOn: Binding(get: { s.groupEnabled(g.id) }, set: { on in Task { @MainActor in await PhoneCore.applySettings(feature, ["groups": [g.id: .bool(on)]]) } })) {
                        Label {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(g.title)
                                Text(g.detail).font(.caption).foregroundStyle(.secondary)
                            }
                        } icon: { Image(systemName: g.symbol) }
                    }
                }
            } header: { Text("What the iPhone can do") } footer: {
                Text("All of these are off until you turn them on.").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(core.sections, id: \.id) { sec in sec.view() }
            actionsSection(s)
            logSection()
        }
        .formStyle(.grouped)
        .alert("Remove this iPhone?", isPresented: Binding(get: { confirmRevoke != nil }, set: { if !$0 { confirmRevoke = nil } })) {
            Button("Remove", role: .destructive) {
                if let id = confirmRevoke { Task { @MainActor in _ = try? await PhoneCore.invoke(feature, method: "revokeDevice", args: ["id": .string(id)]) } }
                confirmRevoke = nil
            }
            Button("Cancel", role: .cancel) { confirmRevoke = nil }
        } message: {
            Text("It will stop working right away. You can pair it again later.")
        }
    }

    @ViewBuilder func pairSection(s: PhoneSettings, running: Bool) -> some View {
        let core = feature.core
        Section("Pair an iPhone") {
            if let p = core.pairing {
                HStack(alignment: .top, spacing: 18) {
                    if let img = PhoneQR.image(p.url) {
                        Image(nsImage: img).interpolation(.none).resizable().frame(width: 200, height: 200)
                            .padding(8).background(Color.white).clipShape(RoundedRectangle(cornerRadius: 8))
                            .accessibilityLabel("QR code for pairing")
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Scan this with the iPhone camera, then open the link in Safari.").fixedSize(horizontal: false, vertical: true)
                        Text("Then tap Share and Add to Home Screen to keep Glide Remote one tap away.").font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("The code works for 10 minutes and pairs one iPhone. Don't share it: it contains the key.").font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if let local = p.localURL {
                            Text("If the camera can't open it, the Mac is also at \(local.components(separatedBy: "/#").first ?? local)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                        Button("Cancel Pairing") { PhoneCore.cancelPairing(feature) }
                    }
                }
            } else {
                HStack {
                    Button {
                        Task { @MainActor in await PhoneCore.beginPairing(feature) }
                    } label: { Label("Pair iPhone", systemImage: "qrcode") }
                        .disabled(feature.context?.services.isHeadless == true && !running)
                    Text(running ? "Shows a QR code to scan with your iPhone." : "Turns on iPhone access and shows a QR code.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder func devicesSection() -> some View {
        let devices = feature.core.devices?.devices ?? []
        Section("Paired iPhones") {
            if devices.isEmpty { Text("No iPhone is paired yet").foregroundStyle(.secondary) }
            ForEach(devices) { d in
                HStack {
                    Image(systemName: "iphone").foregroundStyle(.secondary)
                    if renaming == d.id {
                        TextField("Name", text: $newName).onSubmit { commitRename(d.id) }.frame(maxWidth: 220)
                        Button("Save") { commitRename(d.id) }
                        Button("Cancel") { renaming = nil }
                    } else {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(d.name)
                            Text("Last used \(PhoneTime.ago(d.lastSeen).lowercased() == "never" ? "never" : PhoneTime.ago(d.lastSeen))").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Rename") { newName = d.name; renaming = d.id }
                        Button("Remove", role: .destructive) { confirmRevoke = d.id }
                    }
                }
            }
        }
    }

    func commitRename(_ id: String) {
        _ = feature.core.devices?.rename(id, newName)
        renaming = nil
    }

    @ViewBuilder func actionsSection(_ s: PhoneSettings) -> some View {
        Section {
            ForEach(feature.registry.all, id: \.name) { a in
                let groupOn = s.groupEnabled(a.group)
                Picker(selection: Binding(get: { PhoneGate.policy(a, s).rawValue }, set: { v in
                    Task { @MainActor in _ = try? await PhoneCore.invoke(feature, method: "setPolicy", args: ["name": .string(a.name), "policy": .string(v)]) }
                })) {
                    Text("Allow").tag("allow")
                    Text("Ask").tag("ask")
                    Text("Off").tag("off")
                } label: {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(a.title)
                        Text(groupOn ? (a.relay ? a.name : "\(a.name), same Wi-Fi only") : "Turn on \(PhoneGroups.switchable.first { $0.id == a.group }?.title ?? a.group) first")
                            .font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                }
                .disabled(!groupOn)
            }
            Button("Reset to Defaults") { Task { @MainActor in _ = try? await PhoneCore.invoke(feature, method: "resetPolicies", args: .null) } }
            let always = s.always.flatMap { d, list in list.map { (id: "\(d)|\($0)", device: d, action: $0) } }.sorted { $0.id < $1.id }
            ForEach(always, id: \.id) { pair in
                HStack {
                    let name = feature.core.devices?.device(pair.device)?.name ?? "Removed iPhone"
                    Text("\(name) can always \(feature.registry.action(pair.action)?.title.lowercased() ?? pair.action)")
                    Spacer()
                    Button("Ask Again") {
                        Task { @MainActor in _ = try? await PhoneCore.invoke(feature, method: "revokeAlways", args: ["deviceId": .string(pair.device), "action": .string(pair.action)]) }
                    }
                }
            }
        } header: { Text("Actions") } footer: {
            Text("Allow runs right away. Ask shows a request on this Mac first; it is denied after a minute without an answer. Off turns it off.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder func logSection() -> some View {
        Section("Recent requests") {
            let log = feature.core.log.list.prefix(40)
            if log.isEmpty { Text("Nothing yet").foregroundStyle(.secondary) }
            ForEach(Array(log), id: \.id) { e in
                HStack {
                    Text(PhoneTime.clock(e.at)).font(.caption.monospaced()).foregroundStyle(.secondary)
                    Text(e.device).font(.caption)
                    Text(feature.registry.action(e.action)?.title ?? e.action).lineLimit(1)
                    Spacer()
                    Text(Self.outcome(e)).font(.caption).foregroundStyle(e.outcome == "ok" ? Color.green : Color.orange)
                }
            }
            if !log.isEmpty { Button("Clear") { feature.core.log.clear() } }
        }
    }

    static func outcome(_ e: PhoneLogEntry) -> String {
        switch e.outcome {
        case "ok": return e.approval == "user" ? "Allowed by you" : e.approval == "always" ? "Allowed (always)" : "Done"
        case "denied": return "Denied"
        case "timeout": return "No answer"
        case "off": return "Turned off"
        case "not-found": return "Unknown"
        default: return "Failed"
        }
    }
}

struct PhoneConfirmView: View {
    @Environment(\.glideTheme) private var theme
    let feature: PhoneFeature
    let core: PhoneCoreState

    var body: some View {
        let _ = core.revision
        let list = feature.confirmations.pending
        if list.isEmpty {
            EmptyState(symbol: "checkmark.shield", title: "No iPhone requests", subtitle: "Requests from your iPhone that need your answer show up here")
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(list.enumerated()), id: \.element.id) { i, r in
                        VStack(alignment: .leading, spacing: 6) {
                            Label("\(r.deviceName) asks to", systemImage: "iphone.gen3")
                                .font(.system(size: 12, weight: .semibold)).foregroundStyle(theme.text2)
                            Text(r.summary).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.text).fixedSize(horizontal: false, vertical: true)
                            Text("Expires at \(PhoneTime.clock(r.expiresAt.timeIntervalSince1970 * 1000))").font(.system(size: 11)).foregroundStyle(theme.text3)
                            HStack(spacing: 14) {
                                HStack(spacing: 4) { Kbd("↩"); Text("Allow Once").font(.system(size: 11.5, weight: .medium)) }
                                HStack(spacing: 4) { Kbd("⌘↩"); Text("Always Allow").font(.system(size: 11.5)) }
                                HStack(spacing: 4) { Kbd("⌘⌫"); Text("Deny").font(.system(size: 11.5)) }
                            }
                            .foregroundStyle(theme.text2)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(i == min(core.confirmSelected, list.count - 1) ? theme.selected : theme.surface))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(theme.border, lineWidth: 1))
                    }
                }
                .padding(14)
            }
        }
    }
}
