import Foundation

// Payloads, one per message type. Field names follow packages/protocol (v0) and SPEC §3.1 (v1).
// Inbound structs are lenient: everything the iPhone can live without is optional, so a server-side
// schema change degrades a view instead of dropping the message.

// MARK: - connection

nonisolated struct HelloPayload: Encodable, Sendable {
    var deviceToken: String
    var role: String? = "controller"
    var capabilities: [String]?
    var app: String? = Wire.appVersion
}

nonisolated struct WelcomePayload: Decodable, Sendable, Equatable {
    var clientId: String?
    var deviceId: String
    var name: String
    var kind: String
    var role: String?
    var canApprove: Bool?
    var spaceId: String?
    var `protocol`: Int?
    var server: String?
    var mode: String?
}

nonisolated struct PortInfo: Decodable, Sendable, Hashable {
    var id: String
    var kind: String
    var name: String
    var state: String?
}

nonisolated struct DeviceInfo: Decodable, Sendable, Identifiable, Hashable {
    var deviceId: String
    var name: String
    var kind: String
    var role: String?
    var capabilities: [String]?
    var ports: [PortInfo]?
    var app: String?
    var canApprove: Bool?
    var online: Bool
    var connections: Int?
    var pairedAt: Double?
    var lastSeen: Double?
    var id: String { deviceId }
}

nonisolated struct PresencePayload: Decodable, Sendable {
    var spaceId: String?
    var devices: [DeviceInfo]
    var reason: String?
    var deviceId: String?
}

// MARK: - pairing

nonisolated struct PairStartRequest: Encodable, Sendable {
    var name: String
    var kind: String = "iphone"
    var capabilities: [String]?
}

nonisolated struct PairStartResponse: Decodable, Sendable {
    var pairingId: String
    var code: String
    var display: String
    var qr: String
    var expiresAt: Double
    var pollSecret: String
    var status: String
    var deviceId: String?
    var deviceToken: String?
}

nonisolated struct PairStatusResponse: Decodable, Sendable {
    var pairingId: String
    var status: String
    var expiresAt: Double?
    var deviceId: String?
    var deviceToken: String?
    var reason: String?
}

nonisolated struct PairApproveRequest: Encodable, Sendable {
    var code: String
    var pairingId: String?
}

nonisolated struct PairDenyRequest: Encodable, Sendable {
    var pairingId: String?
    var code: String?
}

nonisolated struct PendingPairing: Decodable, Sendable, Identifiable, Hashable {
    var pairingId: String
    var name: String
    var kind: String
    var capabilities: [String]?
    var code: String
    var display: String
    var requestedAt: Double?
    var expiresAt: Double
    var origin: String?
    var id: String { pairingId }
}

nonisolated struct PairApprovedPayload: Decodable, Sendable {
    var pairingId: String
    var deviceId: String
    var name: String
    var kind: String
    var canApprove: Bool?
    var approvedBy: String?
}

nonisolated struct PairDeniedPayload: Decodable, Sendable {
    var pairingId: String
    var reason: String
    var message: String?
}

/// Server error body: {error, message}.
nonisolated struct APIErrorBody: Decodable, Sendable {
    var error: String?
    var message: String?
}

nonisolated struct HealthResponse: Decodable, Sendable {
    nonisolated struct Urls: Decodable, Sendable {
        var host: String?
        var https: String?
        var http: String?
        var local: String?
        var lan: [String]?
    }
    nonisolated struct Models: Decodable, Sendable {
        var chat: String?
        var transcribe: String?
    }
    var ok: Bool?
    var name: String?
    var version: String?
    var `protocol`: Int?
    var mode: String?
    var models: Models?
    var urls: Urls?
}

// MARK: - agent work log

nonisolated struct AgentStepPayload: Decodable, Sendable, Identifiable, Hashable {
    var stepId: String
    var runId: String?
    var parentId: String?
    var cardId: String?
    var phase: String
    var status: String
    var title: String
    var detail: String?
    /** short evidence, e.g. "USB says OP-1 ✓" */
    var evidence: String?
    /** proof = deterministic check; opinion = a model's reading */
    var kind: String?
    var model: String?
    var effort: String?
    var latencyMs: Double?
    var source: String?
    var recordedFrom: String?
    var startedAt: Double?
    var endedAt: Double?
    var id: String { stepId }
}

nonisolated struct LogPayload: Decodable, Sendable {
    var level: String
    var message: String
    var code: String?
    var ref: String?
    var issues: [String]?
}

// MARK: - identified devices, drivers, links

