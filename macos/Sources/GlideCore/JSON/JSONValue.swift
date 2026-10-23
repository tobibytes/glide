import Foundation

/// Any JSON value. Used for free-form payloads (`SearchItem.data`, feature settings bags, workflow params)
/// and to carry unknown fields through decode → encode untouched, so data written by the Electron app
/// (or a newer Glide) survives a round trip through the native app.
public enum JSONValue: Sendable, Hashable, Codable, CustomStringConvertible {
    case null
    case bool(Bool)
    /// Integral numbers keep their exact value (timestamps in ms exceed Int32 and must not gain ".0").
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let i = try? c.decode(Int64.self) { self = .int(i); return }
        if let d = try? c.decode(Double.self) { self = .double(d); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case let .bool(b): try c.encode(b)
        case let .int(i): try c.encode(i)
        case let .double(d):
            if d.isFinite, d == d.rounded(), abs(d) < 9.0e15 { try c.encode(Int64(d)) } else { try c.encode(d) }
        case let .string(s): try c.encode(s)
        case let .array(a): try c.encode(a)
        case let .object(o): try c.encode(o)
        }
    }

    // MARK: convenience accessors

    public var stringValue: String? { if case let .string(s) = self { return s }; return nil }
    public var boolValue: Bool? { if case let .bool(b) = self { return b }; return nil }
    public var doubleValue: Double? {
        switch self {
        case let .int(i): return Double(i)
        case let .double(d): return d
        default: return nil
        }
    }
    public var intValue: Int? {
        switch self {
        case let .int(i): return Int(i)
        case let .double(d) where d == d.rounded(): return Int(d)
        default: return nil
        }
    }
    public var arrayValue: [JSONValue]? { if case let .array(a) = self { return a }; return nil }
    public var objectValue: [String: JSONValue]? { if case let .object(o) = self { return o }; return nil }
    public var isNull: Bool { if case .null = self { return true }; return false }

    public subscript(key: String) -> JSONValue? {
        if case let .object(o) = self { return o[key] }
        return nil
    }

    /// Text form used where the Electron app treated a value as a string (workflow params, logs).
    public var description: String {
        switch self {
        case .null: return "null"
        case let .bool(b): return b ? "true" : "false"
        case let .int(i): return String(i)
        case let .double(d): return String(d)
        case let .string(s): return s
        case .array, .object:
            return (try? String(decoding: JSONEncoder.glide.encode(self), as: UTF8.self)) ?? ""
        }
    }

    /// Bridge from Foundation JSON objects (JSONSerialization output, helper-style dictionaries).
    public init(any value: Any?) {
        switch value {
        case nil: self = .null
        case is NSNull: self = .null
        case let v as JSONValue: self = v
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) }
            else if CFNumberIsFloatType(n) { self = .double(n.doubleValue) }
            else { self = .int(n.int64Value) }
        case let b as Bool: self = .bool(b)
        case let i as Int: self = .int(Int64(i))
        case let d as Double: self = .double(d)
        case let s as String: self = .string(s)
        case let a as [Any]: self = .array(a.map { JSONValue(any: $0) })
        case let o as [String: Any]: self = .object(o.mapValues { JSONValue(any: $0) })
        default: self = .string(String(describing: value!))
        }
    }

    /// Foundation form (for JSONSerialization / NSAppleScript bridges).
    public var anyValue: Any {
        switch self {
        case .null: return NSNull()
        case let .bool(b): return b
        case let .int(i): return i
        case let .double(d): return d
        case let .string(s): return s
        case let .array(a): return a.map(\.anyValue)
        case let .object(o): return o.mapValues(\.anyValue)
        }
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByFloatLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int64) { self = .int(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(floatLiteral value: Double) { self = .double(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(Dictionary(elements, uniquingKeysWith: { $1 })) }
    public init(nilLiteral: ()) { self = .null }
}

public extension JSONEncoder {
    /// The encoder Glide uses for data.json / usage.json: pretty, stable key order, no escaped slashes.
    static var glide: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return e
    }
    /// Single-line encoder for the test channel and logs.
    static var glideCompact: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }
}
