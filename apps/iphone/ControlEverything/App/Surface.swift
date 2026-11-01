import Foundation

/// One generated control surface for one device, normalised from a ui.spec (v1 gen3d + hackset, or v0
/// widgets) or from a bundled example. This is what the 2D renderer draws.
struct Surface: Identifiable, Hashable {
    var id: String
    var title: String
    var deviceName: String
    var cardId: String?
    /// usb | midi | ir | wifi | ble | serial | sim
    var channel: String?
    var controls: [Control]
    /// controlId -> archetype that operates it in 3D (knob, fader, dimmer-ring, wheel, pull-cord, button, ...)
    var archetypeFor: [String: String]
    var hacks: [HackRow]
    var daemons: [DaemonRow]
    var armed: Bool
    var armReason: String?
    var verifiedBy: [String]
    var modelId: String?
    /// live | fixture | hand | demo
    var source: String?
    /// bundled example: interactions stay on this phone and are never sent
    var isDemo: Bool
    var accents: [String]
    var rev: Int
    var receivedAt: Date

    func isArmed(_ c: Control) -> Bool { c.armed ?? armed }
    func control(_ id: String?) -> Control? { id.flatMap { cid in controls.first { $0.id == cid } } }

    /// Accent for a control: its own, else the device's palette in order, else cyan.
    func accent(for c: Control) -> String {
        if let a = c.accent { return a }
        if let i = controls.firstIndex(where: { $0.id == c.id }), !accents.isEmpty { return accents[i % accents.count] }
        return "#38F0FF"
    }

    /// Controls the 2D grid shows (hack-list triggers live in the hack menu instead).
    var gridControls: [Control] {
        let hackTargets = Set(hacks.compactMap(\.controlId))
        return controls.filter { c in !(hackTargets.contains(c.id) && c.kind == "trigger" && archetypeFor[c.id] == nil) }
    }
}

struct HackRow: Identifiable, Hashable {
    var id: String
    var label: String
    var detail: String?
    /// action | control | daemon
    var kind: String
    var channel: String?
    var controlId: String?
    /// ready | locked | queued | uploading | verified | failed
    var status: String
    /// irreversible: 0.6 s press
    var needsHold: Bool
    var oracle: String?
    var maxRateHz: Double?
    /// driver actionIds this hack runs (verify.result evidence names one of them)
    var actionIds: [String] = []
    /// what control.event carries: the hack id (= its gen3d control id)
    var widgetId: String { controlId ?? id }
}

struct DaemonRow: Identifiable, Hashable {
    var id: String
    var name: String
    var rateHz: Double?
    var status: String
    var controlId: String?
}

extension Surface {
    init(payload p: UiSpecPayload, receivedAt: Date = Date()) {
        if let g = p.gen3d {
            self.init(gen3d: g, hackset: p.hackset, specId: p.specId, cardId: p.deviceCardId ?? p.cardId, demo: false, receivedAt: receivedAt)
            if let src = p.source { source = src }
            return
        }
        // v0: a flat widget list
        var controls: [Control] = []
        var arche: [String: String] = [:]
        for w in p.widgets ?? [] {
            let kind: String
            switch w.kind {
            case "button", "pads": kind = "trigger"
            case "toggle": kind = "toggle"
            case "xy": kind = "xy"
            default: kind = "continuous"
            }
            arche[w.id] = w.kind == "button" ? "button" : w.kind
            controls.append(Control(id: w.id, kind: kind, label: String(w.label.prefix(16)).uppercased(), description: w.description,
                                    range: w.range, yRange: w.yRange, unit: w.unit, default: w.default, binding: w.binding,
                                    yBinding: w.yBinding))
        }
        var hacks: [HackRow] = []
        var daemons: [DaemonRow] = []
        if let hs = p.hackset { (hacks, daemons) = Surface.rows(from: hs, channel: nil) }
        self.init(id: p.specId, title: p.title ?? "Controls", deviceName: p.title ?? "Device", cardId: p.cardId ?? p.deviceCardId,
                  channel: nil, controls: controls, archetypeFor: arche, hacks: hacks, daemons: daemons, armed: true,
                  armReason: nil, verifiedBy: [], modelId: nil, source: p.source, isDemo: false, accents: [], rev: 1,
                  receivedAt: receivedAt)
    }

