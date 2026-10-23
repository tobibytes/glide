import CryptoKit
import Foundation
import GlideCore
import Security

/// One configured MCP server (mcp-types.ts McpServerConfig). Header and env values are secrets.
struct MCPServerConfig: Equatable, Sendable {
    static let secretKeep = "__glide_secret_unchanged__"
    static let defaultTimeoutMs = 30_000
    static let defaultRateLimit = 30

    var id: String
    /// Display name; also the tool namespace (mcp__<name>__<tool>).
    var name: String
    var enabled: Bool
    /// stdio | http | sse
    var transport: String
    var command: String?
    var args: [String] = []
    var env: [String: String]?
    var cwd: String?
    var url: String?
    var headers: [String: String]?
    var autoRunReadOnly = false
    var disabledTools: [String] = []
    var timeoutMs = MCPServerConfig.defaultTimeoutMs
    var rateLimitPerMinute = MCPServerConfig.defaultRateLimit

    static func slugId(_ name: String) -> String {
        let lowered = name.lowercased()
        var out = ""
        var dash = false
        for ch in lowered {
            if ch.isASCII && (ch.isLetter || ch.isNumber) { out.append(ch); dash = false } else if !dash && !out.isEmpty { out.append("-"); dash = true }
        }
        while out.hasSuffix("-") { out.removeLast() }
        let s = String(out.prefix(40))
        return s.isEmpty ? "server" : s
    }

    private static func text(_ v: JSONValue?, _ max: Int) -> String? {
        guard let s = v?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return String(s.prefix(max))
    }

    private static func kv(_ v: JSONValue?) -> [String: String]? {
        guard let o = v?.objectValue else { return nil }
        var out: [String: String] = [:]
        for (k, val) in o.prefix(64) {
            let key = k.trimmingCharacters(in: .whitespaces)
            if key.isEmpty || key.count > 200 || key.contains(where: { $0 == "\r" || $0 == "\n" || $0 == "\0" }) { continue }
            switch val {
            case let .string(s): out[key] = String(s.prefix(8000))
            case .int, .double, .bool: out[key] = val.description
            default: continue
            }
        }
        return out.isEmpty ? nil : out
    }

    private static func transportOf(_ raw: [String: JSONValue]) -> String? {
        let t = raw["transport"]?.stringValue ?? raw["type"]?.stringValue
        switch t {
        case "stdio"?: return "stdio"
        case "http"?, "streamable-http"?, "streamableHttp"?: return "http"
        case "sse"?: return "sse"
        case nil:
            if raw["command"]?.stringValue != nil { return "stdio" }
            if raw["url"]?.stringValue != nil { return "http" }
            return nil
        default: return nil
        }
    }

    /// Validates any server-shaped object into a config, or returns why it's invalid.
    static func normalize(_ value: JSONValue, fallbackName: String? = nil) -> Result<MCPServerConfig, MCPConfigError> {
        guard let raw = value.objectValue else { return .failure(.init("Server config must be an object")) }
        guard let name = text(raw["name"], 60) ?? fallbackName.flatMap({ text(.string($0), 60) }) else { return .failure(.init("Give the server a name")) }
        guard let transport = transportOf(raw) else { return .failure(.init("“\(name)”: choose stdio (a command) or HTTP (a URL)")) }
        let rawId = raw["id"]?.stringValue ?? ""
        let idOK = !rawId.isEmpty && rawId.count <= 60 && rawId.allSatisfy { ($0.isASCII && ($0.isLowercase || $0.isNumber)) || $0 == "-" }
        var c = MCPServerConfig(id: idOK ? rawId : slugId(name), name: name, enabled: raw["enabled"]?.boolValue != false, transport: transport)
        c.autoRunReadOnly = raw["autoRunReadOnly"]?.boolValue == true
        c.disabledTools = (raw["disabledTools"]?.arrayValue ?? []).compactMap(\.stringValue).prefix(500).map { $0 }
        if let t = raw["timeoutMs"]?.doubleValue, t.isFinite { c.timeoutMs = max(1000, min(600_000, Int(t.rounded()))) }
        if let r = raw["rateLimitPerMinute"]?.doubleValue, r.isFinite { c.rateLimitPerMinute = max(0, min(1000, Int(r.rounded()))) }
        if transport == "stdio" {
            guard let command = text(raw["command"], 1000) else { return .failure(.init("“\(name)”: a command is required")) }
            c.command = command
            c.args = (raw["args"]?.arrayValue ?? []).compactMap { v -> String? in
                switch v { case let .string(s): return s; case .int, .double: return v.description; default: return nil }
            }.prefix(64).map { $0 }
            c.cwd = text(raw["cwd"], 1000)
            c.env = kv(raw["env"])
            return .success(c)
        }
        guard let url = text(raw["url"], 2000) else { return .failure(.init("“\(name)”: a URL is required")) }
        guard let u = URL(string: url), let scheme = u.scheme?.lowercased(), u.host?.isEmpty == false else { return .failure(.init("“\(name)”: “\(url)” isn't a valid URL")) }
        guard scheme == "https" || scheme == "http" else { return .failure(.init("“\(name)”: the URL must start with https:// or http://")) }
        c.url = u.absoluteString
        c.headers = kv(raw["headers"])
        return .success(c)
    }

