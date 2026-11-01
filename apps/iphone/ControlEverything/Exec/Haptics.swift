import CoreHaptics
import UIKit

/// Haptic patterns for exec.command (`haptic`) and UI feedback (a tick per detent, one per verdict).
@MainActor
final class Haptics {
    static let shared = Haptics()

    private var engine: CHHapticEngine?
    private let selection = UISelectionFeedbackGenerator()
    private let notify = UINotificationFeedbackGenerator()
    private let impactLight = UIImpactFeedbackGenerator(style: .light)
    private let impactHeavy = UIImpactFeedbackGenerator(style: .heavy)

    var supported: Bool { CHHapticEngine.capabilitiesForHardware().supportsHaptics }

    // UI feedback
    func tick() { selection.selectionChanged() }
    func tap() { impactLight.impactOccurred() }
    func verdict(_ pass: Bool) { notify.notificationOccurred(pass ? .success : .error) }

    /// Play a named pattern. Returns a short description of what played.
    func play(_ name: String) -> String {
        switch name {
        case "tap", "light":
            impactLight.impactOccurred(); return "tap"
        case "medium":
            impactHeavy.impactOccurred(intensity: 0.6); return "medium"
        case "heavy", "thud":
            impactHeavy.impactOccurred(intensity: 1); return "heavy"
        case "success", "ok":
            notify.notificationOccurred(.success); return "success"
        case "warning":
            notify.notificationOccurred(.warning); return "warning"
        case "error", "fail":
            notify.notificationOccurred(.error); return "error"
        default:
            // "pulse": three heavy transients, one per second (the Pulse haptics hack)
            playTransients(count: 3, interval: 1.0, intensity: 1.0, sharpness: 0.35)
            return "pulse ×3 @ 1 Hz"
        }
    }

    private func playTransients(count: Int, interval: Double, intensity: Float, sharpness: Float) {
        guard supported else {
            for i in 0..<count {
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(Double(i) * interval))
                    self.impactHeavy.impactOccurred(intensity: CGFloat(intensity))
                }
            }
            return
        }
        do {
            if engine == nil {
                let e = try CHHapticEngine()
                e.isAutoShutdownEnabled = true
                engine = e
            }
            try engine?.start()
            let events = (0..<count).map { i in
                CHHapticEvent(eventType: .hapticTransient, parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness),
                ], relativeTime: Double(i) * interval)
            }
            let player = try engine?.makePlayer(with: CHHapticPattern(events: events, parameters: []))
            try player?.start(atTime: CHHapticTimeImmediate)
        } catch {
            impactHeavy.impactOccurred()
        }
    }
}
