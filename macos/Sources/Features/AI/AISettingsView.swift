import AppKit
import GlideCore
import GlideUI
import Observation
import SwiftUI

/// State behind Settings → AI.
@MainActor @Observable final class AISettingsModel {
    @ObservationIgnored weak var feature: AIFeature?
    var revision = 0
    var keyDraft = ""
    var message: (text: String, ok: Bool)?
    var testing = false
    var editing: AICommandDef?

    var status: AIKeyStatus {
        _ = revision
        return feature?.keys.status() ?? AIKeyStatus(hasKey: false, encryptionAvailable: true)
    }
    var legacyAvailable: Bool { _ = revision; return feature?.legacyKeyAvailable ?? false }
    var model: String { _ = revision; return feature?.anthropicModel ?? AIModels.defaultModel }
    var provider: AIProvider { _ = revision; return feature?.provider ?? .anthropic }
    var openaiModel: String { _ = revision; return feature?.openaiModel ?? OpenAIModels.defaultModel }
    var openaiBaseURL: String { _ = revision; return feature?.openaiBaseURL ?? "" }
    var modelChoices: [AIModelInfo] { _ = revision; return feature?.modelChoices ?? AIModels.all }
    var openaiModelDraft = ""
    var baseURLDraft: String?
    var effort: String { _ = revision; return feature?.currentEffort ?? "medium" }
    var customCommands: [AICommandDef] { _ = revision; return feature?.customCommands ?? [] }

    func saveKey() {
        guard let f = feature else { return }
        do {
            let before = f.provider
            let s = try f.saveKey(keyDraft)
            keyDraft = ""
            let switched = f.provider != before ? " Switched to \(f.provider.label)." : ""
            message = (s.hasKey ? "\(f.provider.label) API key saved in the Keychain.\(switched)" : "API key removed.", true)
        } catch { message = (AIError.from(error).message, false) }
        revision += 1
    }

    func clearKey() {
        do { try feature?.keys.clear(); message = ("API key removed.", true) } catch { message = (AIError.from(error).message, false) }
        revision += 1
    }

    func importLegacy() {
        guard let f = feature else { return }
        switch f.importLegacyKey() {
        case .success: message = ("Imported the API key from the previous Glide.", true)
        case let .failure(e): message = (e.message, false)
        }
        revision += 1
    }

    func test() {
        guard let f = feature else { return }
        testing = true
        Task { @MainActor in
            let r = await f.testConnection(model: nil)
            self.message = (r.message, r.ok)
            self.testing = false
        }
    }

    func setOpenAIModel(_ id: String) {
        let t = id.trimmingCharacters(in: .whitespaces)
        guard OpenAIModels.isValid(t) else { message = ("That isn't a valid model id.", false); return }
        set("openaiModel", .string(t))
        openaiModelDraft = ""
    }

    func saveBaseURL() {
        let t = (baseURLDraft ?? "").trimmingCharacters(in: .whitespaces)
        guard AIFeature.validOpenAIBaseURL(t) else { message = ("The server URL must be https (or http on localhost).", false); return }
        set("openaiBaseURL", .string(t))
        baseURLDraft = nil
        message = (t.isEmpty ? "Using api.openai.com." : "Using \(t).", true)
    }

    func set(_ key: String, _ value: JSONValue) {
        feature?.applySettings([key: value])
        revision += 1
    }

    func saveCommand(_ cmd: AICommandDef) {
        var list = customCommands
        if let i = list.firstIndex(where: { $0.id == cmd.id }) { list[i] = cmd } else { list.append(cmd) }
        set("customCommands", .array(list.map(\.json)))
        editing = nil
    }

    func deleteCommand(_ id: String) {
        set("customCommands", .array(customCommands.filter { $0.id != id }.map(\.json)))
    }
}

struct AISettingsView: View {
    @Bindable var model: AISettingsModel

