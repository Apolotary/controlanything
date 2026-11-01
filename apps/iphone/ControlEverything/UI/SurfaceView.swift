import SwiftUI

/// One device: header (name, channel, arm state, model id), the 2D controls, the hack menu and daemons.
struct SurfaceView: View {
    @Environment(AppModel.self) private var model
    var surface: Surface

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if !surface.armed { armingBanner }
            controlsGrid
            if !surface.hacks.isEmpty { hackMenu.id("hacks") }
            if !surface.daemons.isEmpty { daemonList.id("daemons") }
            if surface.isDemo {
                Text("DEMO SURFACE · bundled example · nothing is sent to a device")
                    .font(Typo.mono(10)).foregroundStyle(Neon.dim)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
        }
    }

    // MARK: header

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(surface.deviceName).font(Typo.title(22)).tracking(1.2).textCase(.uppercase).foregroundStyle(Neon.bone)
                    .lineLimit(1).minimumScaleFactor(0.6)
                Spacer(minLength: 8)
                Text(ChannelGlyph.text(surface.channel)).font(Typo.mono(11, weight: .bold)).foregroundStyle(Neon.cyan)
                    .padding(.horizontal, 6).padding(.vertical, 2).overlay(Rectangle().stroke(Neon.cyan.opacity(0.6), lineWidth: 1))
            }
            HStack(spacing: 8) {
                Pip(color: surface.armed ? Neon.ok : Neon.volt, filled: surface.armed)
                Text(surface.armed ? "controlled" : "arming").font(Typo.mono(12, weight: .semibold))
                    .foregroundStyle(surface.armed ? Neon.ok : Neon.volt)
                if surface.armed, let reason = surface.armReason {
                    Text(reason).font(Typo.mono(11)).foregroundStyle(Neon.dim).lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    if let m = surface.modelId { ModelChipView(id: m, source: surface.source).fixedSize() }
                    ForEach(surface.verifiedBy, id: \.self) { v in
                        Text(v).font(Typo.mono(10)).foregroundStyle(Neon.ok).fixedSize()
                            .padding(.horizontal, 6).padding(.vertical, 3).overlay(Rectangle().stroke(Neon.ok.opacity(0.45), lineWidth: 1))
                    }
                }
                .padding(1)
            }
        }
        .padding(14)
        .plate()
    }

    private var armingBanner: some View {
        HStack(alignment: .top, spacing: 10) {
            ProgressView().tint(Neon.volt)
            VStack(alignment: .leading, spacing: 4) {
                Text("Controls arm after the device reacts").hudLabel(11, color: Neon.volt)
                Text(surface.armReason ?? "verifying on the real device…").font(Typo.mono(12)).foregroundStyle(Neon.bone)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .plate(edge: Neon.volt, dashed: true)
    }

    // MARK: controls

    private enum Width { case full, half }

    private func widthOf(_ c: Control) -> Width {
        switch surface.archetypeFor[c.id] {
        case "dimmer-ring", "xy-orb", "pads", "keys", "wheel", "wheel-warmth": return .full
        default: break
        }
        switch c.kind {
        case "xy", "stepped": return .full
        default: return .half
        }
    }

    private var rows: [[Control]] {
        var out: [[Control]] = []
        var pendingHalf: Control?
        for c in surface.gridControls {
            if widthOf(c) == .full {
                if let h = pendingHalf { out.append([h]); pendingHalf = nil }
                out.append([c])
            } else if let h = pendingHalf {
                out.append([h, c]); pendingHalf = nil
            } else {
                pendingHalf = c
            }
        }
        if let h = pendingHalf { out.append([h]) }
        return out
    }

    @ViewBuilder
    private var controlsGrid: some View {
        if !surface.gridControls.isEmpty {
            VStack(spacing: 12) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(row) { c in
                            cell(c).frame(maxWidth: .infinity)
                        }
                    }
                }
            }
        }
    }

    private func io(_ c: Control) -> WidgetIO {
        let s = surface
        let m = model
        return WidgetIO(control: c, value: m.value(s, c), accent: Color(hex: s.accent(for: c)), armed: s.isArmed(c),
                        begin: { m.beginDrag(s, c) }, change: { m.dragChanged(s, c, $0) }, end: { m.dragEnded(s, c, $0) },
                        commit: { m.commit(s, c, $0) }, trigger: { m.trigger(s, c, index: $0) })
    }

    @ViewBuilder
    private func widget(_ c: Control) -> some View {
        let io = io(c)
        switch (surface.archetypeFor[c.id], c.kind) {
        case ("dimmer-ring", _): RingWidget(io: io)
        case ("wheel-warmth", _): SteppedWidget(io: io, warmth: true)
        case ("fader", "toggle"), ("lever", "toggle"), ("toggle", _): ToggleWidget(io: io)
        case ("fader", _), ("lever", _): FaderWidget(io: io)
        case ("pull-cord", "trigger"), ("button", "trigger"): TriggerWidget(io: io)
        case ("pull-cord", _): ToggleWidget(io: io, cord: true)
        case ("button", "toggle"): ToggleWidget(io: io)
        case ("xy-orb", _), (_, "xy"): XYWidget(io: io)
        case ("pads", _), ("keys", _): PadsWidget(io: io)
        case (_, "stepped"): SteppedWidget(io: io)
        case (_, "toggle"): ToggleWidget(io: io)
        case (_, "trigger"): TriggerWidget(io: io)
        default: KnobWidget(io: io)
        }
    }

    private func cell(_ c: Control) -> some View {
        let armed = surface.isArmed(c)
        return widget(c)
            .accessibilityIdentifier("control." + c.id)
            .padding(12)
            .frame(maxWidth: .infinity)
            .plate(edge: armed ? Color(hex: surface.accent(for: c)) : Neon.dim, cut: 8, edgeOpacity: armed ? 0.5 : 0.4, dashed: !armed)
            .opacity(armed ? 1 : 0.42)
            .allowsHitTesting(armed)
            .overlay(alignment: .topTrailing) {
                if !armed {
                    Text("DISARMED").font(Typo.mono(9, weight: .bold)).foregroundStyle(Neon.void)
                        .padding(.horizontal, 4).padding(.vertical, 1).background(Neon.dim).padding(6)
                }
            }
    }

    // MARK: hack menu

    private var hackMenu: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(title: "HACKS", subtitle: "your devices")
            ForEach(surface.hacks) { h in
                HackRowView(surface: surface, hack: h)
            }
        }
    }

    private var daemonList: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(title: "DAEMONS", subtitle: "automations")
            ForEach(surface.daemons) { d in
                DaemonRowView(surface: surface, daemon: d)
            }
        }
    }
}

