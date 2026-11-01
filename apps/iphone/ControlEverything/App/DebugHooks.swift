#if DEBUG
import Foundation

/// Headless Simulator automation for DEBUG builds only (Release builds compile none of this).
///
/// Launch arguments (`xcrun simctl launch <udid> dev.controleverything.ios -CEServer http://192.168.1.4:8787`):
///   -CEReset 1        forget the paired token first
///   -CEServer <url>   link to this server right away (when not paired)
///   -CEName <name>    this phone's name for pairing
///   -CETab <name>     hacks | scan | ping | log
///   -CEDemo 1         load the bundled demo surfaces
///   -CEOffline 1      open the deck even when not paired (offline demo surfaces, UI tests)
///
/// Deep links while running (`xcrun simctl openurl <udid> 'controleverything://debug?tab=log'`; iOS asks to confirm),
/// or the same keys in an `x.debug` hub message from a paired test script (scripts/mock-brain.ts `debug k=v ...`):
///   tab=<name> · surface=<specId> · hack=<hackId> (same path as a tap) · control=<id>&value=<n|true|false>
///   scanFile=<host path> (scan.frame from an image file) · arm=approve|decline · approvePending=1 · undo=1 · panic=1
extension AppModel {
    func applyLaunchArguments() {
        let d = UserDefaults.standard
        if d.bool(forKey: "CEReset") {
            socket.disconnect()
            CredentialStore.clear()
            credentials = nil
            screen = .connect
        }
        if let name = d.string(forKey: "CEName") { deviceName = name }
        // open the deck without a server (offline look at the demo surfaces; UI tests)
        if d.bool(forKey: "CEOffline") { screen = .deck }
        if let tab = d.string(forKey: "CETab") { setTab(tab) }
        if d.bool(forKey: "CEDemo") { loadDemoSurfaces() }
        if credentials == nil, let server = d.string(forKey: "CEServer") {
            serverInput = server
            Task { await connect(input: server) }
        }
    }

    func setTab(_ name: String) {
        switch name.lowercased() {
        case "scan": tab = .scan
        case "ping", "room": tab = .room
        case "log": tab = .log
        default: tab = .control
        }
    }

    /// Returns true when the URL was a debug command.
    func handleDebugURL(_ url: URL) -> Bool {
        guard url.scheme == "controleverything", url.host == "debug",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return false }
        var q: [String: String] = [:]
        for i in items { q[i.name] = i.value ?? "" }
        runDebug(q)
        return true
    }

    /// The same commands as an `x.debug` hub message ({tab: "log", hack: "full", ...}) from a paired test script:
    /// no system "Open in…?" prompt, and the app keeps its state.
    func handleDebugFrame(_ f: InboundFrame) {
        guard let obj = try? f.payload([String: JSONValue].self) else { return }
        var q: [String: String] = [:]
        for (k, v) in obj { q[k] = v.string ?? v.compact }
        runDebug(q)
    }

    private func runDebug(_ q: [String: String]) {
        if let t = q["tab"] { setTab(t) }
        if let s = q["surface"], surfaces.contains(where: { $0.id == s }) { selectedSurfaceId = s }
        if let h = q["hack"], let s = selectedSurface, let row = s.hacks.first(where: { $0.id == h || $0.widgetId == h }) { upload(s, row) }
        if let cid = q["control"], let s = selectedSurface, let c = s.control(cid) {
            let raw = q["value"] ?? ""
            let v: ControlValue = raw == "true" ? .bool(true) : raw == "false" ? .bool(false) : .number(c.quantize(Double(raw) ?? c.lo))
            if c.kind == "trigger" { trigger(s, c, index: nil) } else { commit(s, c, v) }
        }
        if let path = q["scanFile"], let data = FileManager.default.contents(atPath: path) {
            tab = .scan
            Task { await scanWithImageData(data) }
        }
        if let a = q["arm"], let first = arms.first { confirmArm(first, approve: a == "approve", hold: first.irreversible == true) }
        if q["approvePending"] != nil, let p = pending.first { approve(p) }
        if q["undo"] != nil { undo() }
        if q["panic"] != nil { panic() }
        if q["demo"] != nil { loadDemoSurfaces() }
        if q["clearScan"] != nil { scan = ScanState() }
        if let anchor = q["scroll"] { scrollTarget = anchor }
    }
}
#endif
