import Foundation

/// The /ws connection: one URLSessionWebSocketTask at a time, a receive loop, a keepalive ping, and
/// reconnect with backoff. Frames are handed to `onFrame` on the main actor in arrival order.
final class HubSocket {
    enum State: Equatable {
        case idle
        case connecting(attempt: Int)
        case open
        case waiting(retryIn: Double, reason: String)
    }

    /// WebSocket close code the hub uses for an unknown or revoked device token.
    static let closeUnauthorized = 4401

    var onFrame: (InboundFrame) -> Void = { _ in }
    var onState: (State) -> Void = { _ in }
    /// Called right after a socket is created; send `hello` here (sends queue until the handshake ends).
    var onOpenAttempt: () -> Void = {}
    /// The hub closed with 4401: the token is no longer valid.
    var onUnauthorized: () -> Void = {}

    private var task: URLSessionWebSocketTask?
    private var url: URL?
    private var generation = 0
    private var attempt = 0
    private var reconnect: Task<Void, Never>?
    private var keepalive: Task<Void, Never>?
    private var gotFrame = false
    private(set) var state: State = .idle { didSet { if state != oldValue { onState(state) } } }

    func connect(to url: URL) {
        self.url = url
        attempt = 0
        open()
    }

    func disconnect() {
        url = nil
        reconnect?.cancel()
        keepalive?.cancel()
        generation += 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        state = .idle
    }

    /// Reconnect now (e.g. the app came back to the foreground).
    func kick() {
        guard url != nil else { return }
        switch state {
        case .open, .connecting: return
        default:
            attempt = 0
            open()
        }
    }

    var isOpen: Bool { state == .open }

    /// Encode and send one message. Returns false when there is no socket.
    @discardableResult
    func send<P: Encodable>(_ type: String, _ payload: P, to: String? = nil) -> Bool {
        guard let task else { return false }
        let env = OutboundEnvelope(type: type, to: to, payload: payload)
        guard let data = try? Wire.encoder.encode(env), let text = String(data: data, encoding: .utf8) else { return false }
        let gen = generation
        task.send(.string(text)) { [weak self] error in
            guard let error else { return }
            Task { @MainActor in
                guard let self, gen == self.generation else { return }
                self.lost("send failed: \(error.localizedDescription)", gen: gen)
            }
        }
        return true
    }

    // MARK: - lifecycle

    private func open() {
        guard let url else { return }
        reconnect?.cancel()
        keepalive?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        generation += 1
        let gen = generation
        attempt += 1
        gotFrame = false
        state = .connecting(attempt: attempt)
        let t = Net.session.webSocketTask(with: url)
        t.maximumMessageSize = 16 * 1024 * 1024
        task = t
        t.resume()
        onOpenAttempt()
        receive(gen: gen)
        keepalive = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard let self, gen == self.generation, let t = self.task else { return }
                let ok = await withCheckedContinuation { (k: CheckedContinuation<Bool, Never>) in
                    t.sendPing { err in k.resume(returning: err == nil) }
                }
                if !ok, gen == self.generation { self.lost("no pong from the server", gen: gen); return }
            }
        }
    }

    private func receive(gen: Int) {
        guard let t = task else { return }
        Task { [weak self] in
            while true {
                do {
                    let msg = try await t.receive()
                    guard let self, gen == self.generation else { return }
                    let data: Data
                    switch msg {
                    case .string(let s): data = Data(s.utf8)
                    case .data(let d): data = d
                    @unknown default: continue
                    }
                    if !self.gotFrame {
                        self.gotFrame = true
                        self.attempt = 0
                        self.state = .open
                    }
                    if let head = try? Wire.decoder.decode(EnvelopeHead.self, from: data) {
                        self.onFrame(InboundFrame(head: head, data: data))
                    }
                } catch {
                    guard let self, gen == self.generation else { return }
                    if t.closeCode.rawValue == Self.closeUnauthorized {
                        self.generation += 1
                        self.task = nil
                        self.keepalive?.cancel()
                        self.state = .idle
                        self.url = nil
                        self.onUnauthorized()
                        return
                    }
                    let reason = t.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? error.localizedDescription
                    self.lost(reason, gen: gen)
                    return
                }
            }
        }
    }

    private func lost(_ reason: String, gen: Int) {
        guard gen == generation, url != nil else { return }
        generation += 1
        keepalive?.cancel()
        task?.cancel(with: .abnormalClosure, reason: nil)
        task = nil
        let delay = min(10, 0.5 * pow(2, Double(max(0, attempt - 1))))
        state = .waiting(retryIn: delay, reason: reason)
        reconnect = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, self.url != nil else { return }
            self.open()
        }
    }
}
