import Foundation
import Security

// phone-notify: the network side of ntfy publishing and the access token's storage.

/// Publishes one message. Nonisolated: it runs off the main thread and never blocks the app.
final class PhoneNtfySender: Sendable {
    struct Attempt: Sendable, Equatable {
        /// HTTP status, nil when the server couldn't be reached.
        var status: Int?
        var retryAfter: String? = nil
    }

    let session: URLSession

    init(timeout: TimeInterval = 10) {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = timeout
        c.timeoutIntervalForResource = timeout * 2
        c.httpCookieStorage = nil
        c.urlCache = nil
        c.waitsForConnectivity = false
        session = URLSession(configuration: c)
    }

    /// The request for `message` (exposed for tests). The token goes only in the Authorization header.
    static func request(_ m: PhoneNotifyMessage, server: URL, topic: String, token: String?) -> URLRequest {
        var r = URLRequest(url: server.appendingPathComponent(topic))
        r.httpMethod = "POST"
        r.httpBody = Data(m.body.utf8)
        r.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "Content-Type")
        for (k, v) in m.headers { r.setValue(v, forHTTPHeaderField: k) }
        if let token, !token.isEmpty { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return r
    }

    nonisolated func attempt(_ request: URLRequest) async -> Attempt {
        do {
            let (_, resp) = try await session.data(for: request)
            let http = resp as? HTTPURLResponse
            return Attempt(status: http?.statusCode, retryAfter: http?.value(forHTTPHeaderField: "Retry-After"))
        } catch {
            return Attempt(status: nil, retryAfter: nil)
        }
    }
}

/// Where the optional ntfy access token lives: the login Keychain (service "Glide Phone", account "ntfy-token").
/// Headless runs and tests use `MemorySecretStore`, so they never touch the user's Keychain.
final class PhoneNotifyKeychainToken: AISecretStore, @unchecked Sendable {
    let service: String
    let account: String
    init(service: String = "Glide Phone", account: String = "ntfy-token") {
        self.service = service
        self.account = account
    }

    private var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    func exists() -> Bool {
        var q = base
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess
    }

    func read() throws -> String? {
        var q = base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else { throw PhoneError("keychain", "Couldn't read the ntfy token from the Keychain (\(status)).") }
        return String(data: data, encoding: .utf8)
    }

    func write(_ secret: String) throws {
        let data = Data(secret.utf8)
        var status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = base
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            add[kSecAttrLabel as String] = "Glide: ntfy access token"
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw PhoneError("keychain", "Couldn't save the ntfy token in the Keychain (\(status)).") }
    }

    func delete() throws {
        let status = SecItemDelete(base as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw PhoneError("keychain", "Couldn't remove the ntfy token (\(status)).") }
    }
}
