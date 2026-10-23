import AppKit
import CoreImage
import Foundation
@testable import GlideFeatures
import GlideCore
import SQLite3
import Testing

@Suite("ocr: text assembly + payloads (text.test.ts port)")
struct OCRTextTests {
    func line(_ t: String, _ x: Double, _ y: Double, _ w: Double = 0.2, _ h: Double = 0.04, c: Double = 1) -> OCRLine { OCRLine(text: t, confidence: c, box: Rect(x: x, y: y, width: w, height: h)) }

    @Test func readingOrder() {
        let lines = [line("world", 0.4, 0.101), line("Hello", 0.1, 0.1), line("second", 0.1, 0.15), line("para", 0.1, 0.3), line("noise", 0.5, 0.5, c: 0.1)]
        #expect(OCRText.assemble(lines, minConfidence: 0.5) == "Hello world\nsecond\n\npara")
        #expect(OCRText.assemble([]) == "")
    }

    @Test func payloads() {
        #expect(OCRText.classify("https://example.com/a").kind == .url)
        #expect(OCRText.classify("www.example.com").url == "https://www.example.com")
        #expect(OCRText.classify("a@b.co").url == "mailto:a@b.co")
        #expect(OCRText.classify("tel:+1555").label == "+1555")
        let w = OCRText.classify(#"WIFI:T:WPA;S:My\;Net;P:se\:cret;;"#)
        #expect(w.kind == .wifi && w.wifi?.ssid == "My;Net" && w.wifi?.password == "se:cret" && w.wifi?.security == "WPA")
        #expect(OCRText.classify("javascript:alert(1)").kind == .text)
        #expect(OCRText.classify("otpauth://totp/x").kind == .uri)
        #expect(!OCRText.isOpenable("file:///etc/passwd") && OCRText.isOpenable("https://x.y"))
        #expect(OCRText.extractLinks("see www.a.com, https://b.org/x. mail me@c.io") == ["https://www.a.com", "https://b.org/x", "mailto:me@c.io"])
        let s = OCRText.stats("one two\n\nthree")
        #expect(s.lines == 2 && s.words == 3 && s.chars == 14)
    }
}

/// Generated test images (never a screenshot).
enum TestImages {
    static func write(_ rep: NSBitmapImageRep, _ name: String) throws -> String {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("n7-\(name)-\(UUID().uuidString).png")
        try #require(rep.representation(using: .png, properties: [:])).write(to: url)
        return url.path
    }

    static func text(_ lines: [String]) throws -> String {
        let rep = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1200, pixelsHigh: 400, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor.white.setFill()
        NSRect(x: 0, y: 0, width: 1200, height: 400).fill()
        for (i, l) in lines.enumerated() {
            (l as NSString).draw(at: NSPoint(x: 40, y: 300 - i * 90), withAttributes: [.font: NSFont.systemFont(ofSize: 56, weight: .medium), .foregroundColor: NSColor.black])
        }
        NSGraphicsContext.restoreGraphicsState()
        return try write(rep, "text")
    }

    static func qr(_ payload: String) throws -> String {
        let f = try #require(CIFilter(name: "CIQRCodeGenerator"))
        f.setValue(Data(payload.utf8), forKey: "inputMessage")
        let img = try #require(f.outputImage).transformed(by: CGAffineTransform(scaleX: 12, y: 12))
        let padded = img.composited(over: CIImage(color: .white).cropped(to: img.extent.insetBy(dx: -60, dy: -60)))
        let ctx = CIContext()
        let cg = try #require(ctx.createCGImage(padded, from: padded.extent))
        return try write(NSBitmapImageRep(cgImage: cg), "qr")
    }
}

@Suite("ocr: Vision on generated images", .serialized)
@MainActor struct OCRVisionTests {
    @Test func recognizeTextAndAutoCopy() async throws {
        let ctx = N7TestContext("ocr")
        defer { ctx.cleanup() }
        let f = OCRFeature()
        await f.start(context: ctx)
        let path = try TestImages.text(["Glide native OCR", "visit https://example.com"])
        defer { try? FileManager.default.removeItem(atPath: path) }
        let r = try await f.recognize(file: path, source: "file")
        #expect(r.text.contains("Glide native OCR"))
        #expect(r.links.contains("https://example.com"))
        #expect(r.copied && ctx.services.pasteboard.string() == r.text)
    }

