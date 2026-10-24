import Foundation
import GlideCore
import Security

// phone-core: paired devices (docs/PHONE.md "Pairing"). Keys live in a `PhoneKeyStore` (the login Keychain,
// service "Glide Phone Devices", in the real app; a 0600 file in headless runs; memory in unit tests). Device
// metadata (name, created, last seen, never the key) is in <dataDir>/devices.json.

/// Where device keys are kept. Implementations must never log keys.
@MainActor public protocol PhoneKeyStore: AnyObject {
    func key(_ deviceId: String) -> Data?
    func setKey(_ key: Data, for deviceId: String) -> Bool
    func deleteKey(_ deviceId: String)
}

/// Login Keychain, generic passwords under one service (account = device id).
@MainActor public final class PhoneKeychainStore: PhoneKeyStore {
    public static let defaultService = "Glide Phone Devices"
    let service: String
    public init(service: String = PhoneKeychainStore.defaultService) { self.service = service }

    private func base(_ id: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id]
    }

    public func key(_ deviceId: String) -> Data? {
        var q = base(deviceId)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, d.count == 32 else { return nil }
        return d
    }

    public func setKey(_ key: Data, for deviceId: String) -> Bool {
        SecItemDelete(base(deviceId) as CFDictionary)
        var q = base(deviceId)
        q[kSecValueData as String] = key
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        q[kSecAttrLabel as String] = "Glide iPhone pairing"
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    public func deleteKey(_ deviceId: String) { SecItemDelete(base(deviceId) as CFDictionary) }
}

/// A 0600 JSON file of base64 keys (headless runs only: never touches the user's Keychain).
@MainActor public final class PhoneFileKeyStore: PhoneKeyStore {
    let file: URL
    private var keys: [String: String] = [:]
    public init(file: URL) {
        self.file = file
        if let d = try? Data(contentsOf: file), let k = try? JSONDecoder().decode([String: String].self, from: d) { keys = k }
    }
    public func key(_ deviceId: String) -> Data? { keys[deviceId].flatMap { Data(base64Encoded: $0) } }
    public func setKey(_ key: Data, for deviceId: String) -> Bool {
        keys[deviceId] = key.base64EncodedString()
        return save()
    }
    public func deleteKey(_ deviceId: String) {
        keys[deviceId] = nil
        _ = save()
    }
    private func save() -> Bool {
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let d = try? JSONEncoder().encode(keys), (try? d.write(to: file, options: .atomic)) != nil else { return false }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        return true
    }
}

/// In-memory (unit tests).
@MainActor public final class PhoneMemoryKeyStore: PhoneKeyStore {
    public private(set) var keys: [String: Data] = [:]
    public init() {}
    public func key(_ deviceId: String) -> Data? { keys[deviceId] }
    public func setKey(_ key: Data, for deviceId: String) -> Bool { keys[deviceId] = key; return true }
    public func deleteKey(_ deviceId: String) { keys[deviceId] = nil }
}

struct PhoneDevice: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var name: String
    /// Unix ms.
    var createdAt: Double
    var lastSeen: Double?
    var lastTransport: String?

    var json: JSONValue {
        ["id": .string(id), "name": .string(name), "createdAt": .int(Int64(createdAt)), "lastSeen": lastSeen.map { .int(Int64($0)) } ?? .null, "status": "active"]
    }
}

/// Active devices (persisted) and pending pairings (memory only, 10 minutes).
@MainActor final class PhoneDeviceRegistry {
    static let pendingLifetime: TimeInterval = 10 * 60
    static let defaultName = "iPhone"
    let keys: any PhoneKeyStore
    let file: URL?
    var now: () -> Date
    private(set) var devices: [PhoneDevice] = []
    private(set) var pending: [String: (key: Data, name: String, expires: Date)] = [:]
    private var replay = PhoneReplayGuard()
    private var saveTask: Task<Void, Never>?
    var onChange: () -> Void = {}

