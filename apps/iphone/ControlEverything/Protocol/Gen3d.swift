import Foundation

// The parts of ce.gen3d/1 (packages/gen3d/src/schema.ts) a 2D client needs: the SEMANTIC CONTROL LAYER
// (controls + bindings + arm state) and just enough of the presentation layer to pick a 2D widget per
// control (the archetype that operates it) and to find hack-list items. Enum-like fields stay Strings so a
// new archetype or status never breaks decoding.

nonisolated struct ControlRange: Codable, Sendable, Hashable {
    var min: Double
    var max: Double
    var step: Double?
}

nonisolated struct Binding: Codable, Sendable, Hashable {
    var action: String
    var driverId: String?
    var channel: Int?
    var cc: Int?
    var note: Int?
    var args: [String: JSONValue]?
}

nonisolated struct Control: Codable, Sendable, Hashable, Identifiable {
    var id: String
    /// continuous | stepped | toggle | trigger | xy
    var kind: String
    var label: String
    var description: String?
    var range: ControlRange?
    var yRange: ControlRange?
    var unit: String?
    var `default`: ControlValue?
    var stepLabels: [String]?
    var accent: String?
    var binding: Binding
    var yBinding: Binding?
    /// false = shown but inert until the driver is verified on the real device (overrides spec.state)
    var armed: Bool?

    enum CodingKeys: String, CodingKey { case id, kind, label, description, range, yRange, unit, `default`, stepLabels, accent, binding, yBinding, armed }

    init(id: String, kind: String, label: String, description: String? = nil, range: ControlRange? = nil, yRange: ControlRange? = nil,
         unit: String? = nil, default def: ControlValue? = nil, stepLabels: [String]? = nil, accent: String? = nil,
         binding: Binding, yBinding: Binding? = nil, armed: Bool? = nil) {
        self.id = id; self.kind = kind; self.label = label; self.description = description; self.range = range; self.yRange = yRange
        self.unit = unit; self.default = def; self.stepLabels = stepLabels; self.accent = accent; self.binding = binding
        self.yBinding = yBinding; self.armed = armed
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "continuous"
        label = (try? c.decode(String.self, forKey: .label)) ?? id.uppercased()
        description = try? c.decodeIfPresent(String.self, forKey: .description)
        range = try? c.decodeIfPresent(ControlRange.self, forKey: .range)
        yRange = try? c.decodeIfPresent(ControlRange.self, forKey: .yRange)
        unit = try? c.decodeIfPresent(String.self, forKey: .unit)
        self.default = try? c.decodeIfPresent(ControlValue.self, forKey: .default)
        stepLabels = try? c.decodeIfPresent([String].self, forKey: .stepLabels)
        accent = try? c.decodeIfPresent(String.self, forKey: .accent)
        binding = (try? c.decode(Binding.self, forKey: .binding)) ?? Binding(action: "unbound")
        yBinding = try? c.decodeIfPresent(Binding.self, forKey: .yBinding)
        armed = try? c.decodeIfPresent(Bool.self, forKey: .armed)
    }
}

nonisolated struct ArmState: Codable, Sendable, Hashable {
    var armed: Bool
    var reason: String?
    var verifiedBy: [String]?
}

nonisolated struct DeviceRef: Codable, Sendable, Hashable {
    var cardId: String?
    var name: String
    var category: String?
    var accents: [String]?
    var transport: String?
}

nonisolated struct HackItem: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var label: String
    var detail: String?
    /// action | control | daemon
    var kind: String?
    var channel: String?
    var controlId: String?
    /// ready | locked | queued | uploading | verified | failed
    var status: String?
    var progress: Double?
    var cost: Int?
}

nonisolated struct ModelChip: Codable, Sendable, Hashable {
    var id: String
    var state: String
}

/// The archetype params a 2D client reads; everything else in ArchetypeParams is ignored.
nonisolated struct ArchetypeParams2D: Codable, Sendable, Hashable {
    var title: String?
    var subtitle: String?
    var status: String?
    var channel: String?
    var items: [HackItem]?
    var mode: String?
    var momentary: Bool?
    var models: [ModelChip]?
    var rows: Int?
    var cols: Int?
}

nonisolated struct Part: Codable, Sendable, Hashable {
    var id: String
    var kind: String
    var archetype: String?
    var controlId: String?
    var params: ArchetypeParams2D?

    enum CodingKeys: String, CodingKey { case id, kind, archetype, controlId, params }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "primitive"
        archetype = try? c.decodeIfPresent(String.self, forKey: .archetype)
        controlId = try? c.decodeIfPresent(String.self, forKey: .controlId)
        params = try? c.decodeIfPresent(ArchetypeParams2D.self, forKey: .params)
    }
}

