import { describe, expect, it } from 'vitest';
import { Euler, Group, Quaternion, Vector3 } from 'three';
import { WorldPanel } from './world-panel';

function head(yaw = 0, pitch = 0, roll = 0) {
  return {
    position: new Vector3(0, 1.6, 0),
    quaternion: new Quaternion().setFromEuler(new Euler(pitch, yaw, roll, 'YXZ')),
  };
}

describe('WorldPanel', () => {
  it('anchors within reach, below eye level and facing the initial head with yaw only', () => {
    const panel = new Group(), follow = new WorldPanel();
    const pose = head(Math.PI / 2, 0.4, 0.2);
    pose.position.set(3, 1.7, -2);
    follow.update(panel, pose, 0);
    expect(panel.position.x).toBeCloseTo(2.4);
    expect(panel.position.y).toBeCloseTo(1.56);
    expect(panel.position.z).toBeCloseTo(-2);
    expect(new Vector3(0, 1, 0).applyQuaternion(panel.quaternion).toArray()).toEqual([0, 1, 0]);
    expect(new Vector3(0, 0, 1).applyQuaternion(panel.quaternion).x).toBeCloseTo(1);
  });

  it('keeps position and orientation fixed as the user turns or takes small steps', () => {
    const panel = new Group(), follow = new WorldPanel(), pose = head();
    follow.update(panel, pose, 0);
    const position = panel.position.clone(), rotation = panel.quaternion.clone();
    pose.position.x = 0.15;
    pose.quaternion.copy(head(0.2, -0.1).quaternion);
    follow.update(panel, pose, 1000);
    follow.update(panel, pose, 5000);
    expect(panel.position.equals(position)).toBe(true);
    expect(panel.quaternion.equals(rotation)).toBe(true);
  });

  it('requires a continuous look outside the gaze cone for over 1.5 seconds', () => {
    const panel = new Group(), follow = new WorldPanel(), pose = head();
    follow.update(panel, pose, 0);
    const position = panel.position.clone();
    pose.quaternion.copy(head(Math.PI / 2).quaternion);
    follow.update(panel, pose, 100);
    follow.update(panel, pose, 1600);
    expect(panel.position.equals(position)).toBe(true);
    pose.quaternion.identity();
    follow.update(panel, pose, 1601);
    pose.quaternion.copy(head(Math.PI / 2).quaternion);
    follow.update(panel, pose, 1700);
    follow.update(panel, pose, 3200);
    expect(panel.position.equals(position)).toBe(true);
    follow.update(panel, pose, 3201);
    follow.update(panel, pose, 3351);
    expect(panel.position.x).toBeCloseTo(-0.3);
    expect(panel.position.z).toBeCloseTo(-0.3);
    follow.update(panel, pose, 3501);
    expect(panel.position.x).toBeCloseTo(-0.6);
    expect(panel.position.z).toBeCloseTo(0);
  });

  it('uses a 35 degree cone, including gaze pitch', () => {
    const panel = new Group(), follow = new WorldPanel({ height: 0 }), pose = head();
    follow.update(panel, pose, 0);
    pose.quaternion.copy(head(34 * Math.PI / 180).quaternion);
    follow.update(panel, pose, 100);
    follow.update(panel, pose, 5000);
    expect(panel.position.x).toBe(0);
    pose.quaternion.copy(head(0.1, 36 * Math.PI / 180).quaternion);
    follow.update(panel, pose, 5100);
    follow.update(panel, pose, 6601);
    follow.update(panel, pose, 6901);
    expect(panel.position.x).toBeCloseTo(-Math.sin(0.1) * 0.6);
    expect(panel.position.y).toBe(1.6);
  });

  it('recentres smoothly over 300ms after moving more than .75m, holding its destination during the move', () => {
    const panel = new Group(), follow = new WorldPanel(), pose = head();
    follow.update(panel, pose, 0);
    pose.position.x = 0.75;
    follow.update(panel, pose, 10);
    expect(panel.position.x).toBe(0);
    pose.position.x = 0.76;
    follow.update(panel, pose, 20);
    expect(panel.position.x).toBe(0);
    pose.position.x = 0.9;
    pose.quaternion.copy(head(0.4).quaternion);
    follow.update(panel, pose, 170);
    expect(panel.position.x).toBeCloseTo(0.38);
    follow.update(panel, pose, 320);
    expect(panel.position.x).toBeCloseTo(0.76);
    expect(panel.position.z).toBe(-0.6);
    expect(panel.quaternion.equals(new Quaternion())).toBe(true);
    follow.update(panel, pose, 500);
    expect(panel.position.x).toBeCloseTo(0.76);
  });

  it('anchors again on reset and when a session timestamp restarts', () => {
    const panel = new Group(), follow = new WorldPanel(), pose = head();
    follow.update(panel, pose, 500);
    pose.position.x = 0.2;
    follow.reset();
    follow.update(panel, pose, 600);
    expect(panel.position.x).toBeCloseTo(0.2);
    pose.position.x = 0.4;
    follow.update(panel, pose, 0);
    expect(panel.position.x).toBeCloseTo(0.4);
  });

  it('cancels an active transition when a new target resets the anchor', () => {
    const panel = new Group(), follow = new WorldPanel(), pose = head();
    follow.update(panel, pose, 0);
    pose.position.x = 1;
    follow.update(panel, pose, 100);
    follow.update(panel, pose, 250);
    expect(panel.position.x).toBeCloseTo(0.5);
    follow.reset();
    pose.position.x = 2;
    follow.update(panel, pose, 260);
    expect(panel.position.x).toBe(2);
    follow.update(panel, pose, 500);
    expect(panel.position.x).toBe(2);
  });
});
