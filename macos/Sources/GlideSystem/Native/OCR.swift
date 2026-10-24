import Foundation
import GlideCore
import ImageIO
import Vision

/// Vision text recognition and barcode detection (helper OCR.swift). Boxes normalised, origin top-left.
///
/// In the app, each request runs in a short-lived worker (`Glide --ocr-worker …`): Vision keeps its models and
/// buffers resident after the first request (+100–200 MB that never comes back), and a process that exits returns
/// all of it. Without a worker binary (tests) or if the worker fails to start, it runs in-process.
@MainActor public final class VisionOCRService: OCRService {
    let worker: URL?
    public init(worker: URL? = nil) { self.worker = worker }

    /// The running Glide binary, when this process is Glide (not a test runner).
    public static var appWorker: URL? {
        guard let exe = Bundle.main.executableURL, exe.lastPathComponent == "Glide" else { return nil }
        return exe
    }

    public func recognize(path: String, languages: [String], fast: Bool, languageCorrection: Bool) async throws -> OCRResult {
        var args = ["text", path]
        if fast { args.append("--fast") }
        if !languageCorrection { args.append("--no-correction") }
        if !languages.isEmpty { args += ["--languages", languages.joined(separator: ",")] }
        if let worker, let r: OCRResult = try await Self.runWorker(worker, args) { return r }
        return try await offMainThrowing { try Self.recognizeNow(path: path, languages: languages, fast: fast, languageCorrection: languageCorrection) }
    }

    public func barcodes(path: String) async throws -> BarcodeResult {
        if let worker, let r: BarcodeResult = try await Self.runWorker(worker, ["codes", path]) { return r }
        return try await offMainThrowing { try Self.barcodesNow(path: path) }
    }

    /// nil = the worker could not run (fall back to in-process); throws the worker's own error message.
    nonisolated static func runWorker<T: Decodable & Sendable>(_ exe: URL, _ args: [String]) async throws -> T? {
        let out: (Data, Int32)? = await offMain {
            let p = Process()
            p.executableURL = exe
            p.arguments = [OCRWorker.flag] + args
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = FileHandle.nullDevice
            p.standardInput = FileHandle.nullDevice
            do { try p.run() } catch { return nil }
            let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 60, execute: killer)
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            killer.cancel()
            return (data, p.terminationStatus)
        }
        guard let (data, status) = out else { return nil }
        if status == 0, let r = try? JSONDecoder().decode(T.self, from: data) { return r }
        if let e = try? JSONDecoder().decode([String: String].self, from: data), let m = e["error"] { throw FeatureError.failed(m) }
        return nil
    }

    nonisolated static func image(_ path: String) throws -> CGImage {
        guard FileManager.default.fileExists(atPath: path) else { throw FeatureError.failed("Image not found: \(path)") }
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw FeatureError.failed("Could not read the image")
        }
        return img
    }
    nonisolated static func box(_ r: CGRect) -> Rect { Rect(x: Double(r.minX), y: Double(1 - r.maxY), width: Double(r.width), height: Double(r.height)) }

    // autoreleasepool: Vision's buffers are autoreleased and a detached task's thread may not drain its pool soon.
    nonisolated static func recognizeNow(path: String, languages: [String], fast: Bool, languageCorrection: Bool) throws -> OCRResult {
        try autoreleasepool {
            let img = try image(path)
            let req = VNRecognizeTextRequest()
            req.recognitionLevel = fast ? .fast : .accurate
            req.usesLanguageCorrection = languageCorrection
            if languages.isEmpty { req.automaticallyDetectsLanguage = true } else { req.recognitionLanguages = languages }
            try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
            let lines = (req.results ?? []).compactMap { obs -> OCRLine? in
                guard let top = obs.topCandidates(1).first else { return nil }
                return OCRLine(text: top.string, confidence: Double(top.confidence), box: box(obs.boundingBox))
            }
            return OCRResult(width: img.width, height: img.height, lines: lines)
        }
    }

    nonisolated static func barcodesNow(path: String) throws -> BarcodeResult {
        try autoreleasepool {
            let img = try image(path)
            let req = VNDetectBarcodesRequest()
            try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
            var seen = Set<String>()
            let codes = (req.results ?? []).compactMap { obs -> BarcodeResult.Code? in
                guard let payload = obs.payloadStringValue, !payload.isEmpty, seen.insert("\(obs.symbology.rawValue)|\(payload)").inserted else { return nil }
                return BarcodeResult.Code(payload: payload, symbology: obs.symbology.rawValue, box: box(obs.boundingBox))
            }
            return BarcodeResult(width: img.width, height: img.height, codes: codes)
        }
    }
}

/// `Glide --ocr-worker text <path> [--fast] [--no-correction] [--languages en-US,fr-FR]` or `… codes <path>`:
/// one Vision request, JSON result (or {"error": …}) on stdout, then exit. No NSApplication, no UI.
public enum OCRWorker {
    public static let flag = "--ocr-worker"

    public static func runAndExit(arguments: [String]) -> Never {
        let rest = Array(arguments.drop { $0 != flag }.dropFirst())
        func emit(_ data: Data?, _ code: Int32) -> Never {
            FileHandle.standardOutput.write(data ?? Data(#"{"error":"Could not encode the result"}"#.utf8))
            exit(code)
        }
        func fail(_ message: String) -> Never { emit(try? JSONEncoder().encode(["error": message]), 1) }
        guard rest.count >= 2 else { fail("usage: --ocr-worker text|codes <path>") }
        let path = rest[1]
        do {
            switch rest[0] {
            case "text":
                let langs = rest.firstIndex(of: "--languages").flatMap { rest.dropFirst($0 + 1).first }?.split(separator: ",").map(String.init) ?? []
                let r = try VisionOCRService.recognizeNow(path: path, languages: langs, fast: rest.contains("--fast"), languageCorrection: !rest.contains("--no-correction"))
                emit(try JSONEncoder().encode(r), 0)
            case "codes":
                emit(try JSONEncoder().encode(try VisionOCRService.barcodesNow(path: path)), 0)
            default:
                fail("unknown request \(rest[0])")
            }
        } catch {
            fail((error as? LocalizedError)?.errorDescription ?? "\(error)")
        }
    }
}
