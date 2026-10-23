import Foundation
@testable import GlideFeatures
import Testing

private func close(_ a: Double?, _ b: Double, _ digits: Int = 4) -> Bool {
    guard let a else { return false }
    return abs(a - b) < pow(10, Double(-digits)) / 2 * 10
}
private func conv(_ q: String) -> Double? { ConvertUnits.parse(q)?.value }

private func localCal(_ zone: String = "UTC") -> Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: zone)!
    return c
}
private func date(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 0, _ mi: Int = 0, cal: Calendar = localCal()) -> Date {
    cal.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: mi))!
}

@Suite("convert: format") struct ConvertFormatTests {
    @Test func numbers() {
        #expect(ConvertFormat.plainNumber(0.1 + 0.2) == "0.3")
        #expect(ConvertFormat.plainNumber(3.106855961) == "3.10686")
        #expect(ConvertFormat.groupedNumber(1234567.891) == "1,234,570")
        #expect(ConvertFormat.groupedNumber(-1234.5) == "-1,234.5")
        #expect(ConvertFormat.plainNumber(1e-9) == "1e-9")
        #expect(ConvertFormat.plainNumber(3000) == "3000")
    }
    @Test func amounts() {
        #expect(ConvertFormat.parseAmount("1,000.5") == 1000.5)
        #expect(ConvertFormat.parseAmount("1.5k") == nil)
        #expect(ConvertFormat.parseAmount("1.5k", allowSuffix: true) == 1500)
        #expect(ConvertFormat.parseAmount("abc") == nil)
    }
}

@Suite("convert: units") struct ConvertUnitTests {
    @Test func lengthMassVolume() {
        #expect(close(conv("5 km in miles"), 3.10686))
        #expect(close(conv("5km to mi"), 3.10686))
        #expect(close(conv("6 ft in cm"), 182.88))
        #expect(close(conv("5 ft 10 in to cm"), 177.8))
        #expect(close(conv("5 in in cm"), 12.7))
        #expect(close(conv("10 kg in lbs"), 22.0462))
        #expect(close(conv("1 gallon in liters"), 3.78541))
        #expect(close(conv("2 cups to ml"), 473.176, 2))
        #expect(close(conv("1 lb to oz"), 16))
    }
    @Test func temperatures() {
        #expect(close(conv("100f to c"), 37.7778))
        #expect(close(conv("100 °F in °C"), 37.7778))
        #expect(close(conv("0 c in f"), 32))
        #expect(close(conv("-40 c to f"), -40))
        #expect(close(conv("0 k in c"), -273.15))
        #expect(close(conv("20 celsius to kelvin"), 293.15))
    }
    @Test func areaSpeedDataTime() {
        #expect(close(conv("1 acre in m2"), 4046.86, 1))
        #expect(close(conv("100 sq ft in square meters"), 9.2903))
        #expect(close(conv("1 km² in ha"), 100))
        #expect(close(conv("60 mph in km/h"), 96.5606))
        #expect(close(conv("100 km/h to m/s"), 27.7778))
        #expect(close(conv("10 miles per hour in kph"), 16.0934))
        #expect(conv("3 gb in mb") == 3000)
        #expect(conv("1 GiB in MiB") == 1024)
        #expect(close(conv("100 Mb in MB"), 12.5))
        #expect(close(conv("90 min in hours"), 1.5))
        #expect(close(conv("1h 30min in minutes"), 90))
        #expect(close(conv("2 weeks in days"), 14))
        #expect(close(conv("1 cubic meter in liters"), 1000))
    }
    @Test func rejects() {
        for q in ["5 km in kg", "safari", "100 usd in eur", "5 km", "1 in"] { #expect(ConvertUnits.parse(q) == nil, "\(q)") }
        #expect(ConvertUnits.lookup("Mb")?.id == "data:Mbit")
        #expect(ConvertUnits.lookup("mb")?.id == "data:MB")
        #expect(ConvertUnits.lookup("Miles")?.id == "length:mi")
    }
}

let testTable = ConvertCurrency.RateTable(base: "USD", rates: ["EUR": 0.9, "GBP": 0.8, "JPY": 150, "NGN": 1500], date: "2026-10-20", fetchedAt: 0, source: "test")

@Suite("convert: currency") struct ConvertCurrencyTests {
    @Test func parses() {
        #expect(ConvertCurrency.parse("100 usd in eur") == .init(amount: 100, from: "USD", to: "EUR"))
        #expect(ConvertCurrency.parse("€50 to gbp") == .init(amount: 50, from: "EUR", to: "GBP"))
        #expect(ConvertCurrency.parse("50€ in $") == .init(amount: 50, from: "EUR", to: "USD"))
        #expect(ConvertCurrency.parse("1.5k euros in naira") == .init(amount: 1500, from: "EUR", to: "NGN"))
        #expect(ConvertCurrency.parse("$20") == .init(amount: 20, from: "USD", to: nil))
        #expect(ConvertCurrency.parse("100 abc in eur") == nil)
        #expect(ConvertCurrency.parse("hello") == nil)
        #expect(ConvertCurrency.lookup("C$") == "CAD")
        #expect(ConvertCurrency.isoCodes.count >= 150)
    }
    @Test func convertsAndFormats() {
        #expect(close(ConvertCurrency.convert(100, from: "USD", to: "EUR", table: testTable), 90))
        #expect(close(ConvertCurrency.convert(90, from: "EUR", to: "GBP", table: testTable), 80))
        #expect(ConvertCurrency.convert(1, from: "USD", to: "XYZ", table: testTable) == nil)
        #expect(ConvertCurrency.formatMoney(1234.5, "EUR") == "€1,234.50")
        #expect(ConvertCurrency.formatMoney(15000, "JPY") == "¥15,000")
        #expect(ConvertCurrency.formatMoney(12, "SEK") == "12.00 SEK")
    }
}

@Suite("convert: rates store", .serialized) @MainActor struct ConvertRatesTests {
    func tmpFile() -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("n1-rates-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("rates.json")
    }

