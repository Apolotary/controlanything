import SwiftUI
import UIKit

/// App state and the only place that talks to the server. Views read it; actions are methods here.
@Observable
final class AppModel {
    enum Screen: Equatable { case connect, pairing, deck }
    enum DeckTab: Hashable { case control, scan, log, room }

    /// What this phone offers the agent (packages/protocol Capability values): a camera sensor (verify frames,
    /// handheld scans) and a local executor (torch, haptic, screen, say, beep). No "mic": audio features are
    /// the Mac companion's job.
    static let capabilities = ["camera", "local", "display", "speaker"]

    // MARK: connect

    var screen: Screen = .connect
    var serverInput = Prefs.lastServerInput
    var deviceName = Prefs.deviceName
    var busy = false
    var connectError: String?
    var health: HealthResponse?

    // MARK: pairing (device-code flow)

    struct PairingState {
        var endpoint: ServerEndpoint
        var start: PairStartResponse
        var status: String
        var message: String?
    }
    var pairing: PairingState?
    private var pollTask: Task<Void, Never>?

    // MARK: paired

    var credentials: Credentials?
    var welcome: WelcomePayload?
    var socketState: HubSocket.State = .idle
    var presence: [DeviceInfo] = []
    var pending: [PendingPairing] = []
    var steps: [AgentStepPayload] = []
    var surfaces: [Surface] = []
    var selectedSurfaceId: String?
    var values: [String: ControlValue] = [:]
    var cards: [String: DeviceCardPayload] = [:]
    var cardOrder: [String] = []
    var driverStatus: [String: DriverStatusPayload] = [:]
    var linkRequest: LinkRequestPayload?
    var links: [String: LinkResultPayload] = [:]
    var targets: [String: TargetStatusPayload] = [:]
    var arms: [ArmRequestPayload] = []
    var transcript: VoiceTextPayload?
    var commandInput = ""
    var evidence: [EvidencePayload] = []
    var execLog: [ExecRecord] = []
    var hubLog: [HubLogLine] = []
    var hackState: [String: HackSendState] = [:]
    var banner: Banner?
    var scan = ScanState()
    var tab: DeckTab = .control
    /// an anchor id the current tab should scroll to (then cleared)
    var scrollTarget: String?
    var approveCodeInput = ""
    var undoLabel: String? { undoStack.last.map { "UNDO \($0.label)" } }

    let socket = HubSocket()
    let executor = LocalExecutor()

    private var undoStack: [UndoEntry] = []
    private var throttle: [String: ThrottleState] = [:]
    /// controls the user is dragging right now (remote echoes do not move them)
    var activeDrags: Set<String> = []
    private var bannerTask: Task<Void, Never>?
    private var hackTimeouts: [String: Task<Void, Never>] = [:]

    init() {
        if let c = CredentialStore.load() {
            credentials = c
            screen = .deck
        }
    }

    var myDeviceId: String? { credentials?.deviceId }
    var isOnline: Bool { socketState == .open }
    var selectedSurface: Surface? { surfaces.first { $0.id == selectedSurfaceId } ?? surfaces.first }

    // MARK: - connect + pair

    func connect(input: String? = nil) async {
        let text = (input ?? serverInput).trimmingCharacters(in: .whitespacesAndNewlines)
        connectError = nil
        let candidates = ServerEndpoint.candidates(from: text)
        guard !candidates.isEmpty else {
            connectError = "That isn't a server address. Type the Mac's address, e.g. 192.168.1.20:8787."
            return
        }
        busy = true
        defer { busy = false }
        Prefs.deviceName = deviceName
        var lastError: Error?
        for endpoint in candidates {
            do {
                health = try await APIClient(endpoint: endpoint).health()
                serverInput = text
                Prefs.lastServerInput = text
                await startPairing(endpoint)
                return
            } catch {
                lastError = error
            }
        }
        connectError = lastError?.localizedDescription ?? "No server answered."
    }