    @Test func scanQRCodeAndClipboardSeam() async throws {
        let ctx = N7TestContext("ocr")
        defer { ctx.cleanup() }
        let f = OCRFeature()
        await f.start(context: ctx)
        let path = try TestImages.qr("WIFI:T:WPA;S:TestNet;P:hunter2;;")
        defer { try? FileManager.default.removeItem(atPath: path) }
        let r = try await f.scan(file: path, source: "file")
        #expect(r.codes.first?.info.kind == .wifi)
        #expect(r.codes.first?.info.wifi?.ssid == "TestNet")
        // From clipboard image (headless seam) → codes view.
        #expect(await f.fromClipboard("codes") == .error("The clipboard has no image. Copy a screenshot or image first (⌃⇧⌘4 copies a screenshot)."))
        f.headlessClipboardImage = path
        #expect(await f.fromClipboard("codes") == .pushView(ViewID(rawValue: "ocr.codes")))
        let host = N7TestHost()
        f.resultModel.hostOverride = host
        #expect(f.resultModel.rows().first?.title == "Wi-Fi “TestNet”")
        #expect(f.resultModel.rows().first?.actions.first?.title == "Copy Wi-Fi Password")
        // Screen capture is never run headless.
        _ = await f.captureFlow("text")
        #expect(f.effects == ["screencapture -i (skipped: headless)"])
    }
}

// MARK: - browser

/// Builds a fixture home with synthetic Chrome, Firefox and Safari data (no real browser data is read).
enum BrowserFixture {
    static func exec(_ db: OpaquePointer?, _ sql: String) { sqlite3_exec(db, sql, nil, nil, nil) }

    static func sqlite(_ path: String, _ sqls: [String]) {
        var db: OpaquePointer?
        sqlite3_open(path, &db)
        for s in sqls { exec(db, s) }
        sqlite3_close(db)
    }

    static func make() throws -> String {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("n7-browser-home-\(UUID().uuidString)").path
        let fm = FileManager.default
        let chrome = "\(home)/Library/Application Support/Google/Chrome"
        try fm.createDirectory(atPath: "\(chrome)/Default", withIntermediateDirectories: true)
        try fm.createDirectory(atPath: "\(chrome)/Profile 2", withIntermediateDirectories: true)
        try #"{"profile":{"info_cache":{"Default":{"name":"Personal"},"Profile 2":{"name":"Work"}}}}"#.write(toFile: "\(chrome)/Local State", atomically: true, encoding: .utf8)
        let bm = #"{"roots":{"bookmark_bar":{"children":[{"type":"url","name":"Swift Forums","url":"https://forums.swift.org/"},{"type":"folder","name":"Dev","children":[{"type":"url","name":"Fixture Docs","url":"https://docs.fixture.test/start"},{"type":"url","name":"Bad","url":"javascript:alert(1)"}]}]},"other":{"children":[{"type":"url","name":"","url":"https://untitled.fixture.test/"}]}}}"#
        try bm.write(toFile: "\(chrome)/Default/Bookmarks", atomically: true, encoding: .utf8)
        try #"{"roots":{"bookmark_bar":{"children":[{"type":"url","name":"Work Wiki","url":"https://wiki.work.test/"}]}}}"#.write(toFile: "\(chrome)/Profile 2/Bookmarks", atomically: true, encoding: .utf8)
        let recent = BrowserData.msToWebkit(Date().timeIntervalSince1970 * 1000 - 3_600_000)
        sqlite("\(chrome)/Default/History", ["CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER)",
                                            "INSERT INTO urls VALUES(1,'https://history.fixture.test/page','Fixture History Page',7,\(recent),0)",
                                            "INSERT INTO urls VALUES(2,'https://hidden.fixture.test/','Hidden',1,\(recent),1)",
                                            "INSERT INTO urls VALUES(3,'https://old.fixture.test/','Old Page',1,13000000000000000,0)"])
        let ff = "\(home)/Library/Application Support/Firefox"
        try fm.createDirectory(atPath: "\(ff)/Profiles/abcd.default-release", withIntermediateDirectories: true)
        try "[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abcd.default-release\n".write(toFile: "\(ff)/profiles.ini", atomically: true, encoding: .utf8)
        sqlite("\(ff)/Profiles/abcd.default-release/places.sqlite", [
            "CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER, hidden INTEGER)",
            "CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, title TEXT)",
            "INSERT INTO moz_places VALUES(1,'https://fox.fixture.test/','Fox Page',2,\(Int64((Date().timeIntervalSince1970 - 60) * 1_000_000)),0)",
            "INSERT INTO moz_places VALUES(2,'place:sort=8','Smart',0,NULL,0)",
            "INSERT INTO moz_bookmarks VALUES(1,2,NULL,0,'toolbar')", "INSERT INTO moz_bookmarks VALUES(2,1,1,1,'Fox Bookmark')", "INSERT INTO moz_bookmarks VALUES(3,1,2,1,'Smart')",
        ])
        try fm.createDirectory(atPath: "\(home)/Library/Safari", withIntermediateDirectories: true)
        let plist: [String: Any] = ["WebBookmarkType": "WebBookmarkTypeList", "Title": "", "Children": [
            ["WebBookmarkType": "WebBookmarkTypeList", "Title": "BookmarksBar", "Children": [
                ["WebBookmarkType": "WebBookmarkTypeLeaf", "URLString": "https://safari.fixture.test/", "URIDictionary": ["title": "Safari Fixture"]]]],
            ["WebBookmarkType": "WebBookmarkTypeList", "Title": "com.apple.ReadingList", "Children": [
                ["WebBookmarkType": "WebBookmarkTypeLeaf", "URLString": "https://later.fixture.test/", "URIDictionary": ["title": "Read Later"]]]],
        ]]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .binary, options: 0).write(to: URL(fileURLWithPath: "\(home)/Library/Safari/Bookmarks.plist"))
        return home
    }
}

