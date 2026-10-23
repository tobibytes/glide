import Foundation
import GlideCore
import ImageIO
import Vision

/// Vision text recognition and barcode detection (helper OCR.swift). Boxes normalised, origin top-left.
@MainActor public final class VisionOCRService: OCRService {
    public init() {}

    nonisolated static func image(_ path: String) throws -> CGImage {
        guard FileManager.default.fileExists(atPath: path) else { throw FeatureError.failed("Image not found: \(path)") }
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw FeatureError.failed("Could not read the image")
        }
        return img
    }
    nonisolated static func box(_ r: CGRect) -> Rect { Rect(x: Double(r.minX), y: Double(1 - r.maxY), width: Double(r.width), height: Double(r.height)) }

    public func recognize(path: String, languages: [String], fast: Bool, languageCorrection: Bool) async throws -> OCRResult {
        try await offMainThrowing {
            let img = try Self.image(path)
            let req = VNRecognizeTextRequest()
            req.recognitionLevel = fast ? .fast : .accurate
            req.usesLanguageCorrection = languageCorrection
            if languages.isEmpty { req.automaticallyDetectsLanguage = true } else { req.recognitionLanguages = languages }
            try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
            let lines = (req.results ?? []).compactMap { obs -> OCRLine? in
                guard let top = obs.topCandidates(1).first else { return nil }
                return OCRLine(text: top.string, confidence: Double(top.confidence), box: Self.box(obs.boundingBox))
            }
            return OCRResult(width: img.width, height: img.height, lines: lines)
        }
    }

    public func barcodes(path: String) async throws -> BarcodeResult {
        try await offMainThrowing {
            let img = try Self.image(path)
            let req = VNDetectBarcodesRequest()
            try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
            var seen = Set<String>()
            let codes = (req.results ?? []).compactMap { obs -> BarcodeResult.Code? in
                guard let payload = obs.payloadStringValue, !payload.isEmpty, seen.insert("\(obs.symbology.rawValue)|\(payload)").inserted else { return nil }
                return BarcodeResult.Code(payload: payload, symbology: obs.symbology.rawValue, box: Self.box(obs.boundingBox))
            }
            return BarcodeResult(width: img.width, height: img.height, codes: codes)
        }
    }
}
