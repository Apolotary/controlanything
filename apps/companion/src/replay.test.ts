import { parseMessage, type Message, type WireProgressPayload, type WireReadyPayload } from '@ce/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replayArmResult, runReplay, WIRE_CARD, WIRE_REPLAY_CODE } from './replay';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('companion replay', () => {
  it('delivers a complete script whose every message passes the wire schema', async () => {
    const messages: Message[] = [];
    const done = vi.fn();
    runReplay((message) => {
      const result = parseMessage(message);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (result.ok) messages.push(result.message as Message);
      return result.ok;
    }, done);

    await vi.advanceTimersByTimeAsync(20_500);

    expect(done).toHaveBeenCalledOnce();
    expect(messages[0].type).toBe('presence');
    expect(messages.at(-1)?.type).toBe('arm.request');
    expect(new Set(messages.map((message) => message.type))).toEqual(new Set([
      'presence', 'agent.step', 'device.card', 'link.request', 'link.result',
      'driver.spec', 'driver.status', 'verify.result', 'ui.spec', 'arm.request',
    ]));
    const checks = messages.filter((message) => message.type === 'verify.result');
    expect(checks.some((message) => !message.payload.pass)).toBe(true);
    expect(checks.some((message) => message.payload.pass && message.payload.attempt > 1)).toBe(true);
    expect(checks.some((message) => message.payload.expected.effect === 'none')).toBe(true);
    expect(messages.some((message) => message.type === 'exec.command')).toBe(false);
  });

  it('plays the scripted wiring: every message passes the wire schema, the code streams in and ends ready as a labelled FIXTURE', async () => {
    const messages: Message[] = [];
    const done = vi.fn();
    runReplay((message) => {
      const result = parseMessage(message);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (result.ok) messages.push(result.message as Message);
      return result.ok;
    }, done, 'wire');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(done).toHaveBeenCalledOnce();
    const progress = messages.filter((message) => message.type === 'wire.progress').map((message) => message.payload as WireProgressPayload);
    expect(progress.every((p) => p.source === 'fixture' && p.model === 'muse-spark-1.3')).toBe(true);
    expect(progress.map((p) => p.phase).filter((phase, i, all) => all.indexOf(phase) === i)).toEqual(['writing', 'validating', 'dry-run', 'verifying', 'ready']);
    expect(progress.filter((p) => p.codeDelta).length).toBeGreaterThan(10);
    expect(progress.filter((p) => p.codeDelta).map((p) => p.codeDelta).join('')).toBe(WIRE_REPLAY_CODE);
    const ready = messages.find((message) => message.type === 'wire.ready')!.payload as WireReadyPayload;
    expect(ready).toMatchObject({ cardId: WIRE_CARD, code: WIRE_REPLAY_CODE, needs: ['screen'] });
    expect(ready.actions.map((action) => action.actionId)).toEqual(['cc22', 'cc23', 'cc24']);
    expect(messages.some((message) => message.type === 'exec.command')).toBe(false);
  });

  it('cancels the remaining script and completion callback', async () => {
    const inject = vi.fn(() => true);
    const done = vi.fn();
    const stop = runReplay(inject, done);
    await vi.advanceTimersByTimeAsync(1000);
    expect(inject).toHaveBeenCalled();
    const delivered = inject.mock.calls.length;
    stop();
    await vi.runAllTimersAsync();
    expect(inject).toHaveBeenCalledTimes(delivered);
    expect(done).not.toHaveBeenCalled();
  });

  it.each([true, false])('validates the arm response when approved=%s', (approved) => {
    const response = replayArmResult('arm-demo', approved);
    const result = parseMessage(response);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(response.type).toBe('arm.result');
    expect(response.payload).toMatchObject({ armId: 'arm-demo', armed: approved, cardId: 'card-op1f', driverId: 'drv-op1f-1' });
    expect(response.payload.reason).toBe(approved ? undefined : 'cancelled on the Mac');
  });
});
