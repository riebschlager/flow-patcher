import type { EngineEvent, EventField, NodeDefinition, NodeState, NoteEvent, QueryResult } from '@flow-patcher/engine';
import { Outputs } from './recognizer';

/**
 * Each key's channel, by its `code` (the physical key, whatever the layout): the code's position in
 * this list, from 1. Fixed, so a key has the same channel live and on replay, in every patch and
 * session, whatever was pressed first. **Append only**: inserting or reordering would move the
 * channels recordings and patches rely on. Letters come first (KeyA = 1 … KeyZ = 26), then digits
 * (Digit0 = 27 … Digit9 = 36), punctuation, whitespace and editing, modifiers, navigation, function
 * keys and the numpad. Codes not listed get a channel from 1000 up (`channelOf`).
 */
export const KEY_CODES: readonly string[] = [
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
  'IntlBackslash', 'IntlRo', 'IntlYen',
  'Space', 'Enter', 'Tab', 'Backspace', 'Escape', 'CapsLock',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'ContextMenu', 'Fn',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter', 'NumpadEqual', 'NumpadComma', 'NumLock',
  'ScrollLock', 'Pause', 'PrintScreen', 'Lang1', 'Lang2', 'KanaMode', 'Convert', 'NonConvert',
];

const CHANNELS: ReadonlyMap<string, number> = new Map(KEY_CODES.map((code, i) => [code, i + 1]));

/** First channel for codes not in KEY_CODES, and how many there are. */
export const OTHER_CHANNELS = { from: 1000, count: 9000 } as const;

/**
 * A key's channel: its place in KEY_CODES from 1, or for any other code a hash of it (FNV-1a) into
 * 1000–9999, so it's stable too. Two unlisted codes could share a channel; listed ones never do.
 */
export function channelOf(code: string): number {
  const listed = CHANNELS.get(code);
  if (listed !== undefined) return listed;
  let hash = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) hash = Math.imul(hash ^ code.charCodeAt(i), 0x01000193) >>> 0;
  return OTHER_CHANNELS.from + (hash % OTHER_CHANNELS.count);
}

/**
 * Keyboard → Note's two-row piano (the tracker layout), by code: semitones above the Octave knob's C.
 * The bottom letter row is the lower octave, white keys on Z X C V B N M , . / and black keys on the
 * row above (S D, G H J, L ;). The top letter row is the next octave up, white keys on Q W E R T Y U
 * I O P [ ] and black keys on the digits (2 3, 5 6 7, 9 0, =). The bottom row's last five keys
 * (, L . ; /) play the same notes as the top row's first five (Q 2 W 3 E), as in the trackers.
 */
export const PIANO: Readonly<Record<string, number>> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28, BracketLeft: 29, Equal: 30, BracketRight: 31,
};

/** A key's MIDI pitch in Keyboard → Note at an octave (the bottom row's C is MIDI 12 × (octave + 1), so 3 is C3 = 48), or null off the piano or above 127. */
export function pitchOf(code: string, octave: number): number | null {
  const offset = PIANO[code];
  if (offset === undefined || !Number.isFinite(octave)) return null;
  const pitch = 12 * (Math.round(octave) + 1) + offset;
  return pitch >= 0 && pitch <= 127 ? pitch : null;
}

/** The Held keys param as a list of codes: separated by spaces or commas. */
export function heldCodes(text: unknown): string[] {
  return typeof text === 'string' ? text.split(/[\s,]+/).filter((code) => code.length > 0) : [];
}

/** An error for Held keys naming something that isn't a code in KEY_CODES, or null. */
export function checkHeld(text: string): string | null {
  const unknown = heldCodes(text).filter((code) => !CHANNELS.has(code));
  if (!unknown.length) return null;
  return `not a key code: ${unknown.join(', ')}. Use codes like KeyA, Digit1, Space or ArrowUp`;
}

/** One key down, as the window began or along it. Plain data (ADR 0019). */
interface Contact {
  code: string;
  channel: number;
  downAt: number;
  /** The keydown's payload (key, code, modifiers), for an Up that ends it without a keyup. */
  payload: Record<string, EventField>;
}

/** One pushed keydown, auto-repeat or keyup. */
interface Change {
  time: number;
  kind: 'down' | 'repeat' | 'up';
  code: string;
  payload: Record<string, EventField>;
}

