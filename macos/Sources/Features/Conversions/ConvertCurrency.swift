import Foundation

/// Currency parsing and maths (port of convert/currency.ts): "100 usd in eur", "€50 to gbp", "50 euros in naira", "$20".
public enum ConvertCurrency {
    static let names: [String: String] = [
        "dollar": "USD", "dollars": "USD", "buck": "USD", "bucks": "USD", "us dollar": "USD", "us dollars": "USD",
        "euro": "EUR", "euros": "EUR",
        "pound": "GBP", "pounds": "GBP", "quid": "GBP", "sterling": "GBP", "british pound": "GBP", "british pounds": "GBP",
        "yen": "JPY", "yuan": "CNY", "renminbi": "CNY", "rmb": "CNY",
        "rupee": "INR", "rupees": "INR", "naira": "NGN", "cedi": "GHS", "cedis": "GHS", "rand": "ZAR", "shilling": "KES", "shillings": "KES",
        "franc": "CHF", "francs": "CHF", "swiss franc": "CHF", "swiss francs": "CHF",
        "won": "KRW", "peso": "MXN", "pesos": "MXN", "real": "BRL", "reais": "BRL", "ruble": "RUB", "rubles": "RUB", "rouble": "RUB", "roubles": "RUB",
        "lira": "TRY", "krona": "SEK", "kronor": "SEK", "krone": "NOK", "kroner": "NOK", "zloty": "PLN", "forint": "HUF", "baht": "THB",
        "dirham": "AED", "dirhams": "AED", "riyal": "SAR", "riyals": "SAR", "ringgit": "MYR", "rupiah": "IDR", "dong": "VND", "shekel": "ILS", "shekels": "ILS",
        "canadian dollar": "CAD", "canadian dollars": "CAD", "australian dollar": "AUD", "australian dollars": "AUD",
        "hong kong dollar": "HKD", "singapore dollar": "SGD", "new zealand dollar": "NZD",
    ]

    /// Currency symbols; "$" means USD unless prefixed (C$, A$, …). Order matters (longest first).
    static let symbols: [(String, String)] = [
        ("US$", "USD"), ("C$", "CAD"), ("CA$", "CAD"), ("A$", "AUD"), ("AU$", "AUD"), ("NZ$", "NZD"), ("HK$", "HKD"), ("S$", "SGD"), ("R$", "BRL"), ("MX$", "MXN"),
        ("$", "USD"), ("€", "EUR"), ("£", "GBP"), ("¥", "JPY"), ("₹", "INR"), ("₩", "KRW"), ("₽", "RUB"), ("₺", "TRY"), ("₦", "NGN"), ("₱", "PHP"),
        ("₫", "VND"), ("₪", "ILS"), ("฿", "THB"), ("₴", "UAH"), ("₵", "GHS"), ("zł", "PLN"), ("kr", "SEK"), ("Fr", "CHF"),
    ]

    static let symbolOf: [String: String] = ["USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "INR": "₹", "KRW": "₩", "NGN": "₦", "RUB": "₽", "TRY": "₺",
                                             "PHP": "₱", "ILS": "₪", "THB": "฿", "UAH": "₴", "GHS": "₵", "VND": "₫"]

    /// ISO 4217 codes in circulation (~160; used before a rate table is cached so "100 abc" never fetches).
    public static let isoCodes: Set<String> = Set(("AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK " +
        "DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF " +
        "KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP " +
        "PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU " +
        "UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL").split(separator: " ").map(String.init))

    static let zeroDecimals: Set<String> = ["JPY", "KRW", "VND", "IDR", "CLP", "HUF", "ISK", "UGX"]

    /// Rates relative to `base`: 1 base = rates[code] code. Same JSON shape as the Electron rates.json cache.
    public struct RateTable: Codable, Sendable, Equatable {
        public var base: String
        public var rates: [String: Double]
        public var date: String
        public var fetchedAt: Double
        public var source: String
        public init(base: String, rates: [String: Double], date: String, fetchedAt: Double, source: String) {
            self.base = base
            self.rates = rates
            self.date = date
            self.fetchedAt = fetchedAt
            self.source = source
        }
        public func knows(_ code: String) -> Bool { code == base || rates[code] != nil }
    }

