declare module 'troika-three-text' {
  import { Mesh, BufferGeometry, Material, ColorRepresentation } from 'three';
  export class Text extends Mesh<BufferGeometry, Material> {
    text: string;
    font: string | null;
    fontSize: number;
    color: ColorRepresentation;
    anchorX: 'left' | 'center' | 'right';
    anchorY: 'top' | 'middle' | 'bottom';
    textAlign: 'left' | 'center' | 'right';
    maxWidth: number;
    whiteSpace: 'normal' | 'nowrap';
    textRenderInfo: { blockBounds: [number, number, number, number] } | null;
    lineHeight: number;
    letterSpacing: number;
    depthOffset: number;
    sync(callback?: () => void): void;
    dispose(): void;
  }
}
