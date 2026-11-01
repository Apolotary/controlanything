import CoreText
import SwiftUI

/// The HUD palette (packages/gen3d/src/theme.ts NEON) flattened to 2D. Colour means one thing:
/// cyan = what the agent perceives, volt = what you intend (selection, values, progress),
/// magenta = what persists (daemons), ok/fail = only a verdict the camera, mic or wire produced.
nonisolated enum Neon {
    static let void = Color(hex: "#0A0E12")
    static let plate = Color(hex: "#101820")
    static let holo = Color(hex: "#0C2630")
    static let cyan = Color(hex: "#38F0FF")
    static let volt = Color(hex: "#EEFF41")
    static let magenta = Color(hex: "#FF3DBE")
    static let ok = Color(hex: "#5CFFA3")
    static let fail = Color(hex: "#FF5A3C")
    static let bone = Color(hex: "#F3F7FA")
    static let dim = Color(hex: "#8FA3B3")

    static func status(_ s: String?) -> Color {
        switch s {
        case "verified", "controlled", "ok", "done", "pass": return ok
        case "failed", "fail", "error", "offline", "killed": return fail
        case "running", "queued", "uploading", "candidate", "locked", "pinging", "live", "requested": return volt
        case "linking", "breaching", "breached", "daemon": return magenta
        case "pending", "idle", "paused": return dim
        default: return cyan
        }
    }
}

extension Color {
    nonisolated init(hex: String) {
        if let rgb = RGB(hex: hex) { self.init(red: rgb.r, green: rgb.g, blue: rgb.b) } else { self = Neon.cyan }
    }
}

/// Type: labels in Chakra Petch (if its OFL files are bundled under Resources/Fonts) or the expanded
/// system face, uppercase and tracked; values in monospaced digits; Japanese falls back to the system face.
nonisolated enum Typo {
    private static let chakraBold = "ChakraPetch-Bold"
    private static let chakraSemi = "ChakraPetch-SemiBold"
    private static let shareTech = "ShareTechMono-Regular"
    nonisolated(unsafe) private static var registered = false

    /// Register any .ttf/.otf under the bundle's Fonts folder (no Info.plist edit needed).
    static func registerBundledFonts() {
        guard !registered else { return }
        registered = true
        let urls = (Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: "Fonts") ?? [])
            + (Bundle.main.urls(forResourcesWithExtension: "otf", subdirectory: "Fonts") ?? [])
            + (Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: nil) ?? [])
        for url in urls { CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil) }
    }

    private static func has(_ name: String) -> Bool { UIFont(name: name, size: 12) != nil }

    static func label(_ size: CGFloat, bold: Bool = true) -> Font {
        let name = bold ? chakraBold : chakraSemi
        if has(name) { return .custom(name, size: size) }
        return .system(size: size, weight: bold ? .bold : .semibold).width(.expanded)
    }

    static func title(_ size: CGFloat) -> Font {
        if has(chakraBold) { return .custom(chakraBold, size: size) }
        return .system(size: size, weight: .heavy).width(.expanded)
    }

    static func mono(_ size: CGFloat, weight: Font.Weight = .medium) -> Font {
        if has(shareTech) { return .custom(shareTech, size: size) }
        return .system(size: size, weight: weight, design: .monospaced)
    }

    static func body(_ size: CGFloat = 15) -> Font { .system(size: size, weight: .regular) }
}

/// A rectangle with two cut corners (top-left, bottom-right): the plate silhouette.
nonisolated struct Chamfer: Shape {
    var cut: CGFloat = 10
    func path(in r: CGRect) -> Path {
        let c = min(cut, min(r.width, r.height) / 3)
        var p = Path()
        p.move(to: CGPoint(x: r.minX + c, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - c))
        p.addLine(to: CGPoint(x: r.maxX - c, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.minY + c))
        p.closeSubpath()
        return p
    }
}

/// Every word sits on a plate: void/plate fill, a keyline, and a 1 pt neon edge at 60 %.
struct PlateStyle: ViewModifier {
    var edge: Color = Neon.cyan
    var cut: CGFloat = 10
    var fill: Color = Neon.plate
    var edgeOpacity: Double = 0.6
    var dashed = false

    func body(content: Content) -> some View {
        content
            .background(Chamfer(cut: cut).fill(fill.opacity(0.94)))
            .overlay(Chamfer(cut: cut).stroke(Neon.void, lineWidth: 3))
            .overlay(Chamfer(cut: cut).stroke(edge.opacity(edgeOpacity), style: StrokeStyle(lineWidth: 1, dash: dashed ? [5, 4] : [])))
    }
}

extension View {
    func plate(edge: Color = Neon.cyan, cut: CGFloat = 10, fill: Color = Neon.plate, edgeOpacity: Double = 0.6, dashed: Bool = false) -> some View {
        modifier(PlateStyle(edge: edge, cut: cut, fill: fill, edgeOpacity: edgeOpacity, dashed: dashed))
    }

    /// Uppercase tracked label text.
    func hudLabel(_ size: CGFloat = 12, color: Color = Neon.bone, bold: Bool = true) -> some View {
        font(Typo.label(size, bold: bold)).tracking(size * 0.08).textCase(.uppercase).foregroundStyle(color)
    }
}

/// The void background with faint static scanlines (no motion, no flicker).
struct HUDBackground: View {
    var body: some View {
        Canvas { ctx, size in
            ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Neon.void))
            var y: CGFloat = 0
            while y < size.height {
                ctx.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 1)), with: .color(Neon.cyan.opacity(0.035)))
                y += 4
            }
        }
        .ignoresSafeArea()
    }
}

/// A small status pip: filled = verdict or live, hollow = idle.
struct Pip: View {
    var color: Color
    var filled = true
    var size: CGFloat = 8
    var body: some View {
        ZStack {
            Circle().fill(Neon.void).frame(width: size + 4, height: size + 4)
            if filled { Circle().fill(color).frame(width: size, height: size) } else { Circle().stroke(color, lineWidth: 1.5).frame(width: size, height: size) }
        }
    }
}

/// A Meta model id chip (shown whenever a model did the work).
struct ModelChipView: View {
    var id: String
    var source: String?
    var body: some View {
        HStack(spacing: 4) {
            Text(id).font(Typo.mono(10, weight: .semibold)).foregroundStyle(Neon.cyan).lineLimit(1)
            if let source, source != "live" {
                Text(source.uppercased()).font(Typo.mono(9, weight: .bold)).foregroundStyle(Neon.void).lineLimit(1)
                    .padding(.horizontal, 3).background(Neon.dim)
            }
        }
        .fixedSize()
        .padding(.horizontal, 6).padding(.vertical, 3)
        .background(Neon.void)
        .overlay(Rectangle().stroke(Neon.cyan.opacity(0.5), lineWidth: 1))
    }
}

/// Channel glyph: how a device is reached.
nonisolated enum ChannelGlyph {
    static func text(_ ch: String?) -> String {
        switch ch {
        case "usb", "usb-midi", "midi": return "USB"
        case "ir": return "IR"
        case "wifi", "http": return "WIFI"
        case "ble", "ble-midi": return "BLE"
        case "serial": return "SER"
        case "sim": return "SIM"
        default: return "—"
        }
    }
}

/// Kind glyphs from the hack grammar: action ▸, control ◎, daemon ∞.
nonisolated enum KindGlyph {
    static func text(_ kind: String?) -> String {
        switch kind {
        case "control": return "◎"
        case "daemon": return "∞"
        default: return "▸"
        }
    }
}
