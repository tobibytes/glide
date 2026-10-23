import Foundation

/// Turns a root-search query into conversion results (port of convert/engine.ts). Pure: time, zone, rates are inputs.
public enum ConvertEngine {
    public enum Category: String, Sendable { case unit, currency, timezone, date }

    public struct CopyOption: Sendable, Equatable {
        public var id: String
        public var title: String
        public var text: String
    }

    public struct Conversion: Sendable {
        public var category: Category
        public var title: String
        public var subtitle: String
        public var icon: String
        /// Primary text copied/pasted by ⏎ / ⌘⏎.
        public var copy: String
        public var more: [CopyOption]
    }

    public struct Context {
        public var nowMs: Double
        public var localZone: String
        public var calendar: Calendar
        public var rates: ConvertCurrency.RateTable?
        public var ratesStale = false
        public var ratesLoading = false
        public var defaultCurrency: String
        public var currencyEnabled: Bool
        public init(nowMs: Double, localZone: String, calendar: Calendar? = nil, rates: ConvertCurrency.RateTable? = nil, ratesStale: Bool = false,
                    ratesLoading: Bool = false, defaultCurrency: String = "USD", currencyEnabled: Bool = true) {
            self.nowMs = nowMs
            self.localZone = localZone
            var cal = calendar ?? Calendar(identifier: .gregorian)
            if calendar == nil { cal.timeZone = TimeZone(identifier: localZone) ?? .current }
            self.calendar = cal
            self.rates = rates
            self.ratesStale = ratesStale
            self.ratesLoading = ratesLoading
            self.defaultCurrency = defaultCurrency
            self.currencyEnabled = currencyEnabled
        }
    }

    public struct Output {
        public var results: [Conversion]
        /// The query is a currency query: the caller should make sure rates are loaded.
        public var wantsRates: Bool
    }

    static let unitIcon: [ConvertUnits.Dimension: String] = [.length: "📏", .mass: "⚖️", .volume: "🧪", .temperature: "🌡️", .area: "📐", .speed: "💨", .data: "💾", .time: "⏱️"]

    static func unitResult(_ q: String) -> Conversion? {
        guard let c = ConvertUnits.parse(q) else { return nil }
        let src = c.from.map { "\(ConvertFormat.groupedNumber($0.amount)) \($0.unit.symbol)" }.joined(separator: " ")
        let plain = ConvertFormat.plainNumber(c.value)
        let grouped = ConvertFormat.groupedNumber(c.value)
        return Conversion(category: .unit, title: "\(grouped) \(c.to.symbol)",
                          subtitle: "\(src) = \(grouped) \(c.to.name) · \(ConvertUnits.dimensionLabel[c.dim] ?? "")",
                          icon: unitIcon[c.dim] ?? "🔁", copy: "\(plain) \(c.to.symbol)", more: [CopyOption(id: "number", title: "Copy Number Only", text: plain)])
    }

    static func currencyResult(_ q: String, _ ctx: Context) -> (Conversion?, Bool) {
        let known: (String) -> Bool = ctx.rates.map { t in { t.knows($0) } } ?? { ConvertCurrency.isoCodes.contains($0) }
        guard let cq = ConvertCurrency.parse(q, known: known), ctx.currencyEnabled else { return (nil, false) }
        let def = ctx.defaultCurrency
        let to = cq.to ?? (cq.from == def ? (def == "EUR" ? "USD" : "EUR") : def)
        guard let rates = ctx.rates else {
            if !ctx.ratesLoading { return (nil, true) }
            return (Conversion(category: .currency, title: "Fetching exchange rates…",
                               subtitle: "\(ConvertCurrency.formatMoney(cq.amount, cq.from)) → \(to) · results appear as you keep typing", icon: "💱", copy: "", more: []), true)
        }
        guard let value = ConvertCurrency.convert(cq.amount, from: cq.from, to: to, table: rates), let rate = ConvertCurrency.convert(1, from: cq.from, to: to, table: rates) else {
            return (nil, true)
        }
        let date = rates.date
        let sub = "\(ConvertCurrency.formatMoney(cq.amount, cq.from)) = \(ConvertCurrency.formatMoney(value, to)) · 1 \(cq.from) = \(ConvertFormat.plainNumber(rate, 5)) \(to) · "
            + (ctx.ratesStale ? "rates from \(date) (offline)" : "rates \(date)")
        return (Conversion(category: .currency, title: ConvertCurrency.formatMoney(value, to), subtitle: sub, icon: "💱", copy: ConvertCurrency.plainMoney(value, to),
                           more: [CopyOption(id: "formatted", title: "Copy with Currency", text: ConvertCurrency.formatMoney(value, to))]), true)
    }

