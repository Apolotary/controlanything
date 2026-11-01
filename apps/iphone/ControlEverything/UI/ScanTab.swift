import PhotosUI
import SwiftUI

/// Handheld scanner: a camera snapshot (or a photo from the library when there is no camera) goes to the
/// server as scan.frame; SAM 3.1 detections come back as scan.result and can be picked (target.select).
struct ScanTab: View {
    @Environment(AppModel.self) private var model
    @State private var pick: PhotosPickerItem?
    @State private var showCamera = CameraController.hasCamera

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                SectionTitle(title: "SCAN", subtitle: "devices you own · never people")
                if model.scan.image != nil { result } else { viewfinder }
                statusLine
                HStack(spacing: 10) {
                    if CameraController.hasCamera {
                        Button {
                            if model.scan.image != nil { model.scan = ScanState() } else { Task { await model.scanWithCamera() } }
                        } label: {
                            Text(model.scan.image != nil ? "NEW SCAN" : "SCAN").font(Typo.label(16)).tracking(2).foregroundStyle(Neon.void)
                                .frame(maxWidth: .infinity, minHeight: 54).background(Chamfer(cut: 10).fill(Neon.volt))
                        }
                        .buttonStyle(.plain)
                        .disabled(busy || !model.isOnline)
                        .opacity(busy || !model.isOnline ? 0.5 : 1)
                    }
                    PhotosPicker(selection: $pick, matching: .images) {
                        Text(CameraController.hasCamera ? "PHOTO" : "SCAN A PHOTO").font(Typo.label(14)).tracking(1.2)
                            .foregroundStyle(CameraController.hasCamera ? Neon.cyan : Neon.void)
                            .frame(maxWidth: .infinity, minHeight: 54)
                            .background(Chamfer(cut: 10).fill(CameraController.hasCamera ? Neon.plate : Neon.volt))
                            .overlay(Chamfer(cut: 10).stroke(Neon.cyan.opacity(CameraController.hasCamera ? 0.6 : 0), lineWidth: 1))
                    }
                    .disabled(busy || !model.isOnline)
                    .opacity(busy || !model.isOnline ? 0.5 : 1)
                }
                if !model.isOnline {
                    Text("Link to the server to scan.").font(Typo.mono(11)).foregroundStyle(Neon.dim)
                }
                if !model.scan.detections.isEmpty { detectionList }
            }
            .padding(14)
        }
        .onChange(of: pick) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self) { await model.scanWithImageData(data) }
                pick = nil
            }
        }
    }

    private var busy: Bool {
        switch model.scan.status {
        case .capturing, .sending, .waiting: return true
        default: return false
        }
    }

    @ViewBuilder
    private var viewfinder: some View {
        ZStack {
            if CameraController.hasCamera {
                CameraPreview()
                    .onAppear { Task { if await CameraController.requestAccess() { CameraController.shared.start() } } }
                    .onDisappear { CameraController.shared.stop() }
                ScannerReticle()
            } else {
                VStack(spacing: 10) {
                    Text("NO CAMERA ON THIS DEVICE").hudLabel(12, color: Neon.dim)
                    Text("Simulator: pick a photo of a device instead. It goes through the same scan path.")
                        .font(Typo.mono(11)).foregroundStyle(Neon.dim.opacity(0.85)).multilineTextAlignment(.center)
                }
                .padding(24)
            }
        }
        .frame(maxWidth: .infinity).frame(height: 360)
        .background(Neon.void)
        .clipShape(Chamfer(cut: 12))
        .overlay(Chamfer(cut: 12).stroke(Neon.cyan.opacity(0.6), lineWidth: 1))
    }

    private var result: some View {
        GeometryReader { g in
            if let img = model.scan.image {
                let px = model.scan.pixelSize.width > 0 ? model.scan.pixelSize : img.size
                let scale = min(g.size.width / px.width, g.size.height / px.height)
                let w = px.width * scale, h = px.height * scale
                let ox = (g.size.width - w) / 2, oy = (g.size.height - h) / 2
                ZStack(alignment: .topLeading) {
                    Image(uiImage: img).resizable().scaledToFit().frame(width: w, height: h).offset(x: ox, y: oy)
                    ForEach(model.scan.detections) { d in
                        if let r = rect(d, px: px, scale: scale) {
                            let on = d.detId == model.scan.selectedDetId
                            let col = on ? Neon.volt : Neon.cyan
                            ZStack(alignment: .topLeading) {
                                Rectangle().stroke(Neon.void, lineWidth: 5)
                                Rectangle().stroke(col, lineWidth: 2.5)
                                Text(d.label.uppercased()).font(Typo.label(10)).tracking(0.8).foregroundStyle(Neon.void)
                                    .padding(.horizontal, 5).padding(.vertical, 2).background(col)
                                    .offset(y: -18)
                            }
                            .frame(width: r.width, height: r.height)
                            .offset(x: ox + r.minX, y: oy + r.minY)
                            .contentShape(Rectangle())
                            .onTapGesture { model.selectDetection(d) }
                        }
                    }
                }
            }
        }
        .frame(height: 360)
        .background(Neon.void)
        .clipShape(Chamfer(cut: 12))
        .overlay(Chamfer(cut: 12).stroke(Neon.cyan.opacity(0.6), lineWidth: 1))
    }

    /// Box in image pixels (or normalised when every value <= 1.5) -> view rect.
    private func rect(_ d: ScanDetection, px: CGSize, scale: CGFloat) -> CGRect? {
        guard let b = d.box, b.count == 4 else { return nil }
        let normalised = b.allSatisfy { $0 <= 1.5 }
        let x = normalised ? b[0] * px.width : b[0], y = normalised ? b[1] * px.height : b[1]
        let w = normalised ? b[2] * px.width : b[2], h = normalised ? b[3] * px.height : b[3]
        return CGRect(x: x * scale, y: y * scale, width: w * scale, height: h * scale)
    }

    @ViewBuilder
    private var statusLine: some View {
        HStack(spacing: 8) {
            switch model.scan.status {
            case .idle:
                Pip(color: Neon.dim, filled: false)
                Text("ready · point at a device you own").font(Typo.mono(12)).foregroundStyle(Neon.dim)
            case .capturing:
                ProgressView().tint(Neon.volt)
                Text("capturing…").font(Typo.mono(12)).foregroundStyle(Neon.volt)
            case .sending:
                ProgressView().tint(Neon.volt)
                Text("sending \(model.scan.bytes / 1024) KB…").font(Typo.mono(12)).foregroundStyle(Neon.volt)
            case .waiting:
                ProgressView().tint(Neon.volt)
                TimelineView(.periodic(from: .now, by: 0.1)) { ctx in
                    let t = model.scan.sentAt.map { ctx.date.timeIntervalSince($0) } ?? 0
                    Text(String(format: "scanning · waiting for SAM %.1f s", t)).font(Typo.mono(12)).foregroundStyle(Neon.volt)
                }
            case .done:
                Pip(color: Neon.cyan)
                Text(model.scan.detections.isEmpty ? "nothing controllable found" : "\(model.scan.detections.count) device\(model.scan.detections.count == 1 ? "" : "s") · tap one to lock")
                    .font(Typo.mono(12)).foregroundStyle(Neon.bone)
                Spacer(minLength: 4)
                if let m = model.scan.modelId { ModelChipView(id: m, source: nil) }
                if let l = model.scan.latencyMs { Text(String(format: "%.1f s", l / 1000)).font(Typo.mono(11)).foregroundStyle(Neon.dim) }
            case .failed(let msg):
                Pip(color: Neon.fail)
                Text(msg).font(Typo.mono(12)).foregroundStyle(Neon.bone).lineLimit(3)
            }
            Spacer(minLength: 0)
        }
        .padding(10).plate(cut: 8)
    }

    private var detectionList: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(model.scan.detections) { d in
                let on = d.detId == model.scan.selectedDetId
                Button { model.selectDetection(d) } label: {
                    HStack(spacing: 10) {
                        Pip(color: on ? Neon.volt : Neon.cyan, filled: on)
                        Text(d.label).font(Typo.label(14)).foregroundStyle(Neon.bone)
                        if let p = d.prompt, p != d.label { Text("“\(p)”").font(Typo.mono(10)).foregroundStyle(Neon.dim) }
                        Spacer()
                        if let s = d.score { Text(String(format: "%.0f %%", s * 100)).font(Typo.mono(11)).foregroundStyle(Neon.dim) }
                        Text(on ? "LOCKED" : "LOCK").font(Typo.label(11)).foregroundStyle(on ? Neon.volt : Neon.cyan)
                    }
                    .padding(.horizontal, 12).frame(minHeight: 48)
                    .plate(edge: on ? Neon.volt : Neon.cyan, cut: 8)
                }
                .buttonStyle(.plain)
            }
        }
    }
}
