import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { CardPlacement, EdgePlacement, angularScale } from './comfort';
import { acceptsCommandResult, commandSubtitle, commandTimedOut, routeLabel, type CommandState } from './command-state';

describe('comfortable device controls', () => {
  it.each([0.1, 0.6, 3, 20])('places a device at %sm in reach, beside its body', (distance) => {
    const head = new Vector3(0, 1.6, 0), target = new Vector3(0, 1.6, -distance);
    const out = new Vector3(), rotation = new Quaternion();
    new CardPlacement().place(head, target, 0.3, out, rotation);
    expect(out.distanceTo(head)).toBeGreaterThanOrEqual(0.55 - 1e-10);
    expect(out.distanceTo(head)).toBeLessThanOrEqual(0.9 + 1e-10);
    expect(out.x).toBeGreaterThan(0.2);
    const height = 0.048 * angularScale(out.distanceTo(head), 0.048);
    expect(2 * Math.atan(height / (2 * out.distanceTo(head))) * 180 / Math.PI).toBeGreaterThanOrEqual(4 - 1e-10);
  });
  it('shows one edge result outside the view, including directly behind, and hides on return', () => {
    const edge = new EdgePlacement(), head = new Vector3(), q = new Quaternion();
    expect(edge.update(head, q, new Vector3(0, 0, -2))).toBe(false);
    expect(edge.update(head, q, new Vector3(2, 1, -1))).toBe(true);
    expect(edge.position.x).toBeCloseTo(0.32);
    expect(edge.position.y).toBeLessThanOrEqual(0.23);
    expect(edge.angle).toBeGreaterThan(0);
    expect(edge.update(head, q, new Vector3(0, 0, 2))).toBe(true);
    expect(edge.position.x).toBeCloseTo(0.32);
    expect(edge.update(head, q, new Vector3(0, 0, -2))).toBe(false);
  });
});

describe('visual command state', () => {
  const command: CommandState = { controlId: 'power', ts: 123, value: true, phase: 'sending', at: 1000 };
  it('ignores stale and unrelated results and times out exactly once', () => {
    expect(acceptsCommandResult(command, 'power', 123)).toBe(true);
    expect(acceptsCommandResult(command, 'power', 122)).toBe(false);
    expect(acceptsCommandResult(command, 'brightness', 123)).toBe(false);
    expect(commandTimedOut(command, 5999)).toBe(false);
    expect(commandTimedOut(command, 6000)).toBe(true);
    expect(commandTimedOut({ ...command, phase: 'ok' }, 10000)).toBe(false);
  });
  it('maps transport, command and setup state to plain subtitles', () => {
    expect(commandSubtitle(undefined, routeLabel('usb-midi'))).toBe('Ready · via Mac (USB MIDI)');
    expect(commandSubtitle('sending', routeLabel('ir'))).toBe('Sending…');
    expect(commandSubtitle('ok', routeLabel('ir'), 'On · 75 %')).toBe('On · 75 % · via IR bridge');
    expect(commandSubtitle('fail', routeLabel('ir'))).toContain('Retry');
    expect(commandSubtitle(undefined, '', '', 'Verifying audio')).toBe('Testing with the headset mic…');
    expect(commandSubtitle(undefined, '', '', 'Checking camera')).toBe('Testing with the headset camera…');
  });
});