    /// Full JSON (secrets included) — only for the encrypted store and in-process use.
    var json: JSONValue {
        var o: [String: JSONValue] = ["id": .string(id), "name": .string(name), "enabled": .bool(enabled), "transport": .string(transport),
                                      "autoRunReadOnly": .bool(autoRunReadOnly), "disabledTools": .array(disabledTools.map(JSONValue.string)),
                                      "timeoutMs": .int(Int64(timeoutMs)), "rateLimitPerMinute": .int(Int64(rateLimitPerMinute))]
        if let command { o["command"] = .string(command); o["args"] = .array(args.map(JSONValue.string)) }
        if let cwd { o["cwd"] = .string(cwd) }
        if let url { o["url"] = .string(url) }
        if let env { o["env"] = .object(env.mapValues(JSONValue.string)) }
        if let headers { o["headers"] = .object(headers.mapValues(JSONValue.string)) }
        return .object(o)
    }

    /// Secrets replaced by SECRET_KEEP (what the settings UI and the test channel see).
    var masked: MCPServerConfig {
        var c = self
        c.env = env.map { Dictionary(uniqueKeysWithValues: $0.keys.map { ($0, Self.secretKeep) }) }
        c.headers = headers.map { Dictionary(uniqueKeysWithValues: $0.keys.map { ($0, Self.secretKeep) }) }
        return c
    }

    /// Replaces SECRET_KEEP values in an edited config by the saved ones.
    func restoringSecrets(from prev: MCPServerConfig?) -> MCPServerConfig {
        func fill(_ r: [String: String]?, _ old: [String: String]?) -> [String: String]? {
            guard let r else { return nil }
            var out: [String: String] = [:]
            for (k, v) in r {
                if v == Self.secretKeep { if let o = old?[k] { out[k] = o } } else { out[k] = v }
            }
            return out.isEmpty ? nil : out
        }
        var c = self
        c.env = fill(env, prev?.env)
        c.headers = fill(headers, prev?.headers)
        return c
    }

    /// Everything that changes how Glide connects (an edit of these drops the live connection).
    var connectionKey: String {
        AgentText.json([.string(transport), .string(command ?? ""), .array(args.map(JSONValue.string)), .object((env ?? [:]).mapValues(JSONValue.string)),
                        .string(cwd ?? ""), .string(url ?? ""), .object((headers ?? [:]).mapValues(JSONValue.string)), .int(Int64(timeoutMs)), .string(name)])
    }
}

struct MCPConfigError: Error, LocalizedError, Equatable {
    var message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

// MARK: - import (Claude Desktop claude_desktop_config.json, project .mcp.json)

enum MCPImport {
    struct Parsed {
        var format: String
        var servers: [MCPServerConfig]
        var errors: [String]
    }

