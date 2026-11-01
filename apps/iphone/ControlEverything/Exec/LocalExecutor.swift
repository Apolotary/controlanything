import AVFoundation
import SwiftUI
import UIKit

/// Runs exec.command LocalOps on this phone: torch, haptic, screen, say. Every run returns what an
/// exec.ack reports (ok + a short detail). The screen wash is drawn by `ScreenWashOverlay` from this state.
///
/// Photosensitivity (BRIEF §3.2, research/15 §3.6): flashes are governed to <= 3 per rolling second
/// (default pulse 1 Hz), and saturated red never flashes (it is shown steady instead).
@Observable
final class LocalExecutor {
    /// `error` uses the exec.ack codes: unsupported | bad_args | rate_limited | device_error.
    struct Outcome {
        var ok: Bool
        var detail: String
        var error: String? = nil
    }

    // screen wash state (read by the overlay)
    private(set) var washColor: Color?
    private(set) var washHex: String?
    private(set) var washVisible = false
    private(set) var washMode = "steady"
    private(set) var washRateHz: Double = 0
    /// saturated red is shown dimmed (over void) so it never becomes a bright full-field red transition
    private(set) var washOpacity: Double = 1
    // torch state: the level actually set, or the level we would have set (shown on screen) when there is no torch
    private(set) var torchLevel: Double = 0
    private(set) var torchIsVirtual = !CameraController.hasTorch
    private(set) var speaking: String?

    private var washTask: Task<Void, Never>?
    private let governor = FlashGovernor(maxPerSecond: 3)
    private let speech = Speech()
    private let tone = Tone()
    private var lastTorchAt = Date.distantPast
    private let beepGovernor = FlashGovernor(maxPerSecond: 3)

    static let supportedOps = ["torch", "haptic", "screen", "say", "beep"]

    func run(_ op: ExecOp, dryRun: Bool = false) -> Outcome {
        guard op.kind == "local" else {
            return Outcome(ok: false, detail: "\(op.kind) ops run on the Mac companion or a Cardputer, not the iPhone", error: "unsupported")
        }
        let name = (op.op ?? "").lowercased()
        switch name {
        case "torch": return torch(op.arg, dryRun: dryRun)
        case "haptic", "haptics": return haptic(op.arg, dryRun: dryRun)
        case "screen", "wash", "flash": return screen(op.arg, dryRun: dryRun, defaultMode: name == "flash" ? "flash" : nil)
        case "say", "speak": return say(op.arg, dryRun: dryRun)
        case "beep": return beep(op.arg, dryRun: dryRun)
        default: return Outcome(ok: false, detail: "op \"\(name)\" is not supported on iphone (torch, haptic, screen, say, beep)", error: "unsupported")
        }
    }

    func stopSpeech() {
        speech.stop()
        speaking = nil
    }

    // MARK: - torch

    private func torch(_ arg: JSONValue?, dryRun: Bool) -> Outcome {
        // accepted: true/false, "on"/"off", 0..1 (or 0..100), {level}, {on}; no arg toggles
        func fromNumber(_ n: Double) -> Double { n > 1 ? n / 100 : n }
        var level: Double
        switch arg {
        case .bool(let b)?: level = b ? 1 : 0
        case .number(let n)?: level = fromNumber(n)
        case .string(let s)?:
            if let n = Double(s) { level = fromNumber(n) } else if let b = arg?.bool { level = b ? 1 : 0 } else { level = torchLevel > 0 ? 0 : 1 }
        case .object(let o)?:
            if let n = o["level"]?.number { level = fromNumber(n) } else if let on = o["on"]?.bool { level = on ? 1 : 0 } else { level = 1 }
        default: level = torchLevel > 0 ? 0 : 1
        }
        level = min(1, max(0, level))
        let words = level <= 0 ? "off" : "\(Int((level * 100).rounded())) %"
        if dryRun { return Outcome(ok: true, detail: "dry run: torch \(words)") }
        // torch changes are rate-limited to 4 per second so a burst can never strobe it
        let now = Date()
        guard now.timeIntervalSince(lastTorchAt) >= 0.25 else { return Outcome(ok: false, detail: "torch rate limit (max 4 changes/s)", error: "rate_limited") }
        lastTorchAt = now
        do {
            let set = try CameraController.setTorch(level: level)
            torchLevel = set
            torchIsVirtual = false
            return Outcome(ok: true, detail: "torch \(set <= 0 ? "off" : "\(Int((set * 100).rounded())) %")")
        } catch {
            torchLevel = level
            torchIsVirtual = true
            return Outcome(ok: false, detail: "no torch on this device (\(words) shown on screen only)", error: "device_error")
        }
    }

    // MARK: - haptics

