import SwiftUI

/// The paired app: a status strip, one of four modes, the always-visible UNDO, and the mode bar.
struct DeckView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            StatusStrip()
            ZStack {
                switch model.tab {
                case .control: HacksTab()
                case .scan: ScanTab()
                case .log: LogTab()
                case .room: PingTab()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            ModeBar()
        }
    }
}

/// Server, link state, model mode. No decorative telemetry.
struct StatusStrip: View {
    @Environment(AppModel.self) private var model

    private var words: (String, Color) {
        switch model.socketState {
        case .open: return ("linked", Neon.ok)
        case .connecting(let a): return (a > 1 ? "relinking · try \(a)" : "linking…", Neon.volt)
        case .waiting(let s, _): return ("offline · retry in \(String(format: "%.0f", max(1, s))) s", Neon.fail)
        case .idle: return ("offline", Neon.fail)
        }
    }

    var body: some View {
        let (w, c) = words
        HStack(spacing: 8) {
            Pip(color: c, filled: model.isOnline)
            Text(w).font(Typo.mono(12, weight: .semibold)).foregroundStyle(c)
            Text(model.credentials?.server.display ?? "").font(Typo.mono(11)).foregroundStyle(Neon.dim).lineLimit(1)
            Spacer(minLength: 4)
            if let mode = model.welcome?.mode {
                Text(mode == "live" ? "LIVE MODELS" : "FIXTURE").font(Typo.mono(10, weight: .bold))
                    .foregroundStyle(mode == "live" ? Neon.cyan : Neon.void)
                    .padding(.horizontal, 5).padding(.vertical, 2)
                    .background(mode == "live" ? Neon.void : Neon.dim)
                    .overlay(Rectangle().stroke(Neon.cyan.opacity(mode == "live" ? 0.6 : 0), lineWidth: 1))
            }
            if model.undoLabel != nil {
                Button {
                    model.undo()
                } label: {
                    Text("UNDO").font(Typo.label(11)).foregroundStyle(Neon.volt)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .overlay(Rectangle().stroke(Neon.volt.opacity(0.7), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.undoLabel ?? "Undo")
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Neon.void.opacity(0.96))
        .overlay(alignment: .bottom) { Rectangle().fill(Neon.cyan.opacity(0.25)).frame(height: 1) }
    }
}

/// HACKS · SCAN · PING · LOG
struct ModeBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 0) {
            item(.control, "HACKS", badge: model.surfaces.filter { !$0.isDemo }.count)
            item(.scan, "SCAN", badge: 0)
            item(.room, "PING", badge: model.pending.count)
            item(.log, "LOG", badge: 0)
        }
        .padding(.horizontal, 8).padding(.top, 6)
        .background(Neon.void.opacity(0.97))
        .overlay(alignment: .top) { Rectangle().fill(Neon.cyan.opacity(0.25)).frame(height: 1) }
    }

