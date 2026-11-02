import { describe, expect, it } from 'vitest';
import { Color, Vector3 } from 'three';
import { newCursor } from '../../gen3d/interact';
import { BoxField } from './boxes';
import { PinchReticles } from './reticle';
import { THEME } from './theme';

const head = new Vector3(0, 1.4, 0);
const center = new Vector3(0, 1.4, -1);

describe('Calm Glass target outlines', () => {
  it('draws no idle slots and clears vacated outline vertices after tracks disappear', () => {
    const capacity = 3, field = new BoxField(capacity);
    const positions = field.geometry.getAttribute('position');
    const colors = field.geometry.getAttribute('color');
    expect(field.geometry.drawRange.count).toBe(0);
    expect([...positions.array].every((value) => value === 0)).toBe(true);
    field.update(0, head);
    expect(field.geometry.drawRange.count).toBe(0);

    field.set('first', center, 0.4, 0.2, THEME.color.line, true);
    field.update(0, head);
    const indicesPerBox = field.geometry.drawRange.count;
    const floatsPerBox = positions.array.length / capacity;
    field.set('second', new Vector3(1, 1.4, -1), 0.4, 0.2, THEME.color.line, true);
    field.update(0, head);
    expect(field.geometry.drawRange.count).toBe(indicesPerBox * 2);

    field.remove('first'); field.update(0, head);
    expect(field.geometry.drawRange.count).toBe(indicesPerBox);
    expect([...positions.array.slice(floatsPerBox)].every((value) => value === 0)).toBe(true);
    expect([...colors.array.slice(floatsPerBox)].every((value) => value === 0)).toBe(true);
    for (let i = 0; i < indicesPerBox; i++) {
      const vertex = field.geometry.index!.getX(i);
      expect(positions.getX(vertex)).toBeGreaterThan(0.79);
      expect(positions.getX(vertex)).toBeLessThan(1.21);
    }

    field.remove('second');
    expect(field.geometry.drawRange.count).toBe(0);
    expect([...positions.array].every((value) => value === 0)).toBe(true);
    expect([...colors.array].every((value) => value === 0)).toBe(true);
    field.update(0, head);
    expect(field.geometry.drawRange.count).toBe(0);
    field.dispose();
  });

  it('renders a real 1.5 px stroke and promotes the active outline to 2 px accent', () => {
    const field = new BoxField();
    field.set('lamp', center, 0.4, 0.2, THEME.color.line, true);
    field.update(0, head);
    const positions = field.geometry.getAttribute('position');
    const width = () => new Vector3().fromBufferAttribute(positions, 0).distanceTo(new Vector3().fromBufferAttribute(positions, 1));
    expect(width()).toBeCloseTo(THEME.box.stroke, 6);
    const colors = field.geometry.getAttribute('color');
    const color = () => new Color().fromArray(colors.array, 0);
    expect(color().getHexString()).toBe(new Color(THEME.color.line).getHexString());
    field.setActive('lamp'); field.update(0, head);
    expect(width()).toBeCloseTo(THEME.box.activeStroke, 6);
    expect(THEME.box.activeStroke / THEME.box.stroke).toBeCloseTo(2 / 1.5);
    expect(color().getHexString()).toBe(new Color(THEME.color.accent).getHexString());
    field.setActive(null); field.update(0, head);
    expect(width()).toBeCloseTo(THEME.box.stroke, 6);
    expect(color().getHexString()).toBe(new Color(THEME.color.line).getHexString());
    field.dispose();
  });

  it('selects the nearer rounded box and ignores its clipped corner', () => {
    const field = new BoxField();
    field.set('far', new Vector3(0, 1.4, -2), 0.4, 0.2, THEME.color.line, true);
    field.set('near', center, 0.4, 0.2, THEME.color.line, true);
    const straight = { origin: head, dir: new Vector3(0, 0, -1) };
    expect(field.intersectRay(straight, head)?.box.id).toBe('near');
    const corner = { origin: head, dir: new Vector3(0.2, 0.1, -1).normalize() };
    expect(field.intersectRay(corner, head)).toBeNull();
    field.dispose();
  });
});

describe('Calm Glass pinch reticles', () => {
  it('follows the hand ray and contracts into the target border over 180 ms', () => {
    const field = new BoxField(), reticles = new PinchReticles();
    field.set('lamp', center, 0.4, 0.2, THEME.color.line, true);
    const cursor = newCursor('left', 'left');
    cursor.tracked = true;
    cursor.position.set(1, 1, 1);
    cursor.ray = { origin: head.clone(), dir: new Vector3(0, 0, -1) };
    const ring = reticles.getObjectByName('left-reticle')!;
    reticles.update([cursor], head, 0, field);
    expect(ring.visible).toBe(true);
    expect(ring.position.distanceTo(center)).toBeLessThan(1e-6);
    expect(ring.scale.x).toBe(1);
    cursor.pinching = cursor.justPinched = true;
    reticles.update([cursor], head, 0, field);
    cursor.justPinched = false;
    reticles.update([cursor], head, 0.09, field);
    expect(ring.scale.x).toBeGreaterThan(0.08);
    expect(ring.scale.x).toBeLessThan(1);
    expect(ring.position.y).toBeGreaterThan(center.y);
    reticles.update([cursor], head, 0.09, field);
    expect(ring.scale.x).toBeCloseTo(0.08);
    expect(ring.position.distanceTo(new Vector3(0, 1.5, -1))).toBeLessThan(1e-6);
    reticles.update([cursor], head, 1, field);
    expect(ring.scale.x).toBeCloseTo(0.08);
    cursor.pinching = false; cursor.justReleased = true;
    reticles.update([cursor], head, 0.18, field);
    expect(ring.scale.x).toBeCloseTo(1);
    cursor.tracked = false;
    reticles.update([cursor], head, 0, field);
    expect(ring.visible).toBe(false);
    reticles.dispose(); field.dispose();
  });
});
