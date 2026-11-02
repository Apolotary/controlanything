/**
 * Copy rules (creative direction §3.7): state is written in words, "sent" never "done", only an oracle
 * verdict is success, no percentages that are not measurements.
 */
import type { AgentPhase, Evidence, ExecOp, LinkResultPayload } from '@ce/protocol';
import { describeTimings } from '../irCodec';
import { toHex } from '../midiDecode';
import { PRODUCT_NAME } from './product';

const phaseNames: Record<AgentPhase, string> = {
  capture: 'Looking at the room',
  scan: 'Scanning',
  identify: 'Identifying',
  link: 'Connecting',
  research: 'Reading instructions',
  plan: 'Planning controls',
  drive: 'Writing driver',
  codegen: 'Writing driver',
  verify: 'Checking',
  forge: 'Making controls',
  arm: 'Enable controls',
  deploy: 'Controls ready',
  ui: 'Making controls',
  control: 'Updating device',
  other: 'Working',
};

/** Display labels stay separate from protocol phase names. */
export function agentPhaseName(phase: AgentPhase): string {
  return phaseNames[phase];
}

/** Translate display prose only; callers keep raw code, IDs and protocol payloads separate. */
export function companionText(text: string): string {
  const friendly = text
    .replace(/\bControlEverything(?:\s+workbench)?\b/gi, PRODUCT_NAME)
    .replace(/\b(?:hack\s*set|hackset) ready:\s*(\d+) hacks? \((\d+) controls?\)/gi, (_, controls: string, sliders: string) => `Control set ready: ${controls} ${controls === '1' ? 'control' : 'controls'} (${sliders} ${sliders === '1' ? 'slider' : 'sliders'})`)
    .replace(/\bnot armed\s*[·:]?\s*no confirmation in time(?: from the headset)?/gi, 'Not enabled · No confirmation in time from the headset')
    .replace(/\bpanic\s*[·:]\s*all off\b/gi, 'Stop all')
    .replace(/\b(\d+)\s*\/\s*(\d+)\s+armed\b/gi, '$1 of $2 enabled')
    .replace(/\blocal linked\b/gi, 'Local connected')
    .replace(/\bcamera says\b/gi, 'Seen by camera:')
    .replace(/\b(?:hack\s*set|hackset)\b/gi, 'control set')
    .replace(/\bhacks\b/gi, 'controls')
    .replace(/\bhack\b/gi, 'control')
    .replace(/\bdisarmed\b/gi, 'disabled')
    .replace(/\barmed\b/gi, 'enabled')
    .replace(/\barming\b/gi, 'enabling')
    .replace(/\barm\b/gi, 'enable')
    .replace(/\bpanic\b/gi, 'stop all')
    .replace(/\bforge\b/gi, 'making controls')
    .replace(/\bforging\b/gi, 'making controls')
    .replace(/\bforged\b/gi, 'controls ready')
    .replace(/\bverify\b/gi, 'checking')
    .replace(/\bdeploy\b/gi, 'controls ready')
    .replace(/\btape\b/gi, 'recording');
  const firstWord = friendly.match(/^\S+/)?.[0] ?? '';
  return /[-._\d]/.test(firstWord) ? friendly : friendly.charAt(0).toUpperCase() + friendly.slice(1);
}

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
        return 'Stop all';
    }
  }
  if (op.kind === 'ir') {
    if (op.ref) return op.ref.replace(/^(lib|learned):/, '');
    if (op.bytes?.length) return `${op.protocol} ${toHex(op.bytes)}`;
    return op.rawUs ? describeTimings(op.rawUs) : op.protocol;
  }
  return op.arg !== undefined && typeof op.arg !== 'object' ? `${op.op} ${String(op.arg)}` : op.op;
}

/** Human-readable sense for the check verdict. */
export function senseWord(sense: string): string {
  return sense === 'audio' ? 'Heard' : sense === 'camera' ? 'Seen' : 'Checked';
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
      ? { text: `Sent ${what} → no change (negative control)`, pass: true, verdict: `${senseWord(e.observed.sense)} nothing ✓` }
      : { text: `Sent ${what} → ${obs}, but nothing should have changed`, pass: false, verdict: 'Control failed ✗' };
  }
  return e.pass ? { text: `Sent ${what} → ${obs}`, pass: true, verdict: `${senseWord(e.observed.sense)} ✓` } : { text: `Sent ${what} → ${obs === '—' ? 'no change' : obs}`, pass: false, verdict: 'No reaction ✗' };
}

/** "USB · Teenage Engineering OP-1 Field" style proof for a link verdict. */
export function linkProof(r: LinkResultPayload): { proven: boolean; text: string } {
  const proven = r.verdict === 'confirmed' || r.verdict === 'consistent';
  const parts = r.evidence.map((x) => `${x.ok ? '✓' : '✗'} ${companionText(x.detail)}`);
  const channel = r.channel ? r.channel === 'local' ? 'Local' : r.channel.toUpperCase() : 'Connection';
  return { proven, text: `${channel} · ${r.verdict}${r.port ? ` · ${r.port.name}` : ''}${parts.length ? ` · ${parts.join(' · ')}` : ''}` };
}

/** Development clients (simulators, mocks, emulators, test nodes) stay out of stage-mode takes. */
const DEV_NAME = /\(sim\)|\bsim\b|mock|emulator|\btest\b/i;
export function isDevDevice(d: { kind: string; name: string }): boolean {
  return d.kind === 'sim' || DEV_NAME.test(d.name);
}