    static func timeZoneResult(_ q: String, _ ctx: Context) -> Conversion? {
        guard let r = ConvertTimeZones.parse(q, nowMs: ctx.nowMs, localZone: ctx.localZone) else { return nil }
        let day = r.dayDelta > 0 ? " (+\(r.dayDelta) day)" : r.dayDelta < 0 ? " (\(r.dayDelta) day)" : ""
        let subtitle = r.from.map { "\(r.fromTime ?? "") \($0.label) = \(r.time) \(r.to.label)\(day) · \(r.date) · \(r.offset)" } ?? "Now in \(r.to.label) · \(r.date) · \(r.offset)"
        return Conversion(category: .timezone, title: r.to.label == "Local" ? "\(r.time) local" : "\(r.time) \(r.to.label)", subtitle: subtitle, icon: "🌐", copy: r.time,
                          more: [CopyOption(id: "full", title: "Copy Time and Date", text: "\(r.time), \(r.date) (\(r.to.label))"), CopyOption(id: "iso", title: "Copy ISO 8601", text: r.iso)])
    }

    static func dateResult(_ q: String, _ ctx: Context) -> Conversion? {
        let now = Date(timeIntervalSince1970: ctx.nowMs / 1000)
        let cal = ctx.calendar
        guard let r = ConvertDates.parse(q, now: now, cal: cal) else { return nil }
        switch r {
        case let .date(d, hasTime, expression):
            let text = ConvertDates.formatDate(d, withTime: hasTime, cal: cal)
            let rel = Int(((d.timeIntervalSince1970 * 1000 - ctx.nowMs) / 86_400_000).rounded())
            let suffix = hasTime ? "" : rel == 0 ? " · today" : rel > 0 ? " · in \(ConvertDates.describeDays(rel))" : " · \(ConvertDates.describeDays(rel)) ago"
            let iso: String
            if hasTime {
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                iso = f.string(from: d)
            } else { iso = ConvertDates.isoDate(d, cal: cal) }
            return Conversion(category: .date, title: text, subtitle: expression + suffix, icon: "📅", copy: text, more: [CopyOption(id: "iso", title: "Copy ISO Date", text: iso)])
        case let .count(days, unit, from, to, direction, _):
            let cv = ConvertDates.countValue(days: days, unit: unit, from: from, to: to, cal: cal)
            let target = direction == "between" ? "\(ConvertDates.formatDate(from, cal: cal)) → \(ConvertDates.formatDate(to, cal: cal))"
                : "\(direction) \(ConvertDates.formatDate(direction == "since" ? from : to, cal: cal))"
            let extra = unit == "day" && abs(days) >= 7 ? " · \(ConvertDates.describeDays(days))" : unit != "day" ? " · \(ConvertDates.describeDays(days))" : ""
            return Conversion(category: .date, title: cv.label, subtitle: target + extra, icon: "📅", copy: ConvertDates.jsNum(cv.value),
                              more: [CopyOption(id: "label", title: "Copy with Unit", text: cv.label)])
        }
    }

    public static func convert(_ query: String, _ ctx: Context) -> Output {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 3, ConvertRegex.test("[a-z€$£¥₹₦₩₽₺₱]", q, [.caseInsensitive]) else { return Output(results: [], wantsRates: false) }
        if let d = dateResult(q, ctx) { return Output(results: [d], wantsRates: false) }
        if let t = timeZoneResult(q, ctx) { return Output(results: [t], wantsRates: false) }
        if let u = unitResult(q) { return Output(results: [u], wantsRates: false) }
        let (c, wants) = currencyResult(q, ctx)
        return Output(results: c.map { [$0] } ?? [], wantsRates: wants)
    }
}
