import Compression
import Foundation

/// Strict tar(.gz) reader/writer for store packages — port of src/main/features/extensions/store-tar.ts.
/// Only regular files and directories are accepted; links, devices, absolute paths and ".." traversal are
/// rejected before anything is written. gzip is decoded with the Compression framework (raw DEFLATE) with a
/// hard output cap (gzip-bomb safe) and CRC-32 / ISIZE verification.
struct TarError: Error, LocalizedError, Equatable {
    var message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

struct TarFile: Equatable {
    var path: String
    var isDirectory: Bool
    var mode: Int
    var data: Data
}

struct TarLimits {
    var maxEntries = 5000
    var maxTotalBytes = 100 * 1024 * 1024
    var maxFileBytes = 50 * 1024 * 1024
    static let standard = TarLimits()
}

enum Tar {
    static let block = 512

    private static func cstr(_ b: [UInt8], _ start: Int, _ len: Int) -> String {
        let slice = b[start..<min(b.count, start + len)]
        let end = slice.firstIndex(of: 0) ?? slice.endIndex
        return String(decoding: slice[slice.startIndex..<end], as: UTF8.self)
    }

    private static func octal(_ b: [UInt8], _ start: Int, _ len: Int, _ what: String) throws -> Int {
        if b[start] & 0x80 != 0 { throw TarError("Unsupported base-256 \(what) field") }
        let s = cstr(b, start, len).trimmingCharacters(in: CharacterSet(charactersIn: " \0"))
        if s.isEmpty { return 0 }
        guard s.allSatisfy({ ("0"..."7").contains($0) }), let v = Int(s, radix: 8) else { throw TarError("Corrupt \(what) field") }
        return v
    }

    private static func checksumOK(_ h: [UInt8]) throws -> Bool {
        let stored = try octal(h, 148, 8, "checksum")
        var sum = 0
        for i in 0..<block { sum += (i >= 148 && i < 156) ? 32 : Int(h[i]) }
        return sum == stored
    }

    private static func parsePax(_ d: [UInt8]) throws -> [String: String] {
        var out: [String: String] = [:]
        var off = 0
        while off < d.count {
            guard let sp = d[off...].firstIndex(of: 0x20) else { break }
            guard let len = Int(String(decoding: d[off..<sp], as: UTF8.self)), len > 0, off + len <= d.count, sp + 1 <= off + len - 1 else { throw TarError("Corrupt pax header") }
            let rec = String(decoding: d[(sp + 1)..<(off + len - 1)], as: UTF8.self)
            if let eq = rec.firstIndex(of: "="), eq != rec.startIndex { out[String(rec[..<eq])] = String(rec[rec.index(after: eq)...]) }
            off += len
        }
        return out
    }

    /// Normalise an archive path; throws for anything that could escape the destination.
    static func safeEntryPath(_ raw: String) throws -> String {
        if raw.contains("\0") { throw TarError("Illegal NUL in path") }
        if raw.contains("\\") { throw TarError("Backslashes are not allowed in paths: \(raw)") }
        if raw.hasPrefix("/") || raw.range(of: "^[A-Za-z]:", options: .regularExpression) != nil { throw TarError("Absolute path in archive: \(raw)") }
        let parts = raw.split(separator: "/", omittingEmptySubsequences: true).filter { $0 != "." }
        if parts.contains("..") { throw TarError("Path traversal in archive: \(raw)") }
        if parts.isEmpty { throw TarError("Empty path in archive") }
        let out = parts.joined(separator: "/")
        if out.utf8.count > 1024 || parts.count > 32 { throw TarError("Path too long: \(raw.prefix(80))…") }
        return out
    }

