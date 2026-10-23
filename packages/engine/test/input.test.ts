// Input stream format v1 and its fan-out to source nodes (ADR 0029).
import { describe, expect, it } from 'vitest';
import {
  compilePatch,
  inputFields,
  inputRouter,
  INPUT_EVENT_TYPES,
  ManualClock,
  parseInputStream,
  replayInput,
  Runtime,
  Scheduler,
  serializeInputStream,
  type EngineEvent,
  type InputEvent,
  type InputFields,
  type NodeDefinition,
  type Patch,
} from '../src';

const stream = (events: unknown[]) => ({ format: 'flowinput', version: 1, events });
const down = { time: 0.4, type: 'pointerdown', channel: 1, x: 0.2, y: 0.4, pressure: 0.6, pointerType: 'touch' };
const up = { time: 0.48, type: 'pointerup', channel: 1, x: 0.2, y: 0.4, pressure: 0, pointerType: 'touch' };
const errorsOf = (input: unknown) => {
  const parsed = parseInputStream(input);
  return parsed.ok ? [] : parsed.errors;
};

describe('parseInputStream', () => {
  it('accepts a v1 stream and keeps every field verbatim, pressure 0 on up included', () => {
    const parsed = parseInputStream(stream([down, up, { time: 0.48, type: 'resize', canvasWidth: 800, canvasHeight: 600 }]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.stream.events).toEqual([down, up, { time: 0.48, type: 'resize', canvasWidth: 800, canvasHeight: 600 }]);
    expect(parsed.stream.events[1]!.pressure).toBe(0);
  });

  it('accepts every documented type, and an empty stream', () => {
    // A midi event needs its status byte; every other type stands on its own.
    expect(errorsOf(stream(INPUT_EVENT_TYPES.map((type) => ({ time: 1, type, ...(type === 'midi' ? { status: 0x90, data1: 60, data2: 1 } : {}) }))))).toEqual([]);
    expect(errorsOf(stream([]))).toEqual([]);
  });

  it('rejects a wrong format or version, and says the old push list is gone', () => {
    expect(errorsOf({ ...stream([]), format: 'flowpatch' })).toEqual(['format: expected "flowinput", got "flowpatch"']);
    expect(errorsOf({ ...stream([]), version: 2 })).toEqual(['version: expected 1, got 2']);
    expect(errorsOf({ format: 'flowinput', version: 1 })).toEqual(['events: expected an array']);
    expect(errorsOf([{ node: 'pointer', port: 'down', event: { time: 0, channel: 0 } }])[0]).toMatch(/expected \{ format: "flowinput".*\{ node, port, event \}.*ADR 0029/);
    expect(errorsOf('nope')[0]).toMatch(/^input stream: expected/);
  });

  it('rejects unsorted times, naming both', () => {
    expect(errorsOf(stream([up, down]))).toEqual(["events[1].time: 0.4 is before the previous event's 0.48; events must be sorted by time"]);
    // Equal times are in order.
    expect(errorsOf(stream([down, { ...up, time: 0.4 }]))).toEqual([]);
  });

  it('rejects a missing, negative or non-finite time', () => {
    expect(errorsOf(stream([{ type: 'blur' }, { time: -1, type: 'blur' }, { time: 'soon', type: 'blur' }]))).toEqual([
      'events[0].time: expected a number of seconds, 0 or more',
      'events[1].time: expected a number of seconds, 0 or more',
      'events[2].time: expected a number of seconds, 0 or more',
    ]);
  });

  it('rejects an unknown or missing type', () => {
    const [unknown, missing] = [errorsOf(stream([{ time: 0, type: 'pointerrawupdate' }])), errorsOf(stream([{ time: 0 }]))];
    expect(unknown).toEqual([expect.stringMatching(/^events\[0\]\.type: unknown type "pointerrawupdate"; expected one of pointerdown, /)]);
    expect(missing).toEqual([expect.stringMatching(/^events\[0\]\.type: unknown type undefined/)]);
  });

  it('rejects wrong field types', () => {
    expect(errorsOf(stream([
      { ...down, channel: 1.5 },
      { ...down, x: '0.2' },
      { ...down, pressure: null },
      { ...down, pointerType: 3 },
      { ...down, shift: 1 },
      { time: 0.4, type: 'keydown', key: 'a', code: 'KeyA', repeat: 'no' },
      { ...down, extra: { nested: true } },
      { ...down, y: Infinity },
      'pointerdown',
    ]))).toEqual([
      'events[0].channel: expected an integer',
      'events[1].x: expected a finite number',
      'events[2].pressure: expected a finite number',
      'events[3].pointerType: expected a string',
      'events[4].shift: expected a boolean',
      'events[5].repeat: expected a boolean',
      'events[6].extra: expected a finite number, string or boolean',
      'events[7].y: expected a finite number',
      'events[8]: expected an object with time and type',
    ]);
  });

  it('checks MIDI status, data1 and data2 as numbers (#77)', () => {
    const noteOn = { time: 0.4, type: 'midi', status: 0x90, data1: 60, data2: 100 };
    expect(errorsOf(stream([noteOn]))).toEqual([]);
    expect(errorsOf(stream([
      { ...noteOn, data1: '60' },
      { ...noteOn, data2: NaN },
      { ...noteOn, status: '144' },
    ]))).toEqual([
      'events[0].data1: expected a finite number',
      'events[1].data2: expected a finite number',
      'events[2].status: expected a finite number',
    ]);
  });

  it('requires status on midi events and rejects a channel on them (#77)', () => {
    expect(errorsOf(stream([
      { time: 0.4, type: 'midi', data1: 60, data2: 100 },
      { time: 0.4, type: 'midi', channel: 3, status: 0x92, data1: 60, data2: 100 },
      { time: 0.4, type: 'midi', status: 0xc0, data1: 5 },
    ]))).toEqual([
      'events[0].status: midi events need the status byte',
      'events[1].channel: midi events have none; the MIDI channel is in status',
    ]);
  });

  it('rejects derived fields, and coalesced on anything but a move', () => {
    expect(errorsOf(stream([{ ...down, dx: 0.1, age: 0 }, { ...down, coalesced: true }, { ...down, type: 'pointermove', coalesced: true }]))).toEqual([
      "events[0].dx: derived field; the source nodes compute it, so streams don't record it",
      "events[0].age: derived field; the source nodes compute it, so streams don't record it",
      'events[1].coalesced: only pointermove samples are coalesced',
    ]);
  });

  it('serializes one event per line, and that parses back to the same stream', () => {
    const parsed = parseInputStream(stream([down, up]));
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const text = serializeInputStream(parsed.stream);
    expect(text.split('\n')).toHaveLength(6);
    const again = parseInputStream(JSON.parse(text));
    expect(again.ok && serializeInputStream(again.stream)).toBe(text);
    expect(serializeInputStream({ format: 'flowinput', version: 1, events: [] })).toBe('{ "format": "flowinput", "version": 1,\n  "events": [] }\n');
  });
});

/** A Pointer-like source: no query, its events arrive by push. */
const pointerish: NodeDefinition = {
  type: 'pointerish', version: 1, label: 'Pointerish', category: 'canvas-sources', description: '',
  ports: ['down', 'move', 'up', 'cancel'].map((name) => ({ name, type: 'event' as const, direction: 'out' as const })),
  params: [],
  input: { reads: { pointerdown: 'down', pointermove: 'move', pointerup: 'up', pointercancel: 'cancel' }, accepts: (e) => e.coalesced !== true },
};
/** Reads only coalesced moves, as Pointer (high rate) will. */
const fine: NodeDefinition = {
  type: 'fine', version: 1, label: 'Fine', category: 'canvas-sources', description: '',
  ports: [{ name: 'sample', type: 'event', direction: 'out' }],
  params: [],
  input: { reads: { pointermove: 'sample' }, accepts: (e) => e.coalesced === true },
};
const keys: NodeDefinition = {
  type: 'keys', version: 1, label: 'Keys', category: 'canvas-sources', description: '',
  ports: [{ name: 'down', type: 'event', direction: 'out' }, { name: 'menu', type: 'event', direction: 'out' }],
  params: [],
  input: { reads: { keydown: 'down', contextmenu: 'menu' } },
};
/** Numbers every event per channel, so ordering and state show in the log. */
const counter: NodeDefinition = {
  type: 'counter', version: 1, label: 'Counter', category: 'control-logic', description: '',
  ports: [{ name: 'in', type: 'event', direction: 'in' }, { name: 'out', type: 'event', direction: 'out' }],
  params: [],
  query: ({ inputs, state }) => {
    const counts = ((state.counts as Record<string, number> | undefined) ??= {});
    return { out: (inputs.in ?? []).map((e) => ({ time: e.time, channel: e.channel, count: (counts[e.channel] = (counts[e.channel] ?? 0) + 1), x: e.x ?? -1 })) };
  },
};
const registry = new Map([pointerish, fine, keys, counter].map((d) => [d.type, d]));
const node = (id: string, type: string) => ({ id, type, typeVersion: 1, params: {}, position: { x: 0, y: 0 } });
const cable = (from: string, fromPort: string, to: string) => ({ from: { node: from, port: fromPort }, to: { node: to, port: 'in' } });
const patchOf = (nodes: Patch['nodes'], cables: Patch['cables']): Patch => ({ format: 'flowpatch', version: 1, seed: 1, nodes, cables });
const compile = (p: Patch) => {
  const compiled = compilePatch(p, registry);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return compiled.plan;
};

describe('inputRouter', () => {
  const plan = compile(patchOf([node('k', 'keys'), node('p1', 'pointerish'), node('f', 'fine'), node('p2', 'pointerish')], []));
  const router = inputRouter(plan);

  it('knows which types the plan reads', () => {
    expect([...router.types].sort()).toEqual(['contextmenu', 'keydown', 'pointercancel', 'pointerdown', 'pointermove', 'pointerup']);
    expect(router.reads('contextmenu')).toBe(true);
    expect(router.reads('wheel')).toBe(false);
    expect(inputRouter(compile(patchOf([node('p', 'pointerish')], []))).reads('contextmenu')).toBe(false);
  });

  it('sends an event to every node that reads it, in plan order, each with its own fields', () => {
    const { time: _time, ...fields } = down;
    const targets = router.route(fields as InputFields);
    expect(targets.map((t) => [t.node, t.port])).toEqual([['p1', 'down'], ['p2', 'down']]);
    expect(targets[0]!.fields).toEqual({ channel: 1, x: 0.2, y: 0.4, pressure: 0.6, pointerType: 'touch' });
    expect(targets[0]!.fields).not.toBe(targets[1]!.fields);
    // Field order is the stream's, after channel: logs keep the same bytes as the old push files.
    expect(Object.keys(targets[0]!.fields)).toEqual(['channel', 'x', 'y', 'pressure', 'pointerType']);
  });

  it('applies each definition\'s filter: coalesced moves go to the fine source only', () => {
    expect(router.route({ type: 'pointermove', channel: 1, x: 0.3, coalesced: true }).map((t) => t.node)).toEqual(['f']);
    expect(router.route({ type: 'pointermove', channel: 1, x: 0.3 }).map((t) => t.node)).toEqual(['p1', 'p2']);
    expect(router.route({ type: 'wheel', deltaY: 3 })).toEqual([]);
  });

  it('gives an event with no channel channel 0', () => {
    expect(inputFields({ type: 'contextmenu', x: 0.5 })).toEqual({ channel: 0, x: 0.5 });
    expect(router.route({ type: 'contextmenu', x: 0.5 })).toEqual([{ node: 'k', port: 'menu', fields: { channel: 0, x: 0.5 } }]);
  });
});

describe('replayInput', () => {
  const events: InputEvent[] = [
    { time: 0.1, type: 'pointerdown', channel: 1, x: 0.1, y: 0.2, pressure: 0.5, pointerType: 'mouse' },
    { time: 0.13, type: 'pointermove', channel: 1, x: 0.2, y: 0.2, pressure: 0.5, pointerType: 'mouse' },
    { time: 0.13, type: 'pointermove', channel: 1, x: 0.25, y: 0.2, pressure: 0.5, pointerType: 'mouse', coalesced: true },
    { time: 0.2, type: 'pointerdown', channel: 2, x: 0.7, y: 0.7, pressure: 0.5, pointerType: 'touch' },
    { time: 0.2, type: 'keydown', channel: 65, key: 'a', code: 'KeyA', repeat: false },
    { time: 0.31, type: 'pointerup', channel: 1, x: 0.2, y: 0.2, pressure: 0, pointerType: 'mouse' },
    { time: 0.5, type: 'pointercancel', channel: 2, x: 0.7, y: 0.7, pressure: 0, pointerType: 'touch' },
  ];
  const p = patchOf(
    [node('p', 'pointerish'), node('f', 'fine'), node('k', 'keys'), node('c', 'counter')],
    [cable('p', 'down', 'c'), cable('p', 'move', 'c'), cable('f', 'sample', 'c'), cable('k', 'down', 'c'), cable('p', 'up', 'c')],
  );
  const run = (patch: Patch, window: number, start = 0) => {
    const runtime = new Runtime(compile(patch));
    replayInput(runtime, { events }, start);
    const clock = new ManualClock();
    const scheduler = new Scheduler(runtime, { clock, wakeInterval: window, lookahead: Math.max(0.12, window), record: true });
    for (let k = 0; k * window < 1; k++) {
      clock.set(k * window);
      scheduler.wake();
    }
    return scheduler.events().filter((e) => e.time < 1);
  };

  it('pushes each event onto the outputs its type maps to, at its time', () => {
    const log = run(p, 0.025);
    expect(log.filter((e) => e.node !== 'c').map((e) => [e.time, e.node, e.port])).toEqual([
      [0.1, 'p', 'down'], [0.13, 'p', 'move'], [0.13, 'f', 'sample'], [0.2, 'p', 'down'], [0.2, 'k', 'down'], [0.31, 'p', 'up'], [0.5, 'p', 'cancel'],
    ]);
    expect(log.find((e) => e.node === 'p' && e.port === 'up')).toEqual({ node: 'p', port: 'up', time: 0.31, channel: 1, x: 0.2, y: 0.2, pressure: 0, pointerType: 'mouse' });
  });

  it('gives byte-identical logs whatever the window size, and run to run', () => {
    const reference = JSON.stringify(run(p, 0.025));
    for (const window of [0.01, 0.0173, 0.1, 1]) expect(JSON.stringify(run(p, window)), `${window}`).toBe(reference);
    expect(JSON.stringify(run(p, 0.025))).toBe(reference);
  });

  it('replays through any patch with the sources: node ids never appear in the stream', () => {
    const renamed = patchOf(
      [node('counter-2', 'counter'), node('keys-9', 'keys'), node('src', 'pointerish'), node('hi', 'fine')],
      [cable('src', 'down', 'counter-2'), cable('src', 'move', 'counter-2'), cable('hi', 'sample', 'counter-2'), cable('keys-9', 'down', 'counter-2'), cable('src', 'up', 'counter-2')],
    );
    const rename: Record<string, string> = { 'counter-2': 'c', 'keys-9': 'k', src: 'p', hi: 'f' };
    const strip = (log: { node: string }[]) => log.map((e) => ({ ...e, node: rename[e.node] ?? e.node }));
    const sort = (log: object[]) => log.map((e) => JSON.stringify(e)).sort();
    expect(sort(strip(run(renamed, 0.025)))).toEqual(sort(run(p, 0.025)));
  });

  it('stamps at the start + each time', () => {
    const times = run(p, 0.025, 0.25).filter((e) => e.node === 'p').map((e) => e.time);
    expect(times).toEqual([0.35, 0.38, 0.45, 0.56, 0.75].map((t) => expect.closeTo(t, 12)));
  });

  it('a live push of the same events at their recorded times gives the same log as the replay', () => {
    // As the editor would play it: each event routed at its moment, all its targets in one push.
    const runtime = new Runtime(compile(p));
    const clock = new ManualClock();
    const scheduler = new Scheduler(runtime, { clock, record: true, immediateOffset: 0 });
    const router = inputRouter(runtime.plan);
    let next = 0;
    for (let k = 0; k * 0.025 < 1; k++) {
      clock.set(k * 0.025);
      scheduler.wake();
      for (; next < events.length && events[next]!.time < (k + 1) * 0.025; next++) {
        const { time, ...fields } = events[next]!;
        clock.set(time);
        const pushed = scheduler.pushAll(router.route(fields))!;
        expect(pushed.every((e: EngineEvent) => e.time === time)).toBe(true);
      }
    }
    expect(JSON.stringify(scheduler.events().filter((e) => e.time < 1))).toBe(JSON.stringify(run(p, 0.025)));
  });
});
