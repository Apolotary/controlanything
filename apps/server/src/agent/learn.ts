/**
 * IR learning: when the remote's codes are not public (the KOIZUMI KRH-TG-9A), the user presses each button
 * once while a Cardputer with an IR receiver (or the sim's virtual remote) captures it. Each capture becomes
 * a LearnedCode with the pressed button as a hypothesis label; VERIFY replays it and the camera decides.
 */
import { analyseCapture, sameCode } from '../devices/ir';
import type { Dispatcher } from './dispatch';
import type { StepLog } from './steps';
import type { LearnedCode, Target } from './types';

export const LEARN_BUTTONS: { button: string; hypothesis: LearnedCode['hypothesis']; prompt: string }[] = [
  { button: '全灯', hypothesis: 'fullOn', prompt: 'Press 全灯 (full on) once' },
  { button: '消灯', hypothesis: 'off', prompt: 'Press 消灯 (off) once' },
  { button: '明るく', hypothesis: 'brighter', prompt: 'Press 明るく (brighter) once' },
  { button: '暗く', hypothesis: 'dimmer', prompt: 'Press 暗く (dimmer) once' },
  { button: '常夜灯', hypothesis: 'nightLight', prompt: 'Press 常夜灯 (night light) once' },
  { button: '暖色', hypothesis: 'warmer', prompt: 'Press 暖色 (warm) once' },
  { button: '白色', hypothesis: 'cooler', prompt: 'Press 白色 (cool white) once' },
];

export interface LearnOptions {
  buttons?: typeof LEARN_BUTTONS;
  /** per button */
  durationMs?: number;
  signal?: AbortSignal;
  /** stop after this many buttons produced nothing in a row */
  maxMisses?: number;
}

export async function learnCodes(deps: { dispatcher: Dispatcher; steps: StepLog; log?: (line: string) => void }, t: Target, sensorDeviceId: string, o: LearnOptions = {}): Promise<LearnedCode[]> {
  const learned: LearnedCode[] = [];
  let misses = 0;
  const missed: typeof LEARN_BUTTONS = [];
  // one pass over the buttons, then one more try for the ones nobody pressed in time (a slow hand, not a failure)
  const queue = [...(o.buttons ?? LEARN_BUTTONS)].map((b) => ({ ...b, retry: false }));
  while (queue.length) {
    const b = queue.shift()!;
    if (o.signal?.aborted) break;
    const step = deps.steps.begin('link', `learn: ${b.prompt}${b.retry ? ' (once more)' : ''}`, { cardId: t.cardId, runId: t.runId, kind: 'proof' });
    const results = await deps.dispatcher.sense(sensorDeviceId, 'ir-capture', { durationMs: o.durationMs ?? 8000, prompt: b.prompt, cardId: t.cardId, signal: o.signal });
    const caps = results.filter((r) => r.ir?.rawUs?.length).map((r) => analyseCapture({ rawUs: r.ir!.rawUs, khz: r.ir!.khz }));
    if (!caps.length) {
      misses++;
      step.fail('nothing received');
      if (!b.retry) missed.push(b);
      if (misses >= (o.maxMisses ?? 3)) break;
      if (!queue.length && missed.length) queue.push(...missed.splice(0).map((m) => ({ ...m, retry: true })));
      continue;
    }
    misses = 0;
    if (!queue.length && missed.length) queue.push(...missed.splice(0).map((m) => ({ ...m, retry: true })));
    const cap = caps[0];
    const dup = learned.find((l) => sameCode(l, cap));
    if (dup) {
      step.ok(`same code as ${dup.button}; skipped`, { evidence: `${cap.protocol ?? 'UNKNOWN'} ${cap.bytes?.map((x) => x.toString(16).padStart(2, '0')).join(' ') ?? `${cap.rawUs.length} timings`}` });
      continue;
    }
    const code: LearnedCode = { ...cap, learnId: `ir${learned.length + 1}`, button: b.button, hypothesis: b.hypothesis, capturedAt: Date.now() };
    learned.push(code);
    step.ok(`captured ${b.button}`, { evidence: `${cap.protocol ?? 'UNKNOWN'} ${cap.bytes ? cap.bytes.map((x) => x.toString(16).padStart(2, '0')).join(' ') : `${cap.rawUs.length} timings`}${cap.frames && cap.frames > 1 ? ` x${cap.frames}` : ''}`.slice(0, 64) });
  }
  return learned;
}
