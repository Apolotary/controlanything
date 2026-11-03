import Foundation

/// Where the ControlAnything server lives, and how a scanned or typed string becomes one.
///
/// Accepted inputs (from the Mac companion's QR, a pairing QR, a deep link, or the keyboard):
///   http://192.168.1.20:8787            https://192.168.1.20:8443/quest/
///   192.168.1.20 · mac.local:8787       controleverything://connect?server=http://…
///   {"server":"http://…"}               https://host:8443/p/<pairingId>#<code>  (another device's pairing QR)
nonisolated struct ServerEndpoint: Codable, Hashable, Sendable {
    /// scheme://host:port, no path
    var base: URL

    var host: String { base.host ?? "?" }
    var display: String {
        var s = base.host ?? "?"
        if let p = base.port { s += ":\(p)" }
        return s
    }
    var isTLS: Bool { base.scheme == "https" }

    func api(_ path: String) -> URL { base.appending(path: "api").appending(path: path) }

    var webSocketURL: URL {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        c.scheme = isTLS ? "wss" : "ws"
        c.path = "/ws"
        return c.url!
    }

    /// Default plain-HTTP port the server listens on (HTTP_PORT); the HTTPS port is 8443.
    static let defaultHTTPPort = 8787
    static let defaultHTTPSPort = 8443

    /// Candidate base URLs to probe, most likely first. A native app prefers the plain LAN port
    /// (no self-signed certificate to accept), then the URL exactly as given.
    static func candidates(from input: String) -> [ServerEndpoint] {
        guard let url = extractURL(from: input), let host = url.host, !host.isEmpty else { return [] }
        let scheme = (url.scheme ?? "http").lowercased()
        var out: [ServerEndpoint] = []
        func add(_ scheme: String, _ port: Int?) {
            var c = URLComponents()
            c.scheme = scheme
            c.host = host
            c.port = port
            if let u = c.url {
                let e = ServerEndpoint(base: u)
                if !out.contains(e) { out.append(e) }
            }
        }
        if scheme == "https" {
            add("http", defaultHTTPPort)
            add("https", url.port ?? defaultHTTPSPort)
        } else {
            add("http", url.port ?? defaultHTTPPort)
            if url.port == nil { add("https", defaultHTTPSPort) }
        }
        return out
    }

    /// A pairing QR of another device: "CE1:<code>" (short form) or https://host:8443/p/<pairingId>#<code>
    static func pairingTarget(from input: String) -> (pairingId: String?, code: String)? {
        let s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.uppercased().hasPrefix("CE1:") {
            let code = s.dropFirst(4).uppercased().filter { $0.isLetter || $0.isNumber }
            return code.count == 6 ? (nil, String(code)) : nil
        }
        guard let url = URL(string: s) else { return nil }
        let parts = url.path.split(separator: "/")
        guard parts.count == 2, parts[0] == "p", let code = url.fragment, !code.isEmpty else { return nil }
        return (String(parts[1]), code)
    }

    /// Pull a server URL out of whatever the QR or text field holds.
    static func extractURL(from raw: String) -> URL? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        // JSON payload {"server": "..."} or {"http": "...", "https": "..."}
        if s.hasPrefix("{"), let data = s.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            for key in ["server", "http", "url", "https", "local"] {
                if let v = obj[key] as? String, let u = extractURL(from: v) { return u }
            }
            return nil
        }
        // deep link controleverything://connect?server=…
        if s.lowercased().hasPrefix("controleverything:"), let c = URLComponents(string: s) {
            if let v = c.queryItems?.first(where: { $0.name == "server" || $0.name == "url" })?.value {
                return extractURL(from: v)
            }
            return nil
        }
        let withScheme = s.contains("://") ? s : "http://" + s
        guard let u = URL(string: withScheme), let scheme = u.scheme?.lowercased(), ["http", "https", "ws", "wss"].contains(scheme) else { return nil }
        if scheme == "ws" || scheme == "wss" {
            var c = URLComponents(url: u, resolvingAgainstBaseURL: false)
            c?.scheme = scheme == "wss" ? "https" : "http"
            return c?.url
        }
        return u
    }

    /// True for hosts on this LAN (private IPv4, link-local, loopback, *.local, bare hostnames).
    static func isLocalHost(_ host: String) -> Bool {
        let h = host.lowercased()
        if h == "localhost" || h.hasSuffix(".local") || !h.contains(".") { return true }
        if h == "::1" || h.hasPrefix("fe80:") || h.hasPrefix("fd") { return true }
        let o = h.split(separator: ".").compactMap { Int($0) }
        guard o.count == 4 else { return false }
        switch (o[0], o[1]) {
        case (10, _), (127, _), (192, 168), (169, 254): return true
        case (172, 16...31): return true
        default: return false
        }
    }
}
