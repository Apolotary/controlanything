import type { AppMode } from './contract';

export function homeHint(mode: AppMode, tagged: number, cardOpen: boolean): string {
  if (mode === 'control') return cardOpen ? '' : 'Pinch a tagged device to open it';
  return tagged > 0 ? "Switch to Control when you're ready" : 'Pinch a device to tag it';
}

export function controlSegmentLabel(tagged: number): string {
  return tagged > 0 ? `Control · ${tagged}` : 'Control';
}
