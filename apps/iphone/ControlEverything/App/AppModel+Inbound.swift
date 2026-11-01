import SwiftUI
import UIKit

/// Inbound message handling, the local executor, the handheld scanner and the "second eye".
extension AppModel {
    func handle(_ f: InboundFrame) {
        let t = f.head.type
        switch t {
        case MsgType.welcome:
            if let w = try? f.payload(WelcomePayload.self) {
                welcome = w
                if w.deviceId != credentials?.deviceId { log("warn", "welcome for \(w.deviceId), expected \(credentials?.deviceId ?? "?")") }
            }
        case MsgType.presence:
            if let p = try? f.payload(PresencePayload.self) { presence = p.devices }
        case MsgType.pairPending:
            if let p = try? f.payload(PendingPairing.self) {
                pending.removeAll { $0.pairingId == p.pairingId }
                pending.append(p)
                show("\(p.name) (\(p.kind)) wants to join · \(p.display)", tone: .link)
                Haptics.shared.tap()
            }
        case MsgType.pairApproved:
            if let p = try? f.payload(PairApprovedPayload.self) {
                if pending.contains(where: { $0.pairingId == p.pairingId }) {
                    show("\(p.name) joined your space\(p.approvedBy.map { " · approved by \($0)" } ?? "")", tone: .ok)
                }
                pending.removeAll { $0.pairingId == p.pairingId }
            }
        case MsgType.pairDenied:
            if let p = try? f.payload(PairDeniedPayload.self) { pending.removeAll { $0.pairingId == p.pairingId } }
        case MsgType.agentStep:
            if let s = try? f.payload(AgentStepPayload.self) { upsertStep(s) }
        case MsgType.deviceCard:
            if let c = try? f.payload(DeviceCardPayload.self) {
                if cards[c.cardId] == nil { cardOrder.append(c.cardId) }
                cards[c.cardId] = c
            }
        case MsgType.uiSpec:
            if let p = try? f.payload(UiSpecPayload.self) { upsertSurface(Surface(payload: p)) }
            else { log("warn", "could not read a ui.spec from \(f.head.from ?? "?")") }
        case MsgType.controlEvent:
            if let e = try? f.payload(RemoteControlEvent.self) { applyRemote(e) }
        case MsgType.driverStatus:
            if let d = try? f.payload(DriverStatusPayload.self) { driverStatus[d.driverId] = d }
        case MsgType.log:
            if let l = try? f.payload(LogPayload.self) { log(l.level, l.message, code: l.code) }
        case MsgType.voiceText:
            if let v = try? f.payload(VoiceTextPayload.self) { transcript = v }
        case MsgType.panic:
            // the server's fan-out to executors: stop whatever this phone is doing
            if (try? f.payload(PanicPayload.self)) != nil {
                stopLocalEffects()
                show("PANIC · local effects stopped", tone: .fail)
            }
        default:
            if MsgType.matches(t, MsgType.execCommand) { handleExec(f) }
            else if MsgType.matches(t, MsgType.senseRequest) { handleSense(f) }
            else if MsgType.matches(t, MsgType.scanResult) { handleScanResult(f) }
            else if MsgType.matches(t, MsgType.verifyResult) { handleEvidence(f) }
            else if MsgType.matches(t, MsgType.targetStatus) {
                if let ts = try? f.payload(TargetStatusPayload.self) {
                    targets[ts.cardId] = ts
                    if cards[ts.cardId] == nil, !cardOrder.contains(ts.cardId) { cardOrder.append(ts.cardId) }
                }
            }
            else if MsgType.matches(t, MsgType.linkResult) {
                if let l = try? f.payload(LinkResultPayload.self) {
                    links[l.cardId] = l
                    if linkRequest?.cardId == l.cardId, ["confirmed", "consistent"].contains(l.verdict) { linkRequest = nil }
                }
            }
            else if MsgType.matches(t, MsgType.linkRequest) {
                if let l = try? f.payload(LinkRequestPayload.self) {
                    linkRequest = l
                    let who = (l.suggestedClients ?? []).joined(separator: " or ")
                    show("Needs a companion\(who.isEmpty ? "" : ": \(who)")\(l.reason.map { " · \($0)" } ?? "")", tone: .link)
                }
            }
            else if MsgType.matches(t, MsgType.armRequest) {
                if let a = try? f.payload(ArmRequestPayload.self) {
                    arms.removeAll { $0.armId == a.armId }
                    arms.append(a)
                    Haptics.shared.tap()
                }
            }
            else if MsgType.matches(t, MsgType.armResult) {
                if let r = try? f.payload(ArmResultPayload.self) {
                    arms.removeAll { $0.armId == r.armId }
                    let name = cards[r.cardId]?.name ?? "device"
                    show(r.armed ? "\(name) armed\(r.by.map { " by \($0)" } ?? "")" : "\(name) not armed\(r.reason.map { " · \($0)" } ?? "")",
                         tone: r.armed ? .ok : .info)
                }
            }
        }
    }

