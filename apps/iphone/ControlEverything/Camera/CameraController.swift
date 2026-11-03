import AVFoundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// A JPEG ready for scan.frame: upright pixels, longest edge <= 1280, base64 without a data: prefix.
nonisolated struct CapturedFrame: Sendable {
    var jpeg: Data
    var width: Int
    var height: Int
    var capturedAt: Double

    var base64: String { jpeg.base64EncodedString() }
}

nonisolated enum CameraError: LocalizedError, Sendable {
    case unavailable
    case notAuthorized
    case captureFailed(String)
    case badImage

    var errorDescription: String? {
        switch self {
        case .unavailable: return "No camera on this device (the iOS Simulator has none)."
        case .notAuthorized: return "Camera access is off. Allow it in Settings › ControlAnything."
        case .captureFailed(let s): return "Capture failed: \(s)"
        case .badImage: return "Could not read that image."
        }
    }
}

/// One AVCaptureSession for the whole app: preview, QR detection (server QR / other devices' pairing QR)
/// and still capture for scan.frame / sense.result. All session work runs on `queue`, never the main thread.
nonisolated final class CameraController: NSObject, @unchecked Sendable {
    static let shared = CameraController()

    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "dev.controleverything.camera")
    private let photoOutput = AVCapturePhotoOutput()
    private let metadataOutput = AVCaptureMetadataOutput()
    private var configured = false
    private var pending: [Int64: PhotoDelegate] = [:]
    @MainActor private var rotation: AVCaptureDevice.RotationCoordinator?

    /// Called on the main queue with each decoded QR string (deduplicated for 2 s).
    @MainActor var onQRCode: ((String) -> Void)?
    @MainActor private var lastQR: (String, Date)?

    static var hasCamera: Bool { AVCaptureDevice.default(for: .video) != nil }

    static func requestAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }

    func start() {
        queue.async { [self] in
            if !configured { configure() }
            guard configured, !session.isRunning else { return }
            session.startRunning()
        }
    }

    func stop() {
        queue.async { [self] in
            if session.isRunning { session.stopRunning() }
        }
    }

    private func configure() {
        guard let cam = Self.backCamera, let input = try? AVCaptureDeviceInput(device: cam) else { return }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .photo
        guard session.canAddInput(input) else { return }
        session.addInput(input)
        if session.canAddOutput(photoOutput) {
            session.addOutput(photoOutput)
            photoOutput.maxPhotoQualityPrioritization = .speed
        }
        if session.canAddOutput(metadataOutput) {
            session.addOutput(metadataOutput)
            metadataOutput.setMetadataObjectsDelegate(self, queue: .main)
            if metadataOutput.availableMetadataObjectTypes.contains(.qr) {
                metadataOutput.metadataObjectTypes = [.qr]
            }
        }
        configured = true
    }

    private static var backCamera: AVCaptureDevice? {
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) ?? AVCaptureDevice.default(for: .video)
    }

    /// Keep preview and captures upright (iOS 17 RotationCoordinator). Call from the preview view's layout.
    @MainActor func attach(previewLayer: AVCaptureVideoPreviewLayer) {
        if rotation == nil || rotation?.previewLayer !== previewLayer, let cam = Self.backCamera {
            rotation = AVCaptureDevice.RotationCoordinator(device: cam, previewLayer: previewLayer)
        }
        if let rc = rotation, let conn = previewLayer.connection,
           conn.isVideoRotationAngleSupported(rc.videoRotationAngleForHorizonLevelPreview) {
            conn.videoRotationAngle = rc.videoRotationAngleForHorizonLevelPreview
        }
    }

    @MainActor private func captureAngle() -> CGFloat {
        if rotation == nil, let cam = Self.backCamera {
            rotation = AVCaptureDevice.RotationCoordinator(device: cam, previewLayer: nil)
        }
        return rotation?.videoRotationAngleForHorizonLevelCapture ?? 90
    }

    /// Take one still and return it scaled for scan.frame.
    func capture() async throws -> CapturedFrame {
        guard Self.hasCamera else { throw CameraError.unavailable }
        guard await Self.requestAccess() else { throw CameraError.notAuthorized }
        let angle = await captureAngle()
        let data: Data = try await withCheckedThrowingContinuation { k in
            queue.async { [self] in
                if !configured { configure() }
                guard configured else { k.resume(throwing: CameraError.unavailable); return }
                if !session.isRunning { session.startRunning() }
                if let conn = photoOutput.connection(with: .video), conn.isVideoRotationAngleSupported(angle) {
                    conn.videoRotationAngle = angle
                }
                let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
                settings.photoQualityPrioritization = .speed
                let id = settings.uniqueID
                let d = PhotoDelegate { [weak self] result in
                    if let owner = self { owner.queue.async { owner.pending[id] = nil } }
                    k.resume(with: result)
                }
                pending[id] = d
                photoOutput.capturePhoto(with: settings, delegate: d)
            }
        }
        return try Self.downscale(data)
    }

    /// Decode any image (camera JPEG/HEIC, a picked photo), apply its orientation, scale the longest edge
    /// to <= maxEdge and re-encode as JPEG. ImageIO is thread-safe.
    static func downscale(_ data: Data, maxEdge: Int = 1280, quality: Double = 0.72) throws -> CapturedFrame {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { throw CameraError.badImage }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxEdge,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { throw CameraError.badImage }
        let out = NSMutableData()
        guard let dst = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { throw CameraError.badImage }
        CGImageDestinationAddImage(dst, img, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dst) else { throw CameraError.badImage }
        return CapturedFrame(jpeg: out as Data, width: img.width, height: img.height, capturedAt: Wire.nowMs())
    }

    // MARK: - torch

    /// level 0 = off, (0, 1] = on at that level. Returns the level actually set.
    static func setTorch(level: Double) throws -> Double {
        guard let d = AVCaptureDevice.default(for: .video), d.hasTorch else { throw CameraError.unavailable }
        try d.lockForConfiguration()
        defer { d.unlockForConfiguration() }
        if level <= 0.001 {
            d.torchMode = .off
            return 0
        }
        guard d.isTorchAvailable else { throw CameraError.captureFailed("torch is busy or too hot") }
        let l = Float(min(1, max(0.01, level)))
        try d.setTorchModeOn(level: min(l, AVCaptureDevice.maxAvailableTorchLevel))
        return Double(d.torchLevel)
    }

    static var hasTorch: Bool { AVCaptureDevice.default(for: .video)?.hasTorch ?? false }
}

extension CameraController: AVCaptureMetadataOutputObjectsDelegate {
    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        let codes = metadataObjects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
        guard let code = codes.first else { return }
        MainActor.assumeIsolated {
            if let (last, at) = lastQR, last == code, Date().timeIntervalSince(at) < 2 { return }
            lastQR = (code, Date())
            onQRCode?(code)
        }
    }
}

/// Holds one capture's continuation until the photo is processed.
nonisolated private final class PhotoDelegate: NSObject, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
    private let done: (Result<Data, Error>) -> Void
    private var finished = false

    init(done: @escaping (Result<Data, Error>) -> Void) { self.done = done }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        guard !finished else { return }
        finished = true
        if let error { done(.failure(CameraError.captureFailed(error.localizedDescription))); return }
        guard let data = photo.fileDataRepresentation() else { done(.failure(CameraError.badImage)); return }
        done(.success(data))
    }
}