    @Test func fetchesOnceCachesAndReusesWhileFresh() async throws {
        let server = try N1StubHTTPServer()
        defer { server.stop() }
        let file = tmpFile()
        var now = 1_000_000.0
        let providers = ConvertRatesStore.defaultProviders(environment: ["GLIDE_CONVERT_RATES_BASE_URL": server.baseURL])
        let store = ConvertRatesStore(file: file, providers: providers, fetcher: ConvertRatesStore.urlSessionFetcher, now: { now })
        #expect(store.current == nil)
        async let a = store.refresh()
        async let b = store.refresh()
        let (ta, tb) = await (a, b)
        #expect(ta?.rates["EUR"] == 0.9)
        #expect(tb == ta)
        #expect(server.hits("/v6/latest/USD") == 1) // deduplicated
        #expect(store.isFresh)
        await store.refresh()
        #expect(server.hits("/v6/latest/USD") == 1)
        // A new process reads the disk cache (same JSON shape as Electron's rates.json).
        let again = ConvertRatesStore(file: file, providers: providers, fetcher: ConvertRatesStore.urlSessionFetcher, now: { now })
        #expect(again.current?.rates["EUR"] == 0.9)
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        #expect(raw?["base"] as? String == "USD")
        #expect(raw?["source"] as? String == "ExchangeRate-API")
        now += ConvertRatesStore.ttlMs + 1
        #expect(!again.isFresh)
        await again.refresh()
        #expect(server.hits("/v6/latest/USD") == 2)
    }

    @Test func fallsBackToFrankfurterThenKeepsStaleCacheOffline() async throws {
        let server = try N1StubHTTPServer(failER: true)
        defer { server.stop() }
        let providers = ConvertRatesStore.defaultProviders(environment: ["GLIDE_CONVERT_RATES_BASE_URL": server.baseURL])
        let store = ConvertRatesStore(file: tmpFile(), providers: providers, fetcher: ConvertRatesStore.urlSessionFetcher)
        let t = await store.refresh()
        #expect(t?.source == "ECB via Frankfurter")
        #expect(t?.rates["EUR"] == 0.86)
        #expect(server.hits("/frankfurter/latest") == 1)

        let file = tmpFile()
        try JSONEncoder().encode(testTable).write(to: file)
        let offline = ConvertRatesStore(file: file, providers: providers, fetcher: { _ in throw URLError(.notConnectedToInternet) }, now: { ConvertRatesStore.ttlMs * 2 })
        let stale = await offline.refresh()
        #expect(stale?.date == "2026-10-20")
        #expect(offline.lastError?.contains("ExchangeRate-API") == true)
        #expect(offline.requestCount == 2)
        await offline.refresh() // rate-limited after a failure
        #expect(offline.requestCount == 2)
    }
}

@Suite("convert: time zones") struct ConvertTimeZoneTests {
    let now = Date(timeIntervalSince1970: 1_792_497_600).timeIntervalSince1970 * 1000 // Tue Oct 20 2026 12:00 UTC

