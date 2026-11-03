/**
 * ControlAnything's shared spatial look (WP3). Import from here for any new in-headset surface so every lane reads
 * as one product: Meta Horizon OS widgets (pmndrs uikit-horizon, dark scheme), Google XR Blocks' grayGlass plate,
 * the inspiration video's "white = on" pills, Lucide icons. Units for uikit sizes are millimetres
 * (pixelSize 0.001), so `sizeX: 0.34` metres = 340 px wide.
 *
 *   import { LOOK, glassPanel, pill, setPillText, HorizonButton, icon } from '../hud/v2/look';
 *   const panel = glassPanel({ width: 0.30 });            // dark rounded plate, one transparent layer
 *   panel.add(pill('MacBook', 'light'));                   // white pill with dark text
 *   scene.add(panel); each frame: panel.update(dtMs)       // or spatial.addUiRoot(panel, () => visible)
 *
 * Draw-order rule: give each world surface its own `renderOrder` from LOOK.render (or above) and keep
 * `depthTest: false, depthWrite: false` on HUD surfaces: transparent layers must never depth-sort against each other.
 */
import { Color, MeshBasicMaterial } from 'three';
import { Container, Text, setPreferredColorScheme, withOpacity, type ContainerProperties } from '@pmndrs/uikit';
import { Button, ButtonIcon, ButtonLabel, Panel } from '@pmndrs/uikit-horizon';
import { Check, Circle, Hand, Keyboard, Link, Mic, RotateCcw, Sparkles, Square, Triangle, Waves, X, Eye, Box, Gamepad2, Power } from '@pmndrs/uikit-lucide';
import { LOOK } from './theme';
export { LOOK } from './theme';
export { Button as HorizonButton, ButtonIcon, ButtonLabel, Panel } from '@pmndrs/uikit-horizon';

export const isBrowser = typeof document !== 'undefined';
if (isBrowser) setPreferredColorScheme('dark');

/** A small, tree-shaken icon set (Lucide, ISC). Add names here rather than importing the whole pack. */
export const ICONS = {
  hand: Hand, stop: Square, waves: Waves, rings: Circle, prism: Triangle, setup: Sparkles, cancel: X, retry: RotateCcw,
  link: Link, keyboard: Keyboard, check: Check, mic: Mic, eye: Eye, box: Box, gamepad: Gamepad2, power: Power,
} as const;
export type IconName = keyof typeof ICONS;
export function icon(name: IconName, size = 24): InstanceType<(typeof ICONS)[IconName]> {
  return new ICONS[name]({ width: size, height: size });
}

/** Google XR Blocks grayGlass gradient (top → bottom) for card plates. Opaque enough to read over a bright room. */
export class GrayGlassMaterial extends MeshBasicMaterial {
  constructor() {
    super();
    this.customProgramCacheKey = () => 'ce-grayglass-v1';
    const top = new Color(LOOK.plate.top), bottom = new Color(LOOK.plate.bottom);
    this.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n#define USE_UV');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n#define USE_UV')
        .replace('#include <opaque_fragment>', `{
          vec3 grad = mix(vec3(${bottom.r}, ${bottom.g}, ${bottom.b}), vec3(${top.r}, ${top.g}, ${top.b}), clamp(vUv.y, 0.0, 1.0));
          gl_FragColor = vec4(grad, diffuseColor.a);
        }`);
    };
  }
}
/** Flat fills for pills and buttons (Horizon's own colours). */
export const FlatMaterial = MeshBasicMaterial;

/** A root card plate. Pass `width` in metres; content uses px (= mm). Call `update(dtMs)` every frame. */
export function glassPanel(options: { width: number; height?: number; renderOrder?: number; padding?: number; gap?: number } & Partial<ContainerProperties> = { width: 0.34 }): Panel {
  const { width, height, renderOrder, padding, gap, ...rest } = options;
  return new Panel({
    sizeX: width, ...(height ? { sizeY: height } : {}), pixelSize: LOOK.pixelSize, anchorY: 'top',
    flexDirection: 'column', padding: padding ?? LOOK.card.padding, gap: gap ?? LOOK.card.gap, borderRadius: LOOK.plate.radius,
    backgroundColor: withOpacity('#ffffff', LOOK.plate.alpha), panelMaterialClass: GrayGlassMaterial,
    borderWidth: 1.5, borderColor: withOpacity(LOOK.plate.rim, LOOK.plate.rimAlpha),
    renderOrder: renderOrder ?? LOOK.render.card, depthTest: false, depthWrite: false, color: LOOK.text.primary,
    ...rest,
  } as never);
}

/** The inspiration's label pill: 'light' = white with dark text (selected / on), 'dark' = glass with white text. */
export function pill(text: string, tone: 'light' | 'dark' = 'light', extra: Partial<ContainerProperties> = {}): Container {
  const box = new Container({
    flexDirection: 'row', alignItems: 'center', gap: 6, height: LOOK.pill.height, paddingX: 12, borderRadius: 1000,
    backgroundColor: tone === 'light' ? LOOK.pill.light : LOOK.pill.dark, panelMaterialClass: FlatMaterial, flexShrink: 0,
    ...extra,
  } as never);
  box.add(new Text({ text, fontSize: LOOK.pill.fontSize, fontWeight: 'semi-bold', color: tone === 'light' ? LOOK.text.onLight : LOOK.text.primary, whiteSpace: 'nowrap' } as never));
  box.userData.tone = tone;
  return box;
}
export function setPillText(box: Container, text: string): void {
  const label = box.children.find((child): child is Text => child instanceof Text);
  label?.setProperties({ text });
}

/** A Horizon pill button with an optional icon. `variant: 'primary'` is the white "on" state. */
export function horizonButton(label: string, options: { icon?: IconName; variant?: 'primary' | 'secondary'; size?: 'lg' | 'sm'; onClick?: () => void } & Partial<ContainerProperties> = {}): Button {
  const { icon: iconName, variant, size, onClick, ...rest } = options;
  const button = new Button({ variant: variant ?? 'secondary', size: size ?? 'lg', panelMaterialClass: FlatMaterial, gap: 6, ...(onClick ? { onClick } : {}), ...rest } as never);
  if (iconName) { const holder = new ButtonIcon(); holder.add(icon(iconName, size === 'sm' ? 16 : 20)); button.add(holder); }
  if (label) { const labelBox = new ButtonLabel(); labelBox.add(new Text({ text: label, whiteSpace: 'nowrap' } as never)); button.add(labelBox); }
  return button;
}

/** xrblocks FollowHead: frame-rate-independent lazy follow factor (k ≈ 0.1 per 60 Hz frame). */
export function followAlpha(dtSeconds: number, k = 0.1): number { return 1 - Math.exp(-k * Math.min(0.1, Math.max(0, dtSeconds)) * 60); }
/** xrblocks VisibilityTransition: 0.92 → 1 scale over 0.3 s (ease-out). */
export function appearScale(elapsedS: number): number {
  const t = Math.min(1, Math.max(0, elapsedS / LOOK.motion.appearS));
  return 0.92 + 0.08 * (1 - (1 - t) ** 3);
}
