import { describe, expect, it } from 'vitest';
import { OsmoBridge, OsmoController } from './bridge';
import { buildDuml, parseDuml } from './duml';
import { type GimbalLink, MockGimbalLink } from './links';
import { attitudePushPacket } from './om';

function hardware(replyCode?: number) {
  let receive: (chunk: Uint8Array) => void = () => {};
  const link: GimbalLink = {
    kind: 'web', connected: true,
    open: async () => ({ kind: 'web', name: 'test link' }), close: async () => {},
    onData: cb => { receive = cb; }, onClose: () => {},
    write: async bytes => {
      const packet = parseDuml(bytes)!;
      // The observed OM4 push looks plausible but is not a confirmed angle layout.
      receive(attitudePushPacket({ yaw: -16.7, pitch: -103.1, roll: -3.2 }, 90));
      if (replyCode !== undefined) receive(buildDuml({ sender: 4, receiver: 2, seq: packet.seq,
        cmdType: 0x80, cmdSet: 4, cmdId: 0x14, payload: Uint8Array.of(replyCode) }));
    },
  };
  return { link, receive: (bytes: Uint8Array) => receive(bytes) };
}

async function execute(controller: OsmoController) {
  const acks: any[] = [];
  const bridge = new OsmoBridge({ serverBase: '', controller });
  Object.assign(bridge, { ws: { readyState: 1, send: (json: string) => acks.push(JSON.parse(json).payload) } });
  await (bridge as unknown as { onExec: (p: unknown) => Promise<void> }).onExec({
    execId: 'test', op: { kind: 'ble', profile: 'dji-osmo', op: 'pan', arg: 10 },
  });
  return acks[0];
}

describe('truthful Osmo command evidence', () => {
  it('rejects the current coalesced command when its link write fails', async () => {
    const fake = hardware();
    fake.link.write = async () => { throw Error('link failed'); };
    const c = new OsmoController(fake.link); await c.open();
    const first = c.aim({ yaw: 5, pitch: 0, roll: 0 });
    const latest = c.aim({ yaw: 10, pitch: 0, roll: 0 });
    const rejected = expect(latest).rejects.toThrow('link failed');
    expect(await first).toMatchObject({ superseded: true });
    await rejected; await c.close();
  });

  it('does not treat unconfirmed hardware bytes as angles, including for Stop estimates', async () => {
    const c = new OsmoController(hardware(0).link);
    await c.open();
    const ack = await execute(c);
    expect(ack).toMatchObject({ ok: true, applied: { params: { targetYaw: 10, commandConfirmed: 1 } } });
    expect(ack.detail).toBe('sent; gimbal confirmed the command (no reliable angle measurement)');
    expect(c.state.reported).toBeUndefined();
    expect(c.estimate().yaw).toBe(10);
    await c.close();
  });

  it('reports rejection and distinguishes missing confirmation from acceptance', async () => {
    for (const code of [7, undefined]) {
      const c = new OsmoController(hardware(code).link);
      await c.open();
      const ack = await execute(c);
      expect(ack.ok).toBe(code === undefined);
      expect(ack.detail).toContain(code === undefined ? 'no command confirmation' : 'refused the command (code 7)');
      await c.close();
    }
  });

  it('retains measured feedback for the explicitly simulated gimbal', async () => {
    const c = new OsmoController(new MockGimbalLink());
    await c.open();
    try {
      const ack = await execute(c);
      expect(ack.ok).toBe(true);
      expect(ack.detail).toContain('mock gimbal reports pan 10°');
      expect(ack.applied.params.reported).toBe(1);
    } finally { await c.close(); }
  });
});
