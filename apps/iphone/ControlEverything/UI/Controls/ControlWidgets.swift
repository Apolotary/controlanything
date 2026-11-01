import SwiftUI

/// What a widget needs: the control, its live value, colours, arm state, and the gesture callbacks.
struct WidgetIO {
    var control: Control
    var value: ControlValue
    var accent: Color
    var armed: Bool
    var begin: () -> Void
    var change: (ControlValue) -> Void
    var end: (ControlValue) -> Void
    /// one discrete change (tap): records undo and sends one event
    var commit: (ControlValue) -> Void
    var trigger: (Int?) -> Void

    var number: Double { value.number ?? control.lo }
    var t: Double { control.normalized(number) }
}

// MARK: - geometry helpers

private func arcPath(center: CGPoint, radius: CGFloat, from a0: Double, to a1: Double) -> Path {
    var p = Path()
    p.addArc(center: center, radius: radius, startAngle: .degrees(a0), endAngle: .degrees(a1), clockwise: false)
    return p
}

/// A neon stroke over a wider void keyline (legible over anything).
private struct KeylineArc: View {
    var from: Double
    var to: Double
    var color: Color
    var width: CGFloat
    var body: some View {
        GeometryReader { g in
            let c = CGPoint(x: g.size.width / 2, y: g.size.height / 2)
            let r = min(g.size.width, g.size.height) / 2 - width
            ZStack {
                arcPath(center: c, radius: r, from: from, to: to).stroke(Neon.void, style: StrokeStyle(lineWidth: width + 4, lineCap: .butt))
                arcPath(center: c, radius: r, from: from, to: to).stroke(color, style: StrokeStyle(lineWidth: width, lineCap: .butt))
            }
        }
    }
}

private struct Readout: View {
    var text: String
    var color: Color = Neon.volt
    var body: some View {
        Text(text).font(Typo.mono(13, weight: .semibold)).monospacedDigit().foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Neon.void.opacity(0.95))
            .overlay(Rectangle().stroke(color.opacity(0.45), lineWidth: 1))
            .lineLimit(1).minimumScaleFactor(0.6)
    }
}

/// Emits a selection tick every time the value crosses a detent (each step, or every 5 % of the range).
private struct DetentTicker {
    var last: Int?
    mutating func update(_ c: Control, _ v: Double) {
        let step = c.range?.step ?? (c.kind == "stepped" ? 1 : (c.hi - c.lo) * 0.05)
        guard step > 0 else { return }
        let i = Int(((v - c.lo) / step).rounded(.down))
        if let last, last != i { Haptics.shared.tick() }
        last = i
    }
}

// MARK: - knob (vertical drag turns it; 270° sweep)

struct KnobWidget: View {
    var io: WidgetIO
    var size: CGFloat = 96
    @State private var startT: Double?
    @State private var ticker = DetentTicker()

    private let a0 = 135.0, sweep = 270.0

    var body: some View {
        VStack(spacing: 6) {
            Text(io.control.label).hudLabel(11, color: Neon.dim)
            ZStack {
                KeylineArc(from: a0, to: a0 + sweep, color: io.accent.opacity(0.22), width: 6)
                KeylineArc(from: a0, to: a0 + sweep * max(0.001, io.t), color: Neon.volt, width: 6)
                Circle().fill(Neon.holo).padding(size * 0.2)
                Circle().stroke(io.accent, lineWidth: 1.5).padding(size * 0.2)
                // pointer
                GeometryReader { g in
                    let c = CGPoint(x: g.size.width / 2, y: g.size.height / 2)
                    let ang = (a0 + sweep * io.t) * .pi / 180
                    let r0 = size * 0.08, r1 = size * 0.28
                    Path { p in
                        p.move(to: CGPoint(x: c.x + cos(ang) * r0, y: c.y + sin(ang) * r0))
                        p.addLine(to: CGPoint(x: c.x + cos(ang) * r1, y: c.y + sin(ang) * r1))
                    }
                    .stroke(Neon.volt, style: StrokeStyle(lineWidth: 3.5, lineCap: .round))
                }
            }
            .frame(width: size, height: size)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { g in
                        if startT == nil { startT = io.t; io.begin() }
                        let v = io.control.quantize(io.control.denormalized((startT ?? 0) - g.translation.height / 180))
                        ticker.update(io.control, v)
                        io.change(.number(v))
                    }
                    .onEnded { g in
                        let v = io.control.quantize(io.control.denormalized((startT ?? io.t) - g.translation.height / 180))
                        startT = nil
                        io.end(.number(v))
                    }
            )
            .accessibilityElement()
            .accessibilityLabel(io.control.label)
            .accessibilityValue(io.control.format(io.number))
            .accessibilityAdjustableAction { dir in
                let step = io.control.range?.step ?? (io.control.hi - io.control.lo) / 20
                io.commit(.number(io.control.quantize(io.number + (dir == .increment ? step : -step))))
            }
            Readout(text: io.control.format(io.number))
        }
    }
}

