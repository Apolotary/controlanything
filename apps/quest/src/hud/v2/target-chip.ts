import type { AppMode, HudTarget } from '../contract';

type ChipTarget = Pick<HudTarget, 'label' | 'tagged' | 'identifying' | 'busy' | 'connection'>;

/** Tag intent and connection state use the same words on every target chip. */
export function targetChipLabel(target: ChipTarget, mode: AppMode, hovered = false): string {
  const name = target.label.trim();
  if (!target.tagged) return name;
  if (mode === 'annotate') {
    if (hovered) return 'Pinch to untag';
    return `✓ ${name}${target.identifying ? ' · Identifying…' : ''}`;
  }
  const status = target.connection === 'ready' ? 'Ready'
    : target.connection === 'setup' ? target.busy ? 'Setting up…' : 'Needs setup'
    : 'Not connected';
  return `✓ ${name} · ${status}`;
}