    /// Parse an uncompressed tar archive into its entries (validated, nothing written).
    static func read(_ data: Data, limits: TarLimits = .standard) throws -> [TarFile] {
        let buf = [UInt8](data)
        var out: [TarFile] = []
        var seen: [String: Bool] = [:] // path → isDirectory
        var off = 0
        var total = 0
        var pax: [String: String] = [:]
        var longName: String?
        while off + block <= buf.count {
            let h = Array(buf[off..<(off + block)])
            if h.allSatisfy({ $0 == 0 }) { break }
            guard try checksumOK(h) else { throw TarError("Corrupt tar header (bad checksum)") }
            let typeByte = h[156]
            let type = typeByte == 0 ? "0" : String(UnicodeScalar(typeByte))
            var size = try octal(h, 124, 12, "size")
            if let ps = pax["size"] { guard let n = Int(ps) else { throw TarError("Corrupt entry size") }; size = n }
            guard size >= 0 else { throw TarError("Corrupt entry size") }
            let dataStart = off + block
            let dataEnd = dataStart + size
            if dataEnd > buf.count { throw TarError("Truncated tar archive") }
            let body = Array(buf[dataStart..<dataEnd])
            off = dataStart + ((size + block - 1) / block) * block

            if type == "x" {
                if size > 64 * 1024 { throw TarError("pax header too large") }
                pax = try parsePax(body)
                continue
            }
            if type == "g" { continue }
            if type == "L" {
                if size > 4096 { throw TarError("GNU long name too large") }
                longName = cstr(body, 0, body.count)
                continue
            }
            let magic = cstr(h, 257, 6)
            let prefix = magic.hasPrefix("ustar") ? cstr(h, 345, 155) : ""
            let rawName = pax["path"] ?? longName ?? (prefix.isEmpty ? cstr(h, 0, 100) : "\(prefix)/\(cstr(h, 0, 100))")
            pax = [:]
            longName = nil

            let isDir: Bool
            switch type {
            case "0": isDir = false
            case "5": isDir = true
            default:
                let what: String
                switch type {
                case "1": what = "hard link"
                case "2": what = "symbolic link"
                case "3", "4": what = "device"
                case "6": what = "FIFO"
                default: what = "entry type \"\(type)\""
                }
                throw TarError("Archive contains a \(what) (\(rawName)); only files and folders are allowed")
            }
            let p = try safeEntryPath(rawName)
            if !isDir {
                if size > limits.maxFileBytes { throw TarError("\(p) is too large") }
                total += size
                if total > limits.maxTotalBytes { throw TarError("Archive is too large when extracted") }
            }
            let prev = seen[p]
            if let prev, !(prev && isDir) { throw TarError("Duplicate path in archive: \(p)") }
            let segs = p.split(separator: "/")
            for i in 1..<max(1, segs.count) where seen[segs.prefix(i).joined(separator: "/")] == false { throw TarError("\(p) is inside a file") }
            seen[p] = isDir
            if prev == nil { out.append(TarFile(path: p, isDirectory: isDir, mode: try octal(h, 100, 8, "mode"), data: isDir ? Data() : Data(body))) }
            if out.count > limits.maxEntries { throw TarError("Archive has too many entries") }
        }
        for f in out where !f.isDirectory {
            let s = f.path.split(separator: "/")
            for i in 1..<max(1, s.count) where seen[s.prefix(i).joined(separator: "/")] == false { throw TarError("\(f.path) is inside a file") }
        }
        return out
    }

    /// Strip a single common top-level folder (npm's "package/") when there is no package.json at the root.
    static func stripCommonRoot(_ files: [TarFile]) -> [TarFile] {
        if files.contains(where: { $0.path == "package.json" }) { return files }
        guard let first = files.first?.path.split(separator: "/").first.map(String.init),
              files.allSatisfy({ $0.path == first || $0.path.hasPrefix(first + "/") }) else { return files }
        return files.filter { $0.path != first }.map { var f = $0; f.path = String(f.path.dropFirst(first.count + 1)); return f }
    }

