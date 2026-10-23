// Input stream format v1 (ADR 0029): timestamped canvas events, addressed to
// no node, so one recording replays through any patch that has the sources.
// The fan-out from an event to the source nodes that read it lives here too,
// and both the editor's live host and the headless runner use it, so a stream
// can't replay differently from how it was played.
import type { EngineEvent, EventField } from './events';
import type { LivePush, Plan, Runtime } from './runtime';
import type { PushTarget } from './scheduler';

export const INPUT_FORMAT = 'flowinput';
export const INPUT_VERSION = 1;

/** The canvas events a stream records (ADR 0029). */
export const INPUT_EVENT_TYPES = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'pointerenter',
  'pointerleave',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'wheel',
  'keydown',
  'keyup',
  'gesturechange',
  'resize',
  'focus',
  'blur',
  'visibilitychange',
  'midi',
] as const;

export type InputEventType = (typeof INPUT_EVENT_TYPES)[number];

/** One canvas event as the host sees it, before it is stamped: its type and the payload the sources read. */
export interface InputFields {
  type: InputEventType;
  /** The contact (pointer, touch or key) it belongs to. Left out on events with none; it reaches the nodes as 0. */
  channel?: number;
  [field: string]: EventField | undefined;
}

/** One recorded event: `time` is seconds from the stream's start, as applied (ADR 0026, 0029). */
export interface InputEvent extends InputFields {
  time: number;
}

export interface InputStream {
  format: typeof INPUT_FORMAT;
  version: typeof INPUT_VERSION;
  /** Sorted by time; events at one time keep their order. */
  events: InputEvent[];
}

export type InputParseResult = { ok: true; stream: InputStream } | { ok: false; errors: string[] };

/**
 * The payload fields whose type is fixed (design.md "Event payload",
 * docs/nodes/canvas-sources.md). Other fields may be any number, string or
 * boolean, the way an event field can be.
 */
export const INPUT_FIELD_TYPES: Readonly<Record<string, 'number' | 'string' | 'boolean'>> = {
  x: 'number',
  y: 'number',
  pressure: 'number',
  width: 'number',
  height: 'number',
  pointerType: 'string',
  button: 'number',
  buttons: 'number',
  shift: 'boolean',
  alt: 'boolean',
  ctrl: 'boolean',
  meta: 'boolean',
  coalesced: 'boolean',
  key: 'string',
  code: 'string',
  repeat: 'boolean',
  canvasWidth: 'number',
  canvasHeight: 'number',
  status: 'number',
  data1: 'number',
  data2: 'number',
};

/** Fields the source nodes compute from the sequence, so a stream never records them (ADR 0029). */
export const DERIVED_INPUT_FIELDS: readonly string[] = ['dx', 'dy', 'speed', 'angle', 'age'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const TYPES: ReadonlySet<string> = new Set(INPUT_EVENT_TYPES);
const isEventField = (value: unknown) => typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

/** What's wrong with one event, given the previous valid event's time, or none. */
function eventProblems(raw: unknown, where: string, previous: number | null): string[] {
  if (!isRecord(raw)) return [`${where}: expected an object with time and type`];
  const errors: string[] = [];
  const { time, type, channel } = raw;
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) errors.push(`${where}.time: expected a number of seconds, 0 or more`);
  else if (previous !== null && time < previous) errors.push(`${where}.time: ${time} is before the previous event's ${previous}; events must be sorted by time`);
  if (typeof type !== 'string' || !TYPES.has(type)) errors.push(`${where}.type: unknown type ${JSON.stringify(type)}; expected one of ${INPUT_EVENT_TYPES.join(', ')}`);
  if (channel !== undefined && !Number.isInteger(channel)) errors.push(`${where}.channel: expected an integer`);
  for (const [name, value] of Object.entries(raw)) {
    if (name === 'time' || name === 'type' || name === 'channel') continue;
    if (DERIVED_INPUT_FIELDS.includes(name)) {
      errors.push(`${where}.${name}: derived field; the source nodes compute it, so streams don't record it`);
      continue;
    }
    const expected = INPUT_FIELD_TYPES[name];
    if (expected ? typeof value !== expected || (expected === 'number' && !Number.isFinite(value)) : !isEventField(value)) {
      errors.push(`${where}.${name}: expected ${expected === 'number' ? 'a finite number' : expected ? `a ${expected}` : 'a finite number, string or boolean'}`);
    }
  }
  if (raw.coalesced !== undefined && type !== 'pointermove') errors.push(`${where}.coalesced: only pointermove samples are coalesced`);
  if (type === 'midi') {
    // MIDI is channel 0; its MIDI channel is in status (ADR 0029).
    if (channel !== undefined) errors.push(`${where}.channel: midi events have none; the MIDI channel is in status`);
    const status = raw.status;
    if (status === undefined) errors.push(`${where}.status: midi events need the status byte`);
    // Recordings carry channel messages only: the host drops system messages (0xf0 and up).
    else if (typeof status === 'number' && Number.isFinite(status) && !(Number.isInteger(status) && status >= 0x80 && status <= 0xef)) {
      errors.push(`${where}.status: expected a channel message status byte, 128–239`);
    }
  }
  return errors;
}