struct SectionTitle: View {
    var title: String
    var subtitle: String?
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title).hudLabel(13, color: Neon.cyan)
            if let subtitle { Text(subtitle).font(Typo.mono(11)).foregroundStyle(Neon.dim) }
            Rectangle().fill(Neon.cyan.opacity(0.3)).frame(height: 1)
        }
        .padding(.top, 4)
    }
}

/// A hack row, 56 pt: kind glyph, verb phrase, channel, verdict pip. Tap = upload (the human confirmation);
/// irreversible hacks need a 0.6 s hold with a filling ring. After upload: the state in words, the oracle
/// sentence and a sparkline of the raw signal when the server reports one.
struct HackRowView: View {
    @Environment(AppModel.self) private var model
    var surface: Surface
    var hack: HackRow
    @State private var holding = false

    private var sendState: HackSendState? { model.hackState[model.hackKey(surface, hack)] }

    private var pipColor: Color {
        if let v = sendState?.verdict { return v ? Neon.ok : Neon.fail }
        if sendState != nil { return Neon.volt }
        return Neon.status(hack.status)
    }

    private var locked: Bool {
        hack.status == "locked" || (surface.control(hack.controlId).map { !surface.isArmed($0) } ?? !surface.armed)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            row
            if let st = sendState { detail(st) }
        }
        .plate(edge: locked ? Neon.dim : hack.kind == "daemon" ? Neon.magenta : Neon.cyan, cut: 8, edgeOpacity: locked ? 0.35 : 0.55, dashed: locked)
        .opacity(locked ? 0.55 : 1)
    }

    private var row: some View {
        HStack(spacing: 12) {
            Text(KindGlyph.text(hack.kind)).font(Typo.mono(18, weight: .bold))
                .foregroundStyle(hack.kind == "daemon" ? Neon.magenta : locked ? Neon.dim : Neon.volt)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(hack.label).font(Typo.label(15)).tracking(0.8).foregroundStyle(locked ? Neon.dim : Neon.bone).lineLimit(1)
                if let d = hack.detail { Text(d).font(Typo.mono(11)).foregroundStyle(Neon.dim).lineLimit(1) }
            }
            Spacer(minLength: 6)
            if hack.needsHold {
                Text("NO UNDO").font(Typo.mono(9, weight: .bold)).foregroundStyle(Neon.magenta)
                    .padding(.horizontal, 4).overlay(Rectangle().stroke(Neon.magenta.opacity(0.6), lineWidth: 1))
            }
            Text(ChannelGlyph.text(hack.channel)).font(Typo.mono(10, weight: .semibold)).foregroundStyle(Neon.dim)
            ZStack {
                if hack.needsHold {
                    Circle().stroke(Neon.void, lineWidth: 4).frame(width: 22, height: 22)
                    Circle().trim(from: 0, to: holding ? 1 : 0).stroke(Neon.volt, style: StrokeStyle(lineWidth: 3, lineCap: .butt))
                        .rotationEffect(.degrees(-90)).frame(width: 22, height: 22)
                        .animation(holding ? .linear(duration: 0.6) : .easeOut(duration: 0.1), value: holding)
                }
                Pip(color: pipColor, filled: sendState?.verdict != nil || hack.status == "verified" || hack.status == "failed")
            }
            .frame(width: 26)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
        .onTapGesture {
            if hack.needsHold { model.show("Hold for 0.6 s: \(hack.label) can't be undone.", tone: .info); return }
            model.upload(surface, hack)
        }
        .onLongPressGesture(minimumDuration: 0.6, maximumDistance: 30, perform: {
            if hack.needsHold { model.upload(surface, hack) }
        }, onPressingChanged: { pressing in
            if hack.needsHold { holding = pressing }
        })
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("hack." + hack.id)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(hack.needsHold ? "Hold to run; this cannot be undone" : "Runs this hack on your device")
    }

    private func detail(_ st: HackSendState) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(st.words).font(Typo.mono(12, weight: .semibold))
                    .foregroundStyle(st.verdict == true ? Neon.ok : st.verdict == false ? Neon.fail : Neon.volt)
                Spacer(minLength: 0)
                Text(st.sentAt, style: .relative).font(Typo.mono(10)).foregroundStyle(Neon.dim)
            }
            if let s = st.sentence { Text(s).font(Typo.mono(11)).foregroundStyle(Neon.bone).fixedSize(horizontal: false, vertical: true) }
            if let samples = st.samples, samples.count >= 2 {
                Sparkline(samples: samples, color: st.verdict == false ? Neon.fail : Neon.ok).frame(height: 26)
            }
        }
        .padding(.horizontal, 12).padding(.bottom, 10).padding(.top, 2)
    }
}