    func startPairing(_ endpoint: ServerEndpoint) async {
        do {
            let name = deviceName.trimmingCharacters(in: .whitespaces).isEmpty ? "iPhone" : deviceName
            let r = try await APIClient(endpoint: endpoint).pairStart(PairStartRequest(name: name, capabilities: Self.capabilities))
            if r.status == "approved", let id = r.deviceId, let token = r.deviceToken {
                finishPairing(endpoint, deviceId: id, token: token)
                return
            }
            pairing = PairingState(endpoint: endpoint, start: r, status: r.status)
            screen = .pairing
            pollPairing()
        } catch {
            connectError = error.localizedDescription
        }
    }

    func restartPairing() async {
        guard let e = pairing?.endpoint else { cancelPairing(); return }
        pollTask?.cancel()
        await startPairing(e)
    }

    func cancelPairing() {
        pollTask?.cancel()
        pairing = nil
        screen = .connect
    }

    private func pollPairing() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1.5))
                guard let self, !Task.isCancelled, let p = self.pairing else { return }
                if Wire.nowMs() > p.start.expiresAt + 3000 {
                    self.pairing?.status = "expired"
                    self.pairing?.message = "The code expired. Start again for a new one."
                    return
                }
                do {
                    let s = try await APIClient(endpoint: p.endpoint).pairStatus(pairingId: p.start.pairingId, pollSecret: p.start.pollSecret)
                    guard self.pairing?.start.pairingId == p.start.pairingId else { return }
                    self.pairing?.status = s.status
                    self.pairing?.message = nil
                    switch s.status {
                    case "approved":
                        if let id = s.deviceId, let token = s.deviceToken {
                            self.finishPairing(p.endpoint, deviceId: id, token: token)
                        } else {
                            self.pairing?.message = "Approved, but the token was already collected. Start again."
                        }
                        return
                    case "denied", "expired":
                        self.pairing?.message = s.reason.map { $0 == "too_many_attempts" ? "Too many wrong codes." : "Request \($0)." }
                        Haptics.shared.verdict(false)
                        return
                    default: break
                    }
                } catch APIError.http(let code, let msg) where code == 404 || code == 403 {
                    self.pairing?.status = "expired"
                    self.pairing?.message = msg
                    return
                } catch {
                    self.pairing?.message = error.localizedDescription
                }
            }
        }
    }

    private func finishPairing(_ endpoint: ServerEndpoint, deviceId: String, token: String) {
        let name = deviceName.trimmingCharacters(in: .whitespaces).isEmpty ? "iPhone" : deviceName
        let c = Credentials(server: endpoint, deviceId: deviceId, deviceToken: token, name: name, pairedAt: Date())
        if !CredentialStore.save(c) { show("Paired, but the Keychain refused the token; you will pair again next launch.", tone: .fail) }
        credentials = c
        pollTask?.cancel()
        pairing = nil
        screen = .deck
        Haptics.shared.verdict(true)
        connectSocket()
    }

    func unpair() {
        socket.disconnect()
        CredentialStore.clear()
        credentials = nil
        welcome = nil
        resetSession()
        screen = .connect
    }

    private func tokenRevoked() {
        CredentialStore.clear()
        credentials = nil
        welcome = nil
        resetSession()
        connectError = "This iPhone was removed from the space (or the server was reset). Pair it again."
        screen = .connect
    }

    private func resetSession() {
        presence = []; pending = []; steps = []; surfaces = []; values = [:]; cards = [:]; cardOrder = []
        driverStatus = [:]; evidence = []; execLog = []; hubLog = []; hackState = [:]; undoStack = []
        linkRequest = nil; scan = ScanState(); selectedSurfaceId = nil; links = [:]; targets = [:]; arms = []; transcript = nil
    }

    // MARK: - socket

    func connectSocket() {
        guard let c = credentials else { return }
        socket.onOpenAttempt = { [weak self] in self?.sendHello() }
        socket.onFrame = { [weak self] f in self?.handle(f) }
        socket.onState = { [weak self] s in self?.socketState = s }
        socket.onUnauthorized = { [weak self] in self?.tokenRevoked() }
        socket.connect(to: c.server.webSocketURL)
    }

    private func sendHello() {
        guard let c = credentials else { return }
        socket.send(MsgType.hello, HelloPayload(deviceToken: c.deviceToken, capabilities: Self.capabilities))
    }

    func appBecameActive() {
        if credentials != nil {
            if socketState == .idle { connectSocket() } else { socket.kick() }
        }
    }

    // MARK: - controls

    func key(_ surfaceId: String, _ controlId: String) -> String { surfaceId + "/" + controlId }

    func value(_ s: Surface, _ c: Control) -> ControlValue { values[key(s.id, c.id)] ?? c.initialValue }

    /// A drag began: record an undo point and tell the device a gesture started.
    func beginDrag(_ s: Surface, _ c: Control) {
        let k = key(s.id, c.id)
        pushUndo(s, c)
        activeDrags.insert(k)
        send(s, c, value(s, c), phase: "start", index: nil)
    }

    /// A drag moved: update the value; moves go out at <= 25 Hz (the last one always lands).
    func dragChanged(_ s: Surface, _ c: Control, _ v: ControlValue) {
        values[key(s.id, c.id)] = v
        send(s, c, v, phase: "move", index: nil)
    }

    func dragEnded(_ s: Surface, _ c: Control, _ v: ControlValue) {
        let k = key(s.id, c.id)
        values[k] = v
        activeDrags.remove(k)
        send(s, c, v, phase: "end", index: nil)
    }

    /// One discrete change (a tap on a toggle or a step): one undo point, one event.
    func commit(_ s: Surface, _ c: Control, _ v: ControlValue) {
        pushUndo(s, c)
        values[key(s.id, c.id)] = v
        send(s, c, v, phase: "end", index: nil)
    }

    /// A momentary trigger (button, pad): one event with value true.
    func trigger(_ s: Surface, _ c: Control, index: Int?) {
        send(s, c, .bool(true), phase: "end", index: index)
    }

    private func pushUndo(_ s: Surface, _ c: Control) {
        guard c.kind != "trigger" else { return }
        undoStack.append(UndoEntry(surfaceId: s.id, controlId: c.id, previous: value(s, c), label: c.label))
        if undoStack.count > 50 { undoStack.removeFirst() }
    }

    /// Demo surfaces and disarmed controls never reach the wire.
    private func send(_ s: Surface, _ c: Control, _ v: ControlValue, phase: String, index: Int?) {
        guard !s.isDemo, s.isArmed(c) else { return }
        sendThrottled(key(s.id, c.id), s, c, v, phase: phase, index: index)
    }

    private func sendThrottled(_ k: String, _ s: Surface, _ c: Control, _ v: ControlValue, phase: String, index: Int?) {
        var t = throttle[k] ?? ThrottleState()
        let now = Date()
        let minGap = 0.04
        if phase != "move" || now.timeIntervalSince(t.lastSent) >= minGap {
            t.trailing?.cancel()
            t.trailing = nil
            t.lastSent = now
            throttle[k] = t
            sendControlEvent(s, c, v, phase: phase, index: index)
            return
        }
        t.trailing?.cancel()
        let wait = minGap - now.timeIntervalSince(t.lastSent)
        t.trailing = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, let self else { return }
            self.throttle[k]?.lastSent = Date()
            self.throttle[k]?.trailing = nil
            self.sendControlEvent(s, c, self.values[k] ?? v, phase: "move", index: index)
        }
        throttle[k] = t
    }

    private func sendControlEvent(_ s: Surface, _ c: Control, _ v: ControlValue, phase: String, index: Int?) {
        let p = ControlEventPayload(widgetId: c.id, value: v, ts: Wire.nowMs(), specId: s.id, index: index, phase: phase)
        socket.send(MsgType.controlEvent, p)
    }

    func undo() {
        guard let u = undoStack.popLast() else { return }
        guard let s = surfaces.first(where: { $0.id == u.surfaceId }), let c = s.control(u.controlId) else { return }
        values[key(s.id, c.id)] = u.previous
        if !s.isDemo, s.isArmed(c) { sendControlEvent(s, c, u.previous, phase: "end", index: nil) }
        Haptics.shared.tap()
        show("Undo · \(c.label) back to \(describe(u.previous, c))", tone: .info)
    }

    func describe(_ v: ControlValue, _ c: Control) -> String {
        switch v {
        case .number(let n): return c.format(n)
        case .bool(let b): return b ? "ON" : "OFF"
        case .xy(let x, let y): return String(format: "%.2f, %.2f", x, y)
        }
    }

    // MARK: - hacks (the tap is the human confirmation the platform rules require)

    func hackKey(_ s: Surface, _ h: HackRow) -> String { s.id + "/" + h.id }

    func upload(_ s: Surface, _ h: HackRow) {
        let k = hackKey(s, h)
        guard h.status != "locked" else { show("\(h.label) is locked until the agent verifies it.", tone: .info); return }
        let control = s.control(h.widgetId)
        if let control, !s.isArmed(control) { show("\(h.label) arms after the device reacts on camera.", tone: .info); return }
        if control == nil, !s.armed { show("\(h.label) arms after the device reacts on camera.", tone: .info); return }
        Haptics.shared.tap()
        if s.isDemo {
            hackState[k] = HackSendState(sentAt: Date(), words: "demo · not sent", verdict: nil)
            return
        }
        // an action hack fires as {widgetId: hackId, value: true, phase: "end"}
        let p = ControlEventPayload(widgetId: h.widgetId, value: .bool(true), ts: Wire.nowMs(), specId: s.id, index: nil, phase: "end")
        guard socket.send(MsgType.controlEvent, p) else { show("Not linked to the server.", tone: .fail); return }
        hackState[k] = HackSendState(sentAt: Date(), words: "requested", verdict: nil,
                                     actionIds: Array(Set(h.actionIds + [h.id, h.widgetId] + [control?.binding.action].compactMap { $0 })))
        hackTimeouts[k]?.cancel()
        hackTimeouts[k] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.2))
            guard let self, !Task.isCancelled, self.hackState[k]?.verdict == nil else { return }
            self.hackState[k]?.words = "awaiting evidence"
            try? await Task.sleep(for: .seconds(12))
            guard !Task.isCancelled, self.hackState[k]?.verdict == nil else { return }
            self.hackState[k]?.words = "sent · no evidence reported"
        }
    }

    // MARK: - ARM (one-tap human confirmation before the first real drive), PANIC, typed commands

    func confirmArm(_ a: ArmRequestPayload, approve: Bool, hold: Bool = false) {
        socket.send(MsgType.armConfirm, ArmConfirmPayload(armId: a.armId, approve: approve, hold: a.irreversible == true ? hold : nil), to: Wire.serverId)
        arms.removeAll { $0.armId == a.armId }
        Haptics.shared.tap()
        show(approve ? "Armed: \(a.title)" : "Declined: \(a.title)", tone: approve ? .link : .info)
    }

    /// Stop everything: the server sends MIDI panic + IR off to every executor and disarms. Local effects stop now.
    func panic() {
        socket.send(MsgType.panic, PanicPayload(reason: "PANIC on \(credentials?.name ?? "iPhone")", cardId: nil), to: Wire.serverId)
        stopLocalEffects()
        Haptics.shared.verdict(false)
        show("PANIC sent · every device stops and disarms", tone: .fail)
    }

    func stopLocalEffects() {
        executor.clearWash()
        _ = executor.run(ExecOp(kind: "local", op: "torch", arg: .number(0), msg: nil, protocol: nil))
        executor.stopSpeech()
    }

    /// A typed command for the agent ("make resonance a big red lever"); the server treats it like a final transcript.
    func sendCommand() {
        let text = commandInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let s = selectedSurface
        let p = VoiceTextPayload(utteranceId: Wire.newId("u"), text: String(text.prefix(2000)), final: true, source: nil, modelId: nil,
                                 latencyMs: nil, cardId: s?.isDemo == false ? s?.cardId : nil, specId: s?.isDemo == false ? s?.id : nil, intent: nil)
        guard socket.send(MsgType.voiceText, p, to: Wire.serverId) else { show("Not linked to the server.", tone: .fail); return }
        commandInput = ""
        Haptics.shared.tap()
        show("Sent to the agent: “\(text.prefix(60))”", tone: .info)
    }

    // MARK: - approvals (this phone is an approver)

    func approve(_ p: PendingPairing) {
        socket.send(MsgType.pairApprove, PairApproveRequest(code: p.code, pairingId: p.pairingId))
        Haptics.shared.tap()
    }

    func deny(_ p: PendingPairing) {
        socket.send(MsgType.pairDeny, PairDenyRequest(pairingId: p.pairingId, code: nil))
    }

    func approveTypedCode() {
        let code = approveCodeInput.uppercased().filter { $0.isLetter || $0.isNumber }
        guard code.count == 6 else { show("Codes have 6 characters, like K7Q-4M2.", tone: .fail); return }
        socket.send(MsgType.pairApprove, PairApproveRequest(code: code, pairingId: nil))
        approveCodeInput = ""
        show("Sent approval for \(code.prefix(3))-\(code.suffix(3)).", tone: .info)
    }

    /// A QR scanned while paired: another device's pairing QR approves it; a server QR is ignored.
    func handleScannedQR(_ text: String) {
        if let t = ServerEndpoint.pairingTarget(from: text) {
            socket.send(MsgType.pairApprove, PairApproveRequest(code: t.code, pairingId: t.pairingId))
            Haptics.shared.tap()
            show("Approving the device that showed this code…", tone: .info)
        }
    }

    // MARK: - deep links

    func open(url: URL) {
        #if DEBUG
        if handleDebugURL(url) { return }
        #endif
        let text = url.absoluteString
        if credentials != nil {
            handleScannedQR(text)
        } else {
            serverInput = text
            Task { await connect(input: text) }
        }
    }

    // MARK: - banner

    func show(_ text: String, tone: Banner.Tone) {
        banner = Banner(text: text, tone: tone)
        bannerTask?.cancel()
        bannerTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            self?.banner = nil
        }
    }

    // MARK: - demo surfaces (bundled examples; never sent)

    func loadDemoSurfaces() {
        let urls = (Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: "Examples") ?? [])
            + (Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: nil) ?? []).filter { $0.lastPathComponent.hasPrefix("example-") }
        var added = 0
        for url in urls.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            guard let data = try? Data(contentsOf: url) else { continue }
            if let spec = try? Wire.decoder.decode(Gen3dSpec.self, from: data), !spec.controls.isEmpty {
                let s = Surface(gen3d: spec, hackset: nil, specId: "demo." + spec.specId, demo: true)
                if !surfaces.contains(where: { $0.id == s.id }) { surfaces.append(s); added += 1 }
            }
        }
        if selectedSurfaceId == nil { selectedSurfaceId = surfaces.first?.id }
        show(added > 0 ? "Loaded \(added) demo surfaces (local only, nothing is sent)." : "No demo surfaces in this build.", tone: .info)
    }

    func removeDemoSurfaces() {
        surfaces.removeAll { $0.isDemo }
        if !surfaces.contains(where: { $0.id == selectedSurfaceId }) { selectedSurfaceId = surfaces.first?.id }
    }
}

