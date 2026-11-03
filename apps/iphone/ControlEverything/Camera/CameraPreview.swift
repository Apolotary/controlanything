import AVFoundation
import CoreImage.CIFilterBuiltins
import SwiftUI

/// Live camera preview for the shared session. Starts the session on appear and stops it on disappear.
struct CameraPreview: UIViewRepresentable {
    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.previewLayer.session = CameraController.shared.session
        v.previewLayer.videoGravity = .resizeAspectFill
        return v
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

        override func layoutSubviews() {
            super.layoutSubviews()
            CameraController.shared.attach(previewLayer: previewLayer)
        }
    }
}

/// A camera viewfinder that reports QR codes, or a clear message when there is no camera (Simulator)
/// or no permission.
struct QRScannerView: View {
    var onCode: (String) -> Void
    @State private var authorized: Bool?

    var body: some View {
        ZStack {
            if !CameraController.hasCamera {
                unavailable("NO CAMERA ON THIS DEVICE", "The iOS Simulator has no camera. Type the address instead.")
            } else if authorized == false {
                unavailable("CAMERA ACCESS IS OFF", "Allow it in Settings › ControlAnything, or type the address.")
            } else {
                CameraPreview()
                ScannerReticle()
            }
        }
        .background(Neon.void)
        .clipShape(Chamfer(cut: 12))
        .overlay(Chamfer(cut: 12).stroke(Neon.cyan.opacity(0.6), lineWidth: 1))
        .task {
            guard CameraController.hasCamera else { return }
            let ok = await CameraController.requestAccess()
            authorized = ok
            if ok {
                CameraController.shared.onQRCode = { code in onCode(code) }
                CameraController.shared.start()
            }
        }
        .onDisappear {
            CameraController.shared.onQRCode = nil
            CameraController.shared.stop()
        }
    }

    private func unavailable(_ title: String, _ detail: String) -> some View {
        VStack(spacing: 8) {
            Text(title).hudLabel(12, color: Neon.dim)
            Text(detail).font(Typo.mono(11)).foregroundStyle(Neon.dim.opacity(0.8)).multilineTextAlignment(.center)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Volt corner brackets over the viewfinder (the target-lock grammar).
struct ScannerReticle: View {
    var body: some View {
        GeometryReader { g in
            let s = min(g.size.width, g.size.height) * 0.62
            let r = CGRect(x: (g.size.width - s) / 2, y: (g.size.height - s) / 2, width: s, height: s)
            let leg: CGFloat = 26
            Path { p in
                for (cx, cy, dx, dy) in [(r.minX, r.minY, 1.0, 1.0), (r.maxX, r.minY, -1.0, 1.0), (r.minX, r.maxY, 1.0, -1.0), (r.maxX, r.maxY, -1.0, -1.0)] {
                    p.move(to: CGPoint(x: cx, y: cy + dy * leg)); p.addLine(to: CGPoint(x: cx, y: cy)); p.addLine(to: CGPoint(x: cx + dx * leg, y: cy))
                }
            }
            .stroke(Neon.void, lineWidth: 6)
            .overlay(
                Path { p in
                    for (cx, cy, dx, dy) in [(r.minX, r.minY, 1.0, 1.0), (r.maxX, r.minY, -1.0, 1.0), (r.minX, r.maxY, 1.0, -1.0), (r.maxX, r.maxY, -1.0, -1.0)] {
                        p.move(to: CGPoint(x: cx, y: cy + dy * leg)); p.addLine(to: CGPoint(x: cx, y: cy)); p.addLine(to: CGPoint(x: cx + dx * leg, y: cy))
                    }
                }
                .stroke(Neon.volt, lineWidth: 3)
            )
        }
        .allowsHitTesting(false)
    }
}

/// A QR code rendered with Core Image: dark modules on white with a quiet zone (what headset decoders expect).
struct QRCodeView: View {
    var text: String

    var body: some View {
        if let img = Self.image(text) {
            Image(uiImage: img).interpolation(.none).resizable().scaledToFit()
                .padding(14).background(Color.white)
                .accessibilityLabel("Pairing QR code")
        } else {
            Text("QR unavailable").font(Typo.mono(12)).foregroundStyle(Neon.fail)
        }
    }

    static func image(_ text: String) -> UIImage? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12)),
              let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
