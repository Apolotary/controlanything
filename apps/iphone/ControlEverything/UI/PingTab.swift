import SwiftUI

/// PING: how every device is reached. Arm requests and pairing approvals first (this phone is an approver),
/// then the devices the agent identified (link state in words), the paired clients, this phone's own hacks,
/// and the server.
struct PingTab: View {
    @Environment(AppModel.self) private var model
    @State private var scanningApproval = false
    @State private var confirmUnpair = false

    var body: some View {
        @Bindable var model = model
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if !model.pending.isEmpty { pendingSection }
                approveByCode(model: model)
                devicesSection
                clientsSection
                ThisPhoneSection()
                serverSection
            }
            .padding(14)
        }
        .sheet(isPresented: $scanningApproval) {
            VStack(spacing: 14) {
                Text("SCAN THE DEVICE'S PAIRING QR").hudLabel(13, color: Neon.cyan).padding(.top, 20)
                QRScannerView { code in
                    if ServerEndpoint.pairingTarget(from: code) != nil {
                        model.handleScannedQR(code)
                        scanningApproval = false
                    }
                }
                .frame(height: 360)
                Button("CLOSE") { scanningApproval = false }.font(Typo.label(13)).foregroundStyle(Neon.dim)
            }
            .padding(18)
            .presentationDetents([.large])
            .background(HUDBackground())
        }
        .confirmationDialog("Unpair this phone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) { model.unpair() }
        } message: {
            Text("It forgets its device token. Pair it again with a new code.")
        }
    }

    // MARK: approvals

    private var pendingSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(title: "WANTS TO JOIN", subtitle: "your space")
            ForEach(model.pending) { p in
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(p.name).font(Typo.label(16)).foregroundStyle(Neon.bone)
                        Text(p.kind.uppercased()).font(Typo.mono(10, weight: .bold)).foregroundStyle(Neon.dim)
                        Spacer()
                        Text(p.display).font(Typo.mono(20, weight: .bold)).foregroundStyle(Neon.volt)
                    }
                    Text("Check this code matches the one on its screen.").font(Typo.mono(11)).foregroundStyle(Neon.dim)
                    HStack(spacing: 10) {
                        Button("APPROVE") { model.approve(p) }
                            .font(Typo.label(13)).foregroundStyle(Neon.void)
                            .frame(maxWidth: .infinity, minHeight: 46).background(Chamfer(cut: 8).fill(Neon.volt))
                        Button("DENY") { model.deny(p) }
                            .font(Typo.label(13)).foregroundStyle(Neon.dim)
                            .frame(maxWidth: .infinity, minHeight: 46).plate(edge: Neon.dim, cut: 8)
                    }
                    .buttonStyle(.plain)
                }
                .padding(12).plate(edge: Neon.magenta, cut: 8)
            }
        }
    }

    private func approveByCode(model: AppModel) -> some View {
        @Bindable var model = model
        return VStack(alignment: .leading, spacing: 8) {
            SectionTitle(title: "LINK", subtitle: "approve a new device")
            HStack(spacing: 8) {
                TextField("", text: $model.approveCodeInput, prompt: Text("K7Q-4M2").foregroundStyle(Neon.dim.opacity(0.5)))
                    .font(Typo.mono(20, weight: .semibold)).foregroundStyle(Neon.bone)
                    .textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .submitLabel(.go).onSubmit { model.approveTypedCode() }
                    .padding(.horizontal, 12).frame(minHeight: 50).plate(cut: 8)
                Button("APPROVE") { model.approveTypedCode() }
                    .font(Typo.label(12)).foregroundStyle(Neon.void)
                    .padding(.horizontal, 14).frame(minHeight: 50).background(Chamfer(cut: 8).fill(Neon.volt))
                    .buttonStyle(.plain)
                    .disabled(!model.isOnline)
            }
            Button {
                scanningApproval = true
            } label: {
                Text("SCAN ITS QR").font(Typo.label(12)).tracking(1).foregroundStyle(Neon.cyan)
                    .frame(maxWidth: .infinity, minHeight: 44).plate(cut: 8)
            }
            .buttonStyle(.plain)
            .disabled(!model.isOnline)
        }
    }

    // MARK: devices the agent identified

    private var devicesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(title: "PING", subtitle: "how your devices are reached")
            if model.cardOrder.isEmpty {
                Text("No devices identified yet. Scan one with the headset or the SCAN tab.")
                    .font(Typo.mono(11)).foregroundStyle(Neon.dim)
            }
            ForEach(model.cardOrder, id: \.self) { id in deviceRow(id) }
        }
    }

    private func deviceRow(_ id: String) -> some View {
        let card = model.cards[id]
        let target = model.targets[id]
        let link = model.links[id]
        let proven = link.map { ["confirmed", "consistent"].contains($0.verdict) } ?? false
        let proof = link?.evidence?.first(where: \.ok)?.detail ?? link?.reason
        let channel = link?.channel ?? card?.protocols?.first
        return HStack(alignment: .top, spacing: 10) {
            Text(ChannelGlyph.text(channel)).font(Typo.mono(10, weight: .bold)).foregroundStyle(proven ? Neon.cyan : Neon.dim)
                .frame(width: 38, height: 24).overlay(Rectangle().stroke((proven ? Neon.cyan : Neon.dim).opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: proven ? [] : [3, 3])))
            VStack(alignment: .leading, spacing: 3) {
                Text(card?.name ?? id).font(Typo.label(15)).foregroundStyle(Neon.bone)
                Text(proven ? "proven" + (proof.map { " · \($0)" } ?? "") : "hypothesis" + (target.map { " · \($0.state)" } ?? ""))
                    .font(Typo.mono(11)).foregroundStyle(proven ? Neon.ok : Neon.dim).lineLimit(2)
                if let d = target?.detail { Text(d).font(Typo.mono(10)).foregroundStyle(Neon.dim).lineLimit(2) }
            }
            Spacer(minLength: 0)
            if let c = card?.confidence { Text(String(format: "%.0f %%", c * 100)).font(Typo.mono(10)).foregroundStyle(Neon.dim) }
        }
        .padding(12)
        .plate(edge: proven ? Neon.cyan : Neon.dim, cut: 8, dashed: !proven)
    }

    // MARK: paired clients

    private var clientsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(title: "COMPANIONS", subtitle: "\(model.presence.filter(\.online).count) online")
            ForEach(model.presence) { d in
                HStack(spacing: 10) {
                    Pip(color: d.online ? Neon.ok : Neon.dim, filled: d.online)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(d.name).font(Typo.label(14)).foregroundStyle(d.online ? Neon.bone : Neon.dim)
                            if d.deviceId == model.myDeviceId { Text("THIS PHONE").font(Typo.mono(9, weight: .bold)).foregroundStyle(Neon.volt) }
                        }
                        Text(([d.kind] + (d.capabilities ?? [])).joined(separator: " · ")).font(Typo.mono(10)).foregroundStyle(Neon.dim).lineLimit(1)
                    }
                    Spacer()
                    Text(d.online ? "online" : "offline").font(Typo.mono(10)).foregroundStyle(d.online ? Neon.ok : Neon.dim)
                }
                .padding(.horizontal, 12).frame(minHeight: 50)
                .plate(edge: d.online ? Neon.cyan : Neon.dim, cut: 8, edgeOpacity: d.online ? 0.5 : 0.3)
            }
        }
    }

    // MARK: server

    private var serverSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(title: "SERVER", subtitle: nil)
            VStack(alignment: .leading, spacing: 4) {
                kv("address", model.credentials?.server.base.absoluteString ?? "—")
                kv("this phone", "\(model.credentials?.name ?? "—") · \(model.myDeviceId ?? "—")")
                kv("space", model.welcome?.spaceId ?? "—")
                kv("models", model.welcome?.mode == "live" ? "live Meta models" : model.welcome?.mode == "fixture" ? "fixture replay" : "—")
            }
            .padding(12).plate(cut: 8)
            HStack(spacing: 10) {
                Button {
                    model.panic()
                } label: {
                    Text("PANIC · STOP ALL").font(Typo.label(13)).tracking(1).foregroundStyle(Neon.volt)
                        .frame(maxWidth: .infinity, minHeight: 48).plate(edge: Neon.volt, cut: 8)
                }
                .buttonStyle(.plain)
                Button {
                    confirmUnpair = true
                } label: {
                    Text("UNPAIR").font(Typo.label(13)).tracking(1).foregroundStyle(Neon.dim)
                        .frame(maxWidth: .infinity, minHeight: 48).plate(edge: Neon.dim, cut: 8)
                }
                .buttonStyle(.plain)
            }
            if model.surfaces.contains(where: \.isDemo) {
                Button("REMOVE DEMO SURFACES") { model.removeDemoSurfaces() }
                    .font(Typo.label(11)).foregroundStyle(Neon.dim)
            } else {
                Button("LOAD DEMO SURFACES") { model.loadDemoSurfaces() }
                    .font(Typo.label(11)).foregroundStyle(Neon.dim)
            }
        }
    }

    private func kv(_ k: String, _ v: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(k.uppercased()).font(Typo.label(9)).tracking(0.8).foregroundStyle(Neon.dim).frame(width: 82, alignment: .leading)
            Text(v).font(Typo.mono(11)).foregroundStyle(Neon.bone).lineLimit(2).textSelection(.enabled)
        }
    }
}