struct DaemonRowView: View {
    @Environment(AppModel.self) private var model
    var surface: Surface
    var daemon: DaemonRow

    var body: some View {
        let rate = min(daemon.rateHz ?? 2, 3)
        HStack(spacing: 12) {
            Text("∞").font(Typo.mono(18, weight: .bold)).foregroundStyle(Neon.magenta).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(daemon.name).font(Typo.label(15)).tracking(0.8).foregroundStyle(Neon.bone).lineLimit(1)
                Text("\(String(format: rate < 1 ? "%.1f" : "%.0f", rate)) Hz · capped").font(Typo.mono(11)).foregroundStyle(Neon.dim)
            }
            Spacer()
            Text(daemon.status.uppercased()).font(Typo.mono(10, weight: .bold)).foregroundStyle(Neon.status(daemon.status))
            if let cid = daemon.controlId, let c = surface.control(cid) {
                Button(daemon.status == "running" ? "PAUSE" : "RUN") {
                    model.commit(surface, c, .bool(daemon.status != "running"))
                }
                .font(Typo.label(11)).foregroundStyle(Neon.magenta)
                .padding(.horizontal, 10).padding(.vertical, 8).overlay(Rectangle().stroke(Neon.magenta.opacity(0.6), lineWidth: 1))
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 56)
        .plate(edge: Neon.magenta, cut: 8, edgeOpacity: 0.55)
    }
}

/// The raw signal behind a verdict (a two-point bar when only before/after are known).
struct Sparkline: View {
    var samples: [Double]
    var color: Color
    var body: some View {
        GeometryReader { g in
            let lo = samples.min() ?? 0, hi = samples.max() ?? 1
            let span = max(hi - lo, 1e-9)
            Path { p in
                for (i, v) in samples.enumerated() {
                    let x = g.size.width * CGFloat(i) / CGFloat(max(samples.count - 1, 1))
                    let y = g.size.height * (1 - CGFloat((v - lo) / span))
                    if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
                }
            }
            .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineJoin: .round))
        }
        .padding(4)
        .background(Neon.void)
        .overlay(Rectangle().stroke(color.opacity(0.35), lineWidth: 1))
    }
}