    /// Extract validated entries into `dest`, which must not exist yet. Files are created exclusively (O_EXCL).
    static func write(_ files: [TarFile], to dest: URL) throws {
        let fm = FileManager.default
        let root = dest.standardizedFileURL
        if fm.fileExists(atPath: root.path) { throw TarError("Destination already exists: \(root.path)") }
        try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        for f in files {
            let target = f.path.split(separator: "/").reduce(root) { $0.appendingPathComponent(String($1)) }.standardizedFileURL
            guard target.path == root.path || target.path.hasPrefix(root.path + "/") else { throw TarError("Path escapes destination: \(f.path)") }
            if f.isDirectory {
                try fm.createDirectory(at: target, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
                continue
            }
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
            let mode: mode_t = f.mode & 0o111 != 0 ? 0o755 : 0o644
            let fd = open(target.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode)
            if fd < 0 { throw TarError("Cannot create \(f.path): \(String(cString: strerror(errno)))") }
            defer { close(fd) }
            try f.data.withUnsafeBytes { raw in
                var done = 0
                while done < raw.count {
                    let n = Darwin.write(fd, raw.baseAddress!.advanced(by: done), raw.count - done)
                    if n <= 0 { throw TarError("Write failed for \(f.path)") }
                    done += n
                }
            }
            fchmod(fd, mode)
        }
    }

    /// gunzip + validate + extract a store package into `dest` (created). Returns the extracted paths.
    @discardableResult
    static func extractTgz(_ gz: Data, to dest: URL, limits: TarLimits = .standard) throws -> [String] {
        let files = stripCommonRoot(try read(try Gzip.decompress(gz, maxBytes: limits.maxTotalBytes + 2 * 1024 * 1024), limits: limits))
        if files.isEmpty { throw TarError("Archive is empty") }
        try write(files, to: dest)
        return files.map(\.path)
    }

    // MARK: writer (tests and packing)

    struct Input {
        var path: String
        var data: Data?
        var mode: Int = 0o644
        /// "symlink" | "hardlink" (hostile fixtures)
        var link: (type: String, target: String)?
        init(path: String, data: Data? = nil, mode: Int = 0o644, link: (type: String, target: String)? = nil) {
            self.path = path
            self.data = data
            self.mode = mode
            self.link = link
        }
    }

    private static func header(_ name: String, size: Int, type: UInt8, mode: Int, linkname: String = "") -> [UInt8] {
        var h = [UInt8](repeating: 0, count: block)
        func put(_ s: String, _ at: Int, _ len: Int) { for (i, c) in Array(s.utf8).prefix(len).enumerated() { h[at + i] = c } }
        var base = name
        var prefix = ""
        if name.utf8.count > 100, let cut = name.dropLast().lastIndex(of: "/") {
            prefix = String(name[..<cut])
            base = String(name[name.index(after: cut)...])
        }
        put(base, 0, 100)
        put(String(mode, radix: 8).leftPad(7) + "\0", 100, 8)
        put("0000000\0", 108, 8)
        put("0000000\0", 116, 8)
        put(String(size, radix: 8).leftPad(11) + "\0", 124, 12)
        put("00000000000\0", 136, 12)
        put("        ", 148, 8)
        h[156] = type
        put(linkname, 157, 100)
        put("ustar\0", 257, 6)
        put("00", 263, 2)
        put(prefix, 345, 155)
        let sum = h.reduce(0) { $0 + Int($1) }
        put(String(sum, radix: 8).leftPad(6) + "\0 ", 148, 8)
        return h
    }

    static func create(_ entries: [Input]) -> Data {
        var out = [UInt8]()
        for e in entries {
            if let l = e.link {
                out += header(e.path, size: 0, type: l.type == "symlink" ? UInt8(ascii: "2") : UInt8(ascii: "1"), mode: 0o777, linkname: l.target)
                continue
            }
            guard let d = e.data else {
                out += header(e.path.hasSuffix("/") ? e.path : e.path + "/", size: 0, type: UInt8(ascii: "5"), mode: 0o755)
                continue
            }
            out += header(e.path, size: d.count, type: UInt8(ascii: "0"), mode: e.mode)
            out += [UInt8](d)
            let pad = (block - d.count % block) % block
            out += [UInt8](repeating: 0, count: pad)
        }
        out += [UInt8](repeating: 0, count: block * 2)
        return Data(out)
    }

    static func createTgz(_ entries: [Input]) -> Data { Gzip.compress(create(entries)) }
}

private extension String {
    func leftPad(_ n: Int) -> String { count >= n ? self : String(repeating: "0", count: n - count) + self }
}

/// gzip (RFC 1952) on top of the Compression framework's raw DEFLATE.
enum Gzip {
    static func crc32(_ data: Data) -> UInt32 {
        var table = [UInt32](repeating: 0, count: 256)
        for i in 0..<256 {
            var c = UInt32(i)
            for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
            table[i] = c
        }
        var crc: UInt32 = 0xFFFF_FFFF
        for b in data { crc = table[Int((crc ^ UInt32(b)) & 0xFF)] ^ (crc >> 8) }
        return crc ^ 0xFFFF_FFFF
    }