    /// Parse only: Glide never reads those files by itself. Imported servers start disabled.
    static func parse(_ text: String) -> Result<Parsed, MCPConfigError> {
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else { return .failure(.init("That isn't valid JSON")) }
        guard json.objectValue != nil else { return .failure(.init("Expected a JSON object with an mcpServers map")) }
        guard let map = json["mcpServers"]?.objectValue ?? json["servers"]?.objectValue else {
            return .failure(.init("No “mcpServers” found — paste a Claude Desktop config or a .mcp.json file"))
        }
        var servers: [MCPServerConfig] = []
        var errors: [String] = []
        var typed = false
        for (name, raw) in map.sorted(by: { $0.key < $1.key }).prefix(50) {
            if raw["type"]?.stringValue != nil || raw["url"]?.stringValue != nil { typed = true }
            var o = raw.objectValue ?? [:]
            o["name"] = .string(name)
            o["id"] = nil
            o["enabled"] = false
            switch MCPServerConfig.normalize(raw.objectValue == nil ? raw : .object(o), fallbackName: name) {
            case let .success(s): servers.append(s)
            case let .failure(e): errors.append(e.message)
            }
        }
        return .success(Parsed(format: typed ? "mcp-json" : "claude-desktop", servers: servers, errors: errors))
    }

    static func preview(_ p: Parsed, existing: [MCPServerConfig]) -> JSONValue {
        var o: [String: JSONValue] = ["ok": true, "format": .string(p.format)]
        if !p.errors.isEmpty { o["error"] = .string(p.errors.joined(separator: "\n")) }
        o["servers"] = .array(p.servers.map { s in
            ["name": .string(s.name), "transport": .string(s.transport), "command": s.command.map(JSONValue.string) ?? .null,
             "args": .array(s.args.map(JSONValue.string)), "url": s.url.map(JSONValue.string) ?? .null,
             "envKeys": .array((s.env ?? [:]).keys.sorted().map(JSONValue.string)), "headerKeys": .array((s.headers ?? [:]).keys.sorted().map(JSONValue.string)),
             "exists": .bool(existing.contains { $0.id == s.id || $0.name == s.name })]
        })
        return .object(o)
    }
}

// MARK: - secrets

/// Encrypts secret values for mcp-servers.json.
protocol MCPSecretCipher: Sendable {
    var isAvailable: Bool { get }
    func encrypt(_ s: String) throws -> String
    func decrypt(_ s: String) throws -> String
}

/// AES-GCM with a random 256-bit key kept in the login Keychain (generic password, created on first use).
/// Headless/test runs use `MCPFileKeyCipher` instead so they never touch the user's Keychain.
final class MCPKeychainCipher: MCPSecretCipher, @unchecked Sendable {
    let service: String
    let account: String
    private let lock = NSLock()
    private var cached: SymmetricKey?

    init(service: String = "dev.glide.agent.mcp-secrets", account: String = "mcp-servers") {
        self.service = service
        self.account = account
    }

    var isAvailable: Bool { (try? key()) != nil }

    private func key() throws -> SymmetricKey {
        lock.lock()
        defer { lock.unlock() }
        if let cached { return cached }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let d = out as? Data, d.count == 32 {
            let k = SymmetricKey(data: d)
            cached = k
            return k
        }
        let k = SymmetricKey(size: .bits256)
        let data = k.withUnsafeBytes { Data($0) }
        let add: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                                  kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let st = SecItemAdd(add as CFDictionary, nil)
        guard st == errSecSuccess else { throw MCPConfigError("Keychain unavailable (\(st))") }
        cached = k
        return k
    }

    func encrypt(_ s: String) throws -> String { try MCPAES.seal(s, key()) }
    func decrypt(_ s: String) throws -> String { try MCPAES.open(s, key()) }
}

/// Key in a 0600 file next to the config (headless runs and tests only).
final class MCPFileKeyCipher: MCPSecretCipher, @unchecked Sendable {
    let keyFile: URL
    private let lock = NSLock()
    private var cached: SymmetricKey?
    init(keyFile: URL) { self.keyFile = keyFile }
    var isAvailable: Bool { true }
    private func key() throws -> SymmetricKey {
        lock.lock()
        defer { lock.unlock() }
        if let cached { return cached }
        if let d = try? Data(contentsOf: keyFile), d.count == 32 { let k = SymmetricKey(data: d); cached = k; return k }
        let k = SymmetricKey(size: .bits256)
        try FileManager.default.createDirectory(at: keyFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try k.withUnsafeBytes { Data($0) }.write(to: keyFile, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: keyFile.path)
        cached = k
        return k
    }
    func encrypt(_ s: String) throws -> String { try MCPAES.seal(s, key()) }
    func decrypt(_ s: String) throws -> String { try MCPAES.open(s, key()) }
}

/// No encryption available: saving secrets is refused (never written as plain text).
struct MCPNoCipher: MCPSecretCipher {
    var isAvailable: Bool { false }
    func encrypt(_ s: String) throws -> String { throw MCPConfigError("Secure storage is unavailable") }
    func decrypt(_ s: String) throws -> String { throw MCPConfigError("Secure storage is unavailable") }
}

enum MCPAES {
    static func seal(_ s: String, _ key: SymmetricKey) throws -> String {
        guard let combined = try AES.GCM.seal(Data(s.utf8), using: key).combined else { throw MCPConfigError("Encryption failed") }
        return "v1:" + combined.base64EncodedString()
    }
    static func open(_ s: String, _ key: SymmetricKey) throws -> String {
        guard s.hasPrefix("v1:"), let d = Data(base64Encoded: String(s.dropFirst(3))) else { throw MCPConfigError("Unknown secret format") }
        return String(decoding: try AES.GCM.open(AES.GCM.SealedBox(combined: d), using: key), as: UTF8.self)
    }
}

// MARK: - store: <userData>/features/agent/mcp-servers.json

@MainActor final class MCPConfigStore {
    static let maxServers = 50
    let file: URL
    let cipher: any MCPSecretCipher
    var log: (String) -> Void = { _ in }
    private var cache: [MCPServerConfig]?

