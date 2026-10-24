import CryptoKit
import Foundation
import GlideCore

// phone-core: the LAN envelope (docs/PHONE.md "Transport 1"). ChaCha20-Poly1305 (RFC 8439) with a 32-byte key per
// device, a 12-byte random nonce per message and AAD `glide-phone-v1|<deviceId>|req` (responses: `|res`).
// Body: {"v":1,"d":"<deviceId>","n":"<b64url nonce>","c":"<b64url ciphertext||tag>"}.

public enum PhoneCrypto {
    /// Random bytes from the system CSPRNG.
    public static func randomBytes(_ n: Int) -> Data {
        var g = SystemRandomNumberGenerator()
        return Data((0..<n).map { _ in UInt8.random(in: 0...255, using: &g) })
    }

    /// base64url (no padding) of `n` random bytes.
    public static func randomID(_ n: Int) -> String { base64url(randomBytes(n)) }

    public static func base64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    public static func fromBase64url(_ s: String) -> Data? {
        var bytes: [UInt8] = []
        bytes.reserveCapacity(s.utf8.count + 3)
        for c in s.utf8 {
            switch c {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "0")...UInt8(ascii: "9"): bytes.append(c)
            case UInt8(ascii: "-"), UInt8(ascii: "+"): bytes.append(UInt8(ascii: "+"))
            case UInt8(ascii: "_"), UInt8(ascii: "/"): bytes.append(UInt8(ascii: "/"))
            case UInt8(ascii: "="): continue
            default: return nil
            }
        }
        while bytes.count % 4 != 0 { bytes.append(UInt8(ascii: "=")) }
        return Data(base64Encoded: Data(bytes))
    }
}

/// Seal and open one envelope. Used by the Mac's LAN server and by tests (and anything else that needs a client).
public enum PhoneEnvelope {
    public enum Direction: String, Sendable { case req, res }

    public struct Body: Codable, Sendable, Equatable {
        public var v: Int
        public var d: String
        public var n: String
        public var c: String
        public init(v: Int = 1, d: String, n: String, c: String) {
            self.v = v
            self.d = d
            self.n = n
            self.c = c
        }
    }

    public static func aad(deviceId: String, _ dir: Direction) -> Data { Data("glide-phone-v1|\(deviceId)|\(dir.rawValue)".utf8) }

    /// Encrypt `plaintext` for `deviceId`. `nonce` is random unless given (tests).
    public static func seal(_ plaintext: Data, key: Data, deviceId: String, direction: Direction, nonce: Data? = nil) throws -> Body {
        let n = try ChaChaPoly.Nonce(data: nonce ?? PhoneCrypto.randomBytes(12))
        let box = try ChaChaPoly.seal(plaintext, using: SymmetricKey(data: key), nonce: n, authenticating: aad(deviceId: deviceId, direction))
        return Body(d: deviceId, n: PhoneCrypto.base64url(Data(n)), c: PhoneCrypto.base64url(box.ciphertext + box.tag))
    }

    /// Decrypt and authenticate. Throws on a bad tag, a malformed body or a wrong key / device / direction.
    public static func open(_ body: Body, key: Data, direction: Direction) throws -> Data {
        guard body.v == 1, let nonce = PhoneCrypto.fromBase64url(body.n), nonce.count == 12,
              let ct = PhoneCrypto.fromBase64url(body.c), ct.count >= 16, key.count == 32 else { throw PhoneEnvelopeError.malformed }
        let box = try ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: nonce), ciphertext: ct.prefix(ct.count - 16), tag: ct.suffix(16))
        return try ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: aad(deviceId: body.d, direction))
    }

    /// Body JSON → struct (size-limited by the server before this point).
    public static func parse(_ data: Data) -> Body? {
        guard let b = try? JSONDecoder().decode(Body.self, from: data), !b.d.isEmpty, b.d.count <= 64 else { return nil }
        return b
    }

    public static func encode(_ body: Body) -> Data { (try? JSONEncoder.glideCompact.encode(body)) ?? Data() }

    // MARK: client helpers (tests, tools)

    /// A request plaintext `{"id","ts","action","args"}` sealed as an HTTP body.
    public static func request(action: String, args: JSONValue, key: Data, deviceId: String, id: String = UUID().uuidString, ts: Date = Date(), nonce: Data? = nil) throws -> Data {
        let plain: JSONValue = ["id": .string(id), "ts": .int(Int64(ts.timeIntervalSince1970 * 1000)), "action": .string(action), "args": args]
        return encode(try seal(try JSONEncoder.glideCompact.encode(plain), key: key, deviceId: deviceId, direction: .req, nonce: nonce))
    }

    /// Open a response body into its plaintext JSON.
    public static func response(_ data: Data, key: Data, deviceId: String) throws -> JSONValue {
        guard let b = parse(data), b.d == deviceId else { throw PhoneEnvelopeError.malformed }
        return try JSONDecoder().decode(JSONValue.self, from: open(b, key: key, direction: .res))
    }
}

public enum PhoneEnvelopeError: Error, Equatable { case malformed }

/// Per-device nonce replay cache (the last 1024 nonces per device) and the ±120 s timestamp window.
struct PhoneReplayGuard {
    static let window: Double = 120_000
    static let keep = 1024
    private var seen: [String: (set: Set<String>, order: [String])] = [:]

    func timestampOK(_ ts: Double, now: Double) -> Bool { abs(ts - now) <= Self.window }

    /// True (and remembered) when the nonce is new for this device.
    mutating func accept(deviceId: String, nonce: String) -> Bool {
        var e = seen[deviceId] ?? ([], [])
        if e.set.contains(nonce) { return false }
        e.set.insert(nonce)
        e.order.append(nonce)
        if e.order.count > Self.keep {
            let drop = e.order.count - Self.keep
            for n in e.order.prefix(drop) { e.set.remove(n) }
            e.order.removeFirst(drop)
        }
        seen[deviceId] = e
        return true
    }

    mutating func forget(deviceId: String) { seen[deviceId] = nil }
}
