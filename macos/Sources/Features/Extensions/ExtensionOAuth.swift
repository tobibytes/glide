import Foundation
import GlideCore
import Security

// OAuth for Raycast extensions (OAuth.PKCEClient / OAuthService), port of src/main/features/extensions/oauth.ts:
//  - tokens: one JSON object per extension keyed by provider id, kept in the login Keychain (generic password,
//    service "Glide Extension Tokens", account = extension name). Headless runs and tests: memory only.
//  - pending authorizations wait for the browser to come back to glide://oauth?code=…&state=… (matched by state).

/// Where an extension's token JSON lives (one item per extension).
protocol ExtensionTokenBackend: AnyObject {
    func read(_ account: String) throws -> String?
    func write(_ account: String, _ value: String) throws
    func delete(_ account: String) throws
}

final class KeychainTokenBackend: ExtensionTokenBackend {
    static let defaultService = "Glide Extension Tokens"
    let service: String
    init(service: String = KeychainTokenBackend.defaultService) { self.service = service }

    private func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    func read(_ account: String) throws -> String? {
        var q = base(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else { throw ExtensionError("Couldn't read the sign-in tokens from the Keychain (\(status))") }
        return String(data: data, encoding: .utf8)
    }

    func write(_ account: String, _ value: String) throws {
        let data = Data(value.utf8)
        var status = SecItemUpdate(base(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = base(account)
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            add[kSecAttrLabel as String] = "Glide — \(account) extension sign-in"
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw ExtensionError("Couldn't save the sign-in tokens in the Keychain (\(status))") }
    }

    func delete(_ account: String) throws {
        let status = SecItemDelete(base(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw ExtensionError("Couldn't remove the sign-in tokens (\(status))") }
    }
}

final class MemoryTokenBackend: ExtensionTokenBackend {
    private(set) var items: [String: String] = [:]
    func read(_ account: String) throws -> String? { items[account] }
    func write(_ account: String, _ value: String) throws { items[account] = value }
    func delete(_ account: String) throws { items[account] = nil }
}

/// Per-extension, per-provider token sets (the JSON the runtime's PKCEClient.setTokens sends).
@MainActor final class ExtensionTokenStore {
    let backend: ExtensionTokenBackend
    init(backend: ExtensionTokenBackend) { self.backend = backend }

    static func validName(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 128 && s.allSatisfy { $0.isLetter || $0.isNumber || "-_.@".contains($0) } && !s.hasPrefix(".")
    }

    private func all(_ ext: String) -> [String: JSONValue] {
        guard Self.validName(ext), let raw = try? backend.read(ext),
              let v = try? JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8)) else { return [:] }
        return v.objectValue ?? [:]
    }

    private func save(_ ext: String, _ all: [String: JSONValue]) throws {
        guard Self.validName(ext) else { throw ExtensionError("Invalid extension name") }
        if all.isEmpty { try backend.delete(ext); return }
        let data = try JSONEncoder.glideCompact.encode(JSONValue.object(all))
        try backend.write(ext, String(decoding: data, as: UTF8.self))
    }

    func get(_ ext: String, _ provider: String) -> JSONValue? { all(ext)[provider] }

    func set(_ ext: String, _ provider: String, _ tokens: JSONValue) throws {
        guard tokens.objectValue != nil else { throw ExtensionError("setTokens needs a token set") }
        var a = all(ext)
        a[provider] = tokens
        try save(ext, a)
    }

    func remove(_ ext: String, _ provider: String) throws {
        var a = all(ext)
        guard a.removeValue(forKey: provider) != nil else { return }
        try save(ext, a)
    }

    /// Uninstall: every token of the extension.
    func clear(_ ext: String) { if Self.validName(ext) { try? backend.delete(ext) } }
}

/// Authorizations waiting for the glide://oauth redirect. A request is matched by its `state` (CSRF protection).
@MainActor final class OAuthFlows {
    struct Request: Sendable {
        var id: String
        var extName: String
        var sessionId: String
        var url: String
        var state: String
        var providerName: String
    }

    nonisolated static let redirectScheme = "glide"
    nonisolated static let redirectHost = "oauth"

    private var pending: [String: (req: Request, cont: CheckedContinuation<String, Error>, timeout: Task<Void, Never>?)] = [:]
    private var seq = 0
    /// How long a sign-in may take before it fails.
    var timeout: Duration = .seconds(300)

    var requests: [Request] { pending.values.map(\.req).sorted { $0.id < $1.id } }

    /// Checks the authorization URL (https, or http on loopback).
    nonisolated static func validate(url raw: String, state: String) throws -> URL {
        if state.isEmpty { throw ExtensionError("OAuth authorization request has no state") }
        guard let u = URL(string: raw), let scheme = u.scheme?.lowercased(), let host = u.host?.lowercased() else { throw ExtensionError("OAuth authorization URL is invalid") }
        let loopback = ["127.0.0.1", "localhost", "::1"].contains(host)
        guard scheme == "https" || (scheme == "http" && loopback) else { throw ExtensionError("OAuth authorization URLs must use https") }
        return u
    }

