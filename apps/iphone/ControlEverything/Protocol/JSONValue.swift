import Foundation

/// Any JSON value. Used for loosely typed fields (`args`, LocalOp `arg`, unknown payloads) so a schema
/// change on the server never breaks decoding of the fields we do understand.
nonisolated enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "not a JSON value")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n):
            if n.rounded() == n, abs(n) < 9.0e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    var string: String? { if case .string(let s) = self { return s } else { return nil } }
    var number: Double? {
        switch self {
        case .number(let n): return n
        case .string(let s): return Double(s)
        case .bool(let b): return b ? 1 : 0
        default: return nil
        }
    }
    var bool: Bool? {
        switch self {
        case .bool(let b): return b
        case .number(let n): return n != 0
        case .string(let s):
            switch s.lowercased() {
            case "on", "true", "yes", "1": return true
            case "off", "false", "no", "0": return false
            default: return nil
            }
        default: return nil
        }
    }
    var object: [String: JSONValue]? { if case .object(let o) = self { return o } else { return nil } }
    var array: [JSONValue]? { if case .array(let a) = self { return a } else { return nil } }
    subscript(key: String) -> JSONValue? { object?[key] }

    /// Short human form for logs and chips.
    var compact: String {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "on" : "off"
        case .number(let n): return n.rounded() == n ? String(Int64(n)) : String(format: "%.2f", n)
        case .string(let s): return s
        case .array(let a): return "[" + a.map(\.compact).joined(separator: ", ") + "]"
        case .object(let o): return "{" + o.keys.sorted().map { "\($0): \(o[$0]!.compact)" }.joined(separator: ", ") + "}"
        }
    }
}

/// A control value on the wire: number (knob, fader), boolean (toggle, trigger) or {x, y} (xy pad).
nonisolated enum ControlValue: Codable, Hashable, Sendable {
    case number(Double)
    case bool(Bool)
    case xy(x: Double, y: Double)

    private struct XY: Codable { var x: Double; var y: Double }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        let p = try c.decode(XY.self)
        self = .xy(x: p.x, y: p.y)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .number(let n):
            if n.rounded() == n, abs(n) < 9.0e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case .bool(let b): try c.encode(b)
        case .xy(let x, let y): try c.encode(XY(x: x, y: y))
        }
    }

    var number: Double? {
        switch self {
        case .number(let n): return n
        case .bool(let b): return b ? 1 : 0
        case .xy: return nil
        }
    }
    var bool: Bool? {
        switch self {
        case .bool(let b): return b
        case .number(let n): return n != 0
        case .xy: return nil
        }
    }
}

/// Decodes a field that may be a number or a numeric string, without failing the whole payload.
nonisolated struct LenientDouble: Codable, Hashable, Sendable {
    var value: Double
    init(_ v: Double) { value = v }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let d = try? c.decode(Double.self) { value = d; return }
        if let s = try? c.decode(String.self), let d = Double(s) { value = d; return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "not a number")
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(value)
    }
}