    init(gen3d g: Gen3dSpec, hackset: HackSet?, specId: String? = nil, cardId: String? = nil, demo: Bool, receivedAt: Date = Date()) {
        var arche: [String: String] = [:]
        var hacks: [HackRow] = []
        var daemons: [DaemonRow] = []
        var channel: String? = Surface.channel(fromTransport: g.device?.transport)
        let interactive: Set<String> = ["knob", "fader", "lever", "button", "toggle", "dimmer-ring", "pull-cord", "xy-orb", "pads", "keys", "wheel"]
        for part in g.parts ?? [] {
            guard let a = part.archetype else { continue }
            if let cid = part.controlId, interactive.contains(a), arche[cid] == nil {
                arche[cid] = (a == "wheel" && part.params?.mode == "warmth") ? "wheel-warmth" : a
            }
            if a == "tag", let ch = part.params?.channel, channel == nil { channel = ch }
            if a == "hack-list" || a == "deck" {
                for it in part.params?.items ?? [] {
                    let kind = it.kind ?? "action"
                    if kind == "daemon" {
                        daemons.append(DaemonRow(id: it.id, name: it.label, rateHz: nil, status: it.status ?? "ready", controlId: it.controlId))
                    } else {
                        hacks.append(HackRow(id: it.id, label: it.label, detail: it.detail, kind: kind, channel: it.channel ?? channel,
                                             controlId: it.controlId ?? part.controlId, status: it.status ?? "ready", needsHold: false,
                                             oracle: nil, maxRateHz: nil))
                    }
                }
            }
        }
        if let hs = hackset {
            let (more, moreDaemons) = Surface.rows(from: hs, channel: channel)
            let controlIds = Set(g.controls.map(\.id))
            for h in more {
                if let i = hacks.firstIndex(where: { $0.id == h.id || $0.widgetId == h.widgetId }) {
                    // same hack drawn by a gen3d hack-list item: take the hackset's actions, hold rule and status
                    hacks[i].actionIds = h.actionIds
                    hacks[i].needsHold = hacks[i].needsHold || h.needsHold
                    if hacks[i].status == "ready" { hacks[i].status = h.status }
                    if hacks[i].detail == nil { hacks[i].detail = h.detail }
                } else if h.kind == "control", controlIds.contains(h.widgetId) {
                    continue // drawn as a widget in the grid
                } else {
                    hacks.append(h)
                }
            }
            for var d in moreDaemons where !daemons.contains(where: { $0.id == d.id }) {
                if d.controlId == nil, controlIds.contains(d.id) { d.controlId = d.id }
                daemons.append(d)
            }
            if channel == nil { channel = hs.device?.channel?.type }
        }
        self.init(id: specId ?? g.specId, title: g.title, deviceName: g.device?.name ?? g.title, cardId: cardId ?? g.device?.cardId,
                  channel: channel, controls: g.controls, archetypeFor: arche, hacks: hacks, daemons: daemons,
                  armed: g.state?.armed ?? true, armReason: g.state?.reason, verifiedBy: g.state?.verifiedBy ?? [],
                  modelId: g.modelId, source: demo ? "demo" : g.source, isDemo: demo, accents: g.device?.accents ?? [],
                  rev: g.rev ?? 1, receivedAt: receivedAt)
    }

    static func rows(from hs: HackSet, channel: String?) -> ([HackRow], [DaemonRow]) {
        var hacks: [HackRow] = []
        var daemons: [DaemonRow] = []
        let ch = hs.device?.channel?.type ?? channel
        for h in hs.hacks {
            if h.kind == "daemon" {
                daemons.append(DaemonRow(id: h.id, name: h.name, rateHz: h.maxRateHz, status: h.status ?? "ready", controlId: h.controlId))
                continue
            }
            hacks.append(HackRow(id: h.id, label: h.name, detail: h.blurb, kind: h.kind ?? "action", channel: h.channel ?? ch,
                                 controlId: h.controlId ?? h.id, status: h.status ?? "ready",
                                 needsHold: h.confirm == "hold" || h.reversible == false, oracle: h.oracle?.type, maxRateHz: h.maxRateHz,
                                 actionIds: (h.commands ?? []).map(\.action)))
        }
        for d in hs.daemons ?? [] {
            daemons.append(DaemonRow(id: d.id, name: d.name, rateHz: d.maxRateHz, status: d.status ?? "ready", controlId: d.controlId))
        }
        return (hacks, daemons)
    }

    static func channel(fromTransport t: String?) -> String? {
        switch t {
        case "usb-midi": return "usb"
        case "ble-midi": return "ble"
        case "ir": return "ir"
        case "serial": return "serial"
        case "http": return "wifi"
        case "sim": return "sim"
        default: return nil
        }
    }
}

extension Control {
    var lo: Double { range?.min ?? 0 }
    var hi: Double { range?.max ?? 1 }

    /// Snap to the step (stepped controls default to 1) and clamp.
    func quantize(_ v: Double) -> Double {
        let clamped = Swift.min(hi, Swift.max(lo, v))
        let step = range?.step ?? (kind == "stepped" ? 1 : nil)
        guard let step, step > 0 else { return clamped }
        return Swift.min(hi, Swift.max(lo, lo + ((clamped - lo) / step).rounded() * step))
    }

    func normalized(_ v: Double) -> Double { hi > lo ? (v - lo) / (hi - lo) : 0 }
    func denormalized(_ t: Double) -> Double { lo + Swift.min(1, Swift.max(0, t)) * (hi - lo) }

    var initialValue: ControlValue {
        if let d = self.default { return d }
        switch kind {
        case "toggle", "trigger": return .bool(false)
        case "xy": return .xy(x: (lo + hi) / 2, y: ((yRange?.min ?? 0) + (yRange?.max ?? 1)) / 2)
        default: return .number(lo)
        }
    }

    /// Readout text for a numeric value: step labels, integers for MIDI-like ranges, else 2 decimals.
    func format(_ v: Double) -> String {
        if let labels = stepLabels, !labels.isEmpty {
            let i = Int((v - lo).rounded())
            if labels.indices.contains(i) { return labels[i] }
        }
        let isInt = (range?.step.map { $0.rounded() == $0 } ?? false) || (hi - lo) >= 10
        let n = isInt ? String(Int(v.rounded())) : String(format: "%.2f", v)
        return unit.map { n + ($0 == "%" ? "%" : " " + $0) } ?? n
    }
}
