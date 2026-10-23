import Darwin
import Foundation
import IOKit.ps

/// Native system readings (port of src/main/features/sysmon, without vm_stat/pmset/netstat/df): per-core CPU via
/// host_processor_info tick deltas, memory via host_statistics64, disk via statfs("/"), battery via IOKit power
/// sources, network via getifaddrs byte-counter deltas (32-bit counters, wrap-safe).
public enum Sysmon {
    public struct CPUTicks: Hashable, Sendable {
        public var user: UInt64, system: UInt64, idle: UInt64, nice: UInt64
        public init(user: UInt64, system: UInt64, idle: UInt64, nice: UInt64) {
            self.user = user
            self.system = system
            self.idle = idle
            self.nice = nice
        }
    }

    public struct Memory: Hashable, Sendable {
        public var totalBytes: UInt64
        /// app + wired + compressed (Activity Monitor's "Memory Used").
        public var usedBytes: UInt64
        public var appBytes: UInt64
        public var wiredBytes: UInt64
        public var compressedBytes: UInt64
        public var cachedBytes: UInt64
        public var fraction: Double { totalBytes > 0 ? Double(usedBytes) / Double(totalBytes) : 0 }
    }

    public struct Disk: Hashable, Sendable {
        public var totalBytes: UInt64
        public var availableBytes: UInt64
        public var usedBytes: UInt64 { totalBytes > availableBytes ? totalBytes - availableBytes : 0 }
        public var fraction: Double { totalBytes > 0 ? Double(usedBytes) / Double(totalBytes) : 0 }
    }

    public struct Battery: Hashable, Sendable {
        public var percent: Int
        public var charging: Bool
        public var onAC: Bool
        public var minutesRemaining: Int?
    }

    public struct NetCounters: Hashable, Sendable {
        public var rx: UInt64
        public var tx: UInt64
    }

    // MARK: pure math

    /// Per-core busy fraction (0…1) between two tick samples.
    public static func cpuDeltas(_ prev: [CPUTicks], _ next: [CPUTicks]) -> [Double] {
        next.enumerated().map { i, n in
            guard i < prev.count else { return 0 }
            let p = prev[i]
            let busy = Double(n.user &- p.user) + Double(n.system &- p.system) + Double(n.nice &- p.nice)
            let total = busy + Double(n.idle &- p.idle)
            return total > 0 ? min(1, max(0, busy / total)) : 0
        }
    }

    /// Memory from vm_statistics64 page counts (same formula as the Electron vm_stat parser).
    public static func memory(pageSize: UInt64, anonymous: UInt64, purgeable: UInt64, wired: UInt64, compressed: UInt64, fileBacked: UInt64, total: UInt64) -> Memory {
        let app = anonymous > purgeable ? (anonymous - purgeable) * pageSize : 0
        let w = wired * pageSize, c = compressed * pageSize
        return Memory(totalBytes: total, usedBytes: min(total, app + w + c), appBytes: app, wiredBytes: w, compressedBytes: c, cachedBytes: (fileBacked + purgeable) * pageSize)
    }

    /// Delta of a 32-bit interface counter that may have wrapped.
    public static func counterDelta(_ prev: UInt64, _ next: UInt64, width: UInt64 = 1 << 32) -> UInt64 {
        next >= prev ? next - prev : (width - prev) + next
    }

    public static func formatBytes(_ n: Double, digits: Int = 1) -> String {
        let units = ["B", "KB", "MB", "GB", "TB"]
        var v = max(0, n), u = 0
        while v >= 1024 && u < units.count - 1 { v /= 1024; u += 1 }
        if u == 0 { return "\(Int(v.rounded())) B" }
        return v >= 100 ? "\(Int(v.rounded())) \(units[u])" : String(format: "%.\(digits)f %@", v, units[u])
    }

    public static func formatRate(_ bps: Double) -> String { formatBytes(bps) + "/s" }

    public static func formatUptime(_ sec: Double) -> String {
        let s = Int(sec), d = s / 86400, h = (s % 86400) / 3600, m = (s % 3600) / 60
        if d > 0 { return "\(d)d \(h)h" }
        if h > 0 { return "\(h)h \(m)m" }
        return "\(m)m"
    }

