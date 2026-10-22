// The voice pool (ADR 0011: 64 voices, oldest stolen first; audio/voices.ts):
// steals by earliest start at the stealing note's start, frees slots on release
// and lazily once voices end, and is shared by every audio instance a Runtime
// builds on one context.
import { describe, expect, it } from 'vitest';
import {
  compilePatch,
  ManualClock,
  Runtime,
  Scheduler,
  VOICE_LIMIT,
  VoicePool,
  type AudioContextLike,
  type EngineEvent,
  type NodeDefinition,
  type Patch,
  type VoiceHandle,
} from '../src';

/** A pool on a hand-set clock that records every stop it calls, as `id@at`. */
function pool(size = VOICE_LIMIT) {
  let now = 0;
  const stops: string[] = [];
  const voices = new VoicePool(() => now, size);
  const claim = (id: string, start: number, end: number) => voices.claim({ start, end, stop: (at) => void stops.push(`${id}@${at}`) });
  return { voices, stops, claim, set: (t: number) => void (now = t) };
}

describe('VoicePool', () => {
  it('holds 64 voices, and the 65th steals the earliest start, stopped at the new start', () => {
    const { voices, stops, claim } = pool();
    expect(voices.size).toBe(64);
    // Voices 0..63 start 10 ms apart and all ring past 2 s.
    const handles = Array.from({ length: 64 }, (_, i) => claim(`v${i}`, i * 0.01, 2 + i * 0.01));
    expect(stops).toEqual([]);
    expect(voices.inUse()).toBe(64);

    const late = claim('v64', 1, 3);
    expect(stops).toEqual(['v0@1']);
    expect(handles[0]!.stolen).toBe(true);
    expect(handles[0]!.end).toBe(1);
    expect(late.stolen).toBe(false);
    expect(voices.inUse()).toBe(64);

    claim('v65', 1.5, 3);
    expect(stops).toEqual(['v0@1', 'v1@1.5']);
  });

  it('breaks ties on start by claim order', () => {
    const { stops, claim } = pool(2);
    claim('a', 0, 1);
    claim('b', 0, 1);
    claim('c', 0.5, 1);
    expect(stops).toEqual(['a@0.5']);
  });

  it("doesn't steal voices that have ended by the new start", () => {
    const { voices, stops, claim } = pool(2);
    claim('a', 0, 0.5);
    claim('b', 0, 2);
    claim('c', 0.5, 2);
    expect(stops).toEqual([]);
    expect(voices.inUse()).toBe(3); // `a` ended, but the clock hasn't reached its end yet.
  });

  it('keeps the limit at later starts too: a claim older than voices scheduled after it can be the one stolen', () => {
    const { stops, claim } = pool(2);
    claim('a', 1, 2);
    claim('b', 1, 2);
    // Starts before both, so at 0.5 it sounds alone; at 1 three would sound, and it is the oldest.
    const early = claim('c', 0.5, 2);
    expect(stops).toEqual(['c@1']);
    expect(early.stolen).toBe(true);
  });

  it('frees a slot on release, so a withdrawn note steals nothing', () => {
    const { voices, stops, claim } = pool(2);
    claim('a', 0, 2);
    const b = claim('b', 0.1, 2);
    voices.release(b); // a rewind cancelled `b` before it sounded
    claim('c', 0.2, 2);
    expect(stops).toEqual([]);
    expect(voices.inUse()).toBe(2);
    voices.release(b); // releasing twice is harmless
    expect(voices.inUse()).toBe(2);
  });

  it('keeps a stolen voice cut when the note that stole it is cancelled', () => {
    const { voices, stops, claim } = pool(2);
    const a = claim('a', 0, 2);
    claim('b', 0.1, 2);
    const c = claim('c', 0.5, 2);
    expect(stops).toEqual(['a@0.5']);
    // Steals are decided at schedule time: withdrawing `c` frees its slot but doesn't bring `a` back.
    voices.release(c);
    expect(a.stolen).toBe(true);
    expect(voices.inUse()).toBe(1);
    // `a` is out of the pool, so a later claim has room and steals nothing.
    claim('d', 0.6, 2);
    expect(stops).toEqual(['a@0.5']);
  });

  it('reclaims voices once the clock passes their end', () => {
    const { voices, stops, claim, set } = pool(2);
    claim('a', 0, 0.3);
    claim('b', 0, 0.4);
    expect(voices.inUse()).toBe(2);
    set(0.35);
    expect(voices.inUse()).toBe(1);
    set(0.4);
    expect(voices.inUse()).toBe(0);
    claim('c', 0.5, 1);
    claim('d', 0.5, 1);
    expect(stops).toEqual([]);
  });

  it('moves an end: earlier frees the slot sooner, later can steal from the old end on', () => {
    const { voices, stops, claim } = pool(2);
    const a = claim('a', 0, 2);
    claim('b', 0, 2);
    voices.setEnd(a, 0.4); // note-off came early
    claim('c', 0.5, 2);
    expect(stops).toEqual([]);
    // Holding `a` again past 0.5 makes three voices at c's start; `a` is the oldest.
    voices.setEnd(a, 1);
    expect(stops).toEqual(['a@0.5']);
    // A stolen voice's end stays where it was cut.
    voices.setEnd(a, 3);
    expect(a.end).toBe(0.5);
  });

  it('keeps its place among equal starts when its end moves', () => {
    const { voices, stops, claim } = pool(2);
    const a = claim('a', 0, 2);
    claim('b', 0, 2);
    voices.setEnd(a, 3);
    claim('c', 0.5, 2);
    expect(stops).toEqual(['a@0.5']);
  });

  it('holds an Infinity end until told, and gives NaN times no slot', () => {
    const { voices, stops, claim, set } = pool(2);
    const held = claim('held', 0, Infinity);
    set(100);
    expect(voices.inUse()).toBe(1);

    // A NaN end ends at once, at the start; so does a non-finite start. Neither counts or steals.
    const nanEnd = claim('nanEnd', 100, NaN);
    expect(nanEnd.end).toBe(100);
    const nanStart = claim('nanStart', NaN, 101);
    expect(voices.inUse()).toBe(1);
    voices.release(nanEnd);
    voices.release(nanStart);
    claim('b', 100, 101);
    expect(stops).toEqual([]);

    // setEnd(NaN) ends the voice at its start and frees its slot.
    voices.setEnd(held, NaN);
    expect(held.end).toBe(0);
    expect(voices.inUse()).toBe(1);
    claim('c', 100, 101);
    claim('d', 100.5, 101);
    expect(stops).toEqual(['b@100.5']);
  });

  it('steals what a plain scan over every voice would, under random claims, releases and end moves', () => {
    // The rule written out directly: at each start in the added time, steal the earliest start sounding there.
    type Ref = { id: string; start: number; end: number; at: number };
    const reference = (pooled: Ref[], from: number, to: number, size: number, stops: string[]) => {
      const starts = [...new Set(pooled.map((v) => v.start).filter((t) => t >= from && t < to))].sort((a, b) => a - b);
      for (const at of starts) {
        for (;;) {
          const sounding = pooled.filter((v) => v.start <= at && at < v.end).sort((a, b) => a.start - b.start || a.at - b.at);
          if (sounding.length <= size) break;
          const victim = sounding[0]!;
          pooled.splice(pooled.indexOf(victim), 1);
          stops.push(`${victim.id}@${at}`);
        }
      }
    };
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    let steals = 0;
    for (let round = 0; round < 20; round++) {
      const { voices, stops, claim } = pool(4);
      const expected: string[] = [];
      let pooled: Ref[] = [];
      const handles: [VoiceHandle, Ref][] = [];
      for (let i = 0; i < 120; i++) {
        const roll = random();
        if (roll < 0.15 && handles.length) {
          const [handle, ref] = handles[Math.floor(random() * handles.length)]!;
          voices.release(handle);
          pooled = pooled.filter((v) => v !== ref);
        } else if (roll < 0.3 && handles.length) {
          const [handle, ref] = handles[Math.floor(random() * handles.length)]!;
          const end = ref.start + Math.round(random() * 20) / 10;
          voices.setEnd(handle, end);
          if (pooled.includes(ref)) {
            if (!(end > ref.start)) pooled = pooled.filter((v) => v !== ref);
            else {
              const before = ref.end;
              ref.end = end;
              if (end > before) reference(pooled, before, end, 4, expected);
            }
          }
        } else {
          // Starts on a coarse grid, so ties happen, and not always in order.
          const start = Math.round(random() * 40) / 10, end = start + Math.round(random() * 15) / 10;
          const ref = { id: `v${i}`, start, end, at: i };
          handles.push([claim(ref.id, start, end), ref]);
          if (end > start) {
            pooled.push(ref);
            reference(pooled, start, end, 4, expected);
          }
        }
      }
      expect(stops).toEqual(expected);
      expect(voices.inUse()).toBe(pooled.length);
      steals += stops.length;
    }
    expect(steals).toBeGreaterThan(100);
  });

  it('steals the same voices for the same claims, however the clock was read between them', () => {
    const run = (clockAt: (i: number) => number) => {
      const { stops, claim, set } = pool(4);
      for (let i = 0; i < 40; i++) {
        set(clockAt(i));
        claim(`v${i}`, 0.1 * i + 0.2, 0.1 * i + 0.2 + 0.05 * (i % 7) + 0.3);
      }
      return stops;
    };
    const ahead = run((i) => 0.1 * i); // the clock 200 ms behind each note
    expect(ahead.length).toBeGreaterThan(0);
    expect(run((i) => 0.1 * i + 0.2)).toEqual(ahead); // the clock right at each note
    expect(run(() => 0)).toEqual(ahead); // never reclaimed at all
  });
});

