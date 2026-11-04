import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { AUTO_SCREEN, ScreenTouchFinder, autoScreenPlane, confirmPlane, planeCentre } from './screen-auto';
import { projectOnPlane } from './screen-plane';
import { makeGestureFrame, moveHand } from './fixtures.test-support';

const head = new Vector3(0, 1.6, 0);
const tipFrame = (tip: Vector3) => {
  const f = makeGestureFrame('open_palm', 'point'); delete f.hands.left;
  moveHand(f.hands.right!, tip.x, tip.y, tip.z + 0.14); f.head.position.copy(head); f.head.quaternion.copy(new Quaternion());
  return f;
};

describe('automatic screen plane', () => {
  it('faces the wearer, leans back like a lid, and hangs the display under the top of the outline', () => {
    // A laptop box 0.3 m tall around (0, 1.35, -0.6): lid top 0.15 m above its centre.
    const contour: [number, number][] = [[-0.16, -0.15], [0.16, -0.15], [0.16, 0.15], [-0.16, 0.15]];
    const facing = head.clone().sub(new Vector3(0, 1.35, -0.6)).normalize();
    const plane = autoScreenPlane({ position: new Vector3(0, 1.35, -0.6), label: 'laptop', facing, contour, measured: true }, head);
    expect(plane).toMatchObject({ auto: true, confirmed: false, width: AUTO_SCREEN.laptop.width, height: AUTO_SCREEN.laptop.height });
    expect(plane.normal[2]).toBeGreaterThan(0.9); expect(plane.normal[1]).toBeGreaterThan(0.1); // toward the wearer, tilted up
    const centre = planeCentre(plane);
    expect(centre.y).toBeGreaterThan(1.35); expect(centre.y).toBeLessThan(1.45); // above the hinge-level box centre
    expect(Math.abs(centre.x)).toBeLessThan(0.01);
  });

  it('the first touch moves the plane along the line of sight through the fingertip and keeps it inside', () => {
    const plane = autoScreenPlane({ position: new Vector3(0, 1.4, -0.5), label: 'MacBook', measured: true }, head);
    const tip = new Vector3(0.02, 1.43, -0.62);
    const found = confirmPlane(plane, tip, head);
    const at = projectOnPlane(found, tip);
    expect(Math.abs(at.distance)).toBeLessThan(1e-6); expect(at.inside).toBe(true);
    expect(found.confirmed).toBe(true);
    // the centre stays on the line of sight SAM measured
    const before = planeCentre(plane).sub(head).normalize(), after = planeCentre(found).sub(head).normalize();
    expect(before.angleTo(after)).toBeLessThan(0.02);
    // a touch just past the guessed edge slides the screen so the touch is inside
    const edge = confirmPlane(plane, new Vector3(0.2, 1.43, -0.6), head);
    expect(projectOnPlane(edge, new Vector3(0.2, 1.43, -0.6)).u).toBeCloseTo(1 - AUTO_SCREEN.margin, 3);
  });

  it('a fingertip must come to rest within the zone; moving through the air is not a touch', () => {
    const plane = autoScreenPlane({ position: new Vector3(0, 1.4, -0.5), label: 'laptop', measured: true }, head);
    const finder = new ScreenTouchFinder();
    let t = 0;
    finder.update(tipFrame(new Vector3(-0.5, 1.2, -0.3)), t += 16, plane); // first seen away from the screen
    // resting far in front of the guess (35 cm) does not count
    for (let i = 0; i < 30; i++) expect(finder.update(tipFrame(new Vector3(0, 1.5, -0.2)), t += 16, plane)).toBeNull();
    // waving sideways 10 cm in front of the screen, then pausing at the turn: it never stopped right after moving toward it
    for (let i = 0; i < 30; i++) expect(finder.update(tipFrame(new Vector3(-0.2 + i * 0.016, 1.45, -0.45)), t += 16, plane)).toBeNull();
    for (let i = 0; i < 30; i++) expect(finder.update(tipFrame(new Vector3(-0.2 + 29 * 0.016, 1.45, -0.45)), t += 16, plane)).toBeNull();
    let hit: Vector3 | null = null;
    for (let i = 0; i < 30 && !hit; i++) hit = finder.update(tipFrame(new Vector3(0, 1.45, -0.6)), t += 16, plane);
    expect(hit?.z).toBeCloseTo(-0.6, 3);
  });
});
