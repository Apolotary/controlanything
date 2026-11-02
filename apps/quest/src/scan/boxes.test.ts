import { describe, expect, it } from 'vitest';
import { Color, Group, Mesh, PlaneGeometry, Ray, ShaderMaterial, Vector3 } from 'three';
import { BoxField } from '../hud/v2/boxes';
import { THEME } from '../hud/v2/theme';

const head = new Vector3(0, 1.4, 0);
const center = new Vector3(0, 1.4, -1);

describe('scan box interaction', () => {
  it('hits the entire box interior with either ray shape and reports physical distance', () => {
    const field = new BoxField();
    field.set('far', new Vector3(0, 1.4, -3), 0.8, 0.6, THEME.color.line, true);
    field.set('near', center, 0.4, 0.2, THEME.color.line, true);
    field.update(0, head);
    const hit = field.hitTest(new Ray(head, new Vector3(0.1, 0, -1).normalize()));
    expect(hit?.box.id).toBe('near');
    expect(hit?.point.x).toBeCloseTo(0.1);
    expect(hit?.distance).toBeCloseTo(Math.hypot(1, 0.1));
    expect(field.hitTest({ origin: head, dir: new Vector3(0, 0, -10) })?.distance).toBe(1);
    expect(field.hitTest({ origin: head, dir: new Vector3(0, 0, 1) })).toBeNull();
    expect(field.hitTest({ origin: head, dir: new Vector3(0, 0, 0) })).toBeNull();
    field.setOpacity('near', 0);
    expect(field.hitTest(new Ray(head, new Vector3(0, 0, -1)))?.box.id).toBe('far');
    field.set('far', new Vector3(0, 1.4, -5), 0.8, 0.6, THEME.color.line, true);
    expect(field.hitTest({ origin: head, dir: new Vector3(0, 0, -10) })).toBeNull();
    field.dispose();
  });

  it('accepts near-plane pokes anywhere inside but rejects corners, edges and distant points', () => {
    const field = new BoxField();
    field.set('lamp', center, 0.4, 0.2, THEME.color.line, true);
    field.update(0, head);
    const point = new Vector3(0.15, 1.45, -0.97);
    const hit = field.hitTestPoint(point);
    expect(hit?.box.id).toBe('lamp');
    expect(hit?.distance).toBeCloseTo(0.03);
    expect(hit?.point.z).toBe(-1);
    expect(field.hitTestPoint(new Vector3(0.2, 1.5, -1))).toBeNull();
    expect(field.hitTestPoint(new Vector3(0.3, 1.4, -1))).toBeNull();
    expect(field.hitTestPoint(new Vector3(0, 1.4, -0.8))).toBeNull();
    expect(point.z).toBe(-0.97);
    field.dispose();
  });

  it('replaces a tagged box with a chip marker while candidate outlines retain their fade', () => {
    const field = new BoxField();
    field.set('lamp', center, 0.4, 0.2, THEME.color.line, true);
    field.set('laptop', new Vector3(1, 1.4, -1), 0.4, 0.2, THEME.color.line, true);
    field.setHovered('lamp'); field.update(0, head);
    const colors = field.geometry.getAttribute('color');
    expect(new Color().fromArray(colors.array, 0).getHexString()).toBe('ffffff');
    field.setTagged('lamp', true);
    field.setSelected('lamp'); field.setHovered(null);
    field.setOpacity('lamp', 0.25); field.update(0, head);
    expect(new Color().fromArray(colors.array, 0).getHexString()).toBe('ffffff');
    const alpha = field.geometry.getAttribute('boxOpacity');
    expect(alpha.getX(0) * field.material.opacity).toBeCloseTo(0.4);
    expect(alpha.getX(alpha.count / THEME.box.max)).toBe(0);
    field.setSelected(null); field.update(0, head);
    expect(new Color().fromArray(colors.array, 0).getHexString()).toBe('ffffff');
    field.remove('lamp'); field.update(0, head);
    expect(alpha.getX(0) * field.material.opacity).toBeCloseTo(0.4);
    expect([...alpha.array.slice(alpha.count / THEME.box.max)].every((value) => value === 0)).toBe(true);
    expect(field.children.map((child) => child.name)).toEqual(['chip-markers']);
    field.dispose();
  });

  it('caps a scanning field at eight objects and retains selection when reducing a populated field', () => {
    const field = new BoxField();
    for (let i = 0; i < 10; i++) field.set(String(i), center, 0.4, 0.2, THEME.color.line);
    field.setSelected('0'); field.setActive('1'); field.setLimit(8);
    expect(field.boxes.size).toBe(8);
    expect(field.has('0')).toBe(true); expect(field.has('1')).toBe(true);
    expect(field.set('extra', center, 0.4, 0.2, THEME.color.line)).toBeUndefined();
    field.setLimit(1);
    expect([...field.boxes.keys()]).toEqual(['0']);
    field.dispose();
  });
});

