import CryptoKit
import Foundation
import GlideCore
import ImageIO
import UniformTypeIdentifiers

/// Files under <userData>/features/clipboard/ — the same layout and formats as the Electron app:
/// history.json `{version:1, entries:[…]}`, stack.json (PasteStack), images/<sha1>.png + <sha1>.thumb.png.
/// Everything is written atomically with mode 0600 (the history can contain anything the user copied).
public struct ClipStorage: Sendable {
    public let directory: URL
    public init(directory: URL) { self.directory = directory }

    public var historyURL: URL { directory.appendingPathComponent("history.json") }
    public var stackURL: URL { directory.appendingPathComponent("stack.json") }
    public var imagesURL: URL { directory.appendingPathComponent("images", isDirectory: true) }
    public func imageURL(_ sha1: String) -> URL { imagesURL.appendingPathComponent("\(sha1).png") }
    public func thumbURL(_ sha1: String) -> URL { imagesURL.appendingPathComponent("\(sha1).thumb.png") }

    /// Entries newest first; unreadable files or entries are skipped (never throws).
    public func loadHistory() -> [ClipEntry] {
        guard let data = try? Data(contentsOf: historyURL), let root = try? JSONDecoder().decode(JSONValue.self, from: data),
              let list = root["entries"]?.arrayValue else { return [] }
        let entries = list.compactMap { v -> ClipEntry? in
            guard let d = try? JSONEncoder().encode(v) else { return nil }
            return try? JSONDecoder().decode(ClipEntry.self, from: d)
        }
        return ClipModel.sorted(entries)
    }

    public static func encodeHistory(_ entries: [ClipEntry]) throws -> Data {
        struct Shape: Encodable { let version = 1; let entries: [ClipEntry] }
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return try e.encode(Shape(entries: entries))
    }

    public func saveHistory(_ entries: [ClipEntry]) throws { try writeAtomic(Self.encodeHistory(entries), to: historyURL) }

    public func loadStack() -> PasteStack? {
        guard let data = try? Data(contentsOf: stackURL), let v = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
        return PasteStack(json: v)
    }

    public func saveStack(_ s: PasteStack) throws { try writeAtomic(JSONEncoder().encode(s), to: stackURL) }

    public func writeAtomic(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(getpid()).tmp")
        guard FileManager.default.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw FeatureError.failed("Could not write \(tmp.path)")
        }
        guard rename(tmp.path, url.path) == 0 else {
            try? FileManager.default.removeItem(at: tmp)
            throw FeatureError.failed("Could not save \(url.lastPathComponent) (errno \(errno))")
        }
    }

    // MARK: images

    public static func sha1Hex(_ data: Data) -> String { Insecure.SHA1.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    public static func textKey(_ text: String) -> String { "t:" + sha1Hex(Data(text.utf8)) }

    /// Store the PNG and a ≤256 px thumbnail; nil when the bytes are not an image.
    public func saveImage(png: Data, sha1 hash: String? = nil) -> ClipImage? {
        guard let src = CGImageSourceCreateWithData(png as CFData, nil), let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int else { return nil }
        let sha = hash ?? Self.sha1Hex(png)
        try? FileManager.default.createDirectory(at: imagesURL, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: imageURL(sha).path) {
            FileManager.default.createFile(atPath: imageURL(sha).path, contents: png, attributes: [.posixPermissions: 0o600])
        }
        if !FileManager.default.fileExists(atPath: thumbURL(sha).path) { writeThumb(src, to: thumbURL(sha)) }
        return ClipImage(sha1: sha, width: w, height: h, bytes: png.count)
    }

    /// Entries from before thumbnails existed get one on first view.
    public func ensureThumb(_ sha: String) -> URL? {
        let t = thumbURL(sha)
        if FileManager.default.fileExists(atPath: t.path) { return t }
        guard let src = CGImageSourceCreateWithURL(imageURL(sha) as CFURL, nil) else { return nil }
        writeThumb(src, to: t)
        return FileManager.default.fileExists(atPath: t.path) ? t : imageURL(sha)
    }

    private func writeThumb(_ src: CGImageSource, to url: URL) {
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 256, kCGImageSourceCreateThumbnailWithTransform: true]
        guard let thumb = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary),
              let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(dest, thumb, nil)
        CGImageDestinationFinalize(dest)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    public func deleteImage(_ sha: String) {
        try? FileManager.default.removeItem(at: imageURL(sha))
        try? FileManager.default.removeItem(at: thumbURL(sha))
    }
}
