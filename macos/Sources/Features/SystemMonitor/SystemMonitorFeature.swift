import AppKit
import GlideCore
import GlideSystem
import GlideUI
import SwiftUI

/// System Monitor (port of src/main/features/sysmon): CPU per core, memory, disk, battery, network throughput,
/// uptime and top processes, with sparklines. Pull-based: the view samples once a second while it is open; root
/// search shows a "CPU 23% · Mem 61% · Battery 80%" glance row for cpu/memory/battery/… queries.
@MainActor public final class SystemMonitorFeature: Feature, FeatureUI {
    public let id = "sysmon"
    public let title = "System Monitor"
    private weak var context: FeatureContext?
    let sampler = SysmonSampler()
    let model = SysmonModel()
    let procs = ProcessSampler()

    public init() {}
    public func start(context: FeatureContext) async { self.context = context }

    public func items() -> [SearchItem] {
        [SearchItem(id: "sysmon:open", kind: .command, title: "System Monitor", subtitle: "CPU, memory, disk, battery, network", icon: .symbol("gauge.with.dots.needle.67percent"),
                    keywords: ["system", "monitor", "cpu", "memory", "ram", "disk", "battery", "network", "uptime", "activity", "stats", "load"],
                    feature: id, data: ["action": "open"], kindLabel: "Command")]
    }

    static func pct(_ x: Double) -> String { "\(Int((x * 100).rounded()))%" }

    /// The glance row's title and subtitle (pure).
    public static func glance(_ s: SysSample) -> (title: String, subtitle: String) {
        var parts = ["CPU \(pct(s.cpuTotal))"]
        if let m = s.memory { parts.append("Mem \(pct(m.fraction))") }
        if let b = s.battery { parts.append("Battery \(b.percent)%\(b.charging ? " ⚡︎" : "")") }
        var sub = [String(format: "Load %.2f", s.load.first ?? 0)]
        if let d = s.disk { sub.append("Disk \(pct(d.fraction)) used") }
        sub += ["Up \(Sysmon.formatUptime(s.uptime))", "⏎ System Monitor"]
        return (parts.joined(separator: " · "), sub.joined(separator: " · "))
    }

    public func dynamicItems(for query: DynamicQuery) async -> [ScoredItem] {
        let t = query.trimmed.lowercased()
        guard Sysmon.isSysmonQuery(t) else {
            // "c"/"me"/"ba"… primes the CPU delta so the row has a real value one keystroke later.
            if !t.isEmpty, t.count < 3, ["cpu", "memory", "ram", "battery", "system", "disk"].contains(where: { $0.hasPrefix(t) }) { sampler.sample(record: false) }
            return []
        }
        let g = Self.glance(sampler.sample(record: false))
        return [ScoredItem(item: SearchItem(id: "sysmon:glance", kind: .calculator, title: g.title, subtitle: g.subtitle, icon: .symbol("gauge.with.dots.needle.67percent"),
                                            feature: id, data: ["action": "open", "noUsage": true], kindLabel: "System"),
                           score: 996, matchScore: 996, matchKind: .exact)]
    }

    public func actions(for item: SearchItem) -> [ItemAction] { [ItemAction(id: "open", title: "Open System Monitor", shortcut: "↩", icon: "gauge.with.dots.needle.67percent")] }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        guard action == "open" else { return .error("Unknown action \(action)") }
        tick()
        return .pushView("sysmon.monitor")
    }

    /// One 1 s step: sample, refresh top processes.
    func tick() {
        model.sample = sampler.sample(record: true)
        model.history = sampler.history
        let p = procs
        Task { @MainActor in
            let list = await Task.detached { ProcessPolicy.sortByCpu(p.sample()) }.value
            model.top = Array(list.prefix(5))
        }
    }

    public func launcherView(_ vid: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard vid.name == "monitor" else { return nil }
        return AnyView(SysmonView(model: model, cpuModel: sampler.model)
            .task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(1))
                    self?.tick()
                }
            }
            .onAppear {
                host.setPlaceholder("System Monitor")
                host.setFooter(primary: nil, hasActions: false)
            })
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool { false }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "sample":
            let s = sampler.sample(record: args["record"]?.boolValue ?? true)
            let g = Self.glance(s)
            return ["cpu": ["total": .double(s.cpuTotal), "cores": .array(s.cores.map(JSONValue.double)), "load": .array(s.load.map(JSONValue.double))],
                    "memory": s.memory.map { ["totalBytes": .int(Int64($0.totalBytes)), "usedBytes": .int(Int64($0.usedBytes))] } ?? .null,
                    "disk": s.disk.map { ["totalBytes": .int(Int64($0.totalBytes)), "availableBytes": .int(Int64($0.availableBytes))] } ?? .null,
                    "battery": s.battery.map { ["percent": .int(Int64($0.percent)), "charging": .bool($0.charging)] } ?? .null,
                    "net": ["rxPerSec": .double(s.rxPerSec), "txPerSec": .double(s.txPerSec)], "uptimeSec": .double(s.uptime),
                    "glance": .string(g.title), "history": .int(Int64(sampler.history.cpu.count)),
                    // The agent's system_status promises the busiest processes (last ones the monitor view read).
                    "top": .array(model.top.prefix(args["top"]?.intValue ?? 5).map { ["pid": .int(Int64($0.pid)), "name": .string($0.name), "cpu": .double($0.cpu)] })]
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

@MainActor @Observable final class SysmonModel {
    var sample: SysSample?
    var history: (cpu: [Double], mem: [Double], rx: [Double], tx: [Double]) = ([], [], [], [])
    var top: [ProcInfo] = []
}