    private func haptic(_ arg: JSONValue?, dryRun: Bool) -> Outcome {
        let pattern = (arg?.string ?? arg?["pattern"]?.string ?? "pulse").lowercased()
        if dryRun { return Outcome(ok: true, detail: "dry run: haptic \(pattern)") }
        let played = Haptics.shared.play(pattern)
        if !Haptics.shared.supported { return Outcome(ok: false, detail: "no haptic engine on this device (\(played) requested)", error: "device_error") }
        return Outcome(ok: true, detail: "haptic \(played)")
    }

    // MARK: - screen

    private func screen(_ arg: JSONValue?, dryRun: Bool, defaultMode: String?) -> Outcome {
        var hex: String?
        var mode = defaultMode ?? "steady"
        var hz = 1.0
        var ms: Double?
        if let s = arg?.string {
            if ["off", "clear", "none"].contains(s.lowercased()) { if !dryRun { clearWash() }; return Outcome(ok: true, detail: dryRun ? "dry run: screen off" : "screen off") }
            hex = s
        } else if let o = arg?.object {
            hex = o["color"]?.string ?? o["colour"]?.string ?? o["hex"]?.string
            mode = o["mode"]?.string?.lowercased() ?? mode
            hz = o["hz"]?.number ?? o["rateHz"]?.number ?? hz
            ms = o["ms"]?.number ?? o["durationMs"]?.number
            if o["on"]?.bool == false || mode == "off" { if !dryRun { clearWash() }; return Outcome(ok: true, detail: "screen off") }
        }
        guard let hex, let rgb = RGB(hex: hex) else { return Outcome(ok: false, detail: "screen needs a colour like \"#38F0FF\"", error: "bad_args") }
        var note = ""
        if mode != "steady", rgb.isSaturatedRed {
            mode = "steady"
            note = " (red never flashes: shown steady)"
        }
        let rate = min(3, max(0.2, hz))
        if mode == "pulse", hz > 3 { note += " (capped at 3 Hz)" }
        if dryRun { return Outcome(ok: true, detail: "dry run: screen \(hex) \(mode)\(note)") }

        washTask?.cancel()
        washHex = hex.uppercased()
        washColor = rgb.color
        washMode = mode
        washRateHz = mode == "pulse" ? rate : 0
        washOpacity = rgb.isSaturatedRed ? 0.55 : 1
        let fadeIn = rgb.isSaturatedRed ? 1.2 : 0.35
        switch mode {
        case "flash":
            // one crisp flash, counted by the governor
            guard governor.allow() else { return Outcome(ok: false, detail: "flash skipped: 3 flashes per second is the limit", error: "rate_limited") }
            washVisible = true
            washTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(160))
                guard !Task.isCancelled else { return }
                self?.washVisible = false
            }
            return Outcome(ok: true, detail: "screen flash \(washHex!)\(note)")
        case "pulse":
            // breathing, not strobing: eased edges, onsets still counted by the governor
            let period = 1.0 / rate
            let edge = min(0.4, period * 0.4)
            let until = Date().addingTimeInterval((ms ?? 5000) / 1000)
            washTask = Task { [weak self] in
                while !Task.isCancelled, Date() < until {
                    guard let self else { return }
                    if self.governor.allow() { withAnimation(.easeInOut(duration: edge)) { self.washVisible = true } }
                    try? await Task.sleep(for: .seconds(period / 2))
                    withAnimation(.easeInOut(duration: edge)) { self.washVisible = false }
                    try? await Task.sleep(for: .seconds(period / 2))
                }
                withAnimation(.easeOut(duration: 0.3)) { self?.washVisible = false }
            }
            return Outcome(ok: true, detail: "screen pulse \(washHex!) at \(String(format: "%.1f", rate)) Hz\(note)")
        default:
            withAnimation(.easeIn(duration: fadeIn)) { washVisible = true }
            if let ms {
                washTask = Task { [weak self] in
                    try? await Task.sleep(for: .milliseconds(Int(ms)))
                    guard !Task.isCancelled else { return }
                    withAnimation(.easeOut(duration: 0.35)) { self?.washVisible = false }
                }
            }
            return Outcome(ok: true, detail: "screen \(washHex!) steady\(note)")
        }
    }

    func clearWash() {
        washTask?.cancel()
        withAnimation(.easeOut(duration: 0.25)) { washVisible = false }
        washMode = "steady"
        washRateHz = 0
    }

    // MARK: - speech

    private func say(_ arg: JSONValue?, dryRun: Bool) -> Outcome {
        guard let text = (arg?.string ?? arg?["text"]?.string)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            return Outcome(ok: false, detail: "say needs text", error: "bad_args")
        }
        let line = String(text.prefix(280))
        if dryRun { return Outcome(ok: true, detail: "dry run: say \"\(line)\"") }
        speaking = line
        speech.speak(line) { [weak self] in
            if self?.speaking == line { self?.speaking = nil }
        }
        return Outcome(ok: true, detail: "speaking \"\(line.prefix(40))\(line.count > 40 ? "…" : "")\"")
    }
}

