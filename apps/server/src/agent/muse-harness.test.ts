import { describe, expect, it, vi } from 'vitest';
import type { DriverAction } from '@ce/protocol';
import type { StreamClient, StreamMessage, StreamResult } from '../gen3d/stream';
import { CallLog } from '../muse/callLog';
import { RequestCancelledError } from '../muse/cancellation';
import type { WireInput } from './wire';
import { MuseBridgeHarness } from './muse-harness';

const model = 'muse-spark-1.3';
const action = (n: number): DriverAction => ({ actionId: `cc${n}`, label: `Touch ${n}`, kind: 'set', range: { min: 0, max: 127, step: 1 },
  encode: { kind: 'midi', msg: 'cc', channel: 1, number: n, value: '$value' }, expect: { sense: 'ack', effect: 'any' } });
const input: WireInput = { cardId: 'selected-mac', deviceName: 'Visual synth', request: 'Let my fingertip touch the water.',
  driver: { transport: 'midi', executor: { deviceId: 'paired-mac', port: 'ce-visual-synth' }, actions: [action(22), action(23), action(24)] } };
const program = { title: 'Fingertip water', explanation: 'Touch the calibrated screen to make ripples.', needs: ['screen'],
  code: "const t = s.screen;\nif (t && t.inside) {\n out.set('cc22', t.u * 127);\n out.set('cc23', t.v * 127);\n out.set('cc24', t.touching ? 100 : t.hover * 15);\n} else { out.set('cc24', 0); }" };
const call = (name: string, args: unknown = {}) => ({ name, arguments: JSON.stringify(args) });
const response = (tools: ReturnType<typeof call>[], content = ''): StreamResult & { reportedModel: string } => ({ model, reportedModel: model, content, chunks: 1, latencyMs: 1,
  finishReason: tools.length ? 'tool_calls' : 'stop', toolCalls: tools.map((t, index) => ({ ...t, id: `call-${index}`, index, startedMs: 0, doneMs: 1 })) });
const inspections = () => response([call('inspect_selected_device'), call('inspect_gesture_signals')]);
function successfulHash(messages: StreamMessage[]): string {
  for (const m of [...messages].reverse()) if (m.role === 'tool') {
    const result = JSON.parse(m.content); if (result.ok && result.hash) return result.hash;
  }
  throw new Error('No successful check tool result.');
}
type Step = (messages: StreamMessage[]) => StreamResult | Promise<StreamResult>;
function harness(steps: Step[]) {
  const log = new CallLog(() => {});
  const stream = vi.fn<StreamClient['stream']>(async (request, handlers) => {
    const step = steps.shift();
    const r = step ? await step(request.messages) : response([], 'Done; I connected it.');
    for (const c of r.toolCalls) handlers?.onToolCallDelta?.(c);
    return r;
  });
  return { agent: new MuseBridgeHarness({ model, mode: 'live', stream: { model, stream }, callLog: log }), stream, log };
}