/// Line + area sparkline normalised to `maxValue` (or the series max).
struct Sparkline: View {
    let values: [Double]
    var maxValue: Double?
    let color: Color
    var body: some View {
        GeometryReader { geo in
            let m = max(maxValue ?? (values.max() ?? 1), 0.000_001)
            let n = max(values.count - 1, 1)
            let pts = values.enumerated().map { i, v in
                CGPoint(x: geo.size.width * CGFloat(i) / CGFloat(n), y: geo.size.height * (1 - CGFloat(min(v / m, 1))))
            }
            ZStack {
                if pts.count > 1 {
                    Path { p in
                        p.move(to: CGPoint(x: pts[0].x, y: geo.size.height))
                        for pt in pts { p.addLine(to: pt) }
                        p.addLine(to: CGPoint(x: pts[pts.count - 1].x, y: geo.size.height))
                        p.closeSubpath()
                    }
                    .fill(LinearGradient(colors: [color.opacity(0.35), color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                    Path { p in
                        p.move(to: pts[0])
                        for pt in pts.dropFirst() { p.addLine(to: pt) }
                    }
                    .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineJoin: .round))
                } else {
                    Rectangle().fill(color.opacity(0.08))
                }
            }
        }
        .accessibilityHidden(true)
    }
}

struct SysmonView: View {
    @Environment(\.glideTheme) private var theme
    let model: SysmonModel
    let cpuModel: String

    var body: some View {
        let s = model.sample
        ScrollView {
            VStack(spacing: 10) {
                HStack(spacing: 10) {
                    card("CPU", s.map { SystemMonitorFeature.pct($0.cpuTotal) } ?? "–", detail: s.map { String(format: "Load %.2f %.2f %.2f", $0.load[sysmonAt: 0] ?? 0, $0.load[sysmonAt: 1] ?? 0, $0.load[sysmonAt: 2] ?? 0) } ?? cpuModel,
                         series: model.history.cpu, max: 1, color: theme.accent)
                    card("Memory", s?.memory.map { SystemMonitorFeature.pct($0.fraction) } ?? "–",
                         detail: s?.memory.map { "\(Sysmon.formatBytes(Double($0.usedBytes))) of \(Sysmon.formatBytes(Double($0.totalBytes)))" } ?? "",
                         series: model.history.mem, max: 1, color: theme.success)
                }
                HStack(spacing: 10) {
                    card("Network ↓", s.map { Sysmon.formatRate($0.rxPerSec) } ?? "–", detail: s.map { "↑ \(Sysmon.formatRate($0.txPerSec))" } ?? "",
                         series: model.history.rx, max: nil, color: theme.warning)
                    VStack(alignment: .leading, spacing: 6) {
                        stat("internaldrive", "Disk", s?.disk.map { "\(Sysmon.formatBytes(Double($0.availableBytes))) free · \(SystemMonitorFeature.pct($0.fraction)) used" } ?? "–")
                        stat(s?.battery?.charging == true ? "battery.100.bolt" : "battery.75", "Battery",
                             s?.battery.map { "\($0.percent)%\($0.charging ? " · charging" : $0.onAC ? " · on power" : "")\($0.minutesRemaining.map { " · \($0 / 60)h \($0 % 60)m left" } ?? "")" } ?? "No battery")
                        stat("clock", "Uptime", s.map { Sysmon.formatUptime($0.uptime) } ?? "–")
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(theme.surface))
                }
                if let cores = s?.cores, !cores.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Cores").font(theme.sectionFont).foregroundStyle(theme.text3)
                        HStack(alignment: .bottom, spacing: 3) {
                            ForEach(Array(cores.enumerated()), id: \.offset) { _, c in
                                RoundedRectangle(cornerRadius: 2).fill(theme.accent.opacity(0.25 + 0.75 * c)).frame(height: max(3, 36 * c)).frame(maxWidth: .infinity)
                            }
                        }
                        .frame(height: 36, alignment: .bottom)
                    }
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(theme.surface))
                }
                if !model.top.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Top processes").font(theme.sectionFont).foregroundStyle(theme.text3)
                        ForEach(model.top, id: \.pid) { p in
                            HStack {
                                Text(p.name).font(.system(size: 12.5)).foregroundStyle(theme.text).lineLimit(1)
                                Spacer()
                                Text(String(format: "%.1f%%", p.cpu)).font(.system(size: 12, design: .monospaced)).foregroundStyle(theme.text2)
                                Text(ProcessPolicy.formatKb(p.rssKb)).font(.system(size: 12, design: .monospaced)).foregroundStyle(theme.text3).frame(width: 70, alignment: .trailing)
                            }
                        }
                    }
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(theme.surface))
                }
            }
            .padding(12)
        }
        .scrollIndicators(.never)
    }

    private func card(_ title: String, _ value: String, detail: String, series: [Double], max: Double?, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(theme.sectionFont).foregroundStyle(theme.text3)
            Text(value).font(.system(size: 22, weight: .semibold, design: .rounded)).foregroundStyle(theme.text).monospacedDigit()
            Text(detail).font(.system(size: 11)).foregroundStyle(theme.text3).lineLimit(1)
            Sparkline(values: series, maxValue: max, color: color).frame(height: 30)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(theme.surface))
        .accessibilityElement(children: .combine)
    }

    private func stat(_ symbol: String, _ title: String, _ value: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: symbol).frame(width: 18).foregroundStyle(theme.text2)
            Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(theme.text2)
            Spacer(minLength: 4)
            Text(value).font(.system(size: 12)).foregroundStyle(theme.text).lineLimit(1)
        }
    }
}

extension Array {
    subscript(sysmonAt i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
