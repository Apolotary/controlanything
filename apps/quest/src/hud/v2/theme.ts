/** All v2 appearance values live here. Distances are metres at a one-metre reading distance. */
export const THEME = {
  // Horizon neutrals (LOOK): white text, secondary = white 64 % over the grayGlass plate (#A1A1A6), plate = its middle tone.
  color: { line: '#F8FAFC', text: '#FFFFFF', muted: '#A1A1A6', plate: '#222229', button: '#FFFFFF', stroke: '#FFFFFF', accent: '#38BDF8', disabled: '#94A3B8' },
  opacity: { line: 0.8, plate: 0.84, stroke: 0.16, accentSoft: 0.18 },
  surface: { stroke: 0.0006, buttonOpacity: 0.08 },
  font: {
    regular: '/quest/fonts/inter-latin-400-normal.woff',
    medium: '/quest/fonts/inter-latin-500-normal.woff',
    semibold: '/quest/fonts/inter-latin-600-normal.woff',
    tabular: '/quest/fonts/ce-inter-tabular-600.woff',
    mono: '/quest/fonts/JetBrainsMono-Regular.ttf',
    // Inter's cap height is .7275 em: these yield 18 mm titles and 12 mm body text.
    label: 0.0165, body: 0.0165, title: 0.025, detail: 0.015, lineHeight: 1.25, letterSpacing: -0.012,
  },
  box: { max: 24, stroke: 0.0009, activeStroke: 0.0012, corner: 0.0072, cornerSteps: 5, minSize: 0.04, defaultWidth: 0.24, defaultHeight: 0.16, labelGap: 0.12, labelHeight: 0.07, labelPadding: 0.012 },
  card: { width: 0.4, height: 0.32, radius: 0.012, padding: 0.02, gap: 0.035, distance: 0.65, dockDistance: 0.65, maxTargetDistance: 1.2, maxTargetHeight: 0.4, titleY: 0.105, statusY: 0.066, mainY: -0.015, buttonsY: -0.073, detailsY: -0.128, progressY: 0.042, progressHeight: 0.0024, chipWidth: 0.095, chipHeight: 0.025, chipX: 0.1325 },
  control: { width: 0.36, height: 0.036, buttonHeight: 0.048, minHitSize: 0.048, buttonWidth: 0.112, buttonGap: 0.012, trackHeight: 0.005, thumbWidth: 0.014, radius: 0.018, near: 0.055, hitPadding: 0.004, pokeRelease: 0.012, rayDistance: 4, dragHz: 15, holdMs: 600, labelOffset: 0.03, knobDiameter: 0.044, knobTick: 0.007 },
  reticle: { diameter: 0.0168, radius: 0.0084, stroke: 0.0009, dotRadius: 0.0024, segments: 24, distance: 1 },
  motion: { duration: 0.18 },
  panel: { width: 0.38, height: 0.24, gap: 0.025, row: 0.056, textWidth: 0.33, headY: -0.14, toastY: -0.34, depth: 0.001, detailHeight: 0.32, detailLines: 8 },
  render: { boxes: 10, plates: 20, buttons: 22, text: 24 },
  limits: { drawCalls: 120, triangles: 60_000, textChars: 280, logs: 8, evidence: 4 },
} as const;

/**
 * WP3 look: Meta Horizon OS widgets (pmndrs uikit-horizon, dark scheme) with Google XR Blocks' grayGlass
 * tokens and the inspiration video's white = on. Units for `px` values are millimetres (uikit pixelSize 0.001).
 * Layers draw in a fixed order and never depth-sort against each other: device ring < dials < labels < card.
 */
export const LOOK = {
  pixelSize: 0.001,
  plate: { top: '#2F2F37', bottom: '#16161B', alpha: 0.94, rim: '#FFFFFF', rimAlpha: 0.18, radius: 28 },
  text: { primary: '#FFFFFF', secondary: 'rgba(255,255,255,0.64)', onLight: '#121216' },
  card: { width: 340, padding: 20, gap: 14, toggle: 64, titleSize: 22, subtitleSize: 15 },
  pill: { height: 30, fontSize: 14, light: '#FFFFFF', dark: 'rgba(255,255,255,0.10)' },
  dial: { sweepDeg: 110, track: 0.016, knob: 0.0135, gap: 0.03, minW: 0.18, maxW: 0.7, minH: 0.12, maxH: 0.45, trackAlpha: 0.26, smoothing: 14 },
  ring: { stroke: 0.0035, margin: 0.035, radius: 0.03, ticks: 5, pulseS: 0.9, sweepS: 2.4 },
  hand: { clutchRadius: 0.055, valueRadius: 0.032 },
  render: { ring: 26, dials: 27, labels: 28, card: 30, hands: 101 },
  motion: { appearS: 0.3, ackMs: 700 },
} as const;
