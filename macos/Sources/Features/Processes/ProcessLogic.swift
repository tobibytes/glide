import Darwin
import Foundation

/// One process (port of src/main/features/processes/parse.ts ProcessInfo), read natively via libproc.
public struct ProcInfo: Hashable, Sendable {
    public var pid: Int32
    public var ppid: Int32
    /// %CPU over the last sampling interval (can exceed 100 on multi-core).
    public var cpu: Double
    public var rssKb: Int
    public var user: String
    /// Full executable path (or name when the path is unreadable).
    public var command: String
    /// The .app bundle name when it is the bundle's main executable, else the executable's basename.
    public var name: String
    public var appPath: String?
}

public struct PortListener: Hashable, Sendable {
    public var command: String
    public var pid: Int32
    public var user: String
    /// "*:3000", "127.0.0.1:3000", "[::1]:3000"
    public var address: String
    public var port: Int
    public var proto: String
}

/// Pure helpers and the kill policy.
public enum ProcessPolicy {
    public static func appBundle(of command: String) -> String? {
        guard let r = command.range(of: ".app") else { return nil }
        let end = r.upperBound
        if end == command.endIndex || command[end] == "/" { return String(command[..<end]) }
        return nil
    }

    public static func processName(_ command: String) -> String {
        let exe = command.split(separator: "/").last.map(String.init) ?? command
        if let app = appBundle(of: command), command == "\(app)/Contents/MacOS/\(exe)" {
            return ((app as NSString).lastPathComponent as NSString).deletingPathExtension
        }
        return exe
    }

    public static func sortByCpu(_ list: [ProcInfo]) -> [ProcInfo] {
        list.sorted { a, b in a.cpu != b.cpu ? a.cpu > b.cpu : (a.rssKb != b.rssKb ? a.rssKb > b.rssKb : a.pid < b.pid) }
    }

    /// "port 3000", "kill port 3000", ":3000", "port:3000".
    public static func parsePortQuery(_ q: String) -> Int? {
        guard let m = q.range(of: #"^\s*(?:kill\s+)?(?:port\s*:?\s*|:)(\d{1,5})\s*$"#, options: [.regularExpression, .caseInsensitive]) else { return nil }
        let digits = q[m].filter(\.isNumber)
        guard let n = Int(digits), (1...65535).contains(n) else { return nil }
        return n
    }

    static let critical: Set<String> = ["kernel_task", "launchd", "WindowServer", "loginwindow", "Finder", "Dock", "SystemUIServer", "coreaudiod", "mds", "opendirectoryd", "securityd"]

    public enum Risk: Equatable, Sendable { case ok, warn(String) }

    /// Killing these logs you out, freezes the UI or kills Glide; they need an explicit confirmation.
    public static func killRisk(pid: Int32, name: String, command: String, selfPids: [Int32]) -> Risk {
        if pid <= 1 { return .warn(pid == 0 ? "kernel_task is the kernel; it cannot be killed." : "launchd (PID 1) is the root of every process. Killing it restarts your Mac.") }
        if selfPids.contains(pid) { return .warn("This is Glide itself. Glide will quit.") }
        let base = command.split(separator: "/").last.map(String.init) ?? name
        if critical.contains(base) || critical.contains(name) {
            if base == "WindowServer" || base == "loginwindow" { return .warn("\(base) runs your login session. Killing it logs you out and closes every app without saving.") }
            return .warn("\(base) is a core macOS process; killing it may freeze or restart parts of the system.")
        }
        return .ok
    }

    /// Never send signals to these, even with confirmation.
    public static func unkillable(_ pid: Int32) -> Bool { pid <= 1 }

    public static func formatKb(_ kb: Int) -> String {
        if kb >= 1024 * 1024 { return String(format: "%.1f GB", Double(kb) / 1024 / 1024) }
        if kb >= 1024 { return kb >= 100 * 1024 ? "\(kb / 1024) MB" : String(format: "%.1f MB", Double(kb) / 1024) }
        return "\(kb) KB"
    }

    /// CPU % from two cumulative CPU-time readings (ns) over `wallNs`.
    public static func cpuPercent(prevNs: UInt64?, nowNs: UInt64, wallNs: UInt64) -> Double {
        guard let p = prevNs, nowNs >= p, wallNs > 0 else { return 0 }
        return Double(nowNs - p) / Double(wallNs) * 100
    }
}

/// libproc reads (no `ps`, no `lsof`). Only processes the user may inspect report details (like `ps` without root).
public enum LibProc {
    public struct Raw: Sendable {
        public var pid: Int32
        public var ppid: Int32
        public var uid: uid_t
        public var command: String
        public var cpuNs: UInt64
        public var rssBytes: UInt64
    }

