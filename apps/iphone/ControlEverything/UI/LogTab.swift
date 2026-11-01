import SwiftUI

/// LOG: the agent's work log (agent.step) with the Meta model behind each step, plus what this phone
/// executed, the verification evidence, and hub warnings.
struct LogTab: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    SectionTitle(title: "LOG", subtitle: "what the agent did, and which model did it")
                    if let t = model.transcript {
                        HStack(alignment: .top, spacing: 8) {
                            Text("“").font(Typo.title(22)).foregroundStyle(Neon.cyan)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(t.text).font(Typo.mono(13)).foregroundStyle(Neon.bone)
                                HStack(spacing: 6) {
                                    if let m = t.modelId { ModelChipView(id: m, source: t.source) }
                                    if let i = t.intent { Text(i.uppercased()).font(Typo.mono(10, weight: .bold)).foregroundStyle(Neon.volt) }
                                }
                            }
                        }
                        .padding(10).plate(cut: 8)
                    }
                    if model.steps.isEmpty {
                        Text("No agent steps yet. They stream in while the agent scans, identifies, links, writes a driver, verifies and forges controls.")
                            .font(Typo.mono(11)).foregroundStyle(Neon.dim).padding(.vertical, 6)
                    }
                    ForEach(model.steps) { s in StepRow(step: s).id(s.stepId) }
                    if !model.evidence.isEmpty {
                        SectionTitle(title: "EVIDENCE", subtitle: "sent · expected · observed")
                        ForEach(model.evidence) { e in EvidenceRow(e: e) }
                    }
                    if !model.execLog.isEmpty {
                        SectionTitle(title: "RAN ON THIS PHONE", subtitle: "exec.command → exec.ack")
                        ForEach(model.execLog) { r in
                            HStack(alignment: .top, spacing: 8) {
                                Pip(color: r.ok ? Neon.ok : Neon.fail)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(r.op).font(Typo.mono(12, weight: .semibold)).foregroundStyle(Neon.bone)
                                    Text(r.detail).font(Typo.mono(11)).foregroundStyle(Neon.dim)
                                }
                                Spacer()
                                Text(r.at, style: .time).font(Typo.mono(10)).foregroundStyle(Neon.dim)
                            }
                            .padding(10).plate(edge: r.ok ? Neon.cyan : Neon.dim, cut: 6, edgeOpacity: 0.4)
                        }
                    }
                    if !model.hubLog.isEmpty {
                        SectionTitle(title: "HUB", subtitle: "warnings")
                        ForEach(model.hubLog.suffix(20).reversed()) { l in
                            Text("\(l.level.uppercased()) · \(l.message)").font(Typo.mono(10))
                                .foregroundStyle(l.level == "error" ? Neon.fail : Neon.dim)
                        }
                    }
                }
                .padding(14)
            }
            .onChange(of: model.steps.count) { _, _ in
                if let last = model.steps.last { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last.stepId, anchor: .bottom) } }
            }
        }
    }
}

struct StepRow: View {
    var step: AgentStepPayload

    private var color: Color {
        switch step.status {
        case "ok": return Neon.ok
        case "fail": return Neon.fail
        case "running": return Neon.volt
        default: return Neon.dim
        }
    }

    private var duration: String? {
        if let l = step.latencyMs { return String(format: "%.1f s", l / 1000) }
        guard let a = step.startedAt, let b = step.endedAt, b >= a else { return nil }
        return String(format: "%.1f s", (b - a) / 1000)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 4) {
                if step.status == "running" { ProgressView().tint(Neon.volt).scaleEffect(0.7).frame(width: 14, height: 14) }
                else { Pip(color: color, filled: step.status != "pending") }
            }
            .frame(width: 16).padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(step.phase.uppercased()).font(Typo.mono(9, weight: .bold)).foregroundStyle(Neon.void)
                        .padding(.horizontal, 4).padding(.vertical, 1).background(phaseColor)
                    Text(step.title).font(Typo.label(13, bold: false)).foregroundStyle(Neon.bone).lineLimit(2)
                }
                if let d = step.detail, !d.isEmpty { Text(d).font(Typo.mono(11)).foregroundStyle(Neon.dim).lineLimit(3) }
                if let e = step.evidence {
                    Text(e).font(Typo.mono(11, weight: .semibold)).foregroundStyle(step.kind == "proof" ? Neon.ok : Neon.cyan)
                }
                HStack(spacing: 6) {
                    if let m = step.model { ModelChipView(id: m, source: step.source) }
                    if let eff = step.effort { Text("effort \(eff)").font(Typo.mono(10)).foregroundStyle(Neon.dim) }
                    if let d = duration { Text(d).font(Typo.mono(10)).foregroundStyle(Neon.dim) }
                    if let k = step.kind { Text(k).font(Typo.mono(10)).foregroundStyle(k == "proof" ? Neon.ok : Neon.cyan) }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .plate(edge: color, cut: 6, edgeOpacity: step.status == "running" ? 0.7 : 0.35)
    }

    private var phaseColor: Color {
        switch step.phase {
        case "link", "arm": return Neon.magenta
        case "verify": return Neon.ok.opacity(0.85)
        case "scan", "capture", "identify": return Neon.cyan
        default: return Neon.dim
        }
    }
}

struct EvidenceRow: View {
    var e: EvidencePayload
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(AppModel.sentence(for: e)).font(Typo.mono(12, weight: .semibold)).foregroundStyle(e.pass ? Neon.ok : Neon.fail)
                Spacer()
                if let a = e.attempt { Text("try \(a)").font(Typo.mono(10)).foregroundStyle(Neon.dim) }
            }
            if let o = e.observed, let m = o.metric {
                Text("\(o.sense ?? "sense") · \(m) · before \(fmt(o.before)) after \(fmt(o.after)) Δ \(fmt(o.delta)) (threshold \(fmt(o.threshold)))")
                    .font(Typo.mono(10)).foregroundStyle(Neon.dim)
            }
        }
        .padding(10).plate(edge: e.pass ? Neon.ok : Neon.fail, cut: 6, edgeOpacity: 0.45)
    }

    private func fmt(_ v: Double?) -> String { v.map { String(format: "%.3f", $0) } ?? "—" }
}
