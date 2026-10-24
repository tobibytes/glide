import Foundation

/// Writes the generated shortcuts to a folder and, only when the user clicks "Add Shortcuts to iPhone", signs them
/// with `/usr/bin/shortcuts sign --mode anyone` (an unsigned .shortcut cannot be imported on iOS 15 and later).
/// Never signs in tests or headless runs.
enum PhoneShortcutsExport {
    struct Result: Sendable {
        var folder: URL
        var files: [URL]
        var signed: Bool
        var failures: [String]
    }

    /// Unsigned files (binary plists) into `folder`.
    nonisolated static func writeUnsigned(_ shortcuts: [GeneratedShortcut], to folder: URL) throws -> [URL] {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var out: [URL] = []
        for s in shortcuts {
            let url = folder.appendingPathComponent(s.fileName)
            try s.data().write(to: url, options: .atomic)
            out.append(url)
        }
        return out
    }

    static let shortcutsTool = "/usr/bin/shortcuts"

    /// Signs every file in `unsigned` into `folder` (same names). Runs the tool off the main actor, 60 s per file.
    nonisolated static func sign(_ unsigned: [URL], into folder: URL) async -> (files: [URL], failures: [String]) {
        var files: [URL] = []
        var failures: [String] = []
        for u in unsigned {
            let out = folder.appendingPathComponent(u.lastPathComponent)
            let ok = await run(shortcutsTool, ["sign", "--mode", "anyone", "--input", u.path, "--output", out.path], timeout: 60)
            if ok, FileManager.default.fileExists(atPath: out.path) { files.append(out) } else { failures.append(u.deletingPathExtension().lastPathComponent) }
        }
        return (files, failures)
    }

    nonisolated private static func run(_ tool: String, _ args: [String], timeout: TimeInterval) async -> Bool {
        await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: tool)
                p.arguments = args
                p.standardOutput = FileHandle.nullDevice
                p.standardError = FileHandle.nullDevice
                do { try p.run() } catch { c.resume(returning: false); return }
                let deadline = Date().addingTimeInterval(timeout)
                while p.isRunning && Date() < deadline { usleep(100_000) }
                if p.isRunning { p.terminate(); c.resume(returning: false); return }
                c.resume(returning: p.terminationStatus == 0)
            }
        }
    }

    /// The user-facing export: sign into ~/Downloads/Glide Shortcuts (unsigned copies go to a temp folder first).
    nonisolated static func exportSigned(to folder: URL) async -> Result {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("glide-shortcuts-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        do {
            let unsigned = try writeUnsigned(PhoneShortcuts.all(), to: tmp)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let (files, failures) = await sign(unsigned, into: folder)
            return Result(folder: folder, files: files, signed: true, failures: failures)
        } catch {
            return Result(folder: folder, files: [], signed: false, failures: PhoneShortcuts.all().map(\.name))
        }
    }
}
