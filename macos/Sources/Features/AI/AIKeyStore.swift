import CommonCrypto
import Foundation
import Security

/// Where the Anthropic API key is kept. Real app: the login Keychain (generic password, service "Glide",
/// account "anthropic-api-key"). Tests and headless runs: memory only — they never touch the Keychain.
public protocol AISecretStore: AnyObject, Sendable {
    /// Whether an item exists, without reading the secret (never prompts).
    func exists() -> Bool
    func read() throws -> String?
    func write(_ secret: String) throws
    func delete() throws
}

public final class KeychainSecretStore: AISecretStore, @unchecked Sendable {
    public let service: String
    public let account: String
    public init(service: String = "Glide", account: String = "anthropic-api-key") {
        self.service = service
        self.account = account
    }

    private var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func exists() -> Bool {
        var q = base
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess
    }

    public func read() throws -> String? {
        var q = base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else { throw AIError(.other, "Couldn't read the API key from the Keychain (\(status))") }
        return String(data: data, encoding: .utf8)
    }

    public func write(_ secret: String) throws {
        let data = Data(secret.utf8)
        let update: [String: Any] = [kSecValueData as String: data]
        var status = SecItemUpdate(base as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = base
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            add[kSecAttrLabel as String] = "Glide — Anthropic API key"
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw AIError(.other, "Couldn't save the API key in the Keychain (\(status))") }
    }

    public func delete() throws {
        let status = SecItemDelete(base as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw AIError(.other, "Couldn't remove the API key (\(status))") }
    }
}

public final class MemorySecretStore: AISecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    public init(_ initial: String? = nil) { value = initial }
    public func exists() -> Bool { lock.lock(); defer { lock.unlock() }; return value != nil }
    public func read() throws -> String? { lock.lock(); defer { lock.unlock() }; return value }
    public func write(_ secret: String) throws { lock.lock(); value = secret; lock.unlock() }
    public func delete() throws { lock.lock(); value = nil; lock.unlock() }
}

public struct AIKeyStatus: Equatable, Sendable {
    public var hasKey: Bool
    /// Always true natively (the Keychain is the storage); kept for the Electron `KeyStatus` shape.
    public var encryptionAvailable: Bool
}

/// Validation + caching over a secret store (keystore.ts). `read()` is only used to build API requests.
@MainActor public final class AIKeyStore {
    let store: AISecretStore
    private var cache: String??

    public init(store: AISecretStore) { self.store = store }

    public func status() -> AIKeyStatus {
        if case let .some(v) = cache { return AIKeyStatus(hasKey: v != nil, encryptionAvailable: true) }
        return AIKeyStatus(hasKey: store.exists(), encryptionAvailable: true)
    }

    /// Validates the shape; an empty key clears it.
    public nonisolated static func validate(_ key: String) throws -> String? {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        if trimmed.count > 512 || trimmed.contains(where: { $0.isWhitespace }) { throw AIError(.badRequest, "That doesn't look like an API key") }
        return trimmed
    }

    @discardableResult public func set(_ key: String) throws -> AIKeyStatus {
        guard let k = try Self.validate(key) else { return try clear() }
        try store.write(k)
        cache = .some(k)
        return status()
    }

    @discardableResult public func clear() throws -> AIKeyStatus {
        try store.delete()
        cache = .some(nil)
        return status()
    }

    public func read() -> String? {
        if case let .some(v) = cache { return v }
        guard let v = try? store.read() else { return nil } // access denied: don't cache, ask again next time
        cache = .some(v)
        return v
    }
}

// MARK: - migration from the Electron app

/// Electron `safeStorage` on macOS (Chromium OSCrypt): "v10" + AES-128-CBC(PKCS#7), key =
/// PBKDF2-HMAC-SHA1(password, "saltysalt", 1003 iterations, 16 bytes), IV = 16 spaces; the password is the
/// Keychain item "<App> Safe Storage" / "<App> Key". Used once, from the explicit "Import key from previous
/// Glide" button, to read <userData>/features/ai/key.bin.
public enum SafeStorageCrypto {
    public static let prefix = Data("v10".utf8)
    static let salt = Data("saltysalt".utf8)
    static let iterations: UInt32 = 1003
    static let iv = Data(repeating: 0x20, count: kCCBlockSizeAES128)

