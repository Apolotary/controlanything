import Foundation

/// The versioned envelope every WebSocket message uses (see packages/protocol/src/messages.ts):
///   { v: 1, type, id, ts (epoch ms), from ("" from clients; the hub stamps it), to?, payload }
nonisolated enum Wire {
    static let protocolVersion = 1
    static let serverId = "server"
    static let appVersion = "iphone@0.1.0"

    /// Short random id: prefix + base36 time + 18 hex chars (same shape as the TS newId()).
    static func newId(_ prefix: String = "m") -> String {
        let ms = UInt64(Date().timeIntervalSince1970 * 1000)
        var hex = ""
        for _ in 0..<9 { hex += String(format: "%02x", UInt8.random(in: 0...255)) }
        return prefix + String(ms, radix: 36) + hex
    }

    static func nowMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()
    static let decoder = JSONDecoder()
}

/// Message type names. v0 types are in packages/protocol today; v1 types follow SPEC §3.1.
/// Types starting with "x." are experimental and relayed by the hub without payload checks.
nonisolated enum MsgType {
    static let hello = "hello"
    static let welcome = "welcome"
    static let presence = "presence"
    static let pairStart = "pair.start"
    static let pairStatus = "pair.status"
    static let pairApprove = "pair.approve"
    static let pairDeny = "pair.deny"
    static let pairPending = "pair.pending"
    static let pairApproved = "pair.approved"
    static let pairDenied = "pair.denied"
    static let agentStep = "agent.step"
    static let deviceCard = "device.card"
    static let uiSpec = "ui.spec"
    static let controlEvent = "control.event"
    static let driverStatus = "driver.status"
    static let log = "log"
    // v1 (SPEC §3.1)
    static let scanFrame = "scan.frame"
    static let scanResult = "scan.result"
    static let targetSelect = "target.select"
    static let linkRequest = "link.request"
    static let execCommand = "exec.command"
    static let execAck = "exec.ack"
    static let senseRequest = "sense.request"
    static let senseResult = "sense.result"
    static let verifyResult = "verify.result"
    static let targetStatus = "target.status"
    static let linkResult = "link.result"
    static let driverSpec = "driver.spec"
    static let armRequest = "arm.request"
    static let armConfirm = "arm.confirm"
    static let armResult = "arm.result"
    static let panic = "panic"
    static let voiceText = "voice.text"

    /// Debug builds also accept an experimental "x." twin of a server-only type, so a test script can inject
    /// exec.command / scan.result / arm.request through the hub. Release builds take the real types only.
    static func matches(_ type: String, _ name: String) -> Bool {
        #if DEBUG
        return type == name || type == "x." + name
        #else
        return type == name
        #endif
    }
}

/// Just the routing fields, decoded first so the payload can be decoded by type.
nonisolated struct EnvelopeHead: Decodable, Sendable {
    var v: Int?
    var type: String
    var id: String?
    var ts: Double?
    var from: String?
    var to: String?
}

nonisolated struct InboundPayload<P: Decodable>: Decodable {
    var payload: P
}

nonisolated struct OutboundEnvelope<P: Encodable>: Encodable {
    var v: Int = Wire.protocolVersion
    var type: String
    var id: String = Wire.newId()
    var ts: Double = Wire.nowMs()
    var from: String = ""
    var to: String?
    var payload: P

    enum CodingKeys: String, CodingKey { case v, type, id, ts, from, to, payload }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(v, forKey: .v)
        try c.encode(type, forKey: .type)
        try c.encode(id, forKey: .id)
        try c.encode(Int64(ts), forKey: .ts)
        try c.encode(from, forKey: .from)
        try c.encodeIfPresent(to, forKey: .to)
        try c.encode(payload, forKey: .payload)
    }
}

/// A decoded inbound frame: the head plus the raw bytes, so each handler decodes only what it needs.
nonisolated struct InboundFrame: Sendable {
    var head: EnvelopeHead
    var data: Data

    func payload<P: Decodable>(_ type: P.Type) throws -> P {
        try Wire.decoder.decode(InboundPayload<P>.self, from: data).payload
    }
}