    func log(_ level: String, _ message: String, code: String? = nil) {
        hubLog.append(HubLogLine(level: level, message: message, code: code))
        if hubLog.count > 100 { hubLog.removeFirst(hubLog.count - 100) }
    }

    private func upsertStep(_ s: AgentStepPayload) {
        if let i = steps.firstIndex(where: { $0.stepId == s.stepId }) { steps[i] = s } else { steps.append(s) }
        if steps.count > 300 { steps.removeFirst(steps.count - 300) }
    }

    func upsertSurface(_ s: Surface) {
        let isNew = !surfaces.contains { $0.id == s.id }
        if let i = surfaces.firstIndex(where: { $0.id == s.id }) { surfaces[i] = s } else { surfaces.insert(s, at: surfaces.firstIndex(where: \.isDemo) ?? surfaces.endIndex) }
        // a new revision keeps the user's values for controls that still exist
        let ids = Set(s.controls.map(\.id))
        for k in values.keys where k.hasPrefix(s.id + "/") && !ids.contains(String(k.dropFirst(s.id.count + 1))) { values[k] = nil }
        if selectedSurfaceId == nil || isNew && !s.isDemo { selectedSurfaceId = s.id }
        if isNew {
            show("New controls: \(s.deviceName)\(s.armed ? "" : " · arming after verification")", tone: .link)
            Haptics.shared.tap()
        }
    }

    private func applyRemote(_ e: RemoteControlEvent) {
        guard let id = e.controlId ?? e.widgetId else { return }
        let candidates = surfaces.filter { s in (e.specId == nil || e.specId == s.id) && s.control(id) != nil }
        for s in candidates {
            guard let c = s.control(id), c.kind != "trigger" else { continue }
            let k = key(s.id, c.id)
            if activeDrags.contains(k) { continue }
            values[k] = e.value
        }
    }

    // MARK: - exec.command -> local executor -> exec.ack

    private func handleExec(_ f: InboundFrame) {
        guard let cmd = try? f.payload(ExecCommandPayload.self) else {
            log("warn", "unreadable exec.command")
            return
        }
        let me = credentials?.deviceId
        if let target = cmd.executorDeviceId, target != me { return }
        if cmd.executorDeviceId == nil, let to = f.head.to, to != me { return }
        let received = Date()
        let outcome = executor.run(cmd.op, dryRun: cmd.dryRun ?? false)
        let from = f.head.from ?? ""
        let replyTo = from.isEmpty || from == Wire.serverId ? Wire.serverId : from
        let ackType = f.head.type.hasPrefix("x.") ? "x." + MsgType.execAck : MsgType.execAck
        let ack = ExecAckPayload(execId: cmd.execId, ok: outcome.ok, sentAt: Wire.nowMs(), detail: outcome.detail, error: outcome.error,
                                 latencyMs: Date().timeIntervalSince(received) * 1000)
        socket.send(ackType, ack, to: replyTo)
        let opName = [cmd.op.op ?? cmd.op.kind, cmd.op.arg?.compact].compactMap { $0 }.joined(separator: " ")
        execLog.insert(ExecRecord(id: cmd.execId, op: opName, ok: outcome.ok, detail: outcome.detail, at: Date(), from: from), at: 0)
        if execLog.count > 40 { execLog.removeLast(execLog.count - 40) }
    }

    // MARK: - sense.request kind 'frame' -> the second eye

    private func handleSense(_ f: InboundFrame) {
        guard let req = try? f.payload(SenseRequestPayload.self) else { return }
        let me = credentials?.deviceId
        if let target = req.sensorDeviceId, target != me { return }
        if req.sensorDeviceId == nil, let to = f.head.to, to != me { return }
        let from = f.head.from ?? ""
        let replyTo = from.isEmpty || from == Wire.serverId ? Wire.serverId : from
        let resultType = f.head.type.hasPrefix("x.") ? "x." + MsgType.senseResult : MsgType.senseResult
        guard req.kind == "frame" else {
            socket.send(resultType, SenseResultPayload(senseId: req.senseId, kind: req.kind, frame: nil, at: Wire.nowMs(), ok: false,
                                                       error: "iphone senses 'frame' only"), to: replyTo)
            return
        }
        Task {
            do {
                let shot = try await CameraController.shared.capture()
                let frame = ScanFramePayload(frameId: Wire.newId("f"), jpeg: shot.base64, width: shot.width, height: shot.height,
                                             capturedAt: shot.capturedAt, camera: FrameCamera(width: shot.width, height: shot.height, source: "handheld"),
                                             purpose: "verify", cardId: req.cardId, senseId: req.senseId)
                socket.send(resultType, SenseResultPayload(senseId: req.senseId, kind: "frame", frame: frame, at: Wire.nowMs(), ok: true), to: replyTo)
                execLog.insert(ExecRecord(id: req.senseId, op: "second eye · frame", ok: true, detail: "\(shot.width)×\(shot.height), \(shot.jpeg.count / 1024) KB", at: Date(), from: from), at: 0)
            } catch {
                socket.send(resultType, SenseResultPayload(senseId: req.senseId, kind: "frame", frame: nil, at: Wire.nowMs(), ok: false,
                                                           error: error.localizedDescription), to: replyTo)
                execLog.insert(ExecRecord(id: req.senseId, op: "second eye · frame", ok: false, detail: error.localizedDescription, at: Date(), from: from), at: 0)
            }
        }
    }

