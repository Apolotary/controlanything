/**
 * Web MIDI bridge: device list with hot-plug, a test note, and a raw input monitor.
 * Needs a secure context (http://localhost or the https LAN URL) and Chrome/Edge (Safari has no Web MIDI).
 */
import type { Port } from '@ce/protocol';
import { noteOff, noteOn } from './midiDecode';

export interface MidiIn {
  portId: string;
  portName: string;
  data: Uint8Array;
  /** DOMHighResTimeStamp of the event */
  time: number;
}

export class MidiBridge {
  access?: MIDIAccess;
  sysex = false;
  onChange: () => void = () => {};
  onMessage: (m: MidiIn) => void = () => {};

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  /** True when the browser already granted MIDI, so enabling needs no prompt. */
  static async alreadyGranted(): Promise<boolean> {
    try {
      const s = await navigator.permissions.query({ name: 'midi', sysex: true } as unknown as PermissionDescriptor);
      return s.state === 'granted';
    } catch {
      return false;
    }
  }

  async enable(): Promise<void> {
    if (!MidiBridge.supported) throw new Error('Web MIDI is not available in this browser (use Chrome or Edge, on localhost or https).');
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: true });
      this.sysex = true;
    } catch {
      // sysex refused: plain MIDI still covers notes and CCs
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

  /** Middle C for 300 ms. */
  testNote(outputId: string, channel = 1, note = 60, velocity = 100): void {
    this.send(outputId, noteOn(channel, note, velocity));
    this.send(outputId, noteOff(channel, note), performance.now() + 300);
  }

  private listen(): void {
    for (const input of this.inputs()) {
      input.onmidimessage = (e: MIDIMessageEvent) => {
        if (!e.data) return;
        this.onMessage({ portId: input.id, portName: input.name ?? input.id, data: e.data, time: e.timeStamp });
      };
    }
  }
}