    public struct Query: Equatable, Sendable {
        public var amount: Double
        public var from: String
        public var to: String?
    }

    public static func lookup(_ raw: String, known: ((String) -> Bool)? = nil) -> String? {
        let t = raw.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return nil }
        for (sym, code) in symbols where t == sym { return code }
        let lower = ConvertRegex.replace("\\s+", in: t.lowercased(), with: " ")
        if let n = names[lower] { return n }
        if t.count == 3, t.allSatisfy({ $0.isASCII && $0.isLetter }) {
            let code = t.uppercased()
            if known?(code) ?? true { return code }
        }
        return nil
    }

    static let amountPattern = "[-+]?(?:\\d[\\d,_]*\\.?\\d*|\\.\\d+)(?:\\s*[kmbKMB]\\b)?"
    static var symbolPattern: String { symbols.map { NSRegularExpression.escapedPattern(for: $0.0) }.joined(separator: "|") }

    static func parseSource(_ src: String, _ known: @escaping (String) -> Bool) -> (amount: Double, from: String)? {
        let s = src.trimmingCharacters(in: .whitespaces)
        if let pre = ConvertRegex.match("^(\(symbolPattern))\\s*(\(amountPattern))$", s, [.caseInsensitive]), let sym = pre[1], let amt = pre[2] {
            guard let from = lookup(sym, known: known), let amount = ConvertFormat.parseAmount(amt.replacingOccurrences(of: " ", with: ""), allowSuffix: true) else { return nil }
            return (amount, from)
        }
        if let suf = ConvertRegex.match("^(\(amountPattern))\\s*(.+)$", s, [.caseInsensitive]), let amt = suf[1], let unit = suf[2] {
            guard let from = lookup(unit, known: known), let amount = ConvertFormat.parseAmount(amt.replacingOccurrences(of: " ", with: ""), allowSuffix: true) else { return nil }
            return (amount, from)
        }
        return nil
    }

    /// Parse a currency query. Without a target ("$20", "50 eur") the caller converts to the default currency.
    public static func parse(_ query: String, known: @escaping (String) -> Bool = { isoCodes.contains($0) }) -> Query? {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.contains(where: { $0.isASCII && $0.isNumber }), q.count <= 60 else { return nil }
        if let m = ConvertRegex.matches("\\s+(?:in|to|into|as)\\s+|\\s*(?:=|->|→)\\s*", q, [.caseInsensitive]).first {
            let ns = q as NSString
            guard let src = parseSource(ns.substring(to: m.range.location), known),
                  let to = lookup(ns.substring(from: m.range.location + m.range.length), known: known) else { return nil }
            return Query(amount: src.amount, from: src.from, to: to)
        }
        guard let src = parseSource(q, known) else { return nil }
        return Query(amount: src.amount, from: src.from, to: nil)
    }

    public static func convert(_ amount: Double, from: String, to: String, table: RateTable) -> Double? {
        func rate(_ c: String) -> Double? { c == table.base ? 1 : table.rates[c] }
        guard let a = rate(from), let b = rate(to), a > 0, b > 0 else { return nil }
        return amount / a * b
    }

    public static func decimals(_ code: String) -> Int { zeroDecimals.contains(code) ? 0 : 2 }

    /// "€1,234.50" / "1,234.50 SEK" for display.
    public static func formatMoney(_ value: Double, _ code: String) -> String {
        let d = abs(value) < 1 && value != 0 ? 4 : decimals(code)
        let num = ConvertFormat.group(ConvertFormat.toFixed(abs(value), d))
        let signed = (value < 0 ? "-" : "") + num
        if let sym = symbolOf[code] { return "\(sym)\(signed)" }
        return "\(signed) \(code)"
    }

    /// Plain number for copying ("1234.50").
    public static func plainMoney(_ value: Double, _ code: String) -> String {
        let d = abs(value) < 1 && value != 0 ? 4 : decimals(code)
        return ConvertFormat.toFixed(value, d)
    }
}