    @Test func clocks() {
        #expect(ConvertTimeZones.parseClock("5pm")! == (17, 0))
        #expect(ConvertTimeZones.parseClock("12am")! == (0, 0))
        #expect(ConvertTimeZones.parseClock("9:30 am")! == (9, 30))
        #expect(ConvertTimeZones.parseClock("17:45")! == (17, 45))
        #expect(ConvertTimeZones.parseClock("5") == nil)
        #expect(ConvertTimeZones.parseClock("13pm") == nil)
    }
    @Test func zones() {
        #expect(ConvertTimeZones.lookupZone("tokyo", localZone: "UTC")?.zone == "Asia/Tokyo")
        #expect(ConvertTimeZones.lookupZone("NYC", localZone: "UTC")?.zone == "America/New_York")
        #expect(ConvertTimeZones.lookupZone("pst", localZone: "UTC")?.zone == "America/Los_Angeles")
        #expect(ConvertTimeZones.lookupZone("Europe/Paris", localZone: "UTC")?.zone == "Europe/Paris")
        #expect(ConvertTimeZones.lookupZone("utc+3", localZone: "UTC")?.zone == "Etc/GMT-3")
        #expect(ConvertTimeZones.lookupZone("narnia", localZone: "UTC") == nil)
        #expect(ConvertTimeZones.offsetMinutes("Asia/Tokyo", now) == 540)
        #expect(ConvertTimeZones.offsetMinutes("Europe/London", now) == 60)
    }
    @Test func conversions() throws {
        let r = try #require(ConvertTimeZones.parse("5pm london in tokyo", nowMs: now, localZone: "UTC"))
        #expect(r.time == "1:00 AM")
        #expect(r.fromTime == "5:00 PM")
        #expect(r.dayDelta == 1)
        #expect(r.offset == "GMT+9")
        #expect(r.iso == "2026-10-21T01:00:00+09:00")
        #expect(ConvertTimeZones.parse("time in nyc", nowMs: now, localZone: "UTC")?.time == "8:00 AM")
        #expect(ConvertTimeZones.parse("tokyo time", nowMs: now, localZone: "UTC")?.time == "9:00 PM")
        #expect(ConvertTimeZones.parse("3pm in sydney", nowMs: now, localZone: "Europe/London")?.time == "1:00 AM")
        #expect(ConvertTimeZones.parse("9am pst", nowMs: now, localZone: "America/New_York")?.time == "12:00 PM")
        #expect(ConvertTimeZones.parse("5pm", nowMs: now, localZone: "UTC") == nil)
        #expect(ConvertTimeZones.parse("5 km in miles", nowMs: now, localZone: "UTC") == nil)
    }
}

@Suite("convert: dates") struct ConvertDateTests {
    let cal = localCal("America/New_York")
    var now: Date { date(2026, 10, 20, 15, 30, cal: cal) }
    func d(_ q: String) -> Date? { if case let .date(x, _, _) = ConvertDates.parse(q, now: now, cal: cal) { return x }; return nil }
    func count(_ q: String) -> Int? { if case let .count(n, _, _, _, _, _) = ConvertDates.parse(q, now: now, cal: cal) { return n }; return nil }

