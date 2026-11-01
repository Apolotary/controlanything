import Foundation

/// The dev server uses a self-signed certificate on its HTTPS port. We accept it only for hosts on this
/// LAN (the same exposure as the server's plain-HTTP LAN port, which we prefer anyway); public hosts get
/// normal certificate validation.
nonisolated final class LANTrustDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        handle(challenge, completionHandler)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        handle(challenge, completionHandler)
    }

    private func handle(_ challenge: URLAuthenticationChallenge,
                        _ completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        if space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           ServerEndpoint.isLocalHost(space.host), let trust = space.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}

nonisolated enum Net {
    static let delegate = LANTrustDelegate()
    /// One session for REST and the WebSocket.
    static let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 8
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg, delegate: delegate, delegateQueue: nil)
    }()
}

nonisolated enum APIError: LocalizedError, Sendable {
    case unreachable(String)
    case http(Int, String)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .unreachable(let s): return s
        case .http(let code, let msg): return "\(msg) (HTTP \(code))"
        case .badResponse: return "The server sent something unexpected."
        }
    }
}

/// REST calls to /api on the ControlEverything server.
nonisolated struct APIClient: Sendable {
    var endpoint: ServerEndpoint
    var token: String?

    func health(timeout: TimeInterval = 3) async throws -> HealthResponse {
        try await get("health", timeout: timeout)
    }

    func pairStart(_ body: PairStartRequest) async throws -> PairStartResponse {
        try await send("pair/start", method: "POST", body: body)
    }

    func pairStatus(pairingId: String, pollSecret: String) async throws -> PairStatusResponse {
        var c = URLComponents(url: endpoint.api("pair/status"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "pairingId", value: pairingId), URLQueryItem(name: "pollSecret", value: pollSecret)]
        return try await perform(URLRequest(url: c.url!))
    }

    func pairApprove(_ body: PairApproveRequest) async throws {
        let _: JSONValue = try await send("pair/approve", method: "POST", body: body)
    }

    // MARK: plumbing

    private func get<T: Decodable>(_ path: String, timeout: TimeInterval) async throws -> T {
        var r = URLRequest(url: endpoint.api(path))
        r.timeoutInterval = timeout
        return try await perform(r)
    }

    private func send<B: Encodable, T: Decodable>(_ path: String, method: String, body: B) async throws -> T {
        var r = URLRequest(url: endpoint.api(path))
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try Wire.encoder.encode(body)
        return try await perform(r)
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        var r = request
        if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Net.session.data(for: r)
        } catch let e as URLError {
            throw APIError.unreachable(Self.describe(e, host: endpoint.display))
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            let body = try? Wire.decoder.decode(APIErrorBody.self, from: data)
            throw APIError.http(http.statusCode, body?.message ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode))
        }
        do {
            return try Wire.decoder.decode(T.self, from: data)
        } catch {
            throw APIError.badResponse
        }
    }

    static func describe(_ e: URLError, host: String) -> String {
        switch e.code {
        case .timedOut: return "No answer from \(host). Is the server running (npm run dev) and on the same Wi-Fi?"
        case .cannotConnectToHost, .networkConnectionLost: return "\(host) refused the connection. Check the port (8787 for http)."
        case .cannotFindHost, .dnsLookupFailed: return "Can't find \(host). Use the Mac's LAN IP, e.g. 192.168.1.20."
        case .notConnectedToInternet: return "This phone is offline. Join the same Wi-Fi as the Mac."
        case .appTransportSecurityRequiresSecureConnection: return "iOS blocked plain http to \(host). Use the Mac's LAN IP or .local name."
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid:
            return "TLS failed for \(host). Try the http URL on port 8787."
        default: return "\(host): \(e.localizedDescription)"
        }
    }
}
