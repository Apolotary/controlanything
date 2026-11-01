import SwiftUI

/// The full-screen colour wash driven by exec.command `screen` (governed to <= 3 flashes per second in
/// LocalExecutor). Tap to clear it locally.
struct ScreenWashOverlay: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let ex = model.executor
        if ex.washVisible, let c = ex.washColor {
            ZStack(alignment: .bottom) {
                Neon.void.opacity(ex.washOpacity < 1 ? 1 : 0).ignoresSafeArea()
                c.opacity(ex.washOpacity).ignoresSafeArea()
                Text("SCREEN \(ex.washHex ?? "") · \(ex.washMode)\(ex.washRateHz > 0 ? String(format: " %.1f Hz", ex.washRateHz) : "") · tap to clear")
                    .font(Typo.mono(11)).foregroundStyle(Neon.bone)
                    .padding(.horizontal, 10).padding(.vertical, 6).background(Neon.void.opacity(0.92))
                    .padding(.bottom, 40)
            }
            .contentShape(Rectangle())
            .onTapGesture { ex.clearWash() }
            .transition(.opacity)
            .accessibilityLabel("Screen colour from your server. Tap to clear.")
        }
    }
}

/// Torch, speech and similar local effects, written on screen (and the only torch you get in the Simulator).
struct LocalEffectsStrip: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let ex = model.executor
        VStack(spacing: 6) {
            if ex.torchLevel > 0 {
                chip("TORCH \(Int((ex.torchLevel * 100).rounded())) %\(ex.torchIsVirtual ? " · no torch here, shown only" : "")", Neon.volt)
            }
            if let s = ex.speaking { chip("SAYING “\(s.prefix(40))\(s.count > 40 ? "…" : "")”", Neon.cyan) }
        }
        .allowsHitTesting(false)
    }

    private func chip(_ text: String, _ color: Color) -> some View {
        Text(text).font(Typo.mono(11, weight: .semibold)).foregroundStyle(color)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Neon.void.opacity(0.94))
            .overlay(Rectangle().stroke(color.opacity(0.6), lineWidth: 1))
    }
}

struct BannerView: View {
    var banner: Banner
    var body: some View {
        let color: Color = switch banner.tone {
        case .ok: Neon.ok
        case .fail: Neon.fail
        case .link: Neon.magenta
        case .info: Neon.cyan
        }
        HStack(spacing: 8) {
            Pip(color: color)
            Text(banner.text).font(Typo.mono(12)).foregroundStyle(Neon.bone).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .plate(edge: color, cut: 8, edgeOpacity: 0.8)
        .padding(.horizontal, 12)
        .transition(.move(edge: .top).combined(with: .opacity))
    }
}

/// ARM: the one-tap human confirmation before the agent first drives a device (hold when irreversible).
struct ArmCard: View {
    @Environment(AppModel.self) private var model
    var arm: ArmRequestPayload
    @State private var holding = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("ARM").hudLabel(12, color: Neon.magenta)
                Text("one tap = your consent").font(Typo.mono(10)).foregroundStyle(Neon.dim)
                Spacer()
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    let left = max(0, Int((arm.expiresAt - ctx.date.timeIntervalSince1970 * 1000) / 1000))
                    Text("\(left) s").font(Typo.mono(10)).foregroundStyle(Neon.dim)
                }
            }
            Text(arm.title).font(Typo.label(17)).foregroundStyle(Neon.bone)
            Text(arm.summary).font(Typo.mono(12)).foregroundStyle(Neon.dim).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 4) {
                ForEach(arm.actions, id: \.actionId) { a in
                    HStack(spacing: 8) {
                        Pip(color: a.verified == "pass" ? Neon.ok : a.verified == "fail" ? Neon.fail : Neon.dim, filled: a.verified == "pass" || a.verified == "fail", size: 6)
                        Text(a.label).font(Typo.mono(12)).foregroundStyle(Neon.bone)
                        Spacer()
                        Text(a.verified == "pass" ? "seen ✓" : a.verified == "fail" ? "no reaction ✗" : a.verified).font(Typo.mono(10))
                            .foregroundStyle(a.verified == "pass" ? Neon.ok : a.verified == "fail" ? Neon.fail : Neon.dim)
                    }
                }
            }
            HStack(spacing: 10) {
                if arm.irreversible == true {
                    Text(holding ? "HOLDING…" : "HOLD TO ARM · NO UNDO")
                        .font(Typo.label(13)).foregroundStyle(Neon.void)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(
                            GeometryReader { g in
                                ZStack(alignment: .leading) {
                                    Chamfer(cut: 8).fill(Neon.volt.opacity(0.55))
                                    Rectangle().fill(Neon.volt).frame(width: holding ? g.size.width : 0)
                                        .animation(holding ? .linear(duration: 0.6) : .easeOut(duration: 0.1), value: holding)
                                }
                                .clipShape(Chamfer(cut: 8))
                            }
                        )
                        .onLongPressGesture(minimumDuration: 0.6, maximumDistance: 30, perform: {
                            model.confirmArm(arm, approve: true, hold: true)
                        }, onPressingChanged: { holding = $0 })
                } else {
                    Button("ARM") { model.confirmArm(arm, approve: true) }
                        .accessibilityIdentifier("arm.approve")
                        .font(Typo.label(14)).tracking(1.5).foregroundStyle(Neon.void)
                        .frame(maxWidth: .infinity, minHeight: 50).background(Chamfer(cut: 8).fill(Neon.volt))
                }
                Button("NOT NOW") { model.confirmArm(arm, approve: false) }
                    .font(Typo.label(13)).foregroundStyle(Neon.dim)
                    .frame(maxWidth: .infinity, minHeight: 50).plate(edge: Neon.dim, cut: 8)
            }
            .buttonStyle(.plain)
        }
        .padding(14)
        .plate(edge: Neon.magenta, cut: 12, edgeOpacity: 0.9)
        .shadow(color: .black.opacity(0.6), radius: 20)
        .padding(12)
    }
}