describe('scan label layout', () => {
  it('keeps labels four degrees tall and fixed 12 cm above devices as the head moves', () => {
    const field = new BoxField();
    for (let i = 0; i < 8; i++) {
      const depth = 1 + i * 2 / 7;
      field.set(String(i), new Vector3(0, 1.4, -depth), 0.4 * depth, 0.2 * depth, THEME.color.line, true);
    }
    field.update(0, head);
    const first = [];
    for (const box of field.boxes.values()) {
      const anchor = field.labelAnchor(box, head, new Vector3());
      const height = THEME.box.labelHeight * field.labelScale(box, head);
      expect(2 * Math.atan(height / (2 * anchor.distanceTo(head))) * 180 / Math.PI).toBeGreaterThanOrEqual(4);
      expect(anchor.x).toBe(box.center.x);
      expect(anchor.y - box.center.y - box.h / 2).toBeCloseTo(0.12);
      first.push(anchor.clone());
    }
    field.update(0, head);
    let i = 0;
    const movedHead = new Vector3(0.4, 1.5, 0.1);
    for (const box of field.boxes.values()) expect(field.labelAnchor(box, movedHead, new Vector3())).toEqual(first[i++]);
    field.dispose();
  });

  it('scales the existing label group and fades shared plate materials without leaking opacity', () => {
    const field = new BoxField(), root = new Group();
    root.add(field);
    const box = field.set('lamp', new Vector3(0, 1.4, -2), 0.4, 0.2, THEME.color.line, true)!;
    const label = new Group(); label.name = 'target-label:lamp'; root.add(label);
    const material = new ShaderMaterial({ uniforms: { fillAlpha: { value: 0.8 }, edgeAlpha: { value: 0.2 } } });
    const plate = new Mesh(new PlaneGeometry(1, 1), material); plate.scale.set(0.1, 0.028, 1); label.add(plate);
    class LabelText extends Group { fillOpacity = 1; }
    const text = new LabelText(); label.add(text);
    field.setOpacity('lamp', 0.25); field.update(0, head);
    field.labelAnchor(box, head, label.position);
    expect(label.scale.x).toBeCloseTo(2, 1);
    expect(text.fillOpacity).toBe(0.25);
    plate.onBeforeRender(null!, null!, null!, plate.geometry, material, null!);
    expect(material.uniforms.fillAlpha.value).toBeCloseTo(0.2);
    expect(material.uniforms.edgeAlpha.value).toBeCloseTo(0.05);
    plate.onAfterRender(null!, null!, null!, plate.geometry, material, null!);
    expect(material.uniforms.fillAlpha.value).toBe(0.8);
    expect(material.uniforms.edgeAlpha.value).toBe(0.2);
    field.setOpacity('lamp', 0); field.labelAnchor(box, head, label.position);
    expect(label.visible).toBe(false);
    field.dispose(); plate.geometry.dispose(); material.dispose();
  });
});
