import Foundation

/// Unit conversion (port of convert/units.ts): "5 km in miles", "100f to c", "3 gb in mb", "5 ft 10 in to cm".
/// Every unit converts through a base unit of its dimension (m, kg, L, K, m², m/s, byte, s).
public enum ConvertUnits {
    public enum Dimension: String, Sendable, CaseIterable { case length, mass, volume, temperature, area, speed, data, time }

    public struct UnitDef: Sendable, Equatable {
        public var id: String
        public var dim: Dimension
        /// base = (value + offset) * factor
        public var factor: Double
        public var offset: Double = 0
        public var symbol: String
        public var name: String
    }

    public static let dimensionLabel: [Dimension: String] = [
        .length: "Length", .mass: "Mass", .volume: "Volume", .temperature: "Temperature", .area: "Area",
        .speed: "Speed", .data: "Data Size", .time: "Duration",
    ]

    typealias Spec = (id: String, factor: Double, symbol: String, name: String, aliases: [String], offset: Double)
    static func s(_ id: String, _ f: Double, _ sym: String, _ name: String, _ aliases: [String], _ offset: Double = 0) -> Spec { (id, f, sym, name, aliases, offset) }

    static let specs: [(Dimension, [Spec])] = [
        (.length, [
            s("nm", 1e-9, "nm", "nanometers", ["nanometer", "nanometre"]),
            s("um", 1e-6, "µm", "micrometers", ["µm", "micrometer", "micrometre", "micron"]),
            s("mm", 1e-3, "mm", "millimeters", ["millimeter", "millimetre"]),
            s("cm", 1e-2, "cm", "centimeters", ["centimeter", "centimetre"]),
            s("m", 1, "m", "meters", ["meter", "metre", "mtr"]),
            s("km", 1e3, "km", "kilometers", ["kilometer", "kilometre", "kms", "klick"]),
            s("in", 0.0254, "in", "inches", ["inch", "inches", "\"", "″"]),
            s("ft", 0.3048, "ft", "feet", ["foot", "feet", "'", "′"]),
            s("yd", 0.9144, "yd", "yards", ["yard", "yds"]),
            s("mi", 1609.344, "mi", "miles", ["mile"]),
            s("nmi", 1852, "nmi", "nautical miles", ["nautical mile", "nautical miles"]),
            s("au", 149_597_870_700, "au", "astronomical units", ["astronomical unit"]),
            s("ly", 9_460_730_472_580_800, "ly", "light years", ["light year", "light-year", "lightyear"]),
        ]),
        (.mass, [
            s("mg", 1e-6, "mg", "milligrams", ["milligram", "milligramme"]),
            s("g", 1e-3, "g", "grams", ["gram", "gramme", "gm", "gms"]),
            s("kg", 1, "kg", "kilograms", ["kilogram", "kilogramme", "kilo", "kgs"]),
            s("t", 1000, "t", "tonnes", ["tonne", "metric ton", "metric tons"]),
            s("oz", 0.028349523125, "oz", "ounces", ["ounce"]),
            s("lb", 0.45359237, "lb", "pounds", ["lbs", "pound"]),
            s("st", 6.35029318, "st", "stone", ["stone", "stones"]),
            s("ton", 907.18474, "ton", "US tons", ["ton", "tons", "short ton", "short tons"]),
        ]),
        (.volume, [
            s("ml", 1e-3, "mL", "milliliters", ["milliliter", "millilitre", "cc"]),
            s("cl", 1e-2, "cL", "centiliters", ["centiliter", "centilitre"]),
            s("dl", 1e-1, "dL", "deciliters", ["deciliter", "decilitre"]),
            s("l", 1, "L", "liters", ["liter", "litre", "ltr", "lt"]),
            s("tsp", 0.00492892159375, "tsp", "teaspoons", ["teaspoon"]),
            s("tbsp", 0.01478676478125, "tbsp", "tablespoons", ["tablespoon", "tbs"]),
            s("floz", 0.0295735295625, "fl oz", "fluid ounces", ["fl oz", "fluid ounce", "fl. oz"]),
            s("cup", 0.2365882365, "cups", "cups", ["cup"]),
            s("pt", 0.473176473, "pt", "pints", ["pint"]),
            s("qt", 0.946352946, "qt", "quarts", ["quart"]),
            s("gal", 3.785411784, "gal", "gallons", ["gallon", "us gallon", "us gal"]),
            s("impgal", 4.54609, "imp gal", "imperial gallons", ["imperial gallon", "imp gal", "uk gallon", "uk gal"]),
        ]),
        (.temperature, [
            s("c", 1, "°C", "Celsius", ["celsius", "centigrade", "degc", "°c"], 273.15),
            s("f", 5.0 / 9.0, "°F", "Fahrenheit", ["fahrenheit", "degf", "°f"], 459.67),
            s("k", 1, "K", "Kelvin", ["kelvin", "kelvins"], 0),
        ]),
        (.area, [
            s("ha", 1e4, "ha", "hectares", ["hectare"]),
            s("acre", 4046.8564224, "ac", "acres", ["ac", "acres"]),
        ]),
        (.speed, [
            s("kn", 1852.0 / 3600, "kn", "knots", ["kt", "kts", "knot"]),
            s("mph", 1609.344 / 3600, "mph", "miles per hour", ["mph"]),
            s("kmh", 1000.0 / 3600, "km/h", "kilometers per hour", ["kph", "kmh", "kmph", "kph"]),
            s("mps", 1, "m/s", "meters per second", ["mps"]),
            s("fps", 0.3048, "ft/s", "feet per second", ["fps"]),
            s("mach", 343, "Mach", "Mach", ["mach"]),
        ]),
        (.data, [
            s("bit", 1.0 / 8, "bit", "bits", ["bits"]),
            s("B", 1, "B", "bytes", ["b", "byte", "bytes"]),
            s("kB", 1e3, "kB", "kilobytes", ["kb", "kilobyte"]),
            s("MB", 1e6, "MB", "megabytes", ["mb", "megabyte"]),
            s("GB", 1e9, "GB", "gigabytes", ["gb", "gigabyte", "gig", "gigs"]),
            s("TB", 1e12, "TB", "terabytes", ["tb", "terabyte"]),
            s("PB", 1e15, "PB", "petabytes", ["pb", "petabyte"]),
            s("KiB", 1024, "KiB", "kibibytes", ["kib", "kibibyte"]),
            s("MiB", 1_048_576, "MiB", "mebibytes", ["mib", "mebibyte"]),
            s("GiB", 1_073_741_824, "GiB", "gibibytes", ["gib", "gibibyte"]),
            s("TiB", 1_099_511_627_776, "TiB", "tebibytes", ["tib", "tebibyte"]),
            s("kbit", 1e3 / 8, "kbit", "kilobits", ["kbit", "kilobit", "kbps"]),
            s("Mbit", 1e6 / 8, "Mbit", "megabits", ["mbit", "megabit", "mbps"]),
            s("Gbit", 1e9 / 8, "Gbit", "gigabits", ["gbit", "gigabit", "gbps"]),
            s("Tbit", 1e12 / 8, "Tbit", "terabits", ["tbit", "terabit"]),
        ]),
        (.time, [
            s("ns", 1e-9, "ns", "nanoseconds", ["nanosecond"]),
            s("us", 1e-6, "µs", "microseconds", ["µs", "microsecond"]),
            s("ms", 1e-3, "ms", "milliseconds", ["millisecond", "msec", "msecs"]),
            s("s", 1, "s", "seconds", ["sec", "secs", "second"]),
            s("min", 60, "min", "minutes", ["mins", "minute"]),
            s("h", 3600, "h", "hours", ["hr", "hrs", "hour"]),
            s("d", 86_400, "d", "days", ["day"]),
            s("wk", 604_800, "wk", "weeks", ["w", "wks", "week"]),
            s("mo", 2_629_746, "mo", "months", ["month", "mos"]),
            s("yr", 31_556_952, "yr", "years", ["y", "yrs", "year"]),
            s("decade", 315_569_520, "decades", "decades", ["decade"]),
            s("century", 3_155_695_200, "centuries", "centuries", ["century", "centuries"]),
        ]),
    ]

