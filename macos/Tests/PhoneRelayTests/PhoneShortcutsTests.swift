import Foundation
import Testing
@testable import GlideFeatures

/// The generated .shortcut plists: well-formed, round-trip, expected actions, consistent variables and control flow.
/// Never signs (signing only happens when the user clicks "Add Shortcuts to iPhone").
@Suite("phone shortcuts generation")
struct PhoneShortcutsTests {
    typealias Dict = [String: Any]

    func actions(_ s: GeneratedShortcut, format: PropertyListSerialization.PropertyListFormat = .binary) throws -> (Dict, [Dict]) {
        let data = try s.data(format: format)
        var fmt = PropertyListSerialization.PropertyListFormat.xml
        let root = try #require(try PropertyListSerialization.propertyList(from: data, options: [], format: &fmt) as? Dict)
        #expect(fmt == format)
        let acts = try #require(root["WFWorkflowActions"] as? [Dict])
        return (root, acts)
    }

    func identifiers(_ acts: [Dict]) -> [String] { acts.compactMap { $0["WFWorkflowActionIdentifier"] as? String } }

    /// Every OutputUUID referenced anywhere inside `v`.
    func referencedUUIDs(_ v: Any) -> [String] {
        if let d = v as? Dict {
            var out: [String] = []
            if d["Type"] as? String == "ActionOutput", let u = d["OutputUUID"] as? String { out.append(u) }
            for x in d.values { out += referencedUUIDs(x) }
            return out
        }
        if let a = v as? [Any] { return a.flatMap(referencedUUIDs) }
        return []
    }

    func strings(_ v: Any) -> [String] {
        if let s = v as? String { return [s] }
        if let d = v as? Dict { return d.values.flatMap(strings) }
        if let a = v as? [Any] { return a.flatMap(strings) }
        return []
    }

    @Test func allFiveAreWellFormedInBothFormats() throws {
        let all = PhoneShortcuts.all()
        #expect(all.map(\.name) == ["Send to Glide", "Send Clipboard to Mac", "Get Mac Clipboard", "Run Glide Workflow", "Ask Glide Agent"])
        for s in all {
            for format in [PropertyListSerialization.PropertyListFormat.binary, .xml] {
                let (root, acts) = try actions(s, format: format)
                #expect(!acts.isEmpty)
                #expect(root["WFWorkflowMinimumClientVersion"] as? Int == 900)
                #expect(root["WFWorkflowIcon"] is Dict)
                #expect(root["WFWorkflowImportQuestions"] as? [Any] != nil)
                for a in acts {
                    let id = try #require(a["WFWorkflowActionIdentifier"] as? String)
                    #expect(id.hasPrefix("is.workflow.actions."), "\(s.name): \(id)")
                    #expect(a["WFWorkflowActionParameters"] is Dict, "\(s.name): \(id)")
                }
            }
            #expect(s.fileName == s.name + ".shortcut")
            // Binary output is a real binary plist.
            #expect(try s.data().prefix(8) == Data("bplist00".utf8))
        }
    }

