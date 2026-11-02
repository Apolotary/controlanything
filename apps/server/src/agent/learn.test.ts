import type { AgentStepPayload, SenseResultPayload } from '@ce/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFrame, necBytes, NEC_UNIT_US } from '../devices/ir';
import { Dispatcher } from './dispatch';
import { LEARN_BUTTONS, learnCodes } from './learn';
import { StepLog } from './steps';
import { TargetStore } from './targets';

function capture(command: number): SenseResultPayload[] {
  return [{
    senseId: `capture-${command}`, kind: 'ir-capture', at: 1,
    ir: { rawUs: encodeFrame({ protocol: 'NEC', bytes: necBytes(1, command), unitUs: NEC_UNIT_US }), khz: 38 },
  }];
}

function setup() {
  const events: AgentStepPayload[] = [];
  const hub = {
    broadcast(type: string, payload: unknown) {
      if (type === 'agent.step') events.push(payload as AgentStepPayload);
      return 1;
    },
    sendToDevice: () => 0,
  };
  const dispatcher = new Dispatcher({ hub });
  const sense = vi.spyOn(dispatcher, 'sense');
  const steps = new StepLog(hub);
  const target = new TargetStore(hub).create({ cardId: 'light' });
  return { events, sense, dispatcher, steps, target };
}

afterEach(() => vi.restoreAllMocks());

describe('remote learning guidance', () => {
  it('names each button in English and reports its position to the card and receiver', async () => {
    const { events, sense, dispatcher, steps, target } = setup();
    let command = 0;
    sense.mockImplementation(async () => capture(++command));
    const learned = await learnCodes({ dispatcher, steps }, target, 'receiver');
    const names = ['Full on', 'Off', 'Brighter', 'Dimmer', 'Night light', 'Warm', 'Cool white'];
    const prompts = names.map((name, index) => `Press the "${name}" button on your remote (${index + 1} of 7)`);

    expect(events.filter((event) => event.status === 'running').map((event) => event.sentence)).toEqual(prompts);
    expect(events.filter((event) => event.status === 'ok').map((event) => event.sentence))
      .toEqual(names.map((_, index) => `Got it (${index + 1} of 7)`));
    expect(sense.mock.calls.map(([, , options]) => options?.prompt)).toEqual(prompts);
    expect(learned.map((code) => code.button)).toEqual(LEARN_BUTTONS.map((button) => button.button));
    expect(learned.map((code) => code.hypothesis)).toEqual(LEARN_BUTTONS.map((button) => button.hypothesis));
  });

  it('keeps the original button number when a missed press is retried', async () => {
    const { events, sense, dispatcher, steps, target } = setup();
    sense.mockResolvedValueOnce([]).mockResolvedValueOnce(capture(2)).mockResolvedValueOnce(capture(1));
    await learnCodes({ dispatcher, steps }, target, 'receiver', { buttons: LEARN_BUTTONS.slice(0, 2) });

    expect(events.filter((event) => event.status === 'running').map((event) => event.sentence)).toEqual([
      'Press the "Full on" button on your remote (1 of 2)',
      'Press the "Off" button on your remote (2 of 2)',
      'Press the "Full on" button on your remote (1 of 2)',
    ]);
    expect(events.filter((event) => event.status === 'ok').map((event) => event.sentence))
      .toEqual(['Got it (2 of 2)', 'Got it (1 of 2)']);
    expect(events.find((event) => event.status === 'fail')?.sentence).toBe('I did not receive that button press');
  });
});