    // MARK: - handheld scanner: scan.frame -> scan.result

    func scanWithCamera() async {
        scan.status = .capturing
        do {
            let shot = try await CameraController.shared.capture()
            sendScanFrame(shot)
        } catch {
            scan.status = .failed(error.localizedDescription)
        }
    }

    func scanWithImageData(_ data: Data) async {
        scan.status = .capturing
        do {
            let shot = try await Task.detached(priority: .userInitiated) { try CameraController.downscale(data) }.value
            sendScanFrame(shot)
        } catch {
            scan.status = .failed(error.localizedDescription)
        }
    }

    private func sendScanFrame(_ shot: CapturedFrame) {
        let frameId = Wire.newId("f")
        scan = ScanState(status: .sending, frameId: frameId, image: UIImage(data: shot.jpeg),
                         pixelSize: CGSize(width: shot.width, height: shot.height), sentAt: Date(), bytes: shot.jpeg.count)
        let p = ScanFramePayload(frameId: frameId, jpeg: shot.base64, width: shot.width, height: shot.height, capturedAt: shot.capturedAt,
                                 camera: FrameCamera(width: shot.width, height: shot.height, source: "handheld"), purpose: "scan")
        if socket.send(MsgType.scanFrame, p, to: Wire.serverId) {
            scan.status = .waiting
        } else {
            scan.status = .failed("Not connected to the server.")
        }
    }

    private func handleScanResult(_ f: InboundFrame) {
        guard let r = try? f.payload(ScanResultPayload.self) else { return }
        guard r.frameId == scan.frameId else { return }
        scan.detections = r.detections
        scan.modelId = r.modelId
        scan.latencyMs = r.latencyMs
        scan.status = .done
        Haptics.shared.tick()
    }

    func selectDetection(_ d: ScanDetection) {
        scan.selectedDetId = d.detId
        socket.send(MsgType.targetSelect, TargetSelectPayload(frameId: scan.frameId, detId: d.detId, cardId: d.cardId, deviceId: d.deviceId, text: nil), to: Wire.serverId)
        Haptics.shared.tap()
        show("Locked \(d.label). The agent takes it from here.", tone: .link)
    }

    // MARK: - verify.result (evidence) -> hack row verdicts

    private func handleEvidence(_ f: InboundFrame) {
        guard let e = try? f.payload(EvidencePayload.self) else { return }
        evidence.insert(e, at: 0)
        if evidence.count > 60 { evidence.removeLast(evidence.count - 60) }
        Haptics.shared.verdict(e.pass)
        let sense = e.observed?.sense ?? e.expected?.sense ?? "camera"
        let mark = e.pass ? (sense == "audio" || sense == "mic" ? "heard ✓" : sense == "ack" ? "acked ✓" : "seen ✓") : "no reaction ✗"
        for (k, st) in hackState {
            guard let a = e.actionId, st.actionIds.contains(a) else { continue }
            hackState[k]?.verdict = e.pass
            hackState[k]?.words = mark
            hackState[k]?.sentence = Self.sentence(for: e)
            hackState[k]?.samples = e.observed?.samples ?? [e.observed?.before, e.observed?.after].compactMap { $0 }
        }
    }

    /// "sent DIM → seen dimmer (Δ 38 %) ✓"
    static func sentence(for e: EvidencePayload) -> String {
        if let note = e.note ?? e.observed?.note, !note.isEmpty { return note }
        let sent = e.sent?.op.map { short($0) } ?? e.actionId ?? "command"
        let effect = e.expected?.effect ?? "change"
        var obs = e.pass ? effect : "no change"
        if let d = e.observed?.delta { obs += String(format: " (Δ %.0f %%)", abs(d) * (abs(d) <= 1.5 ? 100 : 1)) }
        return "sent \(sent) → \(obs) \(e.pass ? "✓" : "✗")"
    }

    private static func short(_ op: JSONValue) -> String {
        if let o = op.object {
            if let c = o["command"]?.compact { return c }
            if let n = o["number"]?.compact { return "CC \(n)" }
            if let v = o["op"]?.compact { return v }
        }
        return String(op.compact.prefix(24))
    }
}

/// control.event from another controller (the Quest, the Mac), to keep this phone's widgets in sync.
nonisolated struct RemoteControlEvent: Decodable, Sendable {
    var widgetId: String?
    var controlId: String?
    var value: ControlValue
    var specId: String?
}

/// Outbound `log` (any direction is allowed by the protocol).
nonisolated struct LogOut: Encodable, Sendable {
    var level: String
    var message: String
    var code: String?
    var ref: String?
}
