import Darwin
import Foundation

/// CPU / memory / load for the System Monitor extra, read with Mach host calls (read-only, no subprocesses).
public struct SystemSample: Sendable, Equatable {
    public struct Memory: Sendable, Equatable {
        public var totalBytes: Double
        /// app + wired + compressed (Activity Monitor's "Memory Used").
        public var usedBytes: Double
    }
    public var cpu: Double
    public var cores: Int
    public var load: [Double]
    public var memory: Memory?

    /// Per-core (user+system+nice, total) ticks.
    public typealias Ticks = [(busy: UInt64, total: UInt64)]

    public static func cpuTicks() -> Ticks {
        var count: natural_t = 0
        var info: processor_info_array_t?
        var infoCount: mach_msg_type_number_t = 0
        guard host_processor_info(mach_host_self(), PROCESSOR_CPU_LOAD_INFO, &count, &info, &infoCount) == KERN_SUCCESS, let info else { return [] }
        defer { vm_deallocate(mach_task_self_, vm_address_t(bitPattern: info), vm_size_t(Int(infoCount) * MemoryLayout<integer_t>.stride)) }
        var out: Ticks = []
        for i in 0..<Int(count) {
            let base = Int(CPU_STATE_MAX) * i
            let user = UInt64(UInt32(bitPattern: info[base + Int(CPU_STATE_USER)]))
            let sys = UInt64(UInt32(bitPattern: info[base + Int(CPU_STATE_SYSTEM)]))
            let nice = UInt64(UInt32(bitPattern: info[base + Int(CPU_STATE_NICE)]))
            let idle = UInt64(UInt32(bitPattern: info[base + Int(CPU_STATE_IDLE)]))
            out.append((user + sys + nice, user + sys + nice + idle))
        }
        return out
    }

    /// Average busy fraction between two samples (0 when unknown).
    public static func cpuUsage(_ a: Ticks, _ b: Ticks) -> Double {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        var sum = 0.0
        for (x, y) in zip(a, b) {
            let total = Double(y.total &- x.total)
            sum += total > 0 ? Double(y.busy &- x.busy) / total : 0
        }
        return sum / Double(a.count)
    }

    public static func memory() -> Memory? {
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &stats) { p in
            p.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count) }
        }
        guard kr == KERN_SUCCESS else { return nil }
        var pageSize: vm_size_t = 0
        host_page_size(mach_host_self(), &pageSize)
        let page = Double(pageSize)
        let anonymous = Double(stats.internal_page_count) * page
        let purgeable = Double(stats.purgeable_count) * page
        let wired = Double(stats.wire_count) * page
        let compressed = Double(stats.compressor_page_count) * page
        let total = Double(ProcessInfo.processInfo.physicalMemory)
        return Memory(totalBytes: total, usedBytes: min(total, max(0, anonymous - purgeable) + wired + compressed))
    }

    public static func loadAverage() -> [Double] {
        var l = [Double](repeating: 0, count: 3)
        return getloadavg(&l, 3) == 3 ? l : [0, 0, 0]
    }
}