    /// Registers the request, calls `open` (opens the browser) and waits for the redirect's code.
    func authorize(extName: String, sessionId: String, url: String, state: String, providerName: String,
                   open: (Request, URL) throws -> Void) async throws -> String {
        let u = try Self.validate(url: url, state: state)
        if pending.values.contains(where: { $0.req.state == state }) { throw ExtensionError("An authorization with this state is already pending") }
        seq += 1
        let req = Request(id: "oa\(seq)", extName: extName, sessionId: sessionId, url: url, state: state, providerName: providerName)
        let limit = timeout
        return try await withCheckedThrowingContinuation { (c: CheckedContinuation<String, Error>) in
            let t = Task { @MainActor [weak self] in
                try? await Task.sleep(for: limit)
                guard !Task.isCancelled else { return }
                self?.cancel(req.id, reason: "Sign-in with \(providerName) timed out")
            }
            pending[req.id] = (req, c, t)
            do { try open(req, u) } catch { cancel(req.id, reason: error.localizedDescription) }
        }
    }

    func cancel(_ id: String, reason: String = "Authorization was cancelled") {
        guard let p = pending.removeValue(forKey: id) else { return }
        p.timeout?.cancel()
        p.cont.resume(throwing: ExtensionError(reason))
    }

    /// Every pending authorization of a session (it ended).
    func cancelSession(_ sessionId: String) {
        for p in pending.values where p.req.sessionId == sessionId { cancel(p.req.id, reason: "The command stopped") }
    }

    func cancelAll() { for id in Array(pending.keys) { cancel(id, reason: "Glide is shutting down") } }

    /// Query (or, for providers that answer in the fragment, fragment) parameters of a redirect.
    nonisolated static func redirectParams(_ url: URL) -> [String: String]? {
        guard url.scheme?.lowercased() == redirectScheme, url.host?.lowercased() == redirectHost,
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var out: [String: String] = [:]
        for i in comps.queryItems ?? [] { out[i.name] = i.value ?? "" }
        if out["state"] == nil, let frag = comps.fragment, let f = URLComponents(string: "?" + frag) {
            for i in f.queryItems ?? [] where out[i.name] == nil { out[i.name] = i.value ?? "" }
        }
        return out
    }

    /// glide://oauth?package_name=…&code=…&state=… (or ?error=…). Returns the request id it completed, or nil when
    /// the URL is not an OAuth redirect or matches no pending state.
    @discardableResult func handleRedirect(_ raw: String) -> String? {
        guard let url = URL(string: raw), let params = Self.redirectParams(url), let state = params["state"], !state.isEmpty,
              let p = pending.values.first(where: { $0.req.state == state }) else { return nil }
        // The redirect URI names the extension; a mismatch means it was not meant for this request.
        if let pkg = params["package_name"], !pkg.isEmpty, pkg != p.req.extName { return nil }
        pending[p.req.id] = nil
        p.timeout?.cancel()
        if let error = params["error"], !error.isEmpty {
            p.cont.resume(throwing: ExtensionError(params["error_description"].flatMap { $0.isEmpty ? nil : $0 } ?? error))
        } else if let code = params["code"], !code.isEmpty {
            p.cont.resume(returning: code)
        } else {
            p.cont.resume(throwing: ExtensionError("The OAuth redirect carried no authorization code"))
        }
        return p.req.id
    }
}

/// Raycast AI.ask → Glide AI (port of src/main/features/extensions/ai-bridge.ts).
enum ExtensionAI {
    static let notSetUp = "Glide AI is not set up: add an API key in Settings → AI"

    /// Raycast `AI.Model` names / model ids → a model for the active provider, or nil for the AI feature's default.
    /// Claude ids are only returned for Anthropic (AIFeature.resolveModel drops them for OpenAI anyway).
    static func mapModel(_ raw: String?, provider: String) -> String? {
        guard let raw = raw?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        let n = raw.lowercased()
        if provider == "openai" {
            if OpenAIModels.suggested.contains(where: { $0.id == raw }) { return raw }
            // "openai-gpt-4o", "OpenAI_GPT4o", "gpt-4.1-mini" …
            var m = n
            for p in ["openai-", "openai_", "openai/"] where m.hasPrefix(p) { m.removeFirst(p.count) }
            m = m.replacingOccurrences(of: "_", with: "-")
            if m.hasPrefix("gpt"), !m.hasPrefix("gpt-") { m = "gpt-" + m.dropFirst(3) }
            let looksOpenAI = m.hasPrefix("gpt-") || m.range(of: "^o[1-9]", options: .regularExpression) != nil
            return looksOpenAI && OpenAIModels.isValid(m) ? m : nil
        }
        if AIModels.isKnown(raw) { return raw }
        if n.contains("haiku") { return "claude-haiku-4-5" }
        if n.contains("sonnet") { return "claude-sonnet-5-5" }
        if n.contains("fable") { return "claude-fable-5-1" }
        if n.contains("opus") { return "claude-opus-5-5" }
        return nil
    }

    /// Raycast "creativity" (none … maximum, or 0…2) has no portable sampling parameter here, so it nudges the instructions.
    static func creativityNote(_ c: String?) -> String? {
        guard let c = c?.trimmingCharacters(in: .whitespaces).lowercased(), !c.isEmpty else { return nil }
        let level: String
        if let d = Double(c) { level = d < 0.5 ? "low" : d > 1.2 ? "high" : "medium" } else { level = c }
        switch level {
        case "none", "low": return "Answer precisely and deterministically; do not embellish."
        case "high", "maximum": return "Be creative and original."
        default: return nil
        }
    }
}