/** An instrument that claims a voice per event, ringing RING seconds, and releases it when the event is withdrawn. */
const RING = 0.5;
function pooledTypes(pools: VoicePool[]): NodeDefinition[] {
  const metro: NodeDefinition = {
    type: 'metro', version: 1, label: 'Metro', category: 'time-rhythm', description: '',
    ports: [{ name: 'out', type: 'event', direction: 'out' }],
    params: [],
    query: ({ t0, t1 }) => {
      const out: EngineEvent[] = [];
      for (let k = Math.ceil(t0 / 0.025); k * 0.025 < t1; k++) out.push({ time: k * 0.025, channel: 0 });
      return { out };
    },
  };
  const voice: NodeDefinition = {
    type: 'pooled', version: 1, label: 'Pooled', category: 'instruments', description: '',
    ports: [{ name: 'in', type: 'event', direction: 'in' }],
    params: [{ name: 'tone', kind: 'number', min: 0, max: 1, default: 0.5 }],
    audio: ({ voices }) => {
      pools.push(voices);
      const held = new Map<EngineEvent, VoiceHandle>();
      return {
        schedule: (_port, events) => {
          for (const e of events) held.set(e, voices.claim({ start: e.time, end: e.time + RING, stop: () => {} }));
        },
        cancel: (_port, events) => {
          for (const e of events) {
            voices.release(held.get(e)!);
            held.delete(e);
          }
        },
        idleAt: () => Math.max(0, ...[...held.values()].map((h) => h.end)),
      };
    },
  };
  return [metro, voice];
}

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: 1, params, position: { x: 0, y: 0 } });
const patch = (tone: number): Patch => ({
  format: 'flowpatch', version: 1, seed: 1,
  nodes: [node('m', 'metro'), node('v', 'pooled', { tone })],
  cables: [{ from: { node: 'm', port: 'out' }, to: { node: 'v', port: 'in' } }],
});
const fakeContext = (clock: ManualClock): AudioContextLike => ({ get currentTime() { return clock.audio; } }) as AudioContextLike;

