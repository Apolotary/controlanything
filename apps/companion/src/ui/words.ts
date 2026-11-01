/**
 * Copy rules (creative direction §3.7): state is written in words, "sent" never "done", only an oracle
 * verdict is success, no percentages that are not measurements.
 */
import type { Evidence, ExecOp, LinkResultPayload } from '@ce/protocol';
import { describeTimings } from '../irCodec';
import { toHex } from '../midiDecode';

export function opSummary(op: ExecOp): string {
  if (op.kind === 'midi') {
    switch (op.msg) {
      case 'cc':
        return `CC ${op.number} → ${op.value}`;
      case 'note':
        return `note ${op.number}`;
      case 'pc':
        return `program ${op.number}`;
      case 'sysex-identity':
        return 'identity request';
      case 'panic':
        return 'panic';
    }
  }
  if (op.kind === 'ir') {
    if (op.ref) return op.ref.replace(/^(lib|learned):/, '');
    if (op.bytes?.length) return `${op.protocol} ${toHex(op.bytes)}`;
    return op.rawUs ? describeTimings(op.rawUs) : op.protocol;
  }
  return op.arg !== undefined && typeof op.arg !== 'object' ? `${op.op} ${String(op.arg)}` : op.op;
}

/** "heard" / "seen" / "wired" for the verdict word. */
export function senseWord(sense: string): string {
  return sense === 'audio' ? 'heard' : sense === 'camera' ? 'seen' : 'wired';
}

/** What the measurement says, in words with the measured number. */
export function observedPhrase(e: Evidence): string {
  const o = e.observed;
  const rel = o.before !== 0 ? (o.after - o.before) / Math.abs(o.before) : 0;
  switch (o.metric) {
    case 'centroid': {
      if (o.before > 0 && o.after > 0) {
        const oct = Math.log2(o.after / o.before);
        if (Math.abs(oct) < 0.05) return 'no change';
        return `tone ${oct > 0 ? 'up' : 'down'} ${Math.abs(oct).toFixed(2)} oct`;
      }
      return `centroid Δ ${o.delta.toFixed(2)}`;
    }
    case 'rms':
      return Math.abs(o.delta) < 0.5 ? 'no change' : `${o.delta > 0 ? 'louder' : 'quieter'} ${Math.abs(o.delta).toFixed(1)} dB`;
    case 'luma-mask-vs-ring': {
      const pct = Math.round(Math.abs(rel) * 100);
      return pct < 1 ? 'no change' : `light got ${pct} % ${rel > 0 ? 'brighter' : 'darker'}`;
    }
    case 'rb-ratio': {
      const pct = Math.round(Math.abs(rel) * 100);
      return pct < 1 ? 'no change' : `light got ${pct} % ${rel > 0 ? 'warmer' : 'cooler'}`;
    }
    case 'ack':
      return o.after >= 1 ? 'acknowledged' : 'no ack';
    default:
      return o.note ?? '—';
  }
}

/** "sent CC 46 → 97 → tone up 0.62 oct · heard ✓" / "sent IR koizumi/dimmer → no change ✗". */
export function evidenceSentence(e: Evidence): { text: string; pass: boolean; verdict: string } {
  const negative = e.expected.effect === 'none';
  const what = opSummary(e.sent.op);
  const obs = observedPhrase(e);
  if (negative) {
    // a negative control passes when nothing changed
    return e.pass
      ? { text: `sent ${what} → no change (negative control)`, pass: true, verdict: `${senseWord(e.observed.sense)} nothing ✓` }
      : { text: `sent ${what} → ${obs}, but nothing should have changed`, pass: false, verdict: 'control failed ✗' };
  }
  return e.pass ? { text: `sent ${what} → ${obs}`, pass: true, verdict: `${senseWord(e.observed.sense)} ✓` } : { text: `sent ${what} → ${obs === '—' ? 'no change' : obs}`, pass: false, verdict: 'no reaction ✗' };
}

/** "USB · Teenage Engineering OP-1 Field" style proof for a link verdict. */
export function linkProof(r: LinkResultPayload): { proven: boolean; text: string } {
  const proven = r.verdict === 'confirmed' || r.verdict === 'consistent';
  const parts = r.evidence.map((x) => `${x.ok ? '✓' : '✗'} ${x.detail}`);
  const channel = r.channel ? r.channel.toUpperCase() : 'LINK';
  return { proven, text: `${channel} · ${r.verdict}${r.port ? ` · ${r.port.name}` : ''}${parts.length ? ` · ${parts.join(' · ')}` : ''}` };
}

/** Development clients (simulators, mocks, emulators, test nodes) stay out of stage-mode takes. */
const DEV_NAME = /\(sim\)|\bsim\b|mock|emulator|\btest\b/i;
export function isDevDevice(d: { kind: string; name: string }): boolean {
  return d.kind === 'sim' || DEV_NAME.test(d.name);
}