// MARK: - small state types

struct UndoEntry {
    var surfaceId: String
    var controlId: String
    var previous: ControlValue
    var label: String
}

struct ThrottleState {
    var lastSent = Date.distantPast
    var trailing: Task<Void, Never>?
}

struct HackSendState: Hashable {
    var sentAt: Date
    /// requested · awaiting evidence · seen ✓ · heard ✓ · no reaction ✗
    var words: String
    var verdict: Bool?
    var actionIds: [String] = []
    var sentence: String?
    var samples: [Double]?
}

struct ExecRecord: Identifiable, Hashable {
    var id: String
    var op: String
    var ok: Bool
    var detail: String
    var at: Date
    var from: String?
}

struct HubLogLine: Identifiable, Hashable {
    var id = UUID()
    var level: String
    var message: String
    var code: String?
    var at = Date()
}

struct Banner: Equatable {
    enum Tone { case info, ok, fail, link }
    var text: String
    var tone: Tone
}

struct ScanState {
    enum Status: Equatable { case idle, capturing, sending, waiting, done, failed(String) }
    var status: Status = .idle
    var frameId: String?
    var image: UIImage?
    var pixelSize: CGSize = .zero
    var sentAt: Date?
    var detections: [ScanDetection] = []
    var modelId: String?
    var latencyMs: Double?
    var selectedDetId: String?
    var bytes: Int = 0
}