nonisolated struct DeviceCardPayload: Decodable, Sendable, Identifiable, Hashable {
    var cardId: String
    var name: String
    var maker: String?
    var model: String?
    var category: String?
    var confidence: Double?
    var protocols: [String]?
    var evidence: [String]?
    var requires: [String]?
    var notes: String?
    var source: String?
    var id: String { cardId }
}

nonisolated struct DriverActionStatus: Decodable, Sendable, Hashable {
    var actionId: String
    var label: String?
    /// pending | pass | fail | untested
    var verified: String?
}

/// v1: {driverId, cardId, phase, actions[{actionId, label, verified}], modelId}; legacy adds `status`.
nonisolated struct DriverStatusPayload: Decodable, Sendable {
    var driverId: String
    var cardId: String?
    var version: Int?
    /// drafting | validating | verifying | verified | armed | disarmed | failed
    var phase: String?
    var actions: [DriverActionStatus]?
    var status: String?
    var modelId: String?
    var detail: String?
}

nonisolated struct LinkCandidate: Decodable, Sendable, Hashable {
    var deviceId: String
    var name: String
    var kind: String
    var online: Bool
    var port: String?
}

/// "needs a companion: Cardputer (IR)"
nonisolated struct LinkRequestPayload: Decodable, Sendable {
    var linkId: String?
    var cardId: String?
    var needs: [String]?
    var reason: String?
    var suggestedClients: [String]?
    var candidates: [LinkCandidate]?
    /// needs-companion | candidates | waiting
    var status: String?
}

nonisolated struct LinkEvidence: Decodable, Sendable, Hashable {
    var kind: String
    var ok: Bool
    var detail: String
}

/// The channel verdict: confirmed | consistent | mismatch | unknown | none.
nonisolated struct LinkResultPayload: Decodable, Sendable {
    var linkId: String?
    var cardId: String
    var verdict: String
    var executorDeviceId: String?
    var channel: String?
    var evidence: [LinkEvidence]?
    var reason: String?
}

/// Where a target is in the loop: scanned → identifying → … → armed → controlling (or failed).
nonisolated struct TargetStatusPayload: Decodable, Sendable {
    var cardId: String
    var state: String
    var since: Double?
    var detail: String?
    var driverId: String?
    var specId: String?
    var executorDeviceId: String?
}

// MARK: - generated controls

/// v0 control-surface widget (packages/protocol `Widget`), still accepted.
nonisolated struct WidgetV0: Decodable, Sendable, Hashable {
    var id: String
    var kind: String
    var label: String
    var range: ControlRange?
    var yRange: ControlRange?
    var `default`: ControlValue?
    var unit: String?
    var binding: Binding
    var yBinding: Binding?
    var description: String?
}

/// ui.spec. v1 (SPEC §3.1): {specId, deviceCardId, gen3d, hackset}. v0: {specId, title, cardId, widgets}.
nonisolated struct UiSpecPayload: Decodable, Sendable {
    var specId: String
    var title: String?
    var cardId: String?
    var deviceCardId: String?
    var driverId: String?
    var widgets: [WidgetV0]?
    var gen3d: Gen3dSpec?
    var hackset: HackSet?
    var notes: String?
    var source: String?
    var rev: Int?
    var modelId: String?
    var recordedFrom: String?

    enum CodingKeys: String, CodingKey { case specId, title, cardId, deviceCardId, driverId, widgets, gen3d, hackset, notes, source, rev, modelId, recordedFrom }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        specId = try c.decode(String.self, forKey: .specId)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        cardId = try? c.decodeIfPresent(String.self, forKey: .cardId)
        deviceCardId = try? c.decodeIfPresent(String.self, forKey: .deviceCardId)
        driverId = try? c.decodeIfPresent(String.self, forKey: .driverId)
        widgets = try? c.decodeIfPresent([WidgetV0].self, forKey: .widgets)
        gen3d = try? c.decodeIfPresent(Gen3dSpec.self, forKey: .gen3d)
        hackset = try? c.decodeIfPresent(HackSet.self, forKey: .hackset)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        rev = try? c.decodeIfPresent(Int.self, forKey: .rev)
        modelId = try? c.decodeIfPresent(String.self, forKey: .modelId)
        recordedFrom = try? c.decodeIfPresent(String.self, forKey: .recordedFrom)
    }
}