    init(file: URL, cipher: any MCPSecretCipher) {
        self.file = file
        self.cipher = cipher
    }

    func list() -> [MCPServerConfig] {
        if let cache { return cache }
        guard let d = try? Data(contentsOf: file), let raw = MCP.decode(d) else { cache = []; return [] }
        var out: [MCPServerConfig] = []
        for s in raw["servers"]?.arrayValue ?? [] {
            guard var o = s.objectValue else { continue }
            for key in ["env", "headers"] {
                guard let enc = o[key]?.objectValue else { continue }
                var dec: [String: JSONValue] = [:]
                for (k, v) in enc {
                    guard let e = v["enc"]?.stringValue else { continue }
                    if let plain = try? cipher.decrypt(e) { dec[k] = .string(plain) } else { log("mcp: couldn't decrypt \(k) for \(o["name"]?.stringValue ?? "?")") }
                }
                o[key] = dec.isEmpty ? nil : .object(dec)
            }
            if case let .success(c) = MCPServerConfig.normalize(.object(o)) { out.append(c) }
        }
        cache = out
        return out
    }

    func get(_ id: String) -> MCPServerConfig? { list().first { $0.id == id } }

    func write(_ servers: [MCPServerConfig]) throws {
        let hasSecrets = servers.contains { !($0.env ?? [:]).isEmpty || !($0.headers ?? [:]).isEmpty }
        if hasSecrets && !cipher.isAvailable { throw MCPConfigError("Secure storage is unavailable, so headers and environment values can't be saved") }
        var stored: [JSONValue] = []
        for s in servers.prefix(Self.maxServers) {
            guard var o = s.json.objectValue else { continue }
            for (key, values) in [("env", s.env), ("headers", s.headers)] {
                guard let values else { continue }
                var enc: [String: JSONValue] = [:]
                for (k, v) in values { enc[k] = ["enc": .string(try cipher.encrypt(v))] }
                o[key] = .object(enc)
            }
            stored.append(.object(o))
        }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = (try? JSONEncoder.glide.encode(JSONValue.object(["version": 1, "servers": .array(stored)]))) ?? Data()
        try data.write(to: file, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        cache = Array(servers.prefix(Self.maxServers))
    }

    /// Adds or replaces by id; a new server whose id is taken gets a numbered id.
    @discardableResult func upsert(_ server: MCPServerConfig, isNew: Bool) throws -> MCPServerConfig {
        var all = list()
        var s = server
        if isNew {
            var id = s.id
            var i = 2
            while all.contains(where: { $0.id == id }) { id = "\(s.id)-\(i)"; i += 1 }
            s.id = id
        }
        if all.contains(where: { $0.id != s.id && $0.name.lowercased() == s.name.lowercased() }) { throw MCPConfigError("A server named “\(s.name)” already exists") }
        if let i = all.firstIndex(where: { $0.id == s.id }) { all[i] = s } else { all.append(s) }
        try write(all)
        return s
    }

    func remove(_ id: String) throws -> Bool {
        let all = list()
        guard all.contains(where: { $0.id == id }) else { return false }
        try write(all.filter { $0.id != id })
        return true
    }
}