describe('bounded native Muse tool harness (stubbed API transport)', () => {
  it('feeds real validation failures back to Muse and finishes only the repaired checked artifact', async () => {
    const h = harness([
      inspections, () => response([call('check_program', { ...program, code: "out.set('cc99', 12);" })]),
      messages => {
        const rejection = JSON.parse((messages.at(-1) as { content: string }).content);
        expect(rejection.ok).toBe(false); expect(rejection.issues.join(' ')).toContain('cc99');
        return response([call('check_program', program)]);
      }, messages => response([call('finish_program', { hash: successfulHash(messages) })]),
    ]);
    const progress = vi.fn(); const result = await h.agent.write(input, progress, { wiringTag: 'wire-real-scope' });
    expect(result.ok).toBe(true); expect(result.code).toBe(program.code); expect(result.dry?.frames).toBe(480);
    const receipt = h.agent.get('wire-real-scope')!;
    expect(receipt.outcome).toBe('checked'); expect(receipt.cardId).toBe(input.cardId);
    expect(receipt.tools.map(t => [t.name, t.ok])).toEqual([
      ['inspect_selected_device', true], ['inspect_gesture_signals', true], ['check_program', false], ['check_program', true], ['finish_program', true],
    ]);
    expect(receipt.artifact?.used.sort()).toEqual(['cc22', 'cc23', 'cc24']);
    expect(h.log.list()).toHaveLength(4);
    // A provider can send the complete tool argument in one chunk; that first
    // actual chunk must still reach the code preview without invented typing.
    expect(progress.mock.calls.some(([phase, data]) => phase === 'writing' && data.codeDelta === program.code)).toBe(true);
  });

  it('never interprets a model prose success claim as checked or authorized', async () => {
    const h = harness([]); const result = await h.agent.write(input, () => {});
    expect(result.ok).toBe(false); expect(result.code).toBe(''); expect(h.stream).toHaveBeenCalledTimes(2);
    expect(h.agent.list()[0]).toMatchObject({ outcome: 'failed', tools: [] });
  });

  it('rejects unknown tools, foreign target arguments and premature finish without broadening scope', async () => {
    const h = harness([
      () => response([call('shell', { command: 'touch /tmp/no' }), call('inspect_selected_device', { cardId: 'another-device' }), call('finish_program', { hash: '0'.repeat(64) })]),
      inspections, () => response([call('check_program', program)]), messages => response([call('finish_program', { hash: successfulHash(messages) })]),
    ]);
    expect((await h.agent.write(input, () => {})).ok).toBe(true);
    const receipt = h.agent.list()[0];
    expect(receipt.tools.slice(0, 3).every(t => !t.ok)).toBe(true);
    expect(receipt.cardId).toBe('selected-mac'); expect(JSON.stringify(receipt)).not.toContain('another-device');
  });

  it('invalidates an earlier successful artifact when a later submitted program fails checks', async () => {
    let oldHash = '';
    const h = harness([
      inspections, () => response([call('check_program', program)]), messages => {
        oldHash = successfulHash(messages); return response([call('check_program', { ...program, code: 'fetch("/bad");' })]);
      }, () => response([call('finish_program', { hash: oldHash })]),
    ]);
    expect((await h.agent.write(input, () => {})).ok).toBe(false);
    const receipt = h.agent.list()[0]; expect(receipt.artifact).toBeUndefined();
    expect(receipt.tools.find(t => t.name === 'finish_program')?.ok).toBe(false);
  });

  it('cancels a transport that ignores AbortSignal and never publishes a checked result', async () => {
    const h = harness([() => new Promise(() => {})]); const abort = new AbortController();
    const pending = h.agent.write(input, () => {}, { signal: abort.signal }); abort.abort();
    await expect(pending).rejects.toBeInstanceOf(RequestCancelledError);
    expect(h.agent.list()[0]).toMatchObject({ outcome: 'cancelled', tools: [] });
  });

  it('runs fixture calls through the same inspections, validator and hash finish with explicit source labels', async () => {
    const log = new CallLog(() => {}), agent = new MuseBridgeHarness({ model, mode: 'fixture', callLog: log });
    const progress = vi.fn();
    const result = await agent.write({ ...input, request: 'private request: touch the water', observation: { jpeg: 'PRIVATE_IMAGE_BYTES', capturedAt: Date.now() - 1000, width: 100, height: 100 } }, progress, { wiringTag: 'fixture-run' });
    expect(result).toMatchObject({ ok: true, source: 'fixture', model: 'fixture' });
    expect(result.title).toContain('FIXTURE');
    const receipt = agent.get('fixture-run')!;
    expect(receipt.tools).toHaveLength(4); expect(receipt.tools.every(t => t.ok)).toBe(true);
    expect(receipt.outcome).toBe('checked'); expect(receipt.observation.available).toBe(true);
    const serialized = JSON.stringify(receipt);
    for (const secret of ['PRIVATE_IMAGE_BYTES', 'private request', result.code]) expect(serialized).not.toContain(secret);
    receipt.tools.length = 0; expect(agent.get('fixture-run')!.tools).toHaveLength(4);
    expect(log.list().every(c => c.source === 'fixture' && c.model === 'fixture')).toBe(true);
    expect(progress.mock.calls.some(([phase, data]) => phase === 'writing' && data.codeDelta)).toBe(true);
  });

  it('enforces its own time budget even when the transport never settles', async () => {
    const h = harness([() => new Promise(() => {})]);
    expect((await h.agent.write(input, () => {}, { budgetMs: 20 })).ok).toBe(false);
    expect(h.agent.list()[0].reason).toContain('time budget');
  });

  it('refuses non-Meta configuration and rejects an unapproved response model before dispatching its tools', async () => {
    const stream = vi.fn<StreamClient['stream']>(async () => response([]));
    const refused = new MuseBridgeHarness({ model: 'other-model', mode: 'live', stream: { model: 'other-model', stream } });
    expect((await refused.write(input, () => {})).ok).toBe(false); expect(stream).not.toHaveBeenCalled();
    const h = harness([() => ({ ...inspections(), model: 'unapproved-model', reportedModel: 'unapproved-model' })]);
    expect((await h.agent.write(input, () => {})).ok).toBe(false); expect(h.agent.list()[0].tools).toEqual([]);
    expect(h.log.list()[0]).toMatchObject({ model: 'unapproved-model', ok: false });
    const missing = harness([() => ({ ...inspections(), reportedModel: undefined })]);
    expect((await missing.agent.write(input, () => {})).ok).toBe(false);
    expect(missing.agent.list()[0].tools).toEqual([]); expect(missing.log.list()[0].model).toBe('not-reported');
  });
});