nonisolated struct Gen3dSpec: Codable, Sendable, Hashable {
    var spec: String?
    var specId: String
    var rev: Int?
    var title: String
    var device: DeviceRef?
    var state: ArmState?
    var controls: [Control]
    var parts: [Part]?
    var notes: String?
    var source: String?
    var modelId: String?

    enum CodingKeys: String, CodingKey { case spec, specId, rev, title, device, state, controls, parts, notes, source, modelId }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spec = try? c.decodeIfPresent(String.self, forKey: .spec)
        specId = try c.decode(String.self, forKey: .specId)
        rev = try? c.decodeIfPresent(Int.self, forKey: .rev)
        title = (try? c.decode(String.self, forKey: .title)) ?? "Device"
        device = try? c.decodeIfPresent(DeviceRef.self, forKey: .device)
        state = try? c.decodeIfPresent(ArmState.self, forKey: .state)
        // decode controls one by one so one bad control does not hide the others
        var list: [Control] = []
        if var arr = try? c.nestedUnkeyedContainer(forKey: .controls) {
            while !arr.isAtEnd {
                if let ctl = try? arr.decode(Control.self) { list.append(ctl) } else { _ = try? arr.decode(JSONValue.self) }
            }
        }
        controls = list
        parts = try? c.decodeIfPresent([Part].self, forKey: .parts)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        modelId = try? c.decodeIfPresent(String.self, forKey: .modelId)
    }
}

// MARK: - ce.hackset/1 (research/15 §5.1; the generator's output, flat, unknown fields dropped)

nonisolated struct HackParam: Codable, Sendable, Hashable {
    var id: String
    var name: String?
    var min: Double?
    var max: Double?
    var `default`: Double?
    var unit: String?
    var step: Double?
}

nonisolated struct HackControlRef: Codable, Sendable, Hashable {
    var archetype: String?
    var size: String?
    var param: String?
}

nonisolated struct HackOracle: Codable, Sendable, Hashable {
    var type: String?
    var region: String?
    var expect: String?
    var reason: String?
}

/// One driver action call; `action` is the driver actionId that verify.result evidence names.
nonisolated struct HackCommand: Codable, Sendable, Hashable {
    var action: String
    var value: Double?
    var param: String?
    var delayMs: Int?
}

nonisolated struct HackInverse: Codable, Sendable, Hashable {
    var restore: String?
    var commands: [HackCommand]?
}

nonisolated struct Hack: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var name: String
    var kind: String?
    var blurb: String?
    var params: [HackParam]?
    var control: HackControlRef?
    var oracle: HackOracle?
    var commands: [HackCommand]?
    var inverse: HackInverse?
    var reversible: Bool?
    /// "hold" = irreversible: needs a 0.6 s press
    var confirm: String?
    var maxRateHz: Double?
    /// the gen3d control that drives it (by protocol convention its id equals the hack id)
    var controlId: String?
    /// server-owned, from verification evidence: ready | locked | queued | uploading | verified | failed
    var status: String?
    var channel: String?

    enum CodingKeys: String, CodingKey {
        case id, name, kind, blurb, params, control, oracle, commands, inverse, reversible, confirm, controlId, status, channel
        case maxRateHz = "max_rate_hz"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? id
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        blurb = try? c.decodeIfPresent(String.self, forKey: .blurb)
        params = try? c.decodeIfPresent([HackParam].self, forKey: .params)
        control = try? c.decodeIfPresent(HackControlRef.self, forKey: .control)
        oracle = try? c.decodeIfPresent(HackOracle.self, forKey: .oracle)
        commands = try? c.decodeIfPresent([HackCommand].self, forKey: .commands)
        inverse = try? c.decodeIfPresent(HackInverse.self, forKey: .inverse)
        reversible = try? c.decodeIfPresent(Bool.self, forKey: .reversible)
        confirm = try? c.decodeIfPresent(String.self, forKey: .confirm)
        maxRateHz = try? c.decodeIfPresent(Double.self, forKey: .maxRateHz)
        controlId = try? c.decodeIfPresent(String.self, forKey: .controlId)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        channel = try? c.decodeIfPresent(String.self, forKey: .channel)
    }
}

nonisolated struct DaemonSpec: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var name: String
    var maxRateHz: Double?
    var status: String?
    var controlId: String?

    enum CodingKeys: String, CodingKey {
        case id, name, status, controlId
        case maxRateHz = "max_rate_hz"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? id
        maxRateHz = try? c.decodeIfPresent(Double.self, forKey: .maxRateHz)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        controlId = try? c.decodeIfPresent(String.self, forKey: .controlId)
    }
}

nonisolated struct HackSetDevice: Codable, Sendable, Hashable {
    nonisolated struct Channel: Codable, Sendable, Hashable { var type: String?; var via: String? }
    var id: String?
    var name: String?
    var kind: String?
    var channel: Channel?
}

nonisolated struct HackSet: Codable, Sendable, Hashable {
    var spec: String?
    var device: HackSetDevice?
    var hacks: [Hack]
    var daemons: [DaemonSpec]?

    enum CodingKeys: String, CodingKey { case spec, device, hacks, daemons }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spec = try? c.decodeIfPresent(String.self, forKey: .spec)
        device = try? c.decodeIfPresent(HackSetDevice.self, forKey: .device)
        var list: [Hack] = []
        if var arr = try? c.nestedUnkeyedContainer(forKey: .hacks) {
            while !arr.isAtEnd {
                if let h = try? arr.decode(Hack.self) { list.append(h) } else { _ = try? arr.decode(JSONValue.self) }
            }
        }
        hacks = list
        daemons = try? c.decodeIfPresent([DaemonSpec].self, forKey: .daemons)
    }
}