    struct Tables: Sendable {
        var byAlias: [String: UnitDef] = [:]
        var byId: [String: UnitDef] = [:]
        var lengthIds: Set<String> = []
    }

    static let tables: Tables = {
        var t = Tables()
        for (dim, list) in specs {
            for sp in list {
                let def = UnitDef(id: "\(dim.rawValue):\(sp.id)", dim: dim, factor: sp.factor, offset: sp.offset, symbol: sp.symbol, name: sp.name)
                t.byId[def.id] = def
                if dim == .length { t.lengthIds.insert(sp.id) }
                for a in [sp.id.lowercased(), sp.symbol.lowercased(), sp.name.lowercased()] + sp.aliases.map({ $0.lowercased() }) where t.byAlias[a] == nil {
                    t.byAlias[a] = def
                }
            }
        }
        return t
    }()

    static func plainLookup(_ token: String) -> UnitDef? {
        if let hit = tables.byAlias[token] { return hit }
        if token.hasSuffix("es"), let h = tables.byAlias[String(token.dropLast(2))] { return h }
        if token.hasSuffix("s") && token.count > 2 { return tables.byAlias[String(token.dropLast())] }
        return nil
    }

    /// "sq ft", "square meters", "km2", "m²" → area; "cubic feet", "cm3" → volume.
    static func poweredLength(_ token: String) -> UnitDef? {
        var power = 0
        var rest = token
        if let pre = ConvertRegex.match("^(sq|square|cu|cubic)\\s+(.+)$", rest), let p1 = pre[1], let p2 = pre[2] {
            power = p1.hasPrefix("s") ? 2 : 3
            rest = p2
        } else if let post = ConvertRegex.match("^(.+?)\\s*(?:\\^?([23])|([²³]))$", rest), let base = post[1] {
            if let d = post[2] { power = Int(d) ?? 2 } else { power = post[3] == "²" ? 2 : 3 }
            rest = base
        } else { return nil }
        guard let len = plainLookup(rest), len.dim == .length, tables.lengthIds.contains(String(len.id.dropFirst("length:".count))) else { return nil }
        let sym = "\(len.symbol)\(power == 2 ? "²" : "³")"
        if power == 2 { return UnitDef(id: "area:\(len.symbol)2", dim: .area, factor: len.factor * len.factor, symbol: sym, name: "square \(len.name)") }
        return UnitDef(id: "volume:\(len.symbol)3", dim: .volume, factor: pow(len.factor, 3) * 1000, symbol: sym, name: "cubic \(len.name)")
    }