/** What one change does to the keys down. */
interface Stepped {
  /** A contact it ended: the keyup's, or one a fresh keydown on a key already down replaced. */
  ended: Contact | null;
  /** The contact it opened (a keydown), or the one a repeat belongs to (null when none is open). */
  contact: Contact | null;
}

/** Fields Key sets itself rather than passing through. */
const OWN_FIELDS = new Set(['time', 'channel', 'repeat', 'phase', 'age']);
function payloadOf(event: EngineEvent): Record<string, EventField> {
  const out: Record<string, EventField> = {};
  for (const [name, value] of Object.entries(event)) if (!OWN_FIELDS.has(name) && value !== undefined) out[name] = value;
  return out;
}

/** Applies one change to `held` in place. */
function step(held: Contact[], change: Change): Stepped | null {
  const index = held.findIndex((c) => c.code === change.code);
  const open = index >= 0 ? held[index]! : null;
  if (change.kind === 'repeat') return { ended: null, contact: open };
  if (open) held.splice(index, 1);
  if (change.kind === 'up') return open ? { ended: open, contact: null } : null;
  const contact: Contact = { code: change.code, channel: channelOf(change.code), downAt: change.time, payload: change.payload };
  held.push(contact);
  return { ended: open, contact };
}

const heldOf = (state: NodeState): Contact[] => (state.held ?? []) as Contact[];
const pendingOf = (state: NodeState): Change[] => (state.pending ?? []) as Change[];

/** The keys down at t: the window's base, then its changes at or before t. */
function heldAt(state: NodeState, t: number): readonly Contact[] {
  // Reads never write state: only query() changes it (NodeState contract).
  const pending = pendingOf(state);
  if (!(pending.length && pending[0]!.time <= t)) return heldOf(state);
  const held = heldOf(state).slice();
  for (const change of pending) {
    if (change.time > t) break;
    step(held, change);
  }
  return held;
}

/** Same-time order: keydowns (and repeats) before keyups, so a press shorter than a render quantum ends up. */
const RANK: Record<Change['kind'], number> = { down: 0, repeat: 0, up: 1 };

/**
 * Canvas source: the keyboard while the performance canvas has focus (docs/nodes/canvas-sources.md).
 * A contact source (ADR 0028): each key is a contact, from its keydown to its keyup.
 *
 * `input` reads the stream's keydown and keyup (ADR 0029), which the host pushes as
 * `{ key, code, repeat, shift, alt, ctrl, meta }` with no channel. Key rewrites its pushes
 * (`InputSpec.rewrites`) and returns, at each push's time:
 * - **Down** at each keydown, and at each auto-repeat with `repeat: true`; **Up** at each keyup.
 *   Each carries the push's payload, `repeat` (false on Up), and `age`: seconds since the key's
 *   keydown (0 on it).
 * - `channel`: the key's `code` (`channelOf`): a fixed channel per physical key, so live and
 *   replay agree and a recording replays the same in any patch.
 * - **All**: Down (repeats left out) and Up, tagged `phase` down and up.
 * - **Note**, with Keyboard → Note on: at each keydown (never a repeat) of a key on the two-row
 *   piano (`PIANO`), pitch from the Octave knob, velocity and duration from the Velocity and Length
 *   knobs read at the note's time, on the key's channel. Notes carry their own length (ADR 0028),
 *   so a keyup ends nothing.
 * Edge cases: a keyup for a key that isn't down (pressed before the canvas had focus) is dropped. A
 * keydown that isn't a repeat on a key already down (its keyup was lost) ends it with an Up first,
 * with the keydown's payload, and plays again. A repeat on a key that isn't down only reaches Down.
 * Pushes without a non-empty string `code` have no key and are dropped. At one time, keydowns go
 * before keyups.
 *
 * **Held**, a Signal: 1 while a key named in Held keys (codes, separated by spaces or commas) is
 * down, else 0. Channel 0 (and any non-integer channel) reads whether any of them is down; another
 * channel reads that key, if it's named. With Held keys empty, every key counts.
 *
 * Event budget: Outputs (recognizer.ts) thins repeats first, keeping RESERVE for Downs and Ups.
 *
 * State (plain data), like Pointer's: `held` the keys down as the window began, `pending` this
 * window's changes in order, `cell` the event count of the current limit window. A Held keys edit
 * keeps the state: it only changes which keys Held reads.
 */
