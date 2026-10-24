import AppKit
import CoreImage
import GlideCore
import GlideUI
import SwiftUI

/// Settings → iPhone → Notifications. phone-core embeds it inside its Form: `PhoneNotifySettingsSection(feature: self)`.
struct PhoneNotifySettingsSection: View {
    let feature: PhoneFeature

    var body: some View {
        if let hub = PhoneNotify.hub(for: feature) {
            PhoneNotifySettingsContent(hub: hub, notifier: hub.notifier)
        } else {
            Section("Notifications") { Text("Notifications start with Glide.").foregroundStyle(.secondary) }
        }
    }
}

private struct PhoneNotifySettingsContent: View {
    let hub: PhoneNotifyHub
    let notifier: PhoneNotifier
    @Environment(\.glideTheme) private var theme
    @State private var serverText = ""
    @State private var tokenText = ""
    @State private var message: (text: String, ok: Bool)?
    @State private var sending = false

    var body: some View {
        let _ = notifier.revision
        let s = notifier.settings()
        Section {
            Toggle("Send notifications to my iPhone", isOn: Binding(get: { s.enabled }, set: { on in apply(["enabled": .bool(on)]) }))
            if s.enabled {
                Toggle("When a timer finishes", isOn: Binding(get: { s.timer }, set: { apply(["timer": .bool($0)]) }))
                Toggle("When an automation fails", isOn: Binding(get: { s.automation }, set: { apply(["automation": .bool($0)]) }))
                Toggle("When something waits for my OK", isOn: Binding(get: { s.confirmation }, set: { apply(["confirmation": .bool($0)]) }))
            }
        } header: { Text("Notifications") } footer: {
            Text("Glide uses ntfy, a free notification service, so your iPhone can get alerts without a Glide app. Notifications only say what happened (\"Tea is done\"). They never include clipboard text, file contents or what you asked Glide Agent.")
                .font(.caption).foregroundStyle(theme.text2)
        }
        if s.enabled {
            Section("Subscribe on your iPhone") {
                HStack(alignment: .top, spacing: 16) {
                    let link = PhoneNotifyRules.subscribeURL(server: s.server, topic: s.topic)
                    PhoneNotifyQR(text: link).frame(width: 132, height: 132)
                        .accessibilityLabel("QR code for the ntfy topic")
                    VStack(alignment: .leading, spacing: 8) {
                        Text("1. Install the free ntfy app from the App Store.")
                        Text("2. Scan this code with the Camera app, or in ntfy tap + and enter the topic below.")
                        Text(s.topic).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                        HStack {
                            Button("Copy Link") { hub.feature?.context?.services.pasteboard.setString(link, html: nil, transient: false) }
                            Button("Regenerate Topic") {
                                _ = notifier.regenerateTopic()
                                message = ("New topic created. Subscribe to it again on your iPhone.", true)
                            }
                        }
                        Text("Anyone who knows the topic can read these notifications, so keep it private.")
                            .font(.caption).foregroundStyle(theme.text2)
                    }
                }
                Button(sending ? "Sending…" : "Send Test Notification") {
                    sending = true
                    Task { @MainActor in
                        let r = (try? await hub.invoke("test", args: .null)) ?? .null
                        sending = false
                        message = (r["message"]?.stringValue ?? "", r["outcome"]?.stringValue == "sent")
                    }
                }
                .disabled(sending)
                if let message {
                    Text(message.text).font(.caption).foregroundStyle(message.ok ? theme.success : theme.danger)
                }
            }
            Section {
                HStack {
                    TextField("Server", text: $serverText, prompt: Text(s.server))
                    Button("Save Server") { apply(["server": .string(serverText)]); serverText = "" }
                        .disabled(serverText.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                HStack {
                    SecureField("Access token (optional)", text: $tokenText, prompt: Text(notifier.hasToken ? "Saved in the Keychain" : "Only for protected topics"))
                    Button("Save Token") { setToken(tokenText); tokenText = "" }
                        .disabled(tokenText.trimmingCharacters(in: .whitespaces).isEmpty)
                    if notifier.hasToken { Button("Remove Token") { setToken(nil) } }
                }
                if let last = notifier.history.first {
                    LabeledContent("Last notification") {
                        Text("\(Self.time(last.at)): \(Self.outcomeText(last.outcome))").foregroundStyle(last.outcome == .sent ? theme.text2 : theme.warning)
                    }
                }
            } header: { Text("ntfy server") } footer: {
                Text("Leave the server as https://ntfy.sh, or enter your own ntfy server. Use an access token if your topic is protected.")
                    .font(.caption).foregroundStyle(theme.text2)
            }
        }
    }

    private func apply(_ patch: JSONValue) {
        do {
            _ = try notifier.update(patch)
            message = nil
        } catch {
            message = ((error as? PhoneError)?.message ?? error.localizedDescription, false)
        }
    }

    private func setToken(_ t: String?) {
        do {
            try notifier.setToken(t)
            message = (t == nil ? "Token removed." : "Token saved in the Keychain.", true)
        } catch {
            message = ((error as? PhoneError)?.message ?? error.localizedDescription, false)
        }
    }

    static func time(_ d: Date) -> String {
        let f = DateFormatter()
        f.timeStyle = .short
        return f.string(from: d)
    }

    static func outcomeText(_ o: PhoneNotifier.Outcome) -> String {
        switch o {
        case .sent: return "sent"
        case .off: return "off"
        case .rateLimited: return "skipped (too many in a minute)"
        case .busy: return "skipped (busy)"
        case .notSetUp: return "not set up"
        case let .failed(st): return st.map { "failed (HTTP \($0))" } ?? "failed (server not reachable)"
        }
    }
}

/// A QR code (CoreImage), drawn without smoothing so it scans from the screen.
struct PhoneNotifyQR: View {
    let text: String
    var body: some View {
        if let img = Self.image(text) {
            Image(nsImage: img).interpolation(.none).resizable().scaledToFit()
                .padding(6).background(Color.white).clipShape(RoundedRectangle(cornerRadius: 6))
        } else {
            Image(systemName: "qrcode").font(.system(size: 48)).foregroundStyle(.secondary)
        }
    }

    static func image(_ text: String) -> NSImage? {
        guard let f = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        f.setValue(Data(text.utf8), forKey: "inputMessage")
        f.setValue("M", forKey: "inputCorrectionLevel")
        guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else { return nil }
        let rep = NSCIImageRep(ciImage: out)
        let img = NSImage(size: rep.size)
        img.addRepresentation(rep)
        return img
    }
}
