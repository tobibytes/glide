import Foundation

/// Any string key, for reading the fields a type does not know about.
public struct AnyCodingKey: CodingKey, Hashable, Sendable {
    public var stringValue: String
    public var intValue: Int? { nil }
    public init(_ s: String) { stringValue = s }
    public init?(stringValue: String) { self.stringValue = stringValue }
    public init?(intValue: Int) { return nil }
}

/// Helpers for Codable types that must round-trip unknown fields.
///
/// Pattern (see `SearchItem`):
/// ```
/// init(from decoder) { let c = try LosslessReader(decoder, known: Self.knownKeys); title = c.string("title") ?? ""; …; extra = c.extra }
/// func encode(to encoder) { var w = LosslessWriter(encoder, extra: extra); w["title"] = title; … }
/// ```
/// Decoding is tolerant like the Electron store's `normaliseData`: a field with the wrong type falls back
/// to its default instead of failing the whole file.
public struct LosslessReader {
    public let container: KeyedDecodingContainer<AnyCodingKey>
    public let extra: [String: JSONValue]

    public init(_ decoder: Decoder, known: Set<String>) throws {
        container = try decoder.container(keyedBy: AnyCodingKey.self)
        var extra: [String: JSONValue] = [:]
        for key in container.allKeys where !known.contains(key.stringValue) {
            extra[key.stringValue] = try? container.decode(JSONValue.self, forKey: key)
        }
        self.extra = extra
    }

    public func has(_ key: String) -> Bool { container.contains(AnyCodingKey(key)) }

    public func value<T: Decodable>(_ type: T.Type, _ key: String) -> T? {
        let k = AnyCodingKey(key)
        guard container.contains(k), (try? container.decodeNil(forKey: k)) == false else { return nil }
        return try? container.decode(T.self, forKey: k)
    }

    public func string(_ key: String) -> String? { value(String.self, key) }
    public func bool(_ key: String) -> Bool? { value(Bool.self, key) }
    public func double(_ key: String) -> Double? { value(Double.self, key) }
    public func int(_ key: String) -> Int? {
        if let i = value(Int.self, key) { return i }
        return value(Double.self, key).map { Int($0) }
    }
    public func strings(_ key: String) -> [String]? {
        guard let raw = value([JSONValue].self, key) else { return nil }
        return raw.compactMap(\.stringValue)
    }
    public func json(_ key: String) -> JSONValue? { value(JSONValue.self, key) }
    public func object(_ key: String) -> [String: JSONValue]? { value(JSONValue.self, key)?.objectValue }
    /// Arrays of objects decode element by element so one bad entry does not drop the rest.
    public func array<T: Decodable>(_ type: T.Type, _ key: String) -> [T]? {
        guard let raw = value([JSONValue].self, key) else { return nil }
        let data = raw.compactMap { try? JSONEncoder().encode($0) }
        return data.compactMap { try? JSONDecoder().decode(T.self, from: $0) }
    }
}

public struct LosslessWriter {
    private var container: KeyedEncodingContainer<AnyCodingKey>
    private var written = Set<String>()
    private let extra: [String: JSONValue]

    public init(_ encoder: Encoder, extra: [String: JSONValue]) {
        container = encoder.container(keyedBy: AnyCodingKey.self)
        self.extra = extra
    }

    /// Writes `value` unless it is nil (optional fields are omitted, like `undefined` in JSON.stringify).
    public mutating func set<T: Encodable>(_ key: String, _ value: T?) throws {
        written.insert(key)
        guard let value else { return }
        try container.encode(value, forKey: AnyCodingKey(key))
    }

    /// Writes the unknown fields that no known field replaced. Call last.
    public mutating func finish() throws {
        for (k, v) in extra where !written.contains(k) {
            try container.encode(v, forKey: AnyCodingKey(k))
        }
    }
}