    /// Keywords that surface the inline "CPU 23% · Mem 61%" row in root search.
    public static func isSysmonQuery(_ q: String) -> Bool {
        let t = q.trimmingCharacters(in: .whitespaces).lowercased()
        guard t.count >= 3 else { return false }
        return ["cpu", "memory", "ram", "battery", "system", "sysmon", "disk", "uptime", "load"].contains { $0.hasPrefix(t) || t.hasPrefix($0) }
    }

    // MARK: readings

    public static func cpuTicks() -> [CPUTicks] {
        var count: natural_t = 0
        var info: processor_info_array_t?
        var infoCount: mach_msg_type_number_t = 0
        guard host_processor_info(mach_host_self(), PROCESSOR_CPU_LOAD_INFO, &count, &info, &infoCount) == KERN_SUCCESS, let info else { return [] }
        defer { vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: info)), vm_size_t(Int(infoCount) * MemoryLayout<integer_t>.stride)) }
        let n = Int(CPU_STATE_MAX)
        return (0..<Int(count)).map { i in
            let b = i * n
            func v(_ s: Int32) -> UInt64 { UInt64(UInt32(bitPattern: info[b + Int(s)])) }
            return CPUTicks(user: v(CPU_STATE_USER), system: v(CPU_STATE_SYSTEM), idle: v(CPU_STATE_IDLE), nice: v(CPU_STATE_NICE))
        }
    }

    public static func totalMemory() -> UInt64 { ProcessInfo.processInfo.physicalMemory }

    public static func memory() -> Memory? {
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
        let r = withUnsafeMutablePointer(to: &stats) { p in
            p.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count) }
        }
        guard r == KERN_SUCCESS else { return nil }
        var page: vm_size_t = 0
        host_page_size(mach_host_self(), &page)
        return memory(pageSize: UInt64(page), anonymous: UInt64(stats.internal_page_count), purgeable: UInt64(stats.purgeable_count),
                      wired: UInt64(stats.wire_count), compressed: UInt64(stats.compressor_page_count), fileBacked: UInt64(stats.external_page_count), total: totalMemory())
    }

    public static func disk(_ path: String = "/") -> Disk? {
        let url = URL(fileURLWithPath: path)
        if let v = try? url.resourceValues(forKeys: [.volumeTotalCapacityKey, .volumeAvailableCapacityForImportantUsageKey]),
           let total = v.volumeTotalCapacity, let avail = v.volumeAvailableCapacityForImportantUsage, total > 0 {
            return Disk(totalBytes: UInt64(total), availableBytes: UInt64(max(0, avail)))
        }
        var s = statfs()
        guard statfs(path, &s) == 0 else { return nil }
        return Disk(totalBytes: UInt64(s.f_blocks) * UInt64(s.f_bsize), availableBytes: UInt64(s.f_bavail) * UInt64(s.f_bsize))
    }

    /// nil on Macs without a battery.
    public static func battery() -> Battery? {
        guard let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(blob)?.takeRetainedValue() as? [CFTypeRef] else { return nil }
        for ps in list {
            guard let d = IOPSGetPowerSourceDescription(blob, ps)?.takeUnretainedValue() as? [String: Any],
                  (d[kIOPSTypeKey] as? String) == kIOPSInternalBatteryType else { continue }
            let cur = d[kIOPSCurrentCapacityKey] as? Int ?? 0, max = d[kIOPSMaxCapacityKey] as? Int ?? 100
            let mins = (d[kIOPSTimeToEmptyKey] as? Int).flatMap { $0 > 0 ? $0 : nil }
            return Battery(percent: max > 0 ? Int((Double(cur) / Double(max) * 100).rounded()) : cur, charging: d[kIOPSIsChargingKey] as? Bool ?? false,
                           onAC: (d[kIOPSPowerSourceStateKey] as? String) == kIOPSACPowerValue, minutesRemaining: mins)
        }
        return nil
    }

    /// Sum of non-loopback interface byte counters (AF_LINK if_data).
    public static func network() -> [String: NetCounters] {
        var out: [String: NetCounters] = [:]
        var addrs: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addrs) == 0, let first = addrs else { return out }
        defer { freeifaddrs(addrs) }
        var p: UnsafeMutablePointer<ifaddrs>? = first
        while let cur = p {
            defer { p = cur.pointee.ifa_next }
            guard let sa = cur.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_LINK), let data = cur.pointee.ifa_data else { continue }
            let name = String(cString: cur.pointee.ifa_name)
            if name.hasPrefix("lo") { continue }
            let d = data.assumingMemoryBound(to: if_data.self).pointee
            out[name] = NetCounters(rx: UInt64(d.ifi_ibytes), tx: UInt64(d.ifi_obytes))
        }
        return out
    }

    public static func loadAverage() -> [Double] {
        var l = [Double](repeating: 0, count: 3)
        return getloadavg(&l, 3) == 3 ? l : [0, 0, 0]
    }

    public static func cpuModel() -> String {
        var size = 0
        sysctlbyname("machdep.cpu.brand_string", nil, &size, nil, 0)
        guard size > 0 else { return "" }
        var buf = [CChar](repeating: 0, count: size)
        sysctlbyname("machdep.cpu.brand_string", &buf, &size, nil, 0)
        return String(decoding: buf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }
}