    var body: some View {
        Form {
            Section("Provider") {
                Picker("AI provider", selection: Binding(get: { model.provider.rawValue }, set: { model.set("provider", .string($0)); model.message = nil })) {
                    ForEach(AIProvider.allCases) { p in Text(p.label).tag(p.rawValue) }
                }
                .pickerStyle(.segmented)
                Text("Pasting a key for the other provider switches to it automatically.").font(.caption).foregroundStyle(.secondary)
            }
            Section("\(model.provider.label) API key") {
                HStack {
                    Image(systemName: model.status.hasKey ? "checkmark.seal.fill" : "key")
                        .foregroundStyle(model.status.hasKey ? Color.green : Color.secondary)
                    Text(model.status.hasKey ? "A key is saved in the Keychain" : "No key saved")
                    Spacer()
                    if model.status.hasKey {
                        Button("Test Connection") { model.test() }.disabled(model.testing)
                        Button("Remove", role: .destructive) { model.clearKey() }
                    }
                }
                HStack {
                    SecureField(model.provider.keyPlaceholder, text: $model.keyDraft).onSubmit { model.saveKey() }
                    Button(model.status.hasKey ? "Replace" : "Save") { model.saveKey() }
                        .disabled(model.keyDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                        .keyboardShortcut(.defaultAction)
                }
                if model.legacyAvailable && model.provider == .anthropic {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("A key from the previous Glide was found")
                            Text("Importing reads the “Glide Safe Storage” Keychain item once; macOS may ask for permission.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Import key from previous Glide") { model.importLegacy() }
                    }
                }
                if let m = model.message {
                    Label(m.text, systemImage: m.ok ? "checkmark.circle" : "exclamationmark.triangle")
                        .foregroundStyle(m.ok ? Color.green : Color.red)
                }
                Text(model.provider == .anthropic
                     ? "Get a key at console.anthropic.com. It is stored in your login Keychain and only sent to api.anthropic.com."
                     : "Get a key at platform.openai.com. It is stored in your login Keychain and only sent to \(model.openaiBaseURL.isEmpty ? "api.openai.com" : model.openaiBaseURL).")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Model") {
                if model.provider == .anthropic {
                    Picker("Default model", selection: Binding(get: { model.model }, set: { model.set("model", .string($0)) })) {
                        ForEach(AIModels.all) { m in Text("\(m.label) — \(m.description)").tag(m.id) }
                    }
                } else {
                    Picker("Default model", selection: Binding(get: { model.openaiModel }, set: { model.setOpenAIModel($0) })) {
                        ForEach(model.modelChoices) { m in Text("\(m.label) — \(m.description)").tag(m.id) }
                    }
                    HStack {
                        TextField("Other model id (gpt-…, openrouter/…, llama3.2)", text: $model.openaiModelDraft).onSubmit { model.setOpenAIModel(model.openaiModelDraft) }
                        Button("Use") { model.setOpenAIModel(model.openaiModelDraft) }
                            .disabled(model.openaiModelDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    HStack {
                        TextField("Server URL (optional): https://openrouter.ai/api/v1, http://localhost:11434/v1",
                                  text: Binding(get: { model.baseURLDraft ?? model.openaiBaseURL }, set: { model.baseURLDraft = $0 }))
                            .onSubmit { model.saveBaseURL() }
                        Button("Save") { model.saveBaseURL() }.disabled(model.baseURLDraft == nil)
                    }
                    Text("Leave the server empty for api.openai.com. Any OpenAI-compatible server works; local servers need no key.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Picker("Effort", selection: Binding(get: { model.effort }, set: { model.set("effort", .string($0)) })) {
                    Text("Low — fastest").tag("low")
                    Text("Medium").tag("medium")
                    Text("High — most thorough").tag("high")
                }
                .pickerStyle(.segmented)
            }
            Section("Built-in AI Commands") {
                ForEach(AITemplates.builtins) { c in
                    HStack {
                        Text(c.icon)
                        Text(c.name)
                        Spacer()
                        if c.replaces { Text("replaces selection").font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
            Section {
                ForEach(model.customCommands) { c in
                    HStack {
                        Text(c.icon)
                        VStack(alignment: .leading) {
                            Text(c.name)
                            Text(c.prompt).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Button("Edit") { model.editing = c }
                        Button(role: .destructive) { model.deleteCommand(c.id) } label: { Image(systemName: "trash") }.buttonStyle(.borderless)
                    }
                }
                if let editing = model.editing {
                    CommandEditor(command: editing, models: model.modelChoices, onSave: { model.saveCommand($0) }, onCancel: { model.editing = nil })
                } else {
                    Button("Add Command…") {
                        model.editing = AICommandDef(id: "", name: "", icon: "🤖", prompt: "Rewrite the text below …\n\n<text>\n{selection}\n</text>")
                    }
                }
            } header: {
                Text("Custom AI Commands")
            } footer: {
                Text("Use {selection} for the selected text and {argument} for text typed after Tab.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

struct CommandEditor: View {
    @State var command: AICommandDef
    var models: [AIModelInfo] = AIModels.all
    let onSave: (AICommandDef) -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField("Icon", text: $command.icon).frame(width: 60)
                TextField("Name", text: $command.name)
            }
            TextEditor(text: $command.prompt).font(.system(.body, design: .monospaced)).frame(minHeight: 90)
            Picker("Model", selection: Binding(get: { command.model ?? "" }, set: { command.model = $0.isEmpty ? nil : $0 })) {
                Text("Default").tag("")
                ForEach(models) { m in Text(m.label).tag(m.id) }
            }
            Toggle("Result replaces the selection", isOn: $command.replaces)
            HStack {
                Spacer()
                Button("Cancel", action: onCancel).keyboardShortcut(.cancelAction)
                Button("Save") {
                    var c = command
                    if c.id.isEmpty { c.id = AITemplates.slug(c.name) }
                    if let clean = AITemplates.sanitize(c.json) { onSave(clean) }
                }
                .disabled(command.name.trimmingCharacters(in: .whitespaces).isEmpty || command.prompt.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }
}
