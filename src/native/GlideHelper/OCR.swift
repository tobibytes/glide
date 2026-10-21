import Foundation
import ImageIO
import Vision

/// Apple Vision text recognition and barcode detection on an image file.
/// Boxes are normalised (0…1) with the origin at the top-left of the image.
enum OCR {
    private static func image(_ path: String) throws -> CGImage {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else { throw HelperError("Image not found: \(path)") }
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw HelperError("Could not read the image")
        }
        return img
    }

    private static func box(_ r: CGRect) -> [String: Any] {
        ["x": Double(r.minX), "y": Double(1 - r.maxY), "width": Double(r.width), "height": Double(r.height)]
    }

    static func recognize(path: String, languages: [String], fast: Bool, correction: Bool) throws -> [String: Any] {
        let img = try image(path)
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = fast ? .fast : .accurate
        req.usesLanguageCorrection = correction
        if languages.isEmpty {
            req.automaticallyDetectsLanguage = true
        } else {
            req.recognitionLanguages = languages
        }
        try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
        let lines: [[String: Any]] = (req.results ?? []).compactMap { obs in
            guard let top = obs.topCandidates(1).first else { return nil }
            return ["text": top.string, "confidence": Double(top.confidence), "box": box(obs.boundingBox)]
        }
        return ["width": img.width, "height": img.height, "lines": lines]
    }

    static func barcodes(path: String) throws -> [String: Any] {
        let img = try image(path)
        let req = VNDetectBarcodesRequest()
        try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
        var seen = Set<String>()
        let codes: [[String: Any]] = (req.results ?? []).compactMap { obs in
            guard let payload = obs.payloadStringValue, !payload.isEmpty else { return nil }
            let key = "\(obs.symbology.rawValue)|\(payload)"
            if seen.contains(key) { return nil }
            seen.insert(key)
            return ["payload": payload, "symbology": obs.symbology.rawValue, "box": box(obs.boundingBox)]
        }
        return ["width": img.width, "height": img.height, "codes": codes]
    }
}
