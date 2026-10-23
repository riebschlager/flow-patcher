import { blockedStatus, type EngineEvent, type NodeDefinition, type NodeState, type NoteEvent } from '@flow-patcher/engine';

/** The Channel menu: every MIDI channel, or one of 1–16. */
export const MIDI_CHANNELS = ['All', ...Array.from({ length: 16 }, (_, i) => String(i + 1))] as const;

/** One MIDI message, decoded: its kind, its MIDI channel (0–15) and its data bytes. */
export interface MidiMessage {
  kind: 'on' | 'off' | 'cc';
  /** 0–15, from the status byte's low nibble. */
  midiChannel: number;
  data1: number;
  data2: number;
}

const byte = (value: unknown, max: number): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : null;

/**
 * Decodes a raw MIDI event (`{ status, data1, data2 }`, ADR 0029) into a note-on, a note-off or a
 * CC, or null for anything else: other message types (pitch bend, aftertouch, clock, sysex), or
 * fields that aren't integer bytes (status 0–255, data 0–127). A note-on with velocity 0 is a
 * note-off, as the MIDI spec has it.
 */
export function decodeMidi(event: Readonly<EngineEvent>): MidiMessage | null {
  const status = byte(event.status, 255), data1 = byte(event.data1, 127), data2 = byte(event.data2, 127);
  if (status === null || data1 === null || data2 === null) return null;
  const type = status & 0xf0, midiChannel = status & 0x0f;
  if (type === 0x90) return { kind: data2 === 0 ? 'off' : 'on', midiChannel, data1, data2 };
  if (type === 0x80) return { kind: 'off', midiChannel, data1, data2 };
  if (type === 0xb0) return { kind: 'cc', midiChannel, data1, data2 };
  return null;
}

/** One CC change this window: the value (0–1) of the chosen controller on a signal channel (1–16). */
interface Change {
  time: number;
  channel: number;
  value: number;
}

/** CC values as the window began: index 0 is the latest change on any channel, 1–16 each MIDI channel + 1. */
type Values = number[];
const SLOTS = 17;

const pendingOf = (state: NodeState): Change[] => (state.pending ?? []) as Change[];
const valuesOf = (state: NodeState): Values => (state.values ?? []) as Values;

function apply(values: Values, change: Change): void {
  values[change.channel] = change.value;
  values[0] = change.value;
}

/** Which MIDI channel (0–15) the Channel menu passes, or null for All. */
function filterOf(param: unknown): number | null {
  const n = Number(param);
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n - 1 : null;
}

/**
 * Canvas source: Web MIDI input (docs/nodes/canvas-sources.md, ADR 0004), behind
 * the `midi` permission. The host asks when a patch containing it first plays,
 * and a denial (or a browser without Web MIDI) shows the blocked state on the
 * card (`blockedStatus`); the rest of the patch plays on.
 *
 * `input` maps the stream's `midi` events (ADR 0029) to the raw **MIDI** output.
 * The host pushes each MIDI message as `{ status, data1, data2 }` on channel 0,
 * one stamp per message, and the runtime merges it into MIDI unchanged, every
 * channel message the host sends, from every MIDI channel, whatever the
 * Channel menu says. `query` derives the rest from
 * those pushes (`ctx.pushed`), at the push's time:
 * - **Note**, at each note-on: `pitch` = data1, `velocity` = data2 / 127 and
 *   `duration` from the Length knob, read at the note's time. Notes carry
 *   their own length (ADR 0028), so a note-off ends nothing.
 * - **Note On** and **Note Off** events with `pitch` and `velocity` (0–1). A
 *   note-on with velocity 0 is a Note Off with velocity 0, and makes no Note.
 * - **CC**, a Signal: the CC Number controller's value, data2 / 127, held
 *   until it changes. Channel 1–16 reads that MIDI channel (0 until it sends
 *   one); any other channel, 0 included, reads the latest change on any.
 * The derived outputs put each message on the signal channel MIDI channel + 1
 * (1–16), so notes from different MIDI channels keep apart downstream. The
 * Channel menu passes only one MIDI channel to them (All: every one).
 * Messages that aren't note-on, note-off or CC, and fields that aren't
 * integer bytes, reach MIDI but nothing else.
 *
 * State (plain data), like Pointer's: `values` holds the CC values as the
 * current window began, and `pending` this window's changes in time order;
 * `signal(t)` applies the pending ones at or before t, so reads don't depend
 * on how time was split into windows. A new CC Number or Channel starts
 * from empty state (`keepState`), since the old values meant something else.
 */