    public static func deriveKey(password: String) throws -> Data {
        var key = Data(count: kCCKeySizeAES128)
        let pw = Array(password.utf8)
        let status = key.withUnsafeMutableBytes { kp in
            salt.withUnsafeBytes { sp in
                CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pw.map { CChar(bitPattern: $0) }, pw.count,
                                     sp.bindMemory(to: UInt8.self).baseAddress, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1),
                                     iterations, kp.bindMemory(to: UInt8.self).baseAddress, kCCKeySizeAES128)
            }
        }
        guard status == kCCSuccess else { throw AIError(.other, "Key derivation failed (\(status))") }
        return key
    }

    static func aes(_ op: Int, key: Data, data: Data) throws -> Data {
        var out = Data(count: data.count + kCCBlockSizeAES128)
        var moved = 0
        let outCount = out.count
        let status = out.withUnsafeMutableBytes { op2 in
            data.withUnsafeBytes { dp in
                key.withUnsafeBytes { kp in
                    iv.withUnsafeBytes { ivp in
                        CCCrypt(CCOperation(op), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
                                kp.baseAddress, key.count, ivp.baseAddress, dp.baseAddress, data.count, op2.baseAddress, outCount, &moved)
                    }
                }
            }
        }
        guard status == kCCSuccess else { throw AIError(.other, "The saved key could not be decrypted (wrong Keychain password?)") }
        return out.prefix(moved)
    }

    public static func decrypt(_ blob: Data, password: String) throws -> String {
        guard blob.count > prefix.count, blob.prefix(prefix.count) == prefix else { throw AIError(.other, "key.bin is not in Electron safeStorage format") }
        let plain = try aes(kCCDecrypt, key: try deriveKey(password: password), data: blob.dropFirst(prefix.count))
        guard let s = String(data: plain, encoding: .utf8) else { throw AIError(.other, "The saved key could not be decrypted (wrong Keychain password?)") }
        return s
    }

    /// Test vectors / round trips only.
    public static func encrypt(_ plain: String, password: String) throws -> Data {
        prefix + (try aes(kCCEncrypt, key: try deriveKey(password: password), data: Data(plain.utf8)))
    }
}

/// Supplies the Electron safeStorage password. The real one reads the Keychain item and may show the system
/// "Glide wants to use your confidential information" prompt — so it is only called from the import button.
public protocol SafeStoragePasswordSource: Sendable {
    func password() throws -> String
}

public struct KeychainSafeStoragePassword: SafeStoragePasswordSource {
    public var service = "Glide Safe Storage"
    public var account = "Glide Key"
    public init() {}
    public func password() throws -> String {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { throw AIError(.other, "The previous Glide's Keychain entry (\(service)) was not found") }
        guard status == errSecSuccess, let data = out as? Data, let s = String(data: data, encoding: .utf8) else {
            throw AIError(.other, "Keychain access to \(service) was denied (\(status))")
        }
        return s
    }
}

public struct FixedSafeStoragePassword: SafeStoragePasswordSource {
    let value: String?
    public init(_ value: String?) { self.value = value }
    public func password() throws -> String {
        guard let value else { throw AIError(.other, "No safe-storage password available in this mode") }
        return value
    }
}

public enum LegacyKeyImport {
    public static func file(in dataDirectory: URL) -> URL { dataDirectory.appendingPathComponent("key.bin") }
    public static func available(in dataDirectory: URL) -> Bool {
        ((try? FileManager.default.attributesOfItem(atPath: file(in: dataDirectory).path))?[.size] as? Int ?? 0) > 0
    }

    /// Decrypt key.bin with the password source and return the key (validated).
    public static func decrypt(dataDirectory: URL, passwords: SafeStoragePasswordSource) throws -> String {
        guard let blob = try? Data(contentsOf: file(in: dataDirectory)), !blob.isEmpty else { throw AIError(.other, "No key from a previous Glide was found") }
        let key = try SafeStorageCrypto.decrypt(blob, password: try passwords.password())
        guard let valid = try AIKeyStore.validate(key) else { throw AIError(.other, "The saved key is empty") }
        return valid
    }
}