/// control.event: `widgetId` is the gen3d control id, which equals the hack id for hack-bound controls;
/// an action hack fires as {widgetId: hackId, value: true, phase: "end"}.
nonisolated struct ControlEventPayload: Encodable, Sendable {
    var widgetId: String
    var value: ControlValue
    var ts: Double
    var specId: String?
    var index: Int?
    var phase: String?

    enum CodingKeys: String, CodingKey { case widgetId, value, ts, specId, index, phase }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(widgetId, forKey: .widgetId)
        try c.encode(value, forKey: .value)
        try c.encode(Int64(ts), forKey: .ts)
        try c.encodeIfPresent(specId, forKey: .specId)
        try c.encodeIfPresent(index, forKey: .index)
        try c.encodeIfPresent(phase, forKey: .phase)
    }
}

// MARK: - execution (SPEC §3.1 / §3.2)

/// MidiOp | IrOp | LocalOp. The iPhone executes LocalOp {kind:'local', op, arg}; it reports the rest as unsupported.
nonisolated struct ExecOp: Decodable, Sendable {
    var kind: String
    var op: String?
    var arg: JSONValue?
    var msg: String?
    var `protocol`: String?
}

nonisolated struct ExecCommandPayload: Decodable, Sendable {
    var execId: String
    var executorDeviceId: String?
    var op: ExecOp
    var port: String?
    var dryRun: Bool?
    var cardId: String?
    var driverId: String?
    var actionId: String?
}

/// executor → server (to: "server"). `error` is one of no_port | no_midi | no_ir | bad_args | rate_limited |
/// unsupported | serial_offline | timeout | device_error | refused.
nonisolated struct ExecAckPayload: Encodable, Sendable {
    var execId: String
    var ok: Bool
    var sentAt: Double
    var detail: String?
    var error: String?
    var latencyMs: Double?

    enum CodingKeys: String, CodingKey { case execId, ok, sentAt, detail, error, latencyMs }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(execId, forKey: .execId)
        try c.encode(ok, forKey: .ok)
        try c.encode(Int64(sentAt), forKey: .sentAt)
        try c.encodeIfPresent(detail.map { String($0.prefix(1000)) }, forKey: .detail)
        try c.encodeIfPresent(error, forKey: .error)
        try c.encodeIfPresent(latencyMs.map { max(0, $0.rounded()) }, forKey: .latencyMs)
    }
}

// MARK: - perception (SPEC §3.1)

nonisolated struct FrameCamera: Codable, Sendable, Hashable {
    var width: Int?
    var height: Int?
    var fovY: Double?
    /// passthrough | synthetic | replay | handheld
    var source: String?
}

/// scan.frame (to: "server") from a handheld scanner: no pose. Also the `frame` of a sense.result.
nonisolated struct ScanFramePayload: Encodable, Sendable {
    var frameId: String
    var jpeg: String
    var width: Int
    var height: Int
    var capturedAt: Double
    var camera: FrameCamera?
    /// scan | verify | pair
    var purpose: String
    var cardId: String?
    var senseId: String?

    enum CodingKeys: String, CodingKey { case frameId, jpeg, width, height, capturedAt, camera, purpose, cardId, senseId }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(frameId, forKey: .frameId)
        try c.encode(jpeg, forKey: .jpeg)
        try c.encode(width, forKey: .width)
        try c.encode(height, forKey: .height)
        try c.encode(Int64(capturedAt), forKey: .capturedAt)
        try c.encodeIfPresent(camera, forKey: .camera)
        try c.encode(purpose, forKey: .purpose)
        try c.encodeIfPresent(cardId, forKey: .cardId)
        try c.encodeIfPresent(senseId, forKey: .senseId)
    }
}

nonisolated struct ScanDetection: Decodable, Sendable, Identifiable, Hashable {
    var detId: String
    var label: String
    var prompt: String?
    var score: Double?
    /// [x, y, w, h]: pixels or normalised (values <= 1.5 are taken as normalised)
    var box: [Double]?
    var polygon: [[Double]]?
    var cardId: String?
    var deviceId: String?
    var id: String { detId }

    enum CodingKeys: String, CodingKey { case detId, label, prompt, score, box, bbox, polygon, cardId, deviceId }
    private struct BoxObj: Decodable { var x: Double; var y: Double; var w: Double; var h: Double }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        detId = (try? c.decode(String.self, forKey: .detId)) ?? UUID().uuidString
        label = (try? c.decode(String.self, forKey: .label)) ?? "device"
        prompt = try? c.decodeIfPresent(String.self, forKey: .prompt)
        score = try? c.decodeIfPresent(Double.self, forKey: .score)
        deviceId = try? c.decodeIfPresent(String.self, forKey: .deviceId)
        cardId = try? c.decodeIfPresent(String.self, forKey: .cardId)
        if let a = try? c.decodeIfPresent([Double].self, forKey: .box), a.count == 4 {
            box = a
        } else if let o = (try? c.decodeIfPresent(BoxObj.self, forKey: .box)) ?? (try? c.decodeIfPresent(BoxObj.self, forKey: .bbox)) {
            box = [o.x, o.y, o.w, o.h]
        }
        if let pts = try? c.decodeIfPresent([[Double]].self, forKey: .polygon) {
            polygon = pts
        } else if let pts = try? c.decodeIfPresent([BoxPoint].self, forKey: .polygon) {
            polygon = pts.map { [$0.x, $0.y] }
        }
    }
    private struct BoxPoint: Decodable { var x: Double; var y: Double }
}

