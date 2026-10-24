import Foundation

/// Watches one directory with a vnode DispatchSource and calls `onEvent` on the main actor.
///
/// Built in nonisolated code on purpose: a handler closure written inside @MainActor code would inherit main-actor
/// isolation, and Swift 6's runtime check traps when the source fires on its background queue.
final class PhoneRelayFolderWatcher: @unchecked Sendable {
    private let source: DispatchSourceFileSystemObject
    let url: URL

    private init(url: URL, source: DispatchSourceFileSystemObject) {
        self.url = url
        self.source = source
    }

    /// nil when the directory cannot be opened (it does not exist yet); the safety poll still covers it.
    nonisolated static func make(url: URL, onEvent: @escaping @MainActor (_ gone: Bool) -> Void) -> PhoneRelayFolderWatcher? {
        let fd = open(url.path, O_EVTONLY)
        guard fd >= 0 else { return nil }
        let queue = DispatchQueue(label: "dev.glide.phone-relay.watch", qos: .utility)
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .extend, .attrib, .link, .rename, .delete], queue: queue)
        src.setEventHandler(handler: handler(source: src, onEvent: onEvent))
        src.setCancelHandler { close(fd) }
        src.resume()
        return PhoneRelayFolderWatcher(url: url, source: src)
    }

    nonisolated private static func handler(source: DispatchSourceFileSystemObject, onEvent: @escaping @MainActor (Bool) -> Void) -> @Sendable () -> Void {
        return { [weak source] in
            let mask = source?.data ?? []
            let gone = mask.contains(.delete) || mask.contains(.rename)
            DispatchQueue.main.async { MainActor.assumeIsolated { onEvent(gone) } }
        }
    }

    func cancel() { source.cancel() }
}

/// File-system helpers run off the main actor (directory listing and reads of files up to 25 MB).
enum PhoneRelayIO {
    struct Entry: Sendable {
        var name: String
        var url: URL
        var size: Int
        var modified: Date
    }

    nonisolated static func list(_ dir: URL) -> [Entry] {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
        guard let urls = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys, options: []) else { return [] }
        return urls.compactMap { u in
            let v = try? u.resourceValues(forKeys: Set(keys))
            guard v?.isRegularFile ?? true else { return nil }
            return Entry(name: u.lastPathComponent, url: u, size: v?.fileSize ?? 0, modified: v?.contentModificationDate ?? .distantPast)
        }.sorted { $0.modified < $1.modified }
    }

    nonisolated static func read(_ url: URL, max: Int) -> Data? {
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        return try? h.read(upToCount: max + 1)
    }

    /// Write `data` to `url` atomically: a hidden temp file in the same folder, then rename(2) over the target, so
    /// iCloud and the phone never see half a file.
    @discardableResult
    nonisolated static func writeAtomic(_ data: Data, to url: URL) -> Bool {
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString.prefix(8)).tmp")
        do {
            try data.write(to: tmp)
            if rename(tmp.path, url.path) != 0 {
                try? FileManager.default.removeItem(at: tmp)
                return false
            }
            return true
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            return false
        }
    }

    nonisolated static func remove(_ url: URL) { try? FileManager.default.removeItem(at: url) }
}