export const midiIn: NodeDefinition = {
  type: 'midi-in',
  version: 1,
  label: 'MIDI In',
  category: 'canvas-sources',
  description: 'Notes and CCs from MIDI devices, one channel per MIDI channel, plus the raw MIDI messages. Asks for MIDI access when the patch first plays.',
  ports: [
    { name: 'note', type: 'note', direction: 'out', label: 'Note' },
    { name: 'on', type: 'event', direction: 'out', label: 'Note On' },
    { name: 'off', type: 'event', direction: 'out', label: 'Note Off' },
    { name: 'cc', type: 'signal', direction: 'out', label: 'CC' },
    { name: 'midi', type: 'event', direction: 'out', label: 'MIDI' },
  ],
  params: [
    { name: 'channel', kind: 'enum', options: MIDI_CHANNELS, default: 'All', label: 'Channel' },
    { name: 'controller', kind: 'number', min: 0, max: 127, default: 1, step: 1, label: 'CC Number', modulatable: false },
    { name: 'length', kind: 'number', min: 0.01, max: 8, default: 0.25, unit: 's', label: 'Length' },
  ],
  permission: 'midi',
  input: { reads: { midi: 'midi' } },
  status: (ctx) => blockedStatus('midi', ctx.permission),
  keepState: (before, after) => before.controller === after.controller && before.channel === after.channel,
  query({ state, pushed, params, param }) {
    const values = valuesOf(state);
    for (let i = values.length; i < SLOTS; i++) values[i] = 0;
    state.values = values;
    for (const change of pendingOf(state)) apply(values, change);
    const only = filterOf(params.channel);
    const controller = params.controller as number;
    const note: NoteEvent[] = [], on: EngineEvent[] = [], off: EngineEvent[] = [];
    const pending: Change[] = [];
    // The pushes come in time order, then push order: the order the messages arrived in.
    for (const e of pushed.midi ?? []) {
      const message = decodeMidi(e);
      if (!message || !Number.isFinite(e.time) || (only !== null && message.midiChannel !== only)) continue;
      const channel = message.midiChannel + 1;
      const velocity = message.data2 / 127;
      if (message.kind === 'on') {
        on.push({ time: e.time, channel, pitch: message.data1, velocity });
        const length = param('length', e.time, channel);
        note.push({ time: e.time, channel, pitch: message.data1, velocity, duration: Number.isFinite(length) ? length : 0.25 });
      } else if (message.kind === 'off') {
        off.push({ time: e.time, channel, pitch: message.data1, velocity });
      } else if (message.data1 === controller) {
        pending.push({ time: e.time, channel, value: velocity });
      }
    }
    state.pending = pending;
    // The runtime merges the pushed MIDI events into the MIDI output itself.
    return { note, on, off };
  },
  signal(ctx, port, t, channel) {
    if (port !== 'cc') return 0;
    // Reads never write state: only query() changes it (NodeState contract).
    const base = valuesOf(ctx.state);
    let latest = base[0] ?? 0;
    const slot = Number.isInteger(channel) && channel >= 1 && channel <= 16 ? channel : 0;
    let value = base[slot] ?? 0;
    for (const change of pendingOf(ctx.state)) {
      if (change.time > t) break;
      latest = change.value;
      if (change.channel === slot) value = change.value;
    }
    return slot === 0 ? latest : value;
  },
};