    /// "km/h", "miles per hour", "ft/s" → speed.
    static func compoundSpeed(_ token: String) -> UnitDef? {
        guard let m = ConvertRegex.match("^(.+?)\\s*(?:/|\\bper\\b|\\bp\\b)\\s*(.+)$", token), let l = m[1], let r = m[2] else { return nil }
        guard let a = lookup(l), let b = lookup(r), a.dim == .length, b.dim == .time else { return nil }
        let singular = b.name.hasSuffix("s") ? String(b.name.dropLast()) : b.name
        return UnitDef(id: "speed:\(a.symbol)/\(b.symbol)", dim: .speed, factor: a.factor / b.factor, symbol: "\(a.symbol)/\(b.symbol)", name: "\(a.name) per \(singular)")
    }

    /// Resolve a unit name typed by the user ("Miles", "°F", "Mb", "sq ft").
    public static func lookup(_ raw: String) -> UnitDef? {
        var trimmed = raw.trimmingCharacters(in: .whitespaces)
        if trimmed.hasSuffix(".") { trimmed.removeLast() }
        guard !trimmed.isEmpty else { return nil }
        // "Mb"/"Gb" (capital prefix, lowercase b) is the networking spelling for bits.
        if let bits = ConvertRegex.match("^([kKMGTP])b$", trimmed), let p = bits[1], trimmed.first != "k" {
            let id = trimmed == "Kb" ? "data:kbit" : "data:\(p.uppercased())bit"
            if let bit = tables.byId[id] { return bit }
        }
        var token = trimmed.lowercased()
        token = ConvertRegex.replace("^degrees?\\s+", in: token, with: "")
        token = ConvertRegex.replace("^°\\s*", in: token, with: "")
        token = ConvertRegex.replace("\\s+", in: token, with: " ")
        return plainLookup(token) ?? poweredLength(token) ?? compoundSpeed(token) ?? (token == "m/s" ? tables.byId["speed:mps"] : nil)
    }

