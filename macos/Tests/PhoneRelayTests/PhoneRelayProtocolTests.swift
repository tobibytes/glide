import Foundation
import Testing
@testable import GlideCore
@testable import GlideFeatures

@Suite("phone relay protocol")
struct PhoneRelayProtocolTests {
    @Test func parsesAValidRequest() throws {
        let d = Data(#"{"v":1,"id":"20261024-123456","action":"clipboard.set","args":{"text":"hi"},"from":"Shortcuts"}"#.utf8)
        guard case let .request(r) = PhoneRelayProtocol.parse(d, fileName: "20261024-123456.json") else { Issue.record("not a request"); return }
        #expect(r.id == "20261024-123456")
        #expect(r.action == "clipboard.set")
        #expect(r.args["text"]?.stringValue == "hi")
        #expect(r.from == "Shortcuts")
    }

    @Test func idFallsBackToTheFileNameAndArgsDefault() {
        let d = Data(#"{"action":"status"}"#.utf8)
        guard case let .request(r) = PhoneRelayProtocol.parse(d, fileName: "abc-1.json.json") else { Issue.record("not a request"); return }
        #expect(r.id == "abc-1")
        #expect(r.args == .object([:]))
    }

    @Test func partialAndEmptyFilesAreIncomplete() {
        for s in ["", "   ", #"{"v":1,"id":"x","act"#, "\u{FEFF}"] {
            guard case .incomplete = PhoneRelayProtocol.parse(Data(s.utf8), fileName: "x.json") else { Issue.record("\(s) should be incomplete"); continue }
        }
    }

    @Test func invalidRequestsGetAnErrorNow() {
        func code(_ s: String) -> String? {
            if case let .invalid(_, e) = PhoneRelayProtocol.parse(Data(s.utf8), fileName: "r1.json") { return e.code }
            return nil
        }
        #expect(code("[1,2]") == "bad-args")
        #expect(code(#"{"id":"../../etc","action":"status"}"#) == "bad-args")
        #expect(code(#"{"id":"ok","args":{}}"#) == "bad-args")
        #expect(code(#"{"id":"ok","action":"status","args":[1]}"#) == "bad-args")
        #expect(code(#"{"v":2,"id":"ok","action":"status"}"#) == "unsupported")
    }

    @Test func argsAsAJSONStringAndPlistsAreAccepted() throws {
        guard case let .request(r) = PhoneRelayProtocol.parse(Data(#"{"id":"a","action":"send","args":"{\"text\":\"t\"}"}"#.utf8), fileName: "a.json") else {
            Issue.record("string args"); return
        }
        #expect(r.args["text"]?.stringValue == "t")
        let plist = try PropertyListSerialization.data(fromPropertyList: ["v": 1, "id": "p1", "action": "status", "args": [String: Any]()], format: .binary, options: 0)
        guard case let .request(p) = PhoneRelayProtocol.parse(plist, fileName: "p1.json") else { Issue.record("plist"); return }
        #expect(p.id == "p1" && p.action == "status")
    }

    @Test func idsAreSafeFileNames() {
        #expect(PhoneRelayProtocol.isValidId("20261024101010123-123456"))
        #expect(!PhoneRelayProtocol.isValidId(""))
        #expect(!PhoneRelayProtocol.isValidId(".hidden"))
        #expect(!PhoneRelayProtocol.isValidId("a/b"))
        #expect(!PhoneRelayProtocol.isValidId(String(repeating: "a", count: 65)))
        #expect(PhoneRelayProtocol.fallbackId(fileName: "bad name!.json") == "badname")
        #expect(PhoneRelayProtocol.isValidId(PhoneRelayProtocol.fallbackId(fileName: "!!!.json")))
    }

    @Test func placeholdersAndCandidates() {
        #expect(PhoneRelayProtocol.placeholderTarget(".abc.json.icloud") == "abc.json")
        #expect(PhoneRelayProtocol.placeholderTarget("abc.json") == nil)
        #expect(PhoneRelayProtocol.placeholderTarget("..icloud") == nil)
        #expect(!PhoneRelayProtocol.isCandidate(".abc.json.icloud"))
        #expect(!PhoneRelayProtocol.isCandidate(".DS_Store"))
        #expect(!PhoneRelayProtocol.isCandidate("x.json.tmp"))
        #expect(PhoneRelayProtocol.isCandidate("x.json"))
    }

    @Test func replyShapeAddsIdAndText() {
        let ok = PhoneRelayProtocol.reply(id: "r", outcome: ["ok": true, "result": ["text": "The answer"]])
        #expect(ok["id"]?.stringValue == "r")
        #expect(ok["ok"]?.boolValue == true)
        #expect(ok["text"]?.stringValue == "The answer")
        let fail = PhoneRelayProtocol.errorReply(id: "r", PhoneError("denied", "No."))
        #expect(fail["ok"]?.boolValue == false)
        #expect(fail["error"]?["code"]?.stringValue == "denied")
        #expect(fail["text"]?.stringValue == "No.")
        let waiting = PhoneRelayProtocol.reply(id: "r", outcome: ["ok": true, "result": ["text": "I can do that.", "status": "confirming"]])
        #expect(waiting["text"]?.stringValue?.hasPrefix("I can do that.") == true)
        #expect(waiting["text"]?.stringValue?.contains("Approve it in Glide Remote or on the Mac") == true)
        let bare = PhoneRelayProtocol.reply(id: "r", outcome: ["message": "hi"])
        #expect(bare["ok"]?.boolValue == true && bare["result"]?["message"]?.stringValue == "hi")
    }

    @Test func overrideReplacesTheICloudRoots() {
        let roots = PhoneRelayPaths.roots(environment: ["GLIDE_PHONE_RELAY_DIR": "/tmp/x"])
        #expect(roots.map(\.path) == ["/tmp/x"])
        let real = PhoneRelayPaths.roots(environment: [:], home: URL(fileURLWithPath: "/Users/someone"))
        #expect(real.map(\.path) == ["/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/Glide/Phone",
                                     "/Users/someone/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/Glide/Phone"])
    }
}