@Suite("browser: readers and search", .serialized)
@MainActor struct BrowserTests {
    @Test func profilesParsersAndSQLiteCopies() throws {
        let home = try BrowserFixture.make()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let profiles = BrowserData.discoverProfiles(home: home)
        #expect(profiles.map(\.key) == ["chrome:Default", "chrome:Profile 2", "firefox:abcd.default-release", "safari:Safari"])
        #expect(profiles.first?.name == "Personal")
        let chromeBm = BrowserData.parseChromiumBookmarks(try Data(contentsOf: URL(fileURLWithPath: profiles[0].bookmarksFile ?? "")))
        #expect(chromeBm.map(\.title) == ["Swift Forums", "Fixture Docs", "https://untitled.fixture.test/"])
        #expect(chromeBm[1].folder == "Bookmarks Bar / Dev")
        let hist = BrowserData.historyEntries(.chromium, rows: try BrowserSQLite.queryCopy(profiles[0].historyFile ?? "", [BrowserData.historyQuery(.chromium, limit: 10, sinceMs: Date().timeIntervalSince1970 * 1000 - 86_400_000 * 90)])[0])
        #expect(hist.map(\.title) == ["Fixture History Page"])
        #expect(hist.first?.visitCount == 7)
        let ff = BrowserData.firefoxBookmarks(try BrowserSQLite.queryCopy(profiles[2].bookmarksFile ?? "", [BrowserData.firefoxBookmarksSQL])[0])
        #expect(ff.map(\.title) == ["Fox Bookmark"] && ff.first?.folder == "Bookmarks Toolbar")
        let safari = BrowserData.parseSafariBookmarks(try Data(contentsOf: URL(fileURLWithPath: profiles[3].bookmarksFile ?? "")))
        #expect(safari.map(\.folder) == ["Favourites", "Reading List"])
        // The temp copies are gone.
        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: FileManager.default.temporaryDirectory.path))?.filter { $0.hasPrefix("glide-browser-") } ?? []
        #expect(leftovers.isEmpty)
        #expect(BrowserData.safariAccess(home: home) == "ok")
    }

    @Test func featureIndexesSearchesAndHistoryIsOptIn() async throws {
        let home = try BrowserFixture.make()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let ctx = N7TestContext("browser")
        defer { ctx.cleanup() }
        let f = BrowserFeature()
        f.homeOverride = home
        await f.start(context: ctx)
        await f.refresh()
        #expect(f.index.filter { $0.entry.type == "history" }.isEmpty) // history off by default
        let roots = await f.dynamicItems(for: DynamicQuery(text: "swift", deadline: .now + .seconds(1)))
        #expect(roots.first?.item.title == "Swift Forums")
        #expect(roots.first?.item.kindLabel == "Bookmark")
        #expect(await f.dynamicItems(for: DynamicQuery(text: "hist fixture", deadline: .now + .seconds(1))).isEmpty)
        await f.setSettings(["history": true])
        let hist = await f.dynamicItems(for: DynamicQuery(text: "hist fixture", deadline: .now + .seconds(1)))
        #expect(hist.map(\.item.title).contains("Fixture History Page"))
        #expect(hist.map(\.item.title).contains("Fox Page"))
        let rows = f.rows("wiki", type: "bookmark")
        #expect(rows.first?.trailing == "Google Chrome (Work)")
        _ = await f.run(action: "copyMd", on: try #require(roots.first), modifiers: [])
        #expect(ctx.services.pasteboard.string() == "[Swift Forums](https://forums.swift.org/)")
        await f.setSettings(["history": false])
        #expect(f.index.filter { $0.entry.type == "history" }.isEmpty)
    }

    @Test func scoring() {
        let e = BrowserSearch.index([BrowserEntry(type: "bookmark", title: "GitHub", url: "https://github.com/"), BrowserEntry(type: "bookmark", title: "Docs about github", url: "https://docs.test/")],
                                    profile: "p", browser: "chrome")
        let r = BrowserSearch.search(e, "github", limit: 5)
        #expect(r.first?.0.entry.title == "GitHub")
        #expect(BrowserSearch.historyPrefix("history foo bar") == "foo bar")
        #expect(BrowserSearch.historyPrefix("historyfoo") == nil)
    }
}
