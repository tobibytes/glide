import Foundation

/// Exchange rates (port of convert/rates.ts): fetched only when a currency query is typed, cached on disk
/// (`<data>/features/convert/rates.json`, same JSON as Electron) for 6 h, served stale when offline.
/// Providers need no API key: open.er-api.com (~160 currencies), then api.frankfurter.app (ECB) as fallback.
/// `GLIDE_CONVERT_RATES_BASE_URL` (e.g. `http://127.0.0.1:8123`) points both providers at a local stub.
@MainActor public final class ConvertRatesStore {
    public static let ttlMs: Double = 6 * 60 * 60 * 1000
    static let retryAfterMs: Double = 60 * 1000
    nonisolated static let fetchTimeout: TimeInterval = 6

    public typealias Fetcher = @Sendable (URL) async throws -> (status: Int, body: Data)

    public struct Provider: Sendable {
        public var name: String
        public var url: URL
        public var parse: @Sendable (Data, Double) -> ConvertCurrency.RateTable?
    }

    public let file: URL
    let fetcher: Fetcher
    let providers: [Provider]
    let now: () -> Double
    private var table: ConvertCurrency.RateTable?
    private var loaded = false
    private var inflight: Task<ConvertCurrency.RateTable?, Never>?
    private var failedAt: Double = 0
    public private(set) var lastError: String?
    /// Number of network requests made (tests).
    public private(set) var requestCount = 0

    public init(file: URL, providers: [Provider], fetcher: @escaping Fetcher, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.file = file
        self.providers = providers
        self.fetcher = fetcher
        self.now = now
    }

    // MARK: providers

    nonisolated static func cleanRates(_ raw: Any?) -> [String: Double]? {
        guard let dict = raw as? [String: Any] else { return nil }
        var out: [String: Double] = [:]
        for (k, v) in dict {
            guard k.count == 3, k.allSatisfy({ $0.isASCII && $0.isUppercase }) else { continue }
            if let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() {
                let d = n.doubleValue
                if d > 0 && d.isFinite { out[k] = d }
            }
        }
        return out.isEmpty ? nil : out
    }

    nonisolated static func isoDay(_ ms: Double) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    nonisolated public static func defaultProviders(environment: [String: String] = ProcessInfo.processInfo.environment) -> [Provider] {
        let override = environment["GLIDE_CONVERT_RATES_BASE_URL"].flatMap { $0.isEmpty ? nil : $0.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
        let erURL = URL(string: override.map { "\($0)/v6/latest/USD" } ?? "https://open.er-api.com/v6/latest/USD")
        let ffURL = URL(string: override.map { "\($0)/frankfurter/latest?from=USD" } ?? "https://api.frankfurter.app/latest?from=USD")
        var out: [Provider] = []
        if let erURL {
            out.append(Provider(name: "ExchangeRate-API", url: erURL) { data, now in
                guard let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], body["result"] as? String == "success",
                      let rates = cleanRates(body["rates"]) else { return nil }
                let unix = (body["time_last_update_unix"] as? NSNumber).map { $0.doubleValue * 1000 } ?? now
                return ConvertCurrency.RateTable(base: "USD", rates: rates, date: isoDay(unix), fetchedAt: now, source: "ExchangeRate-API")
            })
        }
        if let ffURL {
            out.append(Provider(name: "Frankfurter (ECB)", url: ffURL) { data, now in
                guard let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let rates = cleanRates(body["rates"]) else { return nil }
                return ConvertCurrency.RateTable(base: "USD", rates: rates, date: (body["date"] as? String) ?? isoDay(now), fetchedAt: now, source: "ECB via Frankfurter")
            })
        }
        return out
    }

    nonisolated public static let urlSessionFetcher: Fetcher = { url in
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: fetchTimeout)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = fetchTimeout
        cfg.timeoutIntervalForResource = fetchTimeout
        let session = URLSession(configuration: cfg)
        defer { session.finishTasksAndInvalidate() }
        let (data, resp) = try await session.data(for: req)
        return ((resp as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    // MARK: cache

    private func load() {
        guard !loaded else { return }
        loaded = true
        if let data = try? Data(contentsOf: file), let t = try? JSONDecoder().decode(ConvertCurrency.RateTable.self, from: data) { table = t }
    }

    private func save(_ t: ConvertCurrency.RateTable) {
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(t).write(to: file, options: .atomic)
        } catch {
            lastError = "could not save rates: \(error.localizedDescription)"
        }
    }

    public var current: ConvertCurrency.RateTable? { load(); return table }
    public var isFresh: Bool { load(); return table.map { now() - $0.fetchedAt < Self.ttlMs } ?? false }
    public var isFetching: Bool { inflight != nil }

    /// Fetch when stale (deduplicated, rate-limited after failures). Returns the best table available.
    @discardableResult
    public func refresh(force: Bool = false) async -> ConvertCurrency.RateTable? {
        load()
        if !force && isFresh { return table }
        if !force && failedAt > 0 && now() - failedAt < Self.retryAfterMs { return table }
        if let inflight { return await inflight.value }
        let providers = self.providers
        let fetcher = self.fetcher
        let started = now()
        let task = Task<ConvertCurrency.RateTable?, Never> { @MainActor in
            var errors: [String] = []
            for p in providers {
                self.requestCount += 1
                do {
                    let (status, body) = try await fetcher(p.url)
                    guard (200..<300).contains(status) else { throw ConvertRatesError.http(status) }
                    guard let t = p.parse(body, started) else { throw ConvertRatesError.unexpected }
                    self.table = t
                    self.lastError = nil
                    self.failedAt = 0
                    self.save(t)
                    return t
                } catch {
                    errors.append("\(p.name): \(error.localizedDescription)")
                }
            }
            self.failedAt = self.now()
            self.lastError = errors.joined(separator: "; ")
            return self.table
        }
        inflight = task
        let result = await task.value
        inflight = nil
        return result
    }

    public func clear() {
        table = nil
        loaded = true
        try? FileManager.default.removeItem(at: file)
    }
}

enum ConvertRatesError: Error, LocalizedError {
    case http(Int), unexpected
    var errorDescription: String? {
        switch self {
        case let .http(s): return "HTTP \(s)"
        case .unexpected: return "unexpected response"
        }
    }
}
