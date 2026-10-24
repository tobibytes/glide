import CryptoKit
import Foundation
@testable import GlideFeatures
import Testing

/// Web/crypto.js (the phone's ChaCha20-Poly1305) against the RFC 8439 vectors and OpenSSL (Node script), and
/// against CryptoKit in both directions with the envelope's AAD.
@Suite("Phone web crypto", .serialized)
struct PhoneWebCryptoTests {
    static func node() throws -> String { try #require(PhoneWebSupport.node, "Node is needed for the web crypto checks (set NODE=/path/to/node)") }
    static var script: String { PhoneWebSupport.testsDir.appendingPathComponent("crypto-vectors.mjs").path }

    @Test func rfc8439VectorsAndOpenSSL() throws {
        let r = try PhoneWebSupport.run(try Self.node(), [Self.script], timeout: 120)
        #expect(r.status == 0, "\(r.stdout)\n\(r.stderr)")
        #expect(r.stdout.contains("ok:") && r.stdout.contains(" 0 failed"))
    }

    @Test func javascriptSealsCryptoKitOpens() throws {
        let node = try Self.node()
        for len in [0, 1, 15, 16, 17, 63, 64, 65, 300, 4096] {
            let key = PhoneWebSupport.random(32), nonce = PhoneWebSupport.random(12), pt = PhoneWebSupport.random(len)
            let aad = Data("glide-phone-v1|dev-\(len)|req".utf8)
            let r = try PhoneWebSupport.run(node, [Self.script, "seal", PhoneWebSupport.hex(key), PhoneWebSupport.hex(nonce), PhoneWebSupport.hex(aad), PhoneWebSupport.hex(pt)])
            #expect(r.status == 0, "\(r.stderr)")
            let sealed = PhoneWebSupport.fromHex(r.stdout.trimmingCharacters(in: .whitespacesAndNewlines))
            #expect(sealed.count == len + 16)
            let box = try ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: nonce), ciphertext: sealed.prefix(len), tag: sealed.suffix(16))
            let opened = try ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: aad)
            #expect(opened == pt, "length \(len)")
            // The same envelope with the response AAD must not open.
            #expect(throws: (any Error).self) { try ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: Data("glide-phone-v1|dev-\(len)|res".utf8)) }
        }
    }

    @Test func cryptoKitSealsJavaScriptOpens() throws {
        let node = try Self.node()
        for len in [0, 1, 16, 33, 64, 129, 1000, 5000] {
            let key = PhoneWebSupport.random(32), nonce = PhoneWebSupport.random(12), pt = PhoneWebSupport.random(len)
            let aad = Data("glide-phone-v1|device\(len)|res".utf8)
            let box = try ChaChaPoly.seal(pt, using: SymmetricKey(data: key), nonce: ChaChaPoly.Nonce(data: nonce), authenticating: aad)
            let sealed = box.ciphertext + box.tag
            let r = try PhoneWebSupport.run(node, [Self.script, "open", PhoneWebSupport.hex(key), PhoneWebSupport.hex(nonce), PhoneWebSupport.hex(aad), PhoneWebSupport.hex(sealed)])
            #expect(r.status == 0, "\(r.stderr)")
            #expect(r.stdout.trimmingCharacters(in: .whitespacesAndNewlines) == PhoneWebSupport.hex(pt), "length \(len)")
            var tampered = sealed
            tampered[tampered.startIndex] ^= 1
            let bad = try PhoneWebSupport.run(node, [Self.script, "open", PhoneWebSupport.hex(key), PhoneWebSupport.hex(nonce), PhoneWebSupport.hex(aad), PhoneWebSupport.hex(tampered)])
            #expect(bad.stdout.trimmingCharacters(in: .whitespacesAndNewlines) == "null")
        }
    }
}

/// The embedded web app is current and complete.
@Suite("Phone web assets")
struct PhoneWebAssetsTests {
    @Test func embeddedAssetsAreUpToDate() throws {
        let script = PhoneWebSupport.repo.appendingPathComponent("scripts/embed-phone-web.sh").path
        let r = try PhoneWebSupport.run("/bin/bash", [script, "--check"])
        #expect(r.status == 0, "Run scripts/embed-phone-web.sh: \(r.stderr)")
    }

    @Test func servesThePageScriptsStylesAndIcon() throws {
        let page = try #require(PhoneWebAssets.asset("/"))
        #expect(page.type.hasPrefix("text/html"))
        let html = String(decoding: page.data, as: UTF8.self)
        for ref in ["/crypto.js", "/api.js", "/app.js", "/daisy.css", "/dim.css", "/app.css", "/icon-180.png"] {
            #expect(html.contains(ref), "index.html references \(ref)")
            #expect(PhoneWebAssets.asset(ref) != nil, "\(ref) is embedded")
        }
        #expect(html.contains("viewport-fit=cover") && html.contains("apple-mobile-web-app-capable") && html.contains("apple-touch-icon"))
        #expect(PhoneWebAssets.asset("/index.html")?.data == page.data)
        let icon = try #require(PhoneWebAssets.asset("/icon-180.png"))
        #expect(icon.type == "image/png" && icon.data.starts(with: [0x89, 0x50, 0x4E, 0x47]))
        #expect(PhoneWebAssets.asset("/missing.js") == nil)
        // No CDN or other host at runtime: every reference is local.
        for (path, f) in PhoneWebAssets.files where path != "/daisy.css" && path != "/dim.css" {
            #expect(!f.body.contains("https://cdn") && !f.body.contains("src=\"http") && !f.body.contains("href=\"http"), "\(path) loads nothing remote")
        }
        // The insecure-context rules: no crypto.subtle, navigator.clipboard or service worker.
        let code = ["/app.js", "/api.js", "/crypto.js"].compactMap { PhoneWebAssets.files[$0]?.body }.joined()
        for api in ["crypto.subtle.", "navigator.clipboard.", "serviceWorker.", "randomUUID("] { #expect(!code.contains(api), "uses \(api)") }
    }

    @Test func copyFollowsTheWritingRules() throws {
        // User-facing strings: no em dashes and no " · " separators.
        for name in ["app.js", "api.js", "index.html"] {
            let s = try String(contentsOf: PhoneWebSupport.webDir.appendingPathComponent(name), encoding: .utf8)
            #expect(!s.contains("\u{2014}"), "\(name) has an em dash")
            #expect(!s.contains(" \u{00B7} "), "\(name) has a dot separator")
        }
    }
}
