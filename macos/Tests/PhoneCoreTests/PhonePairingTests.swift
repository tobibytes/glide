import Foundation
@testable import GlideFeatures
import GlideCore
import Testing

@MainActor @Suite("Phone pairing, devices and the /api handler")
struct PhonePairingTests {
    final class Clock { var now = Date(timeIntervalSince1970: 1_800_000_000) }

    @Test func pendingExpiresAfterTenMinutes() {
        let clock = Clock()
        let keys = PhoneMemoryKeyStore()
        let reg = PhoneDeviceRegistry(keys: keys, file: nil, now: { clock.now })
        let p = reg.createPending()
        #expect(p.key.count == 32 && PhoneCrypto.fromBase64url(p.id)?.count == 16)
        #expect(reg.key(for: p.id) == p.key && reg.isPending(p.id))
        #expect(keys.keys.isEmpty, "pending keys stay in memory until the phone connects")
        clock.now = clock.now.addingTimeInterval(10 * 60 + 1)
        #expect(reg.key(for: p.id) == nil && !reg.isPending(p.id))
        #expect(reg.activate(p.id, name: "Late") == nil)
        reg.prune()
        #expect(reg.pending.isEmpty)
    }

    @Test func activateRenameRevoke() throws {
        let keys = PhoneMemoryKeyStore()
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("phone-devices-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("devices.json")
        let reg = PhoneDeviceRegistry(keys: keys, file: file)
        let p = reg.createPending()
        let d = try #require(reg.activate(p.id, name: "  Tobi's\niPhone  "))
        #expect(d.name == "Tobi's iPhone")
        #expect(keys.keys[p.id] == p.key && reg.pending.isEmpty)
        #expect(reg.rename(p.id, "Work phone") && reg.device(p.id)?.name == "Work phone")
        #expect(!reg.rename(p.id, "   "))
        reg.touch(p.id, transport: "lan")
        #expect(reg.device(p.id)?.lastSeen != nil)
        reg.flush()
        let text = try String(contentsOf: file, encoding: .utf8)
        #expect(text.contains("Work phone") && !text.contains(PhoneCrypto.base64url(p.key)) && !text.contains(p.key.base64EncodedString()), "metadata only, never keys")
        let reloaded = PhoneDeviceRegistry(keys: keys, file: file)
        #expect(reloaded.device(p.id)?.name == "Work phone" && reloaded.key(for: p.id) == p.key)
        #expect(reloaded.revoke(p.id))
        #expect(keys.keys[p.id] == nil && reloaded.key(for: p.id) == nil && reloaded.devices.isEmpty)
    }

    func call(_ f: PhoneFeature, _ action: String, _ args: JSONValue = [:], id: String, key: Data, ts: Date = Date(), nonce: Data? = nil) async throws -> (Int, JSONValue?) {
        let body = try PhoneEnvelope.request(action: action, args: args, key: key, deviceId: id, ts: ts, nonce: nonce)
        let r = await PhoneCoreAPI.handle(f, body)
        guard r.status == 200 else { return (r.status, try? JSONDecoder().decode(JSONValue.self, from: r.body)) }
        return (200, try PhoneEnvelope.response(r.body, key: key, deviceId: id))
    }

    @Test func apiPairsOnHelloAndRejectsReplaysAndStaleRequests() async throws {
        let (f, ctx) = await makePhone()
        defer { ctx.cleanup() }
        let reg = try #require(f.core.devices)
        let p = reg.createPending()

        let (s1, hello) = try await call(f, "hello", ["name": "Tobi's iPhone"], id: p.id, key: p.key)
        #expect(s1 == 200 && hello?["ok"] == true)
        #expect(hello?["result"]?["device"]?["name"] == "Tobi's iPhone")
        #expect(hello?["id"]?.stringValue?.isEmpty == false)
        #expect(reg.device(p.id) != nil && !reg.isPending(p.id))

        // Replayed nonce
        let nonce = PhoneCrypto.randomBytes(12)
        let (s2, _) = try await call(f, "status", id: p.id, key: p.key, nonce: nonce)
        #expect(s2 == 200)
        let (s3, body3) = try await call(f, "status", id: p.id, key: p.key, nonce: nonce)
        #expect(s3 == 401 && body3 == ["error": "unpaired"])
        // Stale timestamp
        let (s4, _) = try await call(f, "status", id: p.id, key: p.key, ts: Date().addingTimeInterval(-121))
        #expect(s4 == 401)
        let (s5, _) = try await call(f, "status", id: p.id, key: p.key, ts: Date().addingTimeInterval(125))
        #expect(s5 == 401)
        // Wrong key, unknown device, junk
        let (s6, _) = try await call(f, "status", id: p.id, key: PhoneCrypto.randomBytes(32))
        #expect(s6 == 401)
        let (s7, _) = try await call(f, "status", id: "nobody", key: p.key)
        #expect(s7 == 401)
        #expect(await PhoneCoreAPI.handle(f, Data("{}".utf8)).status == 401)
        // A request sealed as a response (wrong AAD direction)
        let plain = try JSONEncoder().encode(JSONValue.object(["id": "x", "ts": .int(Int64(Date().timeIntervalSince1970 * 1000)), "action": "status", "args": [:]]))
        let mirrored = PhoneEnvelope.encode(try PhoneEnvelope.seal(plain, key: p.key, deviceId: p.id, direction: .res))
        #expect(await PhoneCoreAPI.handle(f, mirrored).status == 401)
        // Revoked
        reg.revoke(p.id)
        let (s8, _) = try await call(f, "status", id: p.id, key: p.key)
        #expect(s8 == 401)
    }

    @Test func helloKeepsAMacSideRename() async throws {
        let (f, ctx) = await makePhone()
        defer { ctx.cleanup() }
        let reg = try #require(f.core.devices)
        let p = reg.createPending()
        _ = try await call(f, "hello", ["name": "First"], id: p.id, key: p.key)
        reg.rename(p.id, "Kitchen iPad")
        let (_, again) = try await call(f, "hello", ["name": "First"], id: p.id, key: p.key)
        #expect(again?["result"]?["device"]?["name"] == "Kitchen iPad")
    }

    @Test func lanServerServesAssetsAndAPIOverLoopback() async throws {
        let (f, ctx) = await makePhone()
        defer { ctx.cleanup() }
        let srv = PhoneLANServer(host: "127.0.0.1") { [weak f] body in
            guard let f else { return PhoneCoreAPI.unpaired }
            return await PhoneCoreAPI.handle(f, body)
        }
        try await srv.start(preferredPort: 0, bonjourName: "should-not-advertise")
        defer { Task { @MainActor in await srv.close() } }
        #expect(!srv.advertised, "a pinned host never advertises on Bonjour")
        #expect(srv.port > 0 && srv.baseURL == "http://127.0.0.1:\(srv.port)")
        let base = try #require(srv.baseURL.flatMap(URL.init(string:)))

        let (html, r1) = try await URLSession.shared.data(from: base)
        let h1 = try #require(r1 as? HTTPURLResponse)
        #expect(h1.statusCode == 200 && (h1.value(forHTTPHeaderField: "Content-Type") ?? "").hasPrefix("text/html") && !html.isEmpty)
        #expect(h1.value(forHTTPHeaderField: "X-Content-Type-Options") == "nosniff")
        let (_, r2) = try await URLSession.shared.data(from: base.appendingPathComponent("nope.js"))
        #expect((r2 as? HTTPURLResponse)?.statusCode == 404)

        var req = URLRequest(url: base.appendingPathComponent("api"))
        req.httpMethod = "POST"
        req.httpBody = Data(#"{"v":1,"d":"x","n":"AAAAAAAAAAAAAAAA","c":"AAAAAAAAAAAAAAAAAAAAAA"}"#.utf8)
        let (b3, r3) = try await URLSession.shared.data(for: req)
        #expect((r3 as? HTTPURLResponse)?.statusCode == 401 && String(decoding: b3, as: UTF8.self) == #"{"error":"unpaired"}"#)

        let p = try #require(f.core.devices).createPending()
        req.httpBody = try PhoneEnvelope.request(action: "hello", args: ["name": "Loopback"], key: p.key, deviceId: p.id)
        let (b4, r4) = try await URLSession.shared.data(for: req)
        #expect((r4 as? HTTPURLResponse)?.statusCode == 200)
        let out = try PhoneEnvelope.response(b4, key: p.key, deviceId: p.id)
        #expect(out["ok"] == true && out["result"]?["device"]?["name"] == "Loopback")
    }

    @Test func oversizedBodyAndJunkAreRefused() async throws {
        let srv = PhoneLANServer(host: "127.0.0.1") { _ in PhoneHTTPResponse(status: 200, body: Data()) }
        srv.idleTimeout = .seconds(1)
        try await srv.start(preferredPort: 0, bonjourName: nil)
        defer { Task { @MainActor in await srv.close() } }
        let port = srv.port
        // A connection that stalls mid-headers is dropped by the idle timeout (well before the 3 s socket timeout).
        let t0 = ContinuousClock.now
        let stalled = await rawHTTP(port: port, "GET / HTTP/1.1\r\nHost: x\r\n")
        #expect(stalled.isEmpty && ContinuousClock.now - t0 < .milliseconds(2800))
        let big = await rawHTTP(port: port, "POST /api HTTP/1.1\r\nHost: x\r\nContent-Length: \(PhoneLANServer.maxBody + 1)\r\n\r\nabc")
        #expect(big.hasPrefix("HTTP/1.1 413"))
        let headers = await rawHTTP(port: port, "GET / HTTP/1.1\r\nX: " + String(repeating: "a", count: 70_000))
        #expect(headers.hasPrefix("HTTP/1.1 431"))
        let get = await rawHTTP(port: port, "GET /api HTTP/1.1\r\nHost: x\r\n\r\n")
        #expect(get.hasPrefix("HTTP/1.1 405"))
    }
}

/// One raw HTTP exchange over a blocking loopback socket (off the main actor); returns what the server sent.
func rawHTTP(port: Int, _ request: String) async -> String {
    await Task.detached {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return "" }
        defer { close(fd) }
        var tv = timeval(tv_sec: 3, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard ok == 0 else { return "" }
        let bytes = Array(request.utf8)
        _ = bytes.withUnsafeBytes { send(fd, $0.baseAddress, $0.count, 0) }
        var out = [UInt8](repeating: 0, count: 4096)
        let n = recv(fd, &out, out.count, 0)
        return n > 0 ? String(decoding: out[0..<n], as: UTF8.self) : ""
    }.value
}
