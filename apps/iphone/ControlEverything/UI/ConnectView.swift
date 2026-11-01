import SwiftUI

/// Step 1: find the server. Scan the "add a device" QR on the Mac companion, or type the address.
struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var focused: Bool

    var body: some View {
        @Bindable var model = model
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("CONTROL\nEVERYTHING").font(Typo.title(34)).tracking(2).foregroundStyle(Neon.bone)
                        .lineSpacing(-4)
                    Text("Pocket deck for the devices you own").font(Typo.mono(13)).foregroundStyle(Neon.dim)
                }
                .padding(.top, 8)

                SectionTitle(title: "LINK", subtitle: "find your server")
                QRScannerView { code in
                    guard !model.busy else { return }
                    model.serverInput = code
                    Task { await model.connect(input: code) }
                }
                .frame(height: 240)
                Text("Scan the “add a device” QR on the Mac companion, or type the address the server printed.")
                    .font(Typo.mono(11)).foregroundStyle(Neon.dim)

                VStack(alignment: .leading, spacing: 8) {
                    Text("SERVER").hudLabel(10, color: Neon.dim)
                    TextField("", text: $model.serverInput, prompt: Text("192.168.1.20:8787").foregroundStyle(Neon.dim.opacity(0.6)))
                        .font(Typo.mono(17)).foregroundStyle(Neon.bone)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .submitLabel(.go).focused($focused)
                        .onSubmit { Task { await model.connect() } }
                        .padding(12).plate(edge: focused ? Neon.volt : Neon.cyan, cut: 8)
                    Text("THIS PHONE'S NAME").hudLabel(10, color: Neon.dim).padding(.top, 4)
                    TextField("", text: $model.deviceName, prompt: Text("iPhone").foregroundStyle(Neon.dim.opacity(0.6)))
                        .font(Typo.mono(15)).foregroundStyle(Neon.bone)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(12).plate(cut: 8)
                }

                if let err = model.connectError {
                    HStack(alignment: .top, spacing: 8) {
                        Pip(color: Neon.fail)
                        Text(err).font(Typo.mono(12)).foregroundStyle(Neon.bone).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(12).plate(edge: Neon.fail, cut: 8)
                }

                Button {
                    focused = false
                    Task { await model.connect() }
                } label: {
                    HStack {
                        if model.busy { ProgressView().tint(Neon.void) }
                        Text(model.busy ? "LINKING…" : "LINK TO SERVER").font(Typo.label(16)).tracking(1.6)
                    }
                    .foregroundStyle(Neon.void)
                    .frame(maxWidth: .infinity, minHeight: 54)
                    .background(Chamfer(cut: 10).fill(model.serverInput.isEmpty ? Neon.dim : Neon.volt))
                }
                .buttonStyle(.plain)
                .disabled(model.busy || model.serverInput.isEmpty)
                .accessibilityLabel("Link to server")

                Text("Same Wi-Fi as the Mac. Plain http on port 8787; https on 8443 also works.")
                    .font(Typo.mono(10)).foregroundStyle(Neon.dim.opacity(0.8))
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 30)
        }
        .scrollDismissesKeyboard(.interactively)
    }
}

/// Step 2: show our own QR + passcode until a trusted device approves (device-code flow).
struct PairingView: View {
    @Environment(AppModel.self) private var model
    @State private var savedBrightness: CGFloat?

    var body: some View {
        if let p = model.pairing {
            ScrollView {
                VStack(spacing: 18) {
                    VStack(spacing: 4) {
                        Text("PAIR THIS PHONE").font(Typo.title(22)).tracking(1.6).foregroundStyle(Neon.bone)
                        Text(p.endpoint.display).font(Typo.mono(12)).foregroundStyle(Neon.dim)
                    }
                    .padding(.top, 10)

                    QRCodeView(text: p.start.qr)
                        .frame(maxWidth: 270)
                        .overlay(Rectangle().stroke(Neon.cyan, lineWidth: 2).padding(-6))
                        .opacity(p.status == "pending" ? 1 : 0.25)

                    Text(p.start.display)
                        .font(Typo.mono(54, weight: .bold)).tracking(4).monospacedDigit().foregroundStyle(Neon.volt)
                        .padding(.horizontal, 18).padding(.vertical, 6).plate(edge: Neon.volt, cut: 10)
                        .accessibilityLabel("Passcode \(p.start.display.map { String($0) }.joined(separator: " "))")

                    VStack(spacing: 6) {
                        Text("Look at this code from the headset,").font(Typo.mono(13)).foregroundStyle(Neon.bone)
                        Text("or type it on the Mac companion.").font(Typo.mono(13)).foregroundStyle(Neon.bone)
                    }

                    status(p)

                    HStack(spacing: 12) {
                        Button("CANCEL") { model.cancelPairing() }
                            .font(Typo.label(13)).foregroundStyle(Neon.dim)
                            .frame(maxWidth: .infinity, minHeight: 48).plate(edge: Neon.dim, cut: 8)
                        if p.status != "pending" {
                            Button("NEW CODE") { Task { await model.restartPairing() } }
                                .font(Typo.label(13)).foregroundStyle(Neon.void)
                                .frame(maxWidth: .infinity, minHeight: 48).background(Chamfer(cut: 8).fill(Neon.volt))
                        }
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 22)
                .padding(.bottom, 30)
            }
            .onAppear { boostBrightness() }
            .onDisappear { restoreBrightness() }
        } else {
            ProgressView().tint(Neon.cyan)
        }
    }

    @ViewBuilder
    private func status(_ p: AppModel.PairingState) -> some View {
        HStack(spacing: 10) {
            switch p.status {
            case "pending":
                ProgressView().tint(Neon.volt)
                VStack(alignment: .leading, spacing: 2) {
                    Text("waiting for approval").font(Typo.mono(13, weight: .semibold)).foregroundStyle(Neon.volt)
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        let left = max(0, Int((p.start.expiresAt - ctx.date.timeIntervalSince1970 * 1000) / 1000))
                        Text("code expires in \(left / 60):\(String(format: "%02d", left % 60))").font(Typo.mono(11)).foregroundStyle(Neon.dim)
                    }
                }
            case "approved":
                Pip(color: Neon.ok)
                Text("approved").font(Typo.mono(13, weight: .semibold)).foregroundStyle(Neon.ok)
            default:
                Pip(color: Neon.fail)
                Text(p.status).font(Typo.mono(13, weight: .semibold)).foregroundStyle(Neon.fail)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .plate(edge: p.status == "pending" ? Neon.volt : p.status == "approved" ? Neon.ok : Neon.fail, cut: 8)
        if let m = p.message {
            Text(m).font(Typo.mono(11)).foregroundStyle(Neon.dim).multilineTextAlignment(.center)
        }
    }

    // a bright screen makes the QR easy for the headset camera
    private func boostBrightness() {
        guard let screen = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen else { return }
        savedBrightness = screen.brightness
        screen.brightness = 1
    }

    private func restoreBrightness() {
        guard let b = savedBrightness, let screen = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen else { return }
        screen.brightness = b
    }
}
