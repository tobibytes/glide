import CryptoKit
import Foundation
@testable import GlideFeatures
import GlideCore
import Testing

@Suite("Phone envelope crypto")
struct PhoneCryptoTests {
    /// RFC 8439 §2.8.2: the AEAD_CHACHA20_POLY1305 test vector, run through CryptoKit's ChaChaPoly.
    @Test func rfc8439AEADVector() throws {
        let key = hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
        let nonce = hex("070000004041424344454647")
        let aad = hex("50515253c0c1c2c3c4c5c6c7")
        let pt = Data("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.".utf8)
        let ct = hex("""
            d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36
            92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116
            """)
        let tag = hex("1ae10b594f09e26a7e902ecbd0600691")
        let box = try ChaChaPoly.seal(pt, using: SymmetricKey(data: key), nonce: ChaChaPoly.Nonce(data: nonce), authenticating: aad)
        #expect(box.ciphertext == ct)
        #expect(box.tag == tag)
        let opened = try ChaChaPoly.open(ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: nonce), ciphertext: ct, tag: tag), using: SymmetricKey(data: key), authenticating: aad)
        #expect(opened == pt)
    }

    /// A fixed envelope (documented in docs/PHONE.md) so the web app's crypto.js can check it builds the same bytes.
    @Test func fixedEnvelopeVector() throws {
        let key = Data((0..<32).map { UInt8($0) })
        let nonce = Data((0..<12).map { UInt8(0xA0 + $0) })
        let body = try PhoneEnvelope.seal(Data(#"{"action":"hello"}"#.utf8), key: key, deviceId: "dev1", direction: .req, nonce: nonce)
        #expect(body.n == "oKGio6Slpqeoqaqr")
        #expect(body.d == "dev1" && body.v == 1)
        let opened = try PhoneEnvelope.open(body, key: key, direction: .req)
        #expect(String(decoding: opened, as: UTF8.self) == #"{"action":"hello"}"#)
        // The vector itself: ciphertext||tag in base64url.
        #expect(body.c == PhoneCryptoTests.fixedCiphertext)
    }

    static let fixedCiphertext = "d4kZPDmPrcOCNdF8mZaRlL8j62IU6iMWCUR-ysGOQbz0vg"

    @Test func base64urlRoundTrip() {
        for n in [0, 1, 2, 3, 12, 16, 32, 33] {
            let d = PhoneCrypto.randomBytes(n)
            let s = PhoneCrypto.base64url(d)
            #expect(!s.contains("=") && !s.contains("+") && !s.contains("/"))
            #expect(PhoneCrypto.fromBase64url(s) == d)
        }
        #expect(PhoneCrypto.fromBase64url("ab$c") == nil)
    }

    @Test func rejectsTamperingAndWrongContext() throws {
        let key = PhoneCrypto.randomBytes(32)
        let body = try PhoneEnvelope.seal(Data("hi".utf8), key: key, deviceId: "d1", direction: .req)
        // Bad tag
        var c = PhoneCrypto.fromBase64url(body.c) ?? Data()
        c[c.count - 1] ^= 1
        var bad = body
        bad.c = PhoneCrypto.base64url(c)
        #expect(throws: (any Error).self) { try PhoneEnvelope.open(bad, key: key, direction: .req) }
        // Flipped ciphertext bit
        var c2 = PhoneCrypto.fromBase64url(body.c) ?? Data()
        c2[0] ^= 0x80
        bad.c = PhoneCrypto.base64url(c2)
        #expect(throws: (any Error).self) { try PhoneEnvelope.open(bad, key: key, direction: .req) }
        // Another device id (AAD) or direction
        var other = body
        other.d = "d2"
        #expect(throws: (any Error).self) { try PhoneEnvelope.open(other, key: key, direction: .req) }
        #expect(throws: (any Error).self) { try PhoneEnvelope.open(body, key: key, direction: .res) }
        // Wrong key
        #expect(throws: (any Error).self) { try PhoneEnvelope.open(body, key: PhoneCrypto.randomBytes(32), direction: .req) }
        // Malformed
        var short = body
        short.n = "AAAA"
        #expect(throws: (any Error).self) { try PhoneEnvelope.open(short, key: key, direction: .req) }
        var v2 = body
        v2.v = 2
        #expect(throws: (any Error).self) { try PhoneEnvelope.open(v2, key: key, direction: .req) }
        #expect(PhoneEnvelope.parse(Data("not json".utf8)) == nil)
    }

    @Test func replayGuard() {
        var g = PhoneReplayGuard()
        let a1 = g.accept(deviceId: "a", nonce: "n1")
        let a2 = g.accept(deviceId: "a", nonce: "n1")
        let b1 = g.accept(deviceId: "b", nonce: "n1")
        #expect(a1 && !a2 && b1)
        for i in 0..<1024 { _ = g.accept(deviceId: "a", nonce: "x\(i)") }
        // n1 fell out of the 1024-entry window, x1023 is still remembered.
        let again = g.accept(deviceId: "a", nonce: "n1")
        let recent = g.accept(deviceId: "a", nonce: "x1023")
        #expect(again && !recent)
        let now = 1_000_000_000.0
        #expect(g.timestampOK(now - 119_000, now: now))
        #expect(!g.timestampOK(now - 121_000, now: now))
        #expect(!g.timestampOK(now + 121_000, now: now))
    }
}
