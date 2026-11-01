/**
 * Visual tokens for the HUD: a holographic hack-interface look that stays legible over passthrough.
 * Palette and contrast ratios from the creative-director brief (research/15-cyberdeck-design.md).
 *
 * Two absolute rules: every neon stroke sits on a void keyline (3 mm neon over 5 mm void), and every
 * piece of text sits on a plate (>= 90 % alpha). Nothing flashes faster than 3 Hz.
 */
export const NEON = {
  /** perception: scan outlines, ping lines, idle HUD (12.8:1 on plate) */
  cyan: '#38F0FF',
  /** intent: lock brackets, selected item, upload progress, hand cursor (16.2:1) */
  volt: '#EEFF41',
  /** power / persistent: link, daemons; strokes and >= 12 mm text only (5.7:1) */
  magenta: '#FF3DBE',
  /** oracle verdicts only: the camera / mic said so */
  ok: '#5CFFA3',
  fail: '#FF5A3C',
  /** primary text (16.6:1 on plate) */
  bone: '#F3F7FA',
  /** secondary text (6.9:1) */
  dim: '#8FA3B3',
  /** plates and keylines; plates at >= 90 % alpha */
  void: '#0A0E12',
  plate: '#101820',
  /** holo surface base tint */
  holo: '#0C2630',
  // aliases kept for readability in the archetype code
  yellow: '#EEFF41',
  green: '#5CFFA3',
  red: '#FF5A3C',
  violet: '#FF3DBE',
  text: '#F3F7FA',
  panel: '#101820',
  ink: '#0A0E12',
} as const;
export type NeonToken = keyof typeof NEON;

/** Default accents for a device that has none of its own: cycled per control (never ok/fail: those are verdicts). */
export const DEFAULT_ACCENTS: readonly string[] = [NEON.cyan, NEON.volt, NEON.magenta, '#7FD8FF', '#FFB36B'];

/** Status → colour, shared by tags, work logs, hack lists and the link matrix. */
export const STATUS_COLOR: Record<string, string> = {
  idle: NEON.dim,
  pending: NEON.dim,
  paused: NEON.dim,
  scanned: NEON.cyan,
  ready: NEON.cyan,
  candidate: NEON.volt,
  locked: NEON.volt,
  pinging: NEON.volt,
  running: NEON.volt,
  queued: NEON.volt,
  uploading: NEON.volt,
  live: NEON.volt,
  linking: NEON.magenta,
  linked: NEON.magenta,
  verified: NEON.ok,
  controlled: NEON.ok,
  ok: NEON.ok,
  done: NEON.ok,
  hypothesis: NEON.dim,
  requested: NEON.volt,
  awaiting: NEON.volt,
  'no-reaction': NEON.fail,
  refused: NEON.fail,
  offline: NEON.fail,
  killed: NEON.fail,
  failed: NEON.fail,
  fail: NEON.fail,
  error: NEON.fail,
};

export function statusColor(status: string | undefined, fallback: string = NEON.cyan): string {
  return (status && STATUS_COLOR[status]) || fallback;
}

/** Fonts (all OFL): labels, readouts/hex/values, Japanese. Loaded by the renderer; canvas falls back to system sans/mono. */
export const FONTS = {
  label: "'Chakra Petch', 'DM Sans', 'Helvetica Neue', Arial, sans-serif",
  mono: "'Share Tech Mono', 'JetBrains Mono', Menlo, monospace",
  jp: "'Noto Sans JP', 'Hiragino Sans', sans-serif",
} as const;