    private func item(_ tab: AppModel.DeckTab, _ title: String, badge: Int) -> some View {
        let on = model.tab == tab
        return Button {
            Haptics.shared.tick()
            model.tab = tab
        } label: {
            VStack(spacing: 5) {
                Rectangle().fill(on ? Neon.volt : .clear).frame(height: 3)
                HStack(spacing: 4) {
                    Text(title).hudLabel(13, color: on ? Neon.volt : Neon.dim)
                    if badge > 0 {
                        Text("\(badge)").font(Typo.mono(10, weight: .bold)).foregroundStyle(Neon.void)
                            .padding(.horizontal, 4).background(tab == .room ? Neon.magenta : Neon.cyan)
                    }
                }
            }
            .frame(maxWidth: .infinity, minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityIdentifier("tab." + title.lowercased())
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

// MARK: - HACKS: your devices

struct HacksTab: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Color.clear.frame(height: 0).id("top")
                if model.surfaces.isEmpty {
                    emptyState
                } else {
                    if model.surfaces.count > 1 { deviceStrip }
                    if let s = model.selectedSurface {
                        SurfaceView(surface: s).id(s.id)
                        if !s.isDemo { CommandBox().id("command") }
                    }
                }
                if let l = model.linkRequest {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("NEEDS A COMPANION").hudLabel(11, color: Neon.magenta)
                        Text((l.suggestedClients ?? []).joined(separator: " · ").uppercased()).font(Typo.label(14)).foregroundStyle(Neon.bone)
                        if let r = l.reason { Text(r).font(Typo.mono(11)).foregroundStyle(Neon.dim) }
                    }
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading).plate(edge: Neon.magenta, cut: 8)
                }
            }
            .padding(14)
        }
        .onChange(of: model.scrollTarget) { _, t in
            guard let t else { return }
            withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(t, anchor: .top) }
            model.scrollTarget = nil
        }
        }
    }

    private var deviceStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.surfaces) { s in
                    let on = s.id == model.selectedSurface?.id
                    Button {
                        Haptics.shared.tick()
                        model.selectedSurfaceId = s.id
                    } label: {
                        HStack(spacing: 6) {
                            Pip(color: s.isDemo ? Neon.dim : s.armed ? Neon.ok : Neon.volt, filled: s.armed, size: 6)
                            Text(s.deviceName).hudLabel(11, color: on ? Neon.void : Neon.bone).lineLimit(1)
                            Text(ChannelGlyph.text(s.channel)).font(Typo.mono(9, weight: .bold)).foregroundStyle(on ? Neon.void : Neon.dim)
                        }
                        .padding(.horizontal, 10).frame(minHeight: 40)
                        .background(Chamfer(cut: 6).fill(on ? Neon.volt : Neon.plate))
                        .overlay(Chamfer(cut: 6).stroke(on ? Neon.volt : Neon.cyan.opacity(0.4), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionTitle(title: "HACKS", subtitle: "your devices")
            Text("No device controls yet.").font(Typo.label(18)).foregroundStyle(Neon.bone)
            Text("Scan a device you own with the headset (or the SCAN tab here). The agent identifies it, links a channel, proves it by watching the device react, then forges controls that land here.")
                .font(Typo.mono(12)).foregroundStyle(Neon.dim).fixedSize(horizontal: false, vertical: true)
            Button {
                model.loadDemoSurfaces()
            } label: {
                Text("LOAD DEMO SURFACES").font(Typo.label(13)).tracking(1).foregroundStyle(Neon.cyan)
                    .frame(maxWidth: .infinity, minHeight: 48).plate(cut: 8)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("loadDemo")
            Text("Demo surfaces are bundled examples; they never send anything.").font(Typo.mono(10)).foregroundStyle(Neon.dim.opacity(0.8))
        }
        .padding(16)
        .plate(dashed: true)
    }
}

/// Typed edits for the agent ("make resonance a big red lever"): sent as a final voice.text.
struct CommandBox: View {
    @Environment(AppModel.self) private var model
    @FocusState private var focused: Bool

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(title: "TELL THE AGENT", subtitle: "edits these controls")
            HStack(spacing: 8) {
                TextField("", text: $model.commandInput, prompt: Text("make the dimmer a big lever").foregroundStyle(Neon.dim.opacity(0.55)))
                    .font(Typo.mono(14)).foregroundStyle(Neon.bone)
                    .focused($focused).submitLabel(.send)
                    .onSubmit { model.sendCommand() }
                    .padding(.horizontal, 12).frame(minHeight: 48).plate(edge: focused ? Neon.volt : Neon.cyan, cut: 8)
                Button {
                    focused = false
                    model.sendCommand()
                } label: {
                    Text("SEND").font(Typo.label(12)).foregroundStyle(Neon.void)
                        .padding(.horizontal, 14).frame(minHeight: 48)
                        .background(Chamfer(cut: 8).fill(model.commandInput.isEmpty || !model.isOnline ? Neon.dim : Neon.volt))
                }
                .buttonStyle(.plain)
                .disabled(model.commandInput.isEmpty || !model.isOnline)
            }
        }
    }
}