public struct SysSample: Sendable, Equatable {
    public var at: Date
    public var cpuTotal: Double
    public var cores: [Double]
    public var load: [Double]
    public var memory: Sysmon.Memory?
    public var disk: Sysmon.Disk?
    public var battery: Sysmon.Battery?
    public var rxPerSec: Double
    public var txPerSec: Double
    public var uptime: Double
}

/// Stateful sampler: CPU/net deltas since the previous call, 60-sample history for the sparklines.
@MainActor public final class SysmonSampler {
    public static let historyLength = 60
    private var prevTicks = Sysmon.cpuTicks()
    private var prevNet: (c: [String: Sysmon.NetCounters], at: Date)?
    public private(set) var last: SysSample?
    public private(set) var history: (cpu: [Double], mem: [Double], rx: [Double], tx: [Double]) = ([], [], [], [])
    public let model = Sysmon.cpuModel()

    public init() {}

    static func push(_ a: inout [Double], _ v: Double) {
        a.append(v)
        if a.count > historyLength { a.removeFirst(a.count - historyLength) }
    }

    /// `record` = the monitor view's 1 s cadence (feeds the sparklines); the glance row only refreshes `last`.
    @discardableResult
    public func sample(record: Bool) -> SysSample {
        if !record, let l = last, Date().timeIntervalSince(l.at) < 0.5 { return l }
        let now = Date()
        let ticks = Sysmon.cpuTicks()
        let cores = Sysmon.cpuDeltas(prevTicks, ticks)
        prevTicks = ticks
        let net = Sysmon.network()
        var rx = 0.0, tx = 0.0
        if let p = prevNet, now > p.at {
            let dt = now.timeIntervalSince(p.at)
            for (k, v) in net {
                guard let o = p.c[k] else { continue }
                rx += Double(Sysmon.counterDelta(o.rx, v.rx)) / dt
                tx += Double(Sysmon.counterDelta(o.tx, v.tx)) / dt
            }
        }
        prevNet = (net, now)
        let total = cores.isEmpty ? 0 : cores.reduce(0, +) / Double(cores.count)
        let s = SysSample(at: now, cpuTotal: total, cores: cores, load: Sysmon.loadAverage(), memory: Sysmon.memory(), disk: Sysmon.disk(),
                          battery: Sysmon.battery(), rxPerSec: rx, txPerSec: tx, uptime: ProcessInfo.processInfo.systemUptime)
        if record {
            Self.push(&history.cpu, total)
            Self.push(&history.mem, s.memory?.fraction ?? 0)
            Self.push(&history.rx, rx)
            Self.push(&history.tx, tx)
        }
        last = s
        return s
    }
}
