// The editor's Web MIDI host (ADR 0004): once the `midi` permission is granted,
// it listens on every MIDI input, including ones connected later, and hands
// each channel message on as one input stream event (ADR 0029):
// `{ type: 'midi', status, data1, data2 }`. LivePatch pushes it through the
// input router like a pointer event, one stamp per message.
import type { InputFields } from '@flow-patcher/engine';

/** What the host needs of a MIDIAccess: its inputs and their connect/disconnect events. */
export type MidiAccessLike = Pick<MIDIAccess, 'inputs' | 'addEventListener' | 'removeEventListener'>;

/**
 * One MIDI message as a stream event, or null for what MIDI In doesn't read:
 * system messages (sysex, clock, active sensing, which some devices send many
 * times a second) and empty or malformed data. A two-byte message (program
 * change, channel pressure) has no `data2`.
 */
export function midiEvent(data: ArrayLike<number> | null | undefined): InputFields | null {
  if (!data || data.length < 2) return null;
  const status = data[0]!, data1 = data[1]!;
  if (!(status >= 0x80 && status < 0xf0) || !(data1 >= 0 && data1 < 0x80)) return null;
  const event: InputFields = { type: 'midi', status, data1 };
  const data2 = data[2];
  if (data2 !== undefined && data2 >= 0 && data2 < 0x80) event.data2 = data2;
  return event;
}

export class MidiHost {
  private access: MidiAccessLike | null = null;
  private readonly inputs = new Set<MIDIInput>();
  private disposed = false;

  /** `push` gets each message's event and its timeStamp (performance.now() time). */
  constructor(private readonly push: (event: InputFields, timeStamp?: number) => void) {}

  /** Starts listening on a granted MIDIAccess. Only the first one counts. */
  attach(access: MidiAccessLike): void {
    if (this.disposed || this.access) return;
    this.access = access;
    access.addEventListener('statechange', this.onState);
    this.listenAll();
  }

  /** Inputs being listened to, for e2e and the console. */
  get listening(): number {
    return this.inputs.size;
  }

  dispose(): void {
    this.disposed = true;
    this.access?.removeEventListener('statechange', this.onState);
    for (const input of this.inputs) input.removeEventListener('midimessage', this.onMessage);
    this.inputs.clear();
    this.access = null;
  }

  private listenAll(): void {
    this.access?.inputs.forEach((input) => {
      if (this.inputs.has(input)) return;
      this.inputs.add(input);
      input.addEventListener('midimessage', this.onMessage);
    });
  }

  /** A device connected or went away: listen on any input that's new. A disconnected one just goes quiet. */
  private readonly onState = () => this.listenAll();

  private readonly onMessage = (event: Event) => {
    const fields = midiEvent((event as MIDIMessageEvent).data);
    if (fields) this.push(fields, event.timeStamp || undefined);
  };
}