/// The phone as a device: its own hacks, run here for testing (the agent drives the same ops over exec.command).
struct ThisPhoneSection: View {
    @Environment(AppModel.self) private var model
    @State private var torch = 0.0
    @State private var hue = 0.52
    @State private var lastDetail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(title: "THIS PHONE", subtitle: "its own hacks · run here to test")
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("TORCH").hudLabel(12)
                    Spacer()
                    Text(torch <= 0 ? "OFF" : "\(Int(torch * 100)) %").font(Typo.mono(12)).foregroundStyle(Neon.volt)
                }
                Slider(value: $torch, in: 0...1, step: 0.1) { editing in
                    if !editing { run("torch", .number(torch)) }
                }
                .tint(Neon.volt)
                HStack(spacing: 10) {
                    button("PULSE HAPTICS") { run("haptic", .string("pulse")) }
                    button("SAY HELLO") { run("say", .string("Linked. This phone takes orders from your server.")) }
                }
                HStack {
                    Text("GLOW SCREEN").hudLabel(12)
                    Spacer()
                    Circle().fill(Color(hue: hue, saturation: 0.85, brightness: 1)).frame(width: 18, height: 18)
                }
                Slider(value: $hue, in: 0...1).tint(Color(hue: hue, saturation: 0.85, brightness: 1))
                HStack(spacing: 10) {
                    button("GLOW 3 S") { run("screen", .object(["color": .string(hex(hue)), "mode": .string("steady"), "ms": .number(3000)])) }
                    button("PULSE 1 HZ") { run("screen", .object(["color": .string(hex(hue)), "mode": .string("pulse"), "hz": .number(1), "ms": .number(4000)])) }
                }
                HStack(spacing: 10) {
                    button("BEEP") { run("beep", .object(["freq": .number(880), "count": .number(2)])) }
                    button("SECOND EYE") { Task { await secondEye() } }
                }
                if let d = lastDetail { Text(d).font(Typo.mono(11)).foregroundStyle(Neon.dim) }
            }
            .padding(12).plate(cut: 8)
        }
    }

    private func button(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(Typo.label(11)).tracking(0.8).foregroundStyle(Neon.cyan)
                .frame(maxWidth: .infinity, minHeight: 44).overlay(Chamfer(cut: 6).stroke(Neon.cyan.opacity(0.55), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func run(_ op: String, _ arg: JSONValue) {
        let o = model.executor.run(ExecOp(kind: "local", op: op, arg: arg, msg: nil, protocol: nil))
        lastDetail = (o.ok ? "ok · " : "✗ · ") + o.detail
    }

    private func secondEye() async {
        do {
            let shot = try await CameraController.shared.capture()
            lastDetail = "second eye ready · \(shot.width)×\(shot.height), \(shot.jpeg.count / 1024) KB (sent when the server asks)"
        } catch {
            lastDetail = "second eye: \(error.localizedDescription)"
        }
    }

    private func hex(_ h: Double) -> String {
        let c = UIColor(hue: h, saturation: 0.85, brightness: 1, alpha: 1)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0
        c.getRed(&r, green: &g, blue: &b, alpha: nil)
        return String(format: "#%02X%02X%02X", Int(r * 255), Int(g * 255), Int(b * 255))
    }
}