    @Test func variablesPointAtEarlierActionsAndBlocksAreBalanced() throws {
        for s in PhoneShortcuts.all() {
            let (_, acts) = try actions(s)
            var defined = Set<String>()
            var open: [String: Int] = [:]
            for a in acts {
                let p = a["WFWorkflowActionParameters"] as? Dict ?? [:]
                for u in referencedUUIDs(p) { #expect(defined.contains(u), "\(s.name): \(u) used before it exists") }
                if let u = p["UUID"] as? String { #expect(!defined.contains(u)); defined.insert(u) }
                if let g = p["GroupingIdentifier"] as? String, let mode = p["WFControlFlowMode"] as? Int {
                    if mode == 0 { open[g, default: 0] += 1 }
                    if mode == 1 { #expect(open[g] == 1, "\(s.name): otherwise outside its block") }
                    if mode == 2 { open[g, default: 0] -= 1 }
                }
            }
            #expect(open.values.allSatisfy { $0 == 0 }, "\(s.name): unbalanced control flow")
        }
    }

    @Test func textTokensPlaceAttachmentsOnTheMarker() throws {
        let t = ShortcutBuilder.tokenString([.text("Glide/Phone/outbox/"), .variable(.output(uuid: "U", name: "Request ID")), .text(".json")])
        guard case let .dict(d) = t, case let .dict(v)? = d["Value"], case let .string(s)? = v["string"], case let .dict(att)? = v["attachmentsByRange"] else {
            Issue.record("shape"); return
        }
        #expect(s == "Glide/Phone/outbox/\u{FFFC}.json")
        #expect(Array(att.keys) == ["{19, 1}"])
        #expect((s as NSString).substring(with: NSRange(location: 19, length: 1)) == "\u{FFFC}")
    }

    @Test func eachShortcutWritesTheRightRequest() throws {
        func check(_ s: GeneratedShortcut, action: String?, must: [String], reads: String? = nil) throws {
            let (root, acts) = try actions(s)
            let ids = identifiers(acts)
            for m in must { #expect(ids.contains("is.workflow.actions." + m), "\(s.name) lacks \(m)") }
            let all = strings(root)
            if let action {
                #expect(all.contains(action), "\(s.name) does not send \(action)")
                #expect(all.contains("Glide/Phone/inbox/"))
                #expect(all.contains("Shortcuts"))
                // The request dictionary carries v, id, action, args, from.
                for k in ["v", "id", "action", "args", "from"] { #expect(all.contains(k), "\(s.name) request lacks \(k)") }
            }
            if let reads { #expect(all.contains { $0.contains(reads) }, "\(s.name) does not read \(reads)") }
        }
        try check(PhoneShortcuts.sendToGlide(), action: "send", must: ["detect.images", "base64encode", "detect.text", "choosefromlist", "dictionary", "setitemname", "documentpicker.save"])
        try check(PhoneShortcuts.sendClipboardToMac(), action: "clipboard.set", must: ["getclipboard", "documentpicker.save", "repeat.count", "documentpicker.open"], reads: "Glide/Phone/outbox/")
        try check(PhoneShortcuts.getMacClipboard(), action: nil, must: ["documentpicker.open", "detect.dictionary", "getvalueforkey", "setclipboard"], reads: "Glide/Phone/clipboard.json")
        try check(PhoneShortcuts.runWorkflow(), action: "workflows.run", must: ["ask", "conditional", "documentpicker.save"])
        try check(PhoneShortcuts.askAgent(), action: "agent.ask", must: ["ask", "repeat.count", "delay", "documentpicker.open", "showresult", "file.delete", "exit"], reads: "Glide/Phone/outbox/")
        // Get Mac Clipboard never writes to the inbox.
        #expect(!strings(try actions(PhoneShortcuts.getMacClipboard()).0).contains("Glide/Phone/inbox/"))
    }

    @Test func shareSheetAndAutomationInputs() throws {
        let (share, _) = try actions(PhoneShortcuts.sendToGlide())
        #expect(share["WFWorkflowTypes"] as? [String] == ["ActionExtension"])
        let classes = share["WFWorkflowInputContentItemClasses"] as? [String] ?? []
        for c in ["WFStringContentItem", "WFURLContentItem", "WFImageContentItem"] { #expect(classes.contains(c)) }
        let (run, _) = try actions(PhoneShortcuts.runWorkflow())
        #expect(run["WFWorkflowInputContentItemClasses"] as? [String] == ["WFStringContentItem"])
        #expect(run["WFWorkflowHasShortcutInputVariables"] as? Bool == true)
    }

    @Test func generationIsDeterministicAndExportsUnsignedFiles() throws {
        #expect(PhoneShortcuts.askAgent().workflow == PhoneShortcuts.askAgent().workflow)
        let dir = RelayScratch.fresh("shortcuts")
        let files = try PhoneShortcutsExport.writeUnsigned(PhoneShortcuts.all(), to: dir)
        #expect(files.map(\.lastPathComponent).sorted() == PhoneShortcuts.all().map(\.fileName).sorted())
        for f in files {
            let d = try Data(contentsOf: f)
            #expect(try PropertyListSerialization.propertyList(from: d, options: [], format: nil) is [String: Any])
        }
        try? FileManager.default.removeItem(at: dir)
    }
}