nonisolated struct ScanResultPayload: Decodable, Sendable {
    var frameId: String
    var width: Double?
    var height: Double?
    var detections: [ScanDetection]
    var modelId: String?
    var source: String?
    var latencyMs: Double?
    var prompts: [String]?
}

nonisolated struct TargetSelectPayload: Encodable, Sendable {
    var frameId: String?
    var detId: String?
    var cardId: String?
    var deviceId: String?
    var text: String?
}

nonisolated struct SenseRequestPayload: Decodable, Sendable {
    var senseId: String
    var sensorDeviceId: String?
    /// frame | audio-features | ir-capture
    var kind: String
    var durationMs: Double?
    var offsetMs: Double?
    var cardId: String?
    var prompt: String?
}

nonisolated struct SenseResultPayload: Encodable, Sendable {
    var senseId: String
    var kind: String
    var frame: ScanFramePayload?
    var at: Double
    var ok: Bool?
    var error: String?

    enum CodingKeys: String, CodingKey { case senseId, kind, frame, at, ok, error }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(senseId, forKey: .senseId)
        try c.encode(kind, forKey: .kind)
        try c.encodeIfPresent(frame, forKey: .frame)
        try c.encode(Int64(at), forKey: .at)
        try c.encodeIfPresent(ok, forKey: .ok)
        try c.encodeIfPresent(error.map { String($0.prefix(300)) }, forKey: .error)
    }
}

/// verify.result = Evidence (SPEC §3.3).
nonisolated struct EvidencePayload: Decodable, Sendable, Identifiable {
    nonisolated struct Sent: Decodable, Sendable { var op: JSONValue?; var at: Double? }
    nonisolated struct Expected: Decodable, Sendable { var sense: String?; var effect: String? }
    nonisolated struct Observed: Decodable, Sendable {
        var sense: String?
        var metric: String?
        var before: Double?
        var after: Double?
        var delta: Double?
        var threshold: Double?
        var sensorDeviceId: String?
        var note: String?
        /// optional raw signal for the sparkline
        var samples: [Double]?
    }
    var evidenceId: String
    var actionId: String?
    var execId: String?
    var cardId: String?
    var driverId: String?
    var sent: Sent?
    var expected: Expected?
    var observed: Observed?
    var pass: Bool
    var attempt: Int?
    var note: String?
    var id: String { evidenceId }
}

// MARK: - human confirmation (ARM), panic, voice

nonisolated struct ArmAction: Decodable, Sendable, Hashable {
    var actionId: String
    var label: String
    /// pending | pass | fail | untested
    var verified: String
}

/// server → approvers: "Arm 4 verified controls for OP-1 Field?" Answer with arm.confirm.
nonisolated struct ArmRequestPayload: Decodable, Sendable, Identifiable, Hashable {
    var armId: String
    var cardId: String
    var driverId: String
    var specId: String?
    var title: String
    var summary: String
    var actions: [ArmAction]
    var irreversible: Bool?
    var expiresAt: Double
    var id: String { armId }
}

nonisolated struct ArmConfirmPayload: Encodable, Sendable {
    var armId: String
    var approve: Bool
    var hold: Bool?
}

nonisolated struct ArmResultPayload: Decodable, Sendable {
    var armId: String
    var cardId: String
    var driverId: String?
    var armed: Bool
    var by: String?
    var reason: String?
}

/// Any direction: stop everything (optionally one target).
nonisolated struct PanicPayload: Codable, Sendable {
    var reason: String?
    var cardId: String?
}

/// server → client: a transcript with the model id. client → server: a typed command (treated as final).
nonisolated struct VoiceTextPayload: Codable, Sendable {
    var utteranceId: String?
    var text: String
    var final: Bool
    var source: String?
    var modelId: String?
    var latencyMs: Double?
    var cardId: String?
    var specId: String?
    /// edit | hack | scan | undo | panic | question | none
    var intent: String?
}
