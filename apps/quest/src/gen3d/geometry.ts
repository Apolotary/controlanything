/** Spec primitive → BufferGeometry. Dimensions in metres; cylinders/cones/capsules are +y up (rotate the part to face +z). */
import { BoxGeometry, BufferGeometry, CapsuleGeometry, ConeGeometry, CylinderGeometry, ExtrudeGeometry, LatheGeometry, PlaneGeometry, RingGeometry, Shape, SphereGeometry, TorusGeometry, Vector2 } from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Part } from '@ce/gen3d';

const DEG = Math.PI / 180;

export function buildGeometry(part: Part): BufferGeometry {
  const d = part.dims ?? {};
  const seg = d.segments;
  switch (part.shape) {
    case 'box': {
      const w = d.w ?? 0.04, h = d.h ?? 0.04, dd = d.d ?? 0.04;
      if (d.radius && d.radius > 0) return new RoundedBoxGeometry(w, h, dd, 3, Math.min(d.radius, Math.min(w, h, dd) / 2));
      return new BoxGeometry(w, h, dd);
    }
    case 'plane':
      return new PlaneGeometry(d.w ?? 0.1, d.h ?? 0.1);
    case 'cylinder': {
      const rTop = d.rTop ?? d.r ?? 0.02, rBottom = d.rBottom ?? d.r ?? 0.02;
      return new CylinderGeometry(rTop, rBottom, d.h ?? 0.02, seg ?? 32);
    }
    case 'cone':
      return new ConeGeometry(d.r ?? 0.02, d.h ?? 0.04, seg ?? 32);
    case 'sphere':
      return new SphereGeometry(d.r ?? 0.02, seg ?? 24, Math.max(8, Math.round((seg ?? 24) * 0.6)));
    case 'capsule':
      return new CapsuleGeometry(d.r ?? 0.01, d.h ?? 0.03, 6, seg ?? 16);
    case 'torus':
      return new TorusGeometry(d.r ?? 0.03, d.tube ?? 0.004, 10, seg ?? 48, (d.arcDeg ?? 360) * DEG);
    case 'ring': {
      const rOuter = d.rOuter ?? d.r ?? 0.03;
      const rInner = d.rInner ?? rOuter * 0.8;
      return new RingGeometry(rInner, rOuter, seg ?? 64, 1, (d.startDeg ?? 0) * DEG, (d.arcDeg ?? 360) * DEG);
    }
    case 'lathe': {
      const pts = (d.profile ?? [[0.02, 0], [0.02, 0.01]]).map(([x, y]) => new Vector2(Math.max(0, x!), y!));
      return new LatheGeometry(pts, seg ?? 48);
    }
    case 'extrude': {
      const prof = d.profile ?? [[-0.02, -0.02], [0.02, -0.02], [0.02, 0.02], [-0.02, 0.02]];
      const shape = new Shape();
      prof.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x!, y!) : shape.lineTo(x!, y!)));
      shape.closePath();
      return new ExtrudeGeometry(shape, { depth: d.depth ?? 0.01, bevelEnabled: false, curveSegments: 8 });
    }
    default:
      return new BoxGeometry(0.02, 0.02, 0.02);
  }
}

/** Rough half-extent of a primitive, for grab radii and the handle placement. */
export function roughRadius(part: Part): number {
  const d = part.dims ?? {};
  switch (part.shape) {
    case 'box':
    case 'plane':
      return Math.max(d.w ?? 0.04, d.h ?? 0.04) / 2;
    case 'cylinder':
      return Math.max(d.rTop ?? d.r ?? 0.02, d.rBottom ?? d.r ?? 0.02, (d.h ?? 0.02) / 2);
    case 'sphere':
    case 'cone':
      return d.r ?? 0.02;
    case 'capsule':
      return (d.h ?? 0.03) / 2 + (d.r ?? 0.01);
    case 'torus':
      return (d.r ?? 0.03) + (d.tube ?? 0.004);
    case 'ring':
      return d.rOuter ?? d.r ?? 0.03;
    case 'lathe':
      return Math.max(...(d.profile ?? [[0.02, 0]]).map(([x]) => Math.abs(x!)));
    case 'extrude':
      return Math.max(...(d.profile ?? [[0.02, 0.02]]).map(([x, y]) => Math.hypot(x!, y!)));
    default:
      return 0.02;
  }
}