/** Checks a parsed `<name>.inputs.json`: the format and version, each event's fields, and time order. */
export function parseInputStream(input: unknown): InputParseResult {
  if (!isRecord(input)) {
    const hint = Array.isArray(input) ? ' (the old list of { node, port, event } pushes is gone: ADR 0029)' : '';
    return { ok: false, errors: [`input stream: expected { format: "${INPUT_FORMAT}", version: ${INPUT_VERSION}, events: [...] }${hint}`] };
  }
  const errors: string[] = [];
  if (input.format !== INPUT_FORMAT) errors.push(`format: expected "${INPUT_FORMAT}", got ${JSON.stringify(input.format)}`);
  else if (input.version !== INPUT_VERSION) errors.push(`version: expected ${INPUT_VERSION}, got ${JSON.stringify(input.version)}`);
  if (!Array.isArray(input.events)) errors.push('events: expected an array');
  if (errors.length) return { ok: false, errors };
  let previous: number | null = null;
  (input.events as unknown[]).forEach((raw, i) => {
    const problems = eventProblems(raw, `events[${i}]`, previous);
    errors.push(...problems);
    const time = isRecord(raw) ? raw.time : undefined;
    if (typeof time === 'number' && Number.isFinite(time) && time >= 0 && (previous === null || time >= previous)) previous = time;
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, stream: { format: INPUT_FORMAT, version: INPUT_VERSION, events: (input.events as InputEvent[]).map((e) => ({ ...e })) } };
}

/** A stream as `<name>.inputs.json` holds it: one event per line, so recordings diff cleanly. */
export function serializeInputStream(stream: InputStream): string {
  const events = stream.events.map((e) => `    ${JSON.stringify(e)}`).join(',\n');
  return `{ "format": ${JSON.stringify(stream.format)}, "version": ${stream.version},\n  "events": [${events ? `\n${events}\n  ` : ''}] }\n`;
}

/**
 * What a canvas source node reads from the input stream (`NodeDefinition.input`):
 * each event type it reads, and the Event output the host pushes it on.
 */
export interface InputSpec {
  reads: Readonly<Partial<Record<InputEventType, string>>>;
  /** Narrows the events of a type it reads (Pointer skips coalesced moves, ADR 0029). Pure. Default: all of them. */
  accepts?(event: Readonly<InputFields>): boolean;
}

/** The event fields a source gets for an input event: its channel (0 when it has none) and its payload, without `time` and `type`. */
export function inputFields(event: Readonly<InputFields>): Omit<EngineEvent, 'time'> {
  const fields: Record<string, EventField> = { channel: event.channel ?? 0 };
  for (const [name, value] of Object.entries(event)) {
    if (name !== 'time' && name !== 'type' && name !== 'channel' && value !== undefined) fields[name] = value;
  }
  return fields as Omit<EngineEvent, 'time'>;
}

/** Routes input events to a plan's source nodes. Build one per plan. */
export interface InputRouter {
  /** Every event type some node in the plan reads, such as `contextmenu` for the host's platform rules. */
  readonly types: ReadonlySet<InputEventType>;
  reads(type: InputEventType): boolean;
  /** The source nodes reading this event, in plan order, each with its port and its own copy of the fields: one push (`Scheduler.pushAll`). */
  route(event: Readonly<InputFields>): PushTarget[];
}

export function inputRouter(plan: Pick<Plan, 'order'>): InputRouter {
  const byType = new Map<InputEventType, { node: string; port: string; spec: InputSpec }[]>();
  for (const node of plan.order) {
    const spec = node.definition.input;
    if (!spec) continue;
    for (const [type, port] of Object.entries(spec.reads) as [InputEventType, string][]) {
      let readers = byType.get(type);
      if (!readers) byType.set(type, (readers = []));
      readers.push({ node: node.id, port, spec });
    }
  }
  const types: ReadonlySet<InputEventType> = new Set(byType.keys());
  return {
    types,
    reads: (type) => types.has(type),
    route(event) {
      const readers = byType.get(event.type);
      if (!readers) return [];
      return readers.filter(({ spec }) => spec.accepts?.(event) ?? true).map(({ node, port }) => ({ node, port, fields: inputFields(event) }));
    },
  };
}

/**
 * Replays a stream into a runtime the way the live host plays it: each event
 * fans out to every source node that reads it (`inputRouter` on the runtime's
 * plan), stamped `start` + its time, as one push. The headless runner calls it
 * before the first window, so nothing rewinds.
 */
export function replayInput(runtime: Runtime, stream: { readonly events: readonly Readonly<InputEvent>[] }, start = 0): void {
  const router = inputRouter(runtime.plan);
  for (const event of stream.events) {
    const time = start + event.time;
    const pushes: LivePush[] = router.route(event).map(({ node, port, fields }) => ({ node, port, event: { time, ...fields } as EngineEvent }));
    runtime.pushAll(pushes);
  }
}