// MARK: - dimmer ring (circular drag around the ring)

struct RingWidget: View {
    var io: WidgetIO
    var size: CGFloat = 210
    @State private var drag: (startT: Double, lastAngle: Double, accum: Double)?
    @State private var ticker = DetentTicker()

    private let a0 = 120.0, sweep = 300.0

    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                KeylineArc(from: a0, to: a0 + sweep, color: io.accent.opacity(0.22), width: 16)
                KeylineArc(from: a0, to: a0 + sweep * max(0.002, io.t), color: Neon.volt, width: 16)
                Circle().fill(Neon.holo.opacity(0.9)).padding(size * 0.2)
                Circle().stroke(io.accent.opacity(0.7), lineWidth: 1).padding(size * 0.2)
                VStack(spacing: 2) {
                    Text(io.control.format(io.number)).font(Typo.mono(30, weight: .bold)).monospacedDigit().foregroundStyle(Neon.bone)
                        .lineLimit(1).minimumScaleFactor(0.5)
                    Text(io.control.label).hudLabel(11, color: Neon.dim)
                }
                .padding(size * 0.24)
            }
            .frame(width: size, height: size)
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { g in
                        let c = CGPoint(x: size / 2, y: size / 2)
                        let ang = atan2(g.location.y - c.y, g.location.x - c.x) * 180 / .pi
                        if drag == nil { drag = (io.t, ang, 0); io.begin(); return }
                        var d = ang - drag!.lastAngle
                        if d > 180 { d -= 360 } else if d < -180 { d += 360 }
                        drag!.accum += d
                        drag!.lastAngle = ang
                        let v = io.control.quantize(io.control.denormalized(drag!.startT + drag!.accum / sweep))
                        ticker.update(io.control, v)
                        io.change(.number(v))
                    }
                    .onEnded { _ in
                        drag = nil
                        io.end(.number(io.number))
                    }
            )
            .accessibilityElement()
            .accessibilityLabel(io.control.label)
            .accessibilityValue(io.control.format(io.number))
            .accessibilityAdjustableAction { dir in
                let step = io.control.range?.step ?? (io.control.hi - io.control.lo) / 20
                io.commit(.number(io.control.quantize(io.number + (dir == .increment ? step : -step))))
            }
            Text("DRAG AROUND THE RING").hudLabel(9, color: Neon.dim.opacity(0.8), bold: false)
        }
    }
}

// MARK: - fader (vertical)

struct FaderWidget: View {
    var io: WidgetIO
    var height: CGFloat = 170
    @State private var startT: Double?
    @State private var ticker = DetentTicker()

    var body: some View {
        VStack(spacing: 6) {
            Text(io.control.label).hudLabel(11, color: Neon.dim)
            GeometryReader { g in
                let h = g.size.height
                let capY = h - CGFloat(io.t) * (h - 28) - 14
                ZStack(alignment: .top) {
                    Rectangle().fill(Neon.void).frame(width: 12)
                    Rectangle().fill(io.accent.opacity(0.25)).frame(width: 6)
                    Rectangle().fill(Neon.volt).frame(width: 6, height: max(0, h - capY)).offset(y: capY)
                    Chamfer(cut: 5).fill(Neon.holo).overlay(Chamfer(cut: 5).stroke(Neon.volt, lineWidth: 2))
                        .frame(width: 46, height: 26).offset(y: capY - 13)
                }
                .frame(maxWidth: .infinity)
            }
            .frame(width: 64, height: height)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { g in
                        if startT == nil { startT = io.t; io.begin() }
                        let v = io.control.quantize(io.control.denormalized((startT ?? 0) - g.translation.height / (height - 28)))
                        ticker.update(io.control, v)
                        io.change(.number(v))
                    }
                    .onEnded { _ in startT = nil; io.end(.number(io.number)) }
            )
            .accessibilityElement()
            .accessibilityLabel(io.control.label)
            .accessibilityValue(io.control.format(io.number))
            .accessibilityAdjustableAction { dir in
                let step = io.control.range?.step ?? (io.control.hi - io.control.lo) / 20
                io.commit(.number(io.control.quantize(io.number + (dir == .increment ? step : -step))))
            }
            Readout(text: io.control.format(io.number))
        }
    }
}