extension LocalExecutor {
    /// beep: frequency Hz, or {freq, count, ms}; at most 3 beeps per second.
    fileprivate func beep(_ arg: JSONValue?, dryRun: Bool) -> Outcome {
        var freq = 880.0, count = 1, ms = 120.0
        if let n = arg?.number, arg?.object == nil { freq = n }
        if let o = arg?.object {
            freq = o["freq"]?.number ?? o["hz"]?.number ?? freq
            count = Int(o["count"]?.number ?? 1)
            ms = o["ms"]?.number ?? ms
        }
        freq = min(4000, max(80, freq)); count = min(8, max(1, count)); ms = min(1000, max(30, ms))
        if dryRun { return Outcome(ok: true, detail: "dry run: beep \(Int(freq)) Hz ×\(count)") }
        guard beepGovernor.allow() else { return Outcome(ok: false, detail: "beep rate limit (3/s)", error: "rate_limited") }
        let t = tone
        Task {
            for i in 0..<count {
                t.play(freq: freq, ms: ms)
                if i < count - 1 { try? await Task.sleep(for: .milliseconds(Int(max(334, ms + 60)))) }
            }
        }
        return Outcome(ok: true, detail: "beep \(Int(freq)) Hz ×\(count)")
    }
}

/// A sine beep through AVAudioEngine (no assets).
final class Tone {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var started = false

    func play(freq: Double, ms: Double) {
        let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
        if !started {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try? AVAudioSession.sharedInstance().setActive(true)
            do { try engine.start(); started = true } catch { return }
        }
        let frames = AVAudioFrameCount(44_100 * ms / 1000)
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames), let ch = buf.floatChannelData?[0] else { return }
        buf.frameLength = frames
        let fade = Int(min(Double(frames) / 4, 441))
        for i in 0..<Int(frames) {
            let env = min(1, Double(min(i, Int(frames) - i)) / Double(max(fade, 1)))
            ch[i] = Float(sin(2 * .pi * freq * Double(i) / 44_100) * 0.35 * env)
        }
        player.scheduleBuffer(buf, completionHandler: nil)
        if !player.isPlaying { player.play() }
    }
}

/// Counts flash onsets in a rolling second.
final class FlashGovernor {
    private var onsets: [Date] = []
    let maxPerSecond: Int
    init(maxPerSecond: Int) { self.maxPerSecond = maxPerSecond }

    func allow(now: Date = Date()) -> Bool {
        onsets.removeAll { now.timeIntervalSince($0) >= 1 }
        guard onsets.count < maxPerSecond else { return false }
        onsets.append(now)
        return true
    }
}

/// AVSpeechSynthesizer wrapper that picks a Japanese voice for Japanese text.
final class Speech {
    private let synth = AVSpeechSynthesizer()
    private let relay = SpeechRelay()
    private var done: [ObjectIdentifier: () -> Void] = [:]

    init() {
        synth.delegate = relay
        relay.onFinish = { [weak self] key in self?.finish(key) }
    }

    func speak(_ text: String, completion: @escaping () -> Void) {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        let u = AVSpeechUtterance(string: text)
        let japanese = text.unicodeScalars.contains { (0x3040...0x30FF).contains($0.value) || (0x4E00...0x9FFF).contains($0.value) }
        u.voice = AVSpeechSynthesisVoice(language: japanese ? "ja-JP" : "en-US")
        u.rate = AVSpeechUtteranceDefaultSpeechRate
        done[ObjectIdentifier(u)] = completion
        synth.speak(u)
    }

    func stop() {
        synth.stopSpeaking(at: .immediate)
    }

    private func finish(_ key: ObjectIdentifier) {
        done.removeValue(forKey: key)?()
        if !synth.isSpeaking { try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation]) }
    }
}

/// Receives AVSpeechSynthesizer callbacks off the main thread and hands them to the main actor.
nonisolated final class SpeechRelay: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    var onFinish: (@MainActor (ObjectIdentifier) -> Void)?

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { relay(utterance) }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { relay(utterance) }

    private func relay(_ u: AVSpeechUtterance) {
        let key = ObjectIdentifier(u)
        let cb = onFinish
        Task { @MainActor in cb?(key) }
    }
}

/// "#RRGGBB" parsing plus the red check used by the photosensitivity rule.
nonisolated struct RGB: Sendable {
    var r: Double, g: Double, b: Double

    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        r = Double((v >> 16) & 0xFF) / 255
        g = Double((v >> 8) & 0xFF) / 255
        b = Double(v & 0xFF) / 255
    }

    /// Saturated red (WCAG 2.3.1 red-flash concern): strong red with weak green and blue.
    var isSaturatedRed: Bool { r > 0.6 && g < 0.45 && b < 0.45 && r - max(g, b) > 0.35 }
    var color: Color { Color(red: r, green: g, blue: b) }
}