    static func decompress(_ gz: Data, maxBytes: Int) throws -> Data {
        let b = [UInt8](gz)
        guard b.count >= 18, b[0] == 0x1F, b[1] == 0x8B, b[2] == 8 else { throw TarError("Not a valid .tgz: incorrect header check") }
        let flg = b[3]
        var p = 10
        if flg & 4 != 0 {
            guard p + 2 <= b.count else { throw TarError("Not a valid .tgz: truncated header") }
            p += 2 + Int(b[p]) | Int(b[p + 1]) << 8
        }
        if flg & 8 != 0 { while p < b.count && b[p] != 0 { p += 1 }; p += 1 }
        if flg & 16 != 0 { while p < b.count && b[p] != 0 { p += 1 }; p += 1 }
        if flg & 2 != 0 { p += 2 }
        guard p < b.count - 8 else { throw TarError("Not a valid .tgz: truncated") }
        let deflated = Data(b[p..<(b.count - 8)])
        let out = try inflate(deflated, maxBytes: maxBytes)
        let t = b.count - 8
        let crc = UInt32(b[t]) | UInt32(b[t + 1]) << 8 | UInt32(b[t + 2]) << 16 | UInt32(b[t + 3]) << 24
        let isize = UInt32(b[t + 4]) | UInt32(b[t + 5]) << 8 | UInt32(b[t + 6]) << 16 | UInt32(b[t + 7]) << 24
        guard crc32(out) == crc, UInt32(truncatingIfNeeded: out.count) == isize else { throw TarError("Not a valid .tgz: checksum mismatch") }
        return out
    }

    private static func run(_ op: compression_stream_operation, _ input: Data, maxBytes: Int) throws -> Data {
        let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { stream.deallocate() }
        guard compression_stream_init(stream, op, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else { throw TarError("Not a valid .tgz: cannot init zlib") }
        defer { compression_stream_destroy(stream) }
        let chunk = 64 * 1024
        let dst = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
        defer { dst.deallocate() }
        var out = Data()
        try input.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
            stream.pointee.src_ptr = src.bindMemory(to: UInt8.self).baseAddress ?? UnsafePointer(dst)
            stream.pointee.src_size = input.count
            while true {
                stream.pointee.dst_ptr = dst
                stream.pointee.dst_size = chunk
                let status = compression_stream_process(stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                let produced = chunk - stream.pointee.dst_size
                if produced > 0 {
                    out.append(dst, count: produced)
                    if out.count > maxBytes { throw TarError("Archive is too large when decompressed") }
                }
                if status == COMPRESSION_STATUS_END { break }
                if status == COMPRESSION_STATUS_ERROR { throw TarError("Not a valid .tgz: invalid deflate data") }
                if produced == 0 && stream.pointee.src_size == 0 { throw TarError("Not a valid .tgz: unexpected end of file") }
            }
        }
        return out
    }

    static func inflate(_ d: Data, maxBytes: Int) throws -> Data { try run(COMPRESSION_STREAM_DECODE, d, maxBytes: maxBytes) }

    static func compress(_ d: Data) -> Data {
        var out = Data([0x1F, 0x8B, 8, 0, 0, 0, 0, 0, 0, 3])
        out.append((try? run(COMPRESSION_STREAM_ENCODE, d, maxBytes: .max)) ?? Data())
        let crc = crc32(d)
        let size = UInt32(truncatingIfNeeded: d.count)
        for v in [crc, size] { for i in 0..<4 { out.append(UInt8((v >> (8 * UInt32(i))) & 0xFF)) } }
        return out
    }
}
