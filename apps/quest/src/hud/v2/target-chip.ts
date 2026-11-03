import type { AppMode, HudTarget } from '../contract';

type ChipTarget = Pick<HudTarget, 'label' | 'tagged' | 'identifying' | 'busy' | 'connection' | 'locating'> & { rawLabel?: string };

/** Tag intent and connection state use the same words on every target chip. */
export function targetChipLabel(target: ChipTarget, mode: AppMode, hovered = false): string {
  const rawName = target.label.trim();
  const name = rawName.length > 18 ? `${rawName.slice(0, 17).trimEnd()}…` : rawName;
  // The Mac's screen is the demo device: its hover pill says what a pinch does.
  if (/\b(laptop|macbook|monitor|computer)\b|visual[\s-]?synth/i.test(`${target.rawLabel ?? ''} ${rawName}`) && (!target.tagged || mode === 'annotate')) {
    return hovered ? 'MacBook · pinch to control' : target.tagged ? '✓ MacBook' : 'MacBook';
  }
  if (!target.tagged) return hovered ? `${name} · Pinch to tag` : name;
  if (target.locating) return `${name} · Locating…`;
  if (mode === 'annotate') {
    if (hovered) return 'Pinch to untag';
    return `✓ ${name}${target.identifying ? ' · Identifying…' : ''}`;
  }
  const status = target.connection === 'ready' ? 'Ready'
    : target.connection === 'setup' ? target.busy ? 'Setting up…' : 'Needs setup'
    : 'Not connected';
  return `✓ ${name} · ${status}`;
}
