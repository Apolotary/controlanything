/**
 * RESEARCH: curated data first (the stored chart or IR library, with provenance), then learned IR codes from
 * the device's own remote, then Muse Spark web_search as the fallback when nothing is stored.
 */
import type { DeviceCardPayload, Provenance } from '@ce/protocol';
import { allowedCcs, irBrief, matchMidiProfile, midiBrief, type Profiles } from '../devices/profiles';
import type { WebSearcher } from '../research/websearch';
import type { LinkCapability } from './link';
import type { LearnedCode, Research } from './types';

export const KOIZUMI_NOTE =
  'The KOIZUMI KRH-TG-9A remote has no public code set (checked Flipper-IRDB, IRDB, LIRC, SmartIR, blogs). ' +
  'Its codes must be learned from the remote with an IR receiver; the library codes of other makers are only a long-shot fallback.';

export interface ResearchDeps {
  profiles: Profiles;
  web: WebSearcher;
}

export async function research(
  deps: ResearchDeps,
  card: DeviceCardPayload,
  cap: LinkCapability | undefined,
  opts: { learned?: LearnedCode[]; signal?: AbortSignal; allowWeb?: boolean } = {},
): Promise<Research> {
  const provenance: Provenance[] = [];
  if (cap === 'midi') {
    const profile = matchMidiProfile(deps.profiles, card);
    if (profile) {
      provenance.push({ source: 'curated', ref: `apps/server/data/devices/${profile.id}.json`, note: profile.sources[0]?.url });
      for (const s of profile.sources.slice(0, 3)) provenance.push({ source: 'manual', ref: s.url, note: s.title.slice(0, 200) });
      return { brief: midiBrief(profile), provenance, profile, allowedCcs: allowedCcs(profile) };
    }
    if (opts.allowWeb === false) return { brief: `No stored MIDI chart for ${card.maker} ${card.model}.`, provenance };
    const q = `${card.maker} ${card.model} MIDI implementation chart: incoming CC numbers, parameter names, channel rules, USB MIDI port name`;
    const w = await deps.web.research(q, { signal: opts.signal });
    for (const c of w.citations.slice(0, 6)) provenance.push({ source: 'web_search', ref: c.url, note: c.title?.slice(0, 200) });
    return { brief: w.text, provenance, modelId: w.model };
  }
  if (cap === 'ir') {
    const lib = deps.profiles.ir;
    const parts: string[] = [];
    if (opts.learned?.length) {
      provenance.push({ source: 'learned', ref: `learned:${card.cardId}`, note: `${opts.learned.length} codes captured from the device's own remote` });
      parts.push(
        `Learned codes from the device's own remote (replay these; each id becomes an action with encode {kind:"ir", protocol:"RAW", ref:"learned:<id>"}):`,
        ...opts.learned.map((l) => `  learned:${l.learnId}: button "${l.button}" (hypothesis ${l.hypothesis}${l.seen ? `, camera saw ${l.seen}` : ''}); ${l.protocol ?? 'UNKNOWN'}${l.bytes ? ` bytes ${l.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}` : ''}, ${l.rawUs.length} timings`),
      );
    }
    if (lib && !opts.learned?.length) {
      provenance.push({ source: 'curated', ref: 'apps/server/data/devices/jp-ceiling-light-ir.json' });
      parts.push(irBrief(lib));
    } else if (opts.learned?.length) {
      parts.push('Use ONLY the learned codes above (one action per learned code, plus a "set" brightness action over brighter/dimmer when both exist). Do not add codes from any brand library: this remote is not in it.');
    }
    if (/koizumi/i.test(`${card.maker} ${card.model} ${card.notes ?? ''}`)) parts.push(KOIZUMI_NOTE);
    return { brief: parts.join('\n'), provenance, irLibrary: lib, learned: opts.learned };
  }
  if (cap === 'local') {
    provenance.push({ source: 'curated', ref: 'builtin:local-ops', note: 'Mac: volume (osascript), Music play/pause, say; iPhone: torch, haptic, screen; DevTerm: print, beep' });
    return { brief: 'Local executor ops: volume 0-100 ("$value"), music play|pause|playpause|next|prev, say <text>; iPhone torch/haptic/screen; DevTerm print/beep.', provenance };
  }
  return { brief: `No control path is known for ${card.name}.`, provenance };
}