describe('Runtime voice pool', () => {
  function setup() {
    const pools: VoicePool[] = [];
    const definitions = new Map(pooledTypes(pools).map((d) => [d.type, d]));
    const compile = (p: Patch) => {
      const compiled = compilePatch(p, definitions);
      if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
      return compiled.plan;
    };
    return { pools, compile };
  }

  it('shares one pool between an audio instance and the one a hot swap rebuilds, and the old one releases on cancel', () => {
    const { pools, compile } = setup();
    const clock = new ManualClock();
    const runtime = new Runtime(compile(patch(0.5)));
    runtime.attachAudio(fakeContext(clock));
    const scheduler = new Scheduler(runtime, { clock });
    for (let k = 0; k < 20; k++) {
      clock.set(k * 0.025);
      scheduler.wake();
    }
    clock.set(0.5);
    // Every 25 ms note rings 500 ms: 20 sound at once, and the old instance has scheduled up to the horizon.
    const before = pools[0]!.inUse();
    expect(before).toBeGreaterThan(20);
    const report = scheduler.swap(compile(patch(0.9))); // a param change rebuilds the instance
    expect(pools).toHaveLength(2);
    expect(pools[1]).toBe(pools[0]);
    // The old instance's withdrawn notes freed their slots, and the new one claimed the re-run's in their place.
    expect(report.cancelled).toBeGreaterThan(0);
    expect(pools[0]!.inUse()).toBe(before);
    runtime.dispose();
  });

  it('gives a new context a fresh pool, and the same context the same one', () => {
    const { pools, compile } = setup();
    const clock = new ManualClock();
    const first = new Runtime(compile(patch(0.5)));
    const context = fakeContext(clock);
    first.attachAudio(context);
    first.dispose();
    first.attachAudio(context);
    expect(pools[1]).toBe(pools[0]);
    first.attachAudio(fakeContext(clock));
    expect(pools[2]).not.toBe(pools[0]);
    // A new live attempt: a new Runtime on a new context.
    const second = new Runtime(compile(patch(0.5)));
    second.attachAudio(fakeContext(clock));
    expect(new Set(pools).size).toBe(3);
    second.dispose();
  });
});
