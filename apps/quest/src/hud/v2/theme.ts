import regular from '@fontsource/inter/files/inter-latin-500-normal.woff';
import semibold from '@fontsource/inter/files/inter-latin-600-normal.woff';

/** All v2 appearance values live here. Distances are metres at a one-metre reading distance. */
export const THEME = {
  color: { line: '#eeeeea', text: '#f5f5f0', muted: '#b7bcb9', plate: '#161b1d', button: '#343c3d', accent: '#a9c8bd', disabled: '#717b79' },
  opacity: { line: 0.8, plate: 0.9 },
  font: { regular, semibold, label: 0.016, body: 0.018, title: 0.022, detail: 0.014, lineHeight: 1.3 },
  box: { max: 24, corner: 0.012, cornerSteps: 3, minSize: 0.04, defaultWidth: 0.24, defaultHeight: 0.16, labelGap: 0.018 },
  card: { width: 0.34, height: 0.25, radius: 0.012, padding: 0.02, gap: 0.04, distance: 0.9, titleY: 0.092, statusY: 0.058, mainY: 0.012, buttonsY: -0.044, detailsY: -0.096 },
  control: { width: 0.3, height: 0.04, buttonWidth: 0.09, buttonGap: 0.012, trackHeight: 0.005, thumbWidth: 0.014, radius: 0.008, near: 0.055, hitPadding: 0.004, rayDistance: 4, dragHz: 15, holdMs: 600, labelOffset: 0.025 },
  panel: { width: 0.38, height: 0.24, gap: 0.025, row: 0.045, textWidth: 0.33, headY: -0.14, toastY: -0.27, depth: 0.001, detailHeight: 0.32, detailLines: 10 },
  render: { boxes: 10, plates: 20, text: 21 },
  limits: { drawCalls: 120, triangles: 60_000, textChars: 280, logs: 8, evidence: 4 },
} as const;