// MARK: - stepped: segmented (warmth bar for the `wheel` archetype)

struct SteppedWidget: View {
    var io: WidgetIO
    var warmth = false

    private var steps: [String] {
        if let l = io.control.stepLabels, !l.isEmpty { return l }
        let step = io.control.range?.step ?? 1
        let n = Int(((io.control.hi - io.control.lo) / max(step, 0.0001)).rounded()) + 1
        return (0..<min(max(n, 2), 12)).map { io.control.format(io.control.lo + Double($0) * step) }
    }

    private func warmColor(_ i: Int, _ n: Int) -> Color {
        let t = n > 1 ? Double(i) / Double(n - 1) : 0
        return Color(red: 1.0, green: 0.62 + 0.36 * t, blue: 0.28 + 0.70 * t)
    }

    var body: some View {
        let labels = steps
        let selected = Int(((io.number - io.control.lo) / (io.control.range?.step ?? 1)).rounded())
        VStack(alignment: .leading, spacing: 8) {
            Text(io.control.label).hudLabel(11, color: Neon.dim)
            HStack(spacing: 4) {
                ForEach(Array(labels.enumerated()), id: \.offset) { i, name in
                    let on = i == selected
                    Button {
                        Haptics.shared.tick()
                        io.commit(.number(io.control.quantize(io.control.lo + Double(i) * (io.control.range?.step ?? 1))))
                    } label: {
                        VStack(spacing: 4) {
                            Rectangle().fill(warmth ? warmColor(i, labels.count) : (on ? Neon.volt : io.accent.opacity(0.3)))
                                .frame(height: 6)
                                .overlay(Rectangle().stroke(Neon.void, lineWidth: 1))
                            Text(name).font(Typo.label(10, bold: on)).tracking(0.6).foregroundStyle(on ? Neon.void : Neon.bone)
                                .lineLimit(1).minimumScaleFactor(0.6)
                        }
                        .padding(.vertical, 8).padding(.horizontal, 2)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(on ? Neon.volt : Neon.void.opacity(0.9))
                        .overlay(Rectangle().stroke(on ? Neon.volt : io.accent.opacity(0.4), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(io.control.label) \(name)")
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }
    }
}

// MARK: - toggle

struct ToggleWidget: View {
    var io: WidgetIO
    var cord = false

    var body: some View {
        let on = io.value.bool ?? false
        VStack(spacing: 8) {
            Text(io.control.label).hudLabel(11, color: Neon.dim)
            Button {
                Haptics.shared.tap()
                io.commit(.bool(!on))
            } label: {
                ZStack(alignment: on ? .trailing : .leading) {
                    Capsule().fill(on ? Neon.volt.opacity(0.22) : Neon.void).frame(width: 84, height: 44)
                        .overlay(Capsule().stroke(on ? Neon.volt : io.accent.opacity(0.5), lineWidth: 1.5))
                    Circle().fill(on ? Neon.volt : Neon.holo).frame(width: 34, height: 34)
                        .overlay(Circle().stroke(on ? Neon.void : io.accent, lineWidth: 1.5))
                        .padding(.horizontal, 5)
                }
                .animation(.easeOut(duration: 0.12), value: on)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(io.control.label)
            .accessibilityValue(on ? "on" : "off")
            Readout(text: cord ? (on ? "PULLED · ON" : "OFF") : (on ? "ON" : "OFF"), color: on ? Neon.volt : Neon.dim)
        }
    }
}

// MARK: - trigger (momentary)

struct TriggerWidget: View {
    var io: WidgetIO
    @State private var pressed = false

    var body: some View {
        Button {
            Haptics.shared.tap()
            io.trigger(nil)
            pressed = true
            Task { try? await Task.sleep(for: .milliseconds(180)); pressed = false }
        } label: {
            HStack(spacing: 8) {
                Text("▸").font(Typo.mono(14, weight: .bold)).foregroundStyle(pressed ? Neon.void : Neon.volt)
                Text(io.control.label).hudLabel(13, color: pressed ? Neon.void : Neon.bone)
                    .lineLimit(1).minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Chamfer(cut: 8).fill(pressed ? Neon.volt : Neon.void.opacity(0.92)))
            .overlay(Chamfer(cut: 8).stroke(pressed ? Neon.volt : io.accent.opacity(0.6), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(io.control.label)
    }
}

// MARK: - XY pad

struct XYWidget: View {
    var io: WidgetIO
    @State private var dragging = false

    var body: some View {
        let c = io.control
        let yr = c.yRange ?? ControlRange(min: 0, max: 1)
        let (x, y): (Double, Double) = {
            if case .xy(let x, let y) = io.value { return (x, y) }
            return ((c.lo + c.hi) / 2, (yr.min + yr.max) / 2)
        }()
        let tx = c.normalized(x)
        let ty = yr.max > yr.min ? (y - yr.min) / (yr.max - yr.min) : 0
        VStack(alignment: .leading, spacing: 6) {
            Text(c.label).hudLabel(11, color: Neon.dim)
            GeometryReader { g in
                let w = g.size.width, h = g.size.height
                ZStack {
                    Rectangle().fill(Neon.holo.opacity(0.7))
                    Path { p in
                        for i in 1..<4 {
                            p.move(to: CGPoint(x: w * CGFloat(i) / 4, y: 0)); p.addLine(to: CGPoint(x: w * CGFloat(i) / 4, y: h))
                            p.move(to: CGPoint(x: 0, y: h * CGFloat(i) / 4)); p.addLine(to: CGPoint(x: w, y: h * CGFloat(i) / 4))
                        }
                    }.stroke(io.accent.opacity(0.15), lineWidth: 1)
                    Path { p in
                        p.move(to: CGPoint(x: w * tx, y: 0)); p.addLine(to: CGPoint(x: w * tx, y: h))
                        p.move(to: CGPoint(x: 0, y: h * (1 - ty))); p.addLine(to: CGPoint(x: w, y: h * (1 - ty)))
                    }.stroke(Neon.volt.opacity(0.7), lineWidth: 1)
                    Circle().fill(Neon.volt).frame(width: dragging ? 30 : 22, height: dragging ? 30 : 22)
                        .overlay(Circle().stroke(Neon.void, lineWidth: 2))
                        .position(x: w * tx, y: h * (1 - ty))
                }
                .overlay(Rectangle().stroke(io.accent.opacity(0.6), lineWidth: 1))
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { gs in
                            if !dragging { dragging = true; io.begin() }
                            let nx = c.quantize(c.denormalized(gs.location.x / w))
                            let fy = min(1, max(0, 1 - gs.location.y / h))
                            io.change(.xy(x: nx, y: yr.min + fy * (yr.max - yr.min)))
                        }
                        .onEnded { _ in dragging = false; io.end(io.value) }
                )
            }
            .aspectRatio(1.4, contentMode: .fit)
            Readout(text: String(format: "X %.2f · Y %.2f", x, y))
        }
    }
}

// MARK: - pads (triggers with an index)

struct PadsWidget: View {
    var io: WidgetIO
    var count = 8
    @State private var lit: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(io.control.label).hudLabel(11, color: Neon.dim)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 4), spacing: 6) {
                ForEach(0..<count, id: \.self) { i in
                    Button {
                        Haptics.shared.tap()
                        io.trigger(i)
                        lit = i
                        Task { try? await Task.sleep(for: .milliseconds(140)); if lit == i { lit = nil } }
                    } label: {
                        Rectangle().fill(lit == i ? Neon.volt : Neon.holo)
                            .overlay(Rectangle().stroke(io.accent.opacity(0.6), lineWidth: 1))
                            .overlay(Text("\(i + 1)").font(Typo.mono(11)).foregroundStyle(lit == i ? Neon.void : Neon.dim))
                            .aspectRatio(1, contentMode: .fit)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(io.control.label) pad \(i + 1)")
                }
            }
        }
    }
}