    static let timebase: (numer: UInt32, denom: UInt32) = {
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        return (tb.numer == 0 ? 1 : tb.numer, tb.denom == 0 ? 1 : tb.denom)
    }()

    public static func pids() -> [Int32] {
        let n = proc_listallpids(nil, 0)
        guard n > 0 else { return [] }
        var buf = [Int32](repeating: 0, count: Int(n) + 64)
        let got = buf.withUnsafeMutableBufferPointer { proc_listallpids($0.baseAddress, Int32($0.count * MemoryLayout<Int32>.size)) }
        return got > 0 ? Array(buf.prefix(Int(got))).filter { $0 >= 0 } : []
    }

    public static func path(_ pid: Int32) -> String? {
        var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let n = proc_pidpath(pid, &buf, UInt32(buf.count))
        guard n > 0 else { return nil }
        return String(decoding: buf.prefix(Int(n)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    public static func name(_ pid: Int32) -> String? {
        var buf = [CChar](repeating: 0, count: 256)
        let n = proc_name(pid, &buf, UInt32(buf.count))
        guard n > 0 else { return nil }
        return String(decoding: buf.prefix(Int(n)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    public static func read(_ pid: Int32) -> Raw? {
        var info = proc_taskallinfo()
        let size = Int32(MemoryLayout<proc_taskallinfo>.size)
        let r = proc_pidinfo(pid, PROC_PIDTASKALLINFO, 0, &info, size)
        let command = path(pid) ?? name(pid) ?? (pid == 0 ? "kernel_task" : "")
        if r == size {
            let ticks = info.ptinfo.pti_total_user &+ info.ptinfo.pti_total_system
            let ns = ticks &* UInt64(timebase.numer) / UInt64(timebase.denom)
            return Raw(pid: pid, ppid: Int32(info.pbsd.pbi_ppid), uid: info.pbsd.pbi_uid, command: command.isEmpty ? withUnsafeBytes(of: info.pbsd.pbi_comm) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) } : command,
                       cpuNs: ns, rssBytes: info.ptinfo.pti_resident_size)
        }
        var bsd = proc_bsdshortinfo()
        let bs = Int32(MemoryLayout<proc_bsdshortinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, &bsd, bs) == bs else { return command.isEmpty ? nil : Raw(pid: pid, ppid: 0, uid: 0, command: command, cpuNs: 0, rssBytes: 0) }
        return Raw(pid: pid, ppid: Int32(bsd.pbsi_ppid), uid: bsd.pbsi_uid, command: command.isEmpty ? withUnsafeBytes(of: bsd.pbsi_comm) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) } : command,
                   cpuNs: 0, rssBytes: 0)
    }

    nonisolated(unsafe) static var userCache: [uid_t: String] = [:]
    static let userLock = NSLock()
    public static func userName(_ uid: uid_t) -> String {
        userLock.lock()
        defer { userLock.unlock() }
        if let u = userCache[uid] { return u }
        let n = getpwuid(uid).flatMap { $0.pointee.pw_name.map { String(cString: $0) } } ?? String(uid)
        userCache[uid] = n
        return n
    }

    /// TCP sockets in LISTEN state for `pid`.
    public static func listeners(_ pid: Int32) -> [(address: String, port: Int, proto: String)] {
        let bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
        guard bytes > 0 else { return [] }
        let count = Int(bytes) / MemoryLayout<proc_fdinfo>.stride
        var fds = [proc_fdinfo](repeating: proc_fdinfo(), count: count + 16)
        let got = fds.withUnsafeMutableBytes { proc_pidinfo(pid, PROC_PIDLISTFDS, 0, $0.baseAddress, Int32($0.count)) }
        guard got > 0 else { return [] }
        var out: [(String, Int, String)] = []
        for fd in fds.prefix(Int(got) / MemoryLayout<proc_fdinfo>.stride) where fd.proc_fdtype == UInt32(PROX_FDTYPE_SOCKET) {
            var si = socket_fdinfo()
            let sz = Int32(MemoryLayout<socket_fdinfo>.size)
            guard proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDSOCKETINFO, &si, sz) == sz else { continue }
            guard si.psi.soi_kind == Int32(SOCKINFO_TCP) else { continue }
            let tcp = si.psi.soi_proto.pri_tcp
            guard tcp.tcpsi_state == TSI_S_LISTEN else { continue }
            let ini = tcp.tcpsi_ini
            let port = Int(UInt16(bigEndian: UInt16(truncatingIfNeeded: ini.insi_lport)))
            let v6 = ini.insi_vflag & UInt8(INI_IPV6) != 0 && ini.insi_vflag & UInt8(INI_IPV4) == 0
            var host = "*"
            if v6 {
                var a = ini.insi_laddr.ina_6
                var buf = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
                if inet_ntop(AF_INET6, &a, &buf, socklen_t(buf.count)) != nil {
                    let s = String(decoding: buf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
                    host = s == "::" ? "*" : "[\(s)]"
                }
            } else {
                var a = ini.insi_laddr.ina_46.i46a_addr4
                var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                if inet_ntop(AF_INET, &a, &buf, socklen_t(buf.count)) != nil {
                    let s = String(decoding: buf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
                    host = s == "0.0.0.0" ? "*" : s
                }
            }
            out.append(("\(host):\(port)", port, v6 ? "IPv6" : "IPv4"))
        }
        return out
    }
}

/// Keeps the previous CPU-time reading per pid so %CPU is a real rate between samples.
public final class ProcessSampler: @unchecked Sendable {
    private let lock = NSLock()
    private var prev: [Int32: UInt64] = [:]
    private var prevAt: UInt64 = 0
    public init() {}

    /// Reads every process; the first call primes the counters (wait ~250 ms and call again for real %CPU).
    public func sample() -> [ProcInfo] {
        let now = DispatchTime.now().uptimeNanoseconds
        let raws = LibProc.pids().compactMap(LibProc.read)
        lock.lock()
        let wall = prevAt == 0 ? 0 : now - prevAt
        let old = prev
        prev = Dictionary(raws.map { ($0.pid, $0.cpuNs) }, uniquingKeysWith: { a, _ in a })
        prevAt = now
        lock.unlock()
        return raws.map { r in
            ProcInfo(pid: r.pid, ppid: r.ppid, cpu: ProcessPolicy.cpuPercent(prevNs: old[r.pid], nowNs: r.cpuNs, wallNs: wall), rssKb: Int(r.rssBytes / 1024),
                     user: LibProc.userName(r.uid), command: r.command, name: ProcessPolicy.processName(r.command), appPath: ProcessPolicy.appBundle(of: r.command))
        }
    }

    public var primed: Bool { lock.lock(); defer { lock.unlock() }; return prevAt != 0 }

    /// Listening TCP sockets (optionally on one port), one row per pid+port.
    public static func listeners(port: Int?) -> [PortListener] {
        var out: [PortListener] = []
        var seen = Set<String>()
        for pid in LibProc.pids() where pid > 0 {
            let socks = LibProc.listeners(pid)
            guard !socks.isEmpty else { continue }
            let raw = LibProc.read(pid)
            for s in socks where port == nil || s.port == port {
                guard seen.insert("\(pid):\(s.port)").inserted else { continue }
                let cmd = raw.map { ProcessPolicy.processName($0.command) } ?? LibProc.name(pid) ?? "?"
                out.append(PortListener(command: cmd, pid: pid, user: raw.map { LibProc.userName($0.uid) } ?? "?", address: s.address, port: s.port, proto: s.proto))
            }
        }
        return out.sorted { $0.port != $1.port ? $0.port < $1.port : $0.pid < $1.pid }
    }
}