    @Test func parsesDates() {
        #expect(ConvertDates.parseDate("dec 25", now: now, cal: cal)?.date == date(2026, 12, 25, cal: cal))
        #expect(ConvertDates.parseDate("25th of december 2027", now: now, cal: cal)?.date == date(2027, 12, 25, cal: cal))
        #expect(ConvertDates.parseDate("2026-02-30", now: now, cal: cal) == nil)
        #expect(ConvertDates.parseDate("12/25", now: now, cal: cal)?.date == date(2026, 12, 25, cal: cal))
        #expect(ConvertDates.parseDate("next friday", now: now, cal: cal)?.date == date(2026, 10, 23, cal: cal))
        #expect(ConvertDates.parseDate("christmas", now: now, cal: cal)?.date == date(2026, 12, 25, cal: cal))
        #expect(ConvertDates.parseDate("marble 3", now: now, cal: cal) == nil)
    }
    @Test func counts() {
        #expect(count("days until dec 25") == 66)
        #expect(count("days since jan 1") == 292)
        #expect(count("days between mar 1 and jun 30") == 121)
        if case let .count(days, unit, from, to, _, _) = ConvertDates.parse("weeks until christmas", now: now, cal: cal) {
            #expect(ConvertDates.countValue(days: days, unit: unit, from: from, to: to, cal: cal).label == "9.4 weeks")
        } else { Issue.record("no count") }
        if case let .count(_, _, _, to, _, _) = ConvertDates.parse("days until jan 1", now: now, cal: cal) {
            #expect(cal.component(.year, from: to) == 2027)
        }
        #expect(ConvertDates.daysBetween(date(2026, 3, 7, cal: cal), date(2026, 3, 9, cal: cal), cal: cal) == 2) // across DST
    }
    @Test func arithmetic() {
        #expect(d("today + 3 weeks") == date(2026, 11, 10, cal: cal))
        #expect(d("today - 1 month") == date(2026, 9, 20, cal: cal))
        #expect(d("jan 31 2026 + 1 month") == date(2026, 2, 28, cal: cal))
        #expect(d("christmas - 10 days") == date(2026, 12, 15, cal: cal))
        #expect(d("2026-12-25 + 1 week") == date(2027, 1, 1, cal: cal))
        #expect(d("90 days from now") == date(2027, 1, 18, 15, 30, cal: cal))
        #expect(d("2 weeks ago") == date(2026, 10, 6, cal: cal))
        #expect(d("in 3 days") == date(2026, 10, 23, cal: cal))
        #expect(d("now + 90 min") == date(2026, 10, 20, 17, 0, cal: cal))
        #expect(ConvertDates.parse("hello world", now: now, cal: cal) == nil)
    }
}

@Suite("convert: engine") struct ConvertEngineTests {
    func ctx(_ rates: ConvertCurrency.RateTable? = nil, stale: Bool = false, loading: Bool = false, enabled: Bool = true) -> ConvertEngine.Context {
        ConvertEngine.Context(nowMs: date(2026, 10, 20, 15, 30).timeIntervalSince1970 * 1000, localZone: "UTC", rates: rates, ratesStale: stale, ratesLoading: loading, currencyEnabled: enabled)
    }
    @Test func routes() throws {
        let u = try #require(ConvertEngine.convert("5 km in miles", ctx()).results.first)
        #expect(u.title == "3.10686 mi")
        #expect(u.copy == "3.10686 mi")
        #expect(u.more.first?.text == "3.10686")
        #expect(ConvertEngine.convert("days until dec 25", ctx()).results.first?.title == "66 days")
        #expect(ConvertEngine.convert("time in tokyo", ctx()).results.first?.category == .timezone)
        #expect(ConvertEngine.convert("1 + 2", ctx()).results.isEmpty)
        #expect(ConvertEngine.convert("safari", ctx()).results.isEmpty)
    }
    @Test func currencyNeedsRates() throws {
        let o = ConvertEngine.convert("100 usd in eur", ctx())
        #expect(o.results.isEmpty && o.wantsRates)
        #expect(!ConvertEngine.convert("5 km in miles", ctx()).wantsRates)
        #expect(ConvertEngine.convert("100 usd in eur", ctx(loading: true)).results.first?.title.hasPrefix("Fetching") == true)
        let r = try #require(ConvertEngine.convert("100 usd in eur", ctx(testTable, stale: true)).results.first)
        #expect(r.title == "€90.00")
        #expect(r.copy == "90.00")
        #expect(r.subtitle.contains("rates from 2026-10-20"))
        #expect(ConvertEngine.convert("50 eur", ctx(testTable)).results.first?.title == "$55.56")
        #expect(!ConvertEngine.convert("100 usd in eur", ctx(enabled: false)).wantsRates)
    }
}

