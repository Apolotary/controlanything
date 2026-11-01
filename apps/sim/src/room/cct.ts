/**
 * Colour temperature -> linear RGB multipliers for the lamp layer, as the sim camera sees them.
 *
 * Blackbody colour from Tanner Helland's fit (sRGB 0-255), decoded to linear light, white-balanced for a camera
 * fixed at 5000 K (no auto white balance, so warm light looks warm), normalised to luminance 1 (colour keys
 * change hue, not brightness) and pulled 15 % back toward neutral.
 */
export type Rgb = [number, number, number];

const srgbToLinear = (c: number) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};

export function blackbodySrgb(k: number): Rgb {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (x: number) => Math.max(0, Math.min(255, x));
  return [c(r), c(g), c(b)];
}

export const luma = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const WB = blackbodySrgb(5000).map(srgbToLinear) as Rgb;
const CHROMA = 0.85;

export function cctToRgb(k: number): Rgb {
  const lin = blackbodySrgb(k).map(srgbToLinear) as Rgb;
  const wb: Rgb = [lin[0] / WB[0], lin[1] / WB[1], lin[2] / WB[2]];
  const y = luma(wb);
  const n: Rgb = [wb[0] / y, wb[1] / y, wb[2] / y];
  return [1 + CHROMA * (n[0] - 1), 1 + CHROMA * (n[1] - 1), 1 + CHROMA * (n[2] - 1)];
}

/** The night LED: a small amber spot (about 2000 K), luminance 1. */
export const NIGHT_RGB: Rgb = (() => {
  const c: Rgb = [1.0, 0.5, 0.16];
  const y = luma(c);
  return [c[0] / y, c[1] / y, c[2] / y];
})();
