/**
 * Web MIDI bridge: device list with hot-plug, sends, and input listeners (monitor, identity replies).
 * Needs a secure context (http://localhost or the https LAN URL) and Chrome/Edge (Safari has no Web MIDI).
 * Implements MidiIO for the executor.
 */
import type { Port } from '@ce/protocol';
import type { MidiInEvent, MidiIO } from './midiExec';
import { noteOff, noteOn } from './midiDecode';

export type MidiIn = MidiInEvent;

export class MidiBridge implements MidiIO {
  access?: MIDIAccess;
  sysex = false;
  onChange: () => void = () => {};
  /** the monitor's listener (kept for compatibility); use addListener for more */
  onMessage: (m: MidiIn) => void = () => {};
  private readonly listeners = new Set<(m: MidiIn) => void>();

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  /** Restore either existing grant after reload without asking for new access. */
  static async alreadyGranted(): Promise<boolean> {
    for (const sysex of [true, false]) {
      try {
        const s = await navigator.permissions.query({ name: 'midi', sysex } as unknown as PermissionDescriptor);
        if (s.state === 'granted') return true;
      } catch {
        // Older browsers may only recognize the plain MIDI permission.
      }
    }
    return false;
  }

  get enabled(): boolean {
    return Boolean(this.access);
  }

  async enable(restore = false): Promise<void> {
    if (!MidiBridge.supported) throw new Error('Web MIDI is not available in this browser (use Chrome or Edge, on localhost or https).');
    let sysex = true;
    if (restore) {
      try {
        sysex = (await navigator.permissions.query({ name: 'midi', sysex: true } as unknown as PermissionDescriptor)).state === 'granted';
      } catch {
        sysex = false;
      }
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex });
      this.sysex = sysex;
    } catch {
      if (!sysex) throw new Error('USB MIDI access is no longer available. Choose Allow USB MIDI to reconnect.');
      // SysEx refused: plain MIDI still covers notes and CCs (no identity check)
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.sysex = false;
    }
    this.access.onstatechange = () => {
      this.listen();
      this.onChange();
    };
    this.listen();
    this.onChange();
  }

  inputs(): MIDIInput[] {
    return this.access ? [...this.access.inputs.values()] : [];
  }

  outputs(): MIDIOutput[] {
    return this.access ? [...this.access.outputs.values()] : [];
  }

  /** Ports in protocol form, for `hello.ports`. */
  ports(): Port[] {
    const map = (p: MIDIPort, kind: Port['kind']): Port => {
      const port: Port = { id: p.id, kind, name: p.name ?? p.id, state: p.state === 'connected' ? 'connected' : 'disconnected' };
      if (p.manufacturer) port.manufacturer = p.manufacturer;
      return port;
    };
    return [...this.inputs().map((p) => map(p, 'midi-in')), ...this.outputs().map((p) => map(p, 'midi-out'))];
  }

  send(outputId: string, bytes: number[], timestamp?: number): void {
    const out = this.access?.outputs.get(outputId);
    if (!out) throw new Error('That MIDI output is gone.');
    out.send(bytes, timestamp);
  }

  addListener(fn: (m: MidiIn) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Middle C for 300 ms (bypasses the executor; for the manual test button only). */
  testNote(outputId: string, channel = 1, note = 60, velocity = 100): void {
    this.send(outputId, noteOn(channel, note, velocity));
    this.send(outputId, noteOff(channel, note), performance.now() + 300);
  }

  private listen(): void {
    for (const input of this.inputs()) {
      input.onmidimessage = (e: MIDIMessageEvent) => {
        if (!e.data) return;
        const m: MidiIn = { portId: input.id, portName: input.name ?? input.id, data: e.data, time: e.timeStamp };
        this.onMessage(m);
        for (const fn of this.listeners) fn(m);
      };
    }
  }
}
