import { describe, expect, it } from 'vitest';
import { Color, Group, Quaternion, Vector3 } from 'three';
import type { HudFrame } from '../contract';
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

  it('keeps candidates calm and removes the box immediately when a device is tagged', () => {
    const field = new BoxField();
    field.set('lamp', center, 0.4, 0.2, THEME.color.line, true);
    field.update(0, head);
    const positions = field.geometry.getAttribute('position');
    const width = () => new Vector3().fromBufferAttribute(positions, 0).distanceTo(new Vector3().fromBufferAttribute(positions, 1));
    expect(width()).toBeCloseTo(THEME.box.stroke, 6);
    const colors = field.geometry.getAttribute('color');
    const opacity = () => field.geometry.getAttribute('boxOpacity').getX(0) * field.material.opacity;
    const color = () => new Color().fromArray(colors.array, 0);
    expect(color().getHexString()).toBe('ffffff');
    expect(opacity()).toBeCloseTo(0.4);
    field.setActive('lamp'); field.update(0, head);
    expect(width()).toBeCloseTo(THEME.box.stroke, 6);
    expect(color().getHexString()).toBe('ffffff');
    expect(opacity()).toBeCloseTo(0.4);
    field.setTagged('lamp', true); field.update(0, head);
    expect(field.geometry.drawRange.count).toBe(0);
    expect(field.getObjectByName('chip-markers')?.userData.count).toBe(1);
    field.setActive(null); field.update(0, head);
    expect(field.geometry.drawRange.count).toBe(0);
    field.setTagged('lamp', false); field.update(0, head);
    expect(width()).toBeCloseTo(THEME.box.stroke, 6);
    expect(color().getHexString()).toBe('ffffff');
    expect(opacity()).toBeCloseTo(0.4);
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

describe('outline capacity and depth stability', () => {
  it('freezes small detector noise and eases sustained position and size changes', () => {
    const field = new BoxField(), noisy = center.clone();
    const box = field.set('lamp', center, 0.4, 0.2, THEME.color.line, true)!;
    for (let frame = 0; frame < 100; frame++) {
      noisy.x = Math.sin(frame) * 0.1;
      field.set('lamp', noisy, 0.4 + Math.sin(frame) * 0.01, 0.2, THEME.color.line);
      field.update(1 / 90, head);
    }
    expect(box.center.equals(center)).toBe(true); expect(box.w).toBe(0.4);
    noisy.x = 0.4;
    for (let frame = 0; frame < 50; frame++) {
      field.set('lamp', noisy, 0.6, 0.3, THEME.color.line);
      field.update(1 / 90, head);
    }
    expect(box.center.x).toBeGreaterThan(0);
    expect(box.center.x).toBeLessThan(0.2);
    expect(box.w).toBeGreaterThan(0.4); expect(box.w).toBeLessThan(0.6);
    field.dispose();
  });

  it('ranks at most five central nearby candidates without counting tagged chips', () => {
    const field = new BoxField();
    const frame: HudFrame = { time: 0, dt: 0, head: { position: head, quaternion: new Quaternion() }, hands: {} };
    for (let i = 0; i < 7; i++) field.set(`candidate-${i}`, new Vector3(i * 0.1, 1.4, -2), 0.1, 0.1, THEME.color.line);
    field.set('far', new Vector3(0, 1.4, -3.1), 0.1, 0.1, THEME.color.line);
    field.set('side', new Vector3(1, 1.4, -1), 0.1, 0.1, THEME.color.line);
    field.set('tagged', new Vector3(0.1, 1.4, -1), 0.1, 0.1, THEME.color.line);
    field.setTagged('tagged', true);
    field.update(0, head, frame, 'annotate');
    expect([...field.boxes.values()].filter((box) => box.visible && !box.tagged).map((box) => box.id)).toEqual(['candidate-0', 'candidate-1', 'candidate-2', 'candidate-3', 'candidate-4']);
    expect(field.isVisible('tagged')).toBe(true);
    field.update(0, head, frame, 'control');
    expect(field.geometry.drawRange.count).toBe(0);
    expect(field.isVisible('candidate-0')).toBe(false);
    field.dispose();
  });

  it('batches quiet rings, waits for attention, and retains an open device', () => {
    const field = new BoxField(), root = new Group(), label = new Group();
    root.add(field, label); label.add(new Group());
    const frame: HudFrame = { time: 0, dt: 0, head: { position: head, quaternion: new Quaternion() }, hands: {} };
    const box = field.set('lamp', center, 0.4, 0.2, THEME.color.line)!;
    field.setTagged('lamp', true, true); field.registerLabel('lamp', label, 0.2);
    field.update(0, head, frame, 'control'); field.labelAnchor(box, head, label.position);
    expect(box.collapsed).toBe(true); expect(label.visible).toBe(true); expect(label.children[0]!.visible).toBe(false);
    expect(field.getObjectByName('chip-markers')?.userData.collapsedCount).toBe(1);
    field.update(0.24, head, frame, 'control'); expect(box.collapsed).toBe(true);
    field.update(0.011, head, frame, 'control'); field.labelAnchor(box, head, label.position);
    expect(box.collapsed).toBe(false); expect(label.children[0]!.visible).toBe(true);
    frame.head.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3);
    field.update(0, head, frame, 'control'); expect(box.collapsed).toBe(true);
    field.setSelected('lamp'); field.update(0, head, frame, 'control'); expect(box.collapsed).toBe(false);
    field.dispose();
  });

  it('uses yaw-only chips with padded ray bounds and no box collider on tagged devices', () => {
    const field = new BoxField(), quaternion = new Quaternion();
    field.labelQuaternion(new Vector3(0, 5, 0), center, quaternion);
    expect(new Vector3(0, 1, 0).applyQuaternion(quaternion).distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-6);
    const box = field.set('lamp', center, 0.4, 0.2, THEME.color.line)!; field.setTagged('lamp', true);
    expect(field.hitTest({ origin: head, dir: new Vector3(0, 0, -1) })).toBeNull();
    const chip = field.labelAnchor(box, head, new Vector3()); chip.x += 0.112;
    expect(field.hitTest({ origin: head, dir: chip.sub(head).normalize() })?.box.id).toBe('lamp');
    field.dispose();
  });

  it('grows beyond 24 persistent tags instead of silently discarding a new tag', () => {
    const field = new BoxField();
    const geometry = field.geometry;
    for (let i = 0; i < 60; i++) expect(field.set(`device-${i}`, center, 0.2, 0.1, THEME.color.accent)).toBeTruthy();
    field.update(0, head);
    expect(field.boxes.size).toBe(60);
    expect(field.geometry).toBe(geometry);
    expect(field.geometry.drawRange.count).toBeLessThanOrEqual(field.geometry.index!.count);
    field.dispose();
  });

  it('uses the actual widget depth and hides a missing or empty ray without moving to the origin', () => {
    const field = new BoxField(), reticles = new PinchReticles(), cursor = newCursor('left', 'left');
    cursor.tracked = true; cursor.canPoke = false; cursor.ray = { origin: head, dir: new Vector3(0, 0, -1) };
    const hit = new Vector3(0, 1.4, -0.6);
    reticles.update([cursor], head, 0, field, [hit]);
    const mesh = reticles.getObjectByName('left-reticle') as import('three').Mesh;
    expect(mesh.position.equals(hit)).toBe(true);
    expect((mesh.material as import('three').MeshBasicMaterial).depthTest).toBe(true);
    cursor.ray.dir.set(0, 0, 0); reticles.update([cursor], head, 0, field, [hit]);
    expect(mesh.visible).toBe(false); expect(mesh.position.equals(hit)).toBe(true);
    cursor.ray.dir.set(0, 0, -1); reticles.update([cursor], head, 0, field);
    expect(mesh.visible).toBe(false); expect(mesh.position.equals(hit)).toBe(true);
    field.dispose(); reticles.dispose();
  });
});