export const key: NodeDefinition = {
  type: 'key',
  version: 1,
  label: 'Key',
  category: 'canvas-sources',
  description: 'Down and Up events from the keyboard while the canvas has focus, one channel per key, with All, a Held signal for chosen keys, and a Keyboard → Note mode on a two-row piano.',
  ports: [
    { name: 'down', type: 'event', direction: 'out', label: 'Down' },
    { name: 'up', type: 'event', direction: 'out', label: 'Up' },
    { name: 'all', type: 'event', direction: 'out', label: 'All' },
    { name: 'note', type: 'note', direction: 'out', label: 'Note' },
    { name: 'held', type: 'signal', direction: 'out', label: 'Held' },
  ],
  params: [
    { name: 'keys', kind: 'text', default: 'Space', label: 'Held keys', check: checkHeld },
    { name: 'piano', kind: 'toggle', default: false, label: 'Keyboard → Note' },
    { name: 'octave', kind: 'number', min: 0, max: 8, default: 3, step: 1, label: 'Octave', modulatable: false },
    { name: 'velocity', kind: 'number', min: 0, max: 1, default: 0.8, label: 'Velocity' },
    { name: 'length', kind: 'number', min: 0.01, max: 8, default: 0.25, unit: 's', label: 'Length' },
  ],
  input: { reads: { keydown: 'down', keyup: 'up' }, rewrites: true },
  query({ state, pushed, params, param }) {
    const held = heldOf(state);
    state.held = held;
    const outputs = new Outputs(state);
    for (const change of pendingOf(state)) step(held, change);
    const items: Change[] = [];
    for (const [port, events] of [['down', pushed.down], ['up', pushed.up]] as const) {
      for (const e of events ?? []) {
        if (!Number.isFinite(e.time) || typeof e.code !== 'string' || !e.code) continue;
        const kind = port === 'up' ? 'up' : e.repeat === true ? 'repeat' : 'down';
        items.push({ time: e.time, kind, code: e.code, payload: payloadOf(e) });
      }
    }
    // Stable: at one time, keydowns then keyups, each in push order.
    items.sort((a, b) => a.time - b.time || RANK[a.kind] - RANK[b.kind]);
    state.pending = items;
    if (!items.length) return {};
    const work = held.slice();
    const octave = params.octave as number, piano = params.piano === true;
    for (const change of items) {
      const stepped = step(work, change);
      if (!stepped) continue;
      const { time } = change;
      const { ended, contact } = stepped;
      if (ended) {
        const up: EngineEvent = { ...(change.kind === 'up' ? change.payload : ended.payload), time, channel: ended.channel, repeat: false, age: time - ended.downAt };
        if (outputs.admit(time, 2, false)) {
          outputs.push('up', up);
          outputs.push('all', { ...up, phase: 'up' });
        }
      }
      if (change.kind === 'repeat') {
        const channel = contact?.channel ?? channelOf(change.code);
        outputs.emit('down', { ...change.payload, time, channel, repeat: true, age: contact ? time - contact.downAt : 0 }, true);
      } else if (change.kind === 'down' && contact) {
        const down: EngineEvent = { ...change.payload, time, channel: contact.channel, repeat: false, age: 0 };
        const pitch = piano ? pitchOf(change.code, octave) : null;
        if (!outputs.admit(time, pitch === null ? 2 : 3, false)) continue;
        outputs.push('down', down);
        outputs.push('all', { ...down, phase: 'down' });
        if (pitch !== null) {
          const velocity = param('velocity', time, contact.channel), length = param('length', time, contact.channel);
          const note: NoteEvent = {
            time,
            channel: contact.channel,
            pitch,
            velocity: Number.isFinite(velocity) ? Math.min(1, Math.max(0, velocity)) : 0.8,
            duration: Number.isFinite(length) && length > 0 ? length : 0.25,
          };
          outputs.push('note', note);
        }
      }
    }
    return outputs.result() satisfies QueryResult;
  },
  signal(ctx, port, t, channel) {
    if (port !== 'held') return 0;
    const chosen = new Set(heldCodes(ctx.params.keys));
    const counts = (c: Contact) => chosen.size === 0 || chosen.has(c.code);
    const held = heldAt(ctx.state, t);
    const any = !Number.isInteger(channel) || channel === 0;
    return held.some((c) => counts(c) && (any || c.channel === channel)) ? 1 : 0;
  },
};