    public static func toBase(_ v: Double, _ u: UnitDef) -> Double { (v + u.offset) * u.factor }
    public static func fromBase(_ b: Double, _ u: UnitDef) -> Double { b / u.factor - u.offset }
    public static func convert(_ v: Double, from: UnitDef, to: UnitDef) -> Double? {
        guard from.dim == to.dim else { return nil }
        return fromBase(toBase(v, from), to)
    }

    public struct Conversion: Sendable {
        public var dim: Dimension
        public var from: [(amount: Double, unit: UnitDef)]
        public var to: UnitDef
        public var value: Double
    }

    /// Split "<source> in <target>" at the last separator (so "5 in in cm" works).
    static func splitQuery(_ q: String) -> (String, String)? {
        let ms = ConvertRegex.matches("\\s+(?:in|to|into|as)(?=\\s)|\\s*(?:=|->|→|>)\\s*", q, [.caseInsensitive])
        guard let last = ms.last else { return nil }
        let ns = q as NSString
        let left = ns.substring(to: last.range.location).trimmingCharacters(in: .whitespaces)
        let right = ns.substring(from: last.range.location + last.range.length).trimmingCharacters(in: .whitespaces)
        return (left, right)
    }

    /// "5 ft 10 in" → [(5, "ft"), (10, "in")]; "100f" → [(100, "f")].
    static func sourceTerms(_ src: String) -> [(Double, String)]? {
        let s = src.trimmingCharacters(in: .whitespaces) as NSString
        guard let re = ConvertRegex.regex("([-+]?(?:\\d[\\d,_]*\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)\\s*([^\\d\\s][^\\d]*?)\\s*(?=[-+]?\\d|\\.\\d|$)") else { return nil }
        var out: [(Double, String)] = []
        var pos = 0
        while pos < s.length {
            guard let m = re.firstMatch(in: s as String, options: [.anchored], range: NSRange(location: pos, length: s.length - pos)), m.range.length > 0 else { return nil }
            guard let amount = ConvertFormat.parseAmount(s.substring(with: m.range(at: 1))) else { return nil }
            out.append((amount, s.substring(with: m.range(at: 2)).trimmingCharacters(in: .whitespaces)))
            pos = m.range.location + m.range.length
            while pos < s.length && s.character(at: pos) == 32 { pos += 1 }
        }
        return out.isEmpty ? nil : out
    }

    /// Parse and evaluate a unit conversion query; nil when the text is not one.
    public static func parse(_ query: String) -> Conversion? {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.contains(where: { $0.isASCII && $0.isNumber }), let (src, dst) = splitQuery(q), let to = lookup(dst), let terms = sourceTerms(src) else { return nil }
        var from: [(amount: Double, unit: UnitDef)] = []
        for (amount, name) in terms {
            guard let unit = lookup(name), unit.dim == to.dim else { return nil }
            from.append((amount, unit))
        }
        if from.count > 1 && to.dim == .temperature { return nil }
        let base = from.reduce(0) { $0 + toBase($1.amount, $1.unit) }
        return Conversion(dim: to.dim, from: from, to: to, value: fromBase(base, to))
    }
}