    init(keys: any PhoneKeyStore, file: URL?, now: @escaping () -> Date = { Date() }) {
        self.keys = keys
        self.file = file
        self.now = now
        if let file, let d = try? Data(contentsOf: file), let list = try? JSONDecoder().decode([PhoneDevice].self, from: d) { devices = list }
    }

    /// Create a pending device; returns its id and key (the key goes only into the QR link).
    func createPending(name: String = PhoneDeviceRegistry.defaultName) -> (id: String, key: Data) {
        prune()
        let id = PhoneCrypto.randomID(16)
        let key = PhoneCrypto.randomBytes(32)
        pending[id] = (key, name, now().addingTimeInterval(Self.pendingLifetime))
        onChange()
        return (id, key)
    }

    func cancelPending(_ id: String) {
        if pending.removeValue(forKey: id) != nil { onChange() }
    }

    func prune() {
        let t = now()
        let before = pending.count
        pending = pending.filter { $0.value.expires > t }
        if pending.count != before { onChange() }
    }

    func isPending(_ id: String) -> Bool {
        guard let p = pending[id] else { return false }
        return p.expires > now()
    }

    func device(_ id: String) -> PhoneDevice? { devices.first { $0.id == id } }

    /// The key for an active device or a pending (not expired) one.
    func key(for id: String) -> Data? {
        if let p = pending[id] { return p.expires > now() ? p.key : nil }
        guard device(id) != nil else { return nil }
        return keys.key(id)
    }

    /// First authenticated request from a pending device: it becomes active (key into the store).
    @discardableResult func activate(_ id: String, name: String?) -> PhoneDevice? {
        if let d = device(id) { return d }
        guard let p = pending[id], p.expires > now() else { return nil }
        guard keys.setKey(p.key, for: id) else { return nil }
        pending[id] = nil
        let d = PhoneDevice(id: id, name: Self.clean(name) ?? p.name, createdAt: now().timeIntervalSince1970 * 1000, lastSeen: nil)
        devices.append(d)
        save(now: true)
        onChange()
        return d
    }

    static func clean(_ name: String?) -> String? {
        guard let name else { return nil }
        let spaced = String(name.map { c in c.isNewline || c.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) } ? " " : c })
        let n = spaced.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return n.isEmpty ? nil : String(n.prefix(40))
    }

    @discardableResult func rename(_ id: String, _ name: String) -> Bool {
        guard let i = devices.firstIndex(where: { $0.id == id }), let n = Self.clean(name) else { return false }
        devices[i].name = n
        save(now: true)
        onChange()
        return true
    }

    @discardableResult func revoke(_ id: String) -> Bool {
        let wasPending = pending.removeValue(forKey: id) != nil
        guard let i = devices.firstIndex(where: { $0.id == id }) else {
            if wasPending { onChange() }
            return wasPending
        }
        devices.remove(at: i)
        keys.deleteKey(id)
        replay.forget(deviceId: id)
        save(now: true)
        onChange()
        return true
    }

    func touch(_ id: String, transport: String) {
        guard let i = devices.firstIndex(where: { $0.id == id }) else { return }
        devices[i].lastSeen = now().timeIntervalSince1970 * 1000
        devices[i].lastTransport = transport
        save(now: false)
        onChange()
    }

    /// Replay window + nonce cache for one authenticated request.
    func acceptFresh(deviceId: String, nonce: String, ts: Double) -> Bool {
        guard replay.timestampOK(ts, now: now().timeIntervalSince1970 * 1000) else { return false }
        return replay.accept(deviceId: deviceId, nonce: nonce)
    }

    private func save(now immediate: Bool) {
        guard file != nil else { return }
        if immediate {
            saveTask?.cancel()
            saveTask = nil
            flush()
            return
        }
        guard saveTask == nil else { return }
        saveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, !Task.isCancelled else { return }
            self.saveTask = nil
            self.flush()
        }
    }

    func flush() {
        guard let file else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let d = try? JSONEncoder.glide.encode(devices) { try? d.write(to: file, options: .atomic) }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}
