// Hot patching with the real nodes, through the headless runner's scripted
// edits (tools/lib/run.ts). Gate check "Hot swap" (docs/milestones.md, M1):
// Clock → Euclidean → Probability → Make Note → Sampled Voice under 100 seeded
// edits, on the real samples (the runner preloads them). Also ADR 0021's rule
// that a knob change takes effect at the new plan's first window, when a tap
// rewinds to before the swap. The swap mechanics are packages/engine/test/hot-swap.test.ts.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPatchEdits,
  compareEvents,
  createNodeContext,
  createRng,
  parsePatch,
  resolveParams,
  type AudioContextLike,
  type EngineEvent,
  type LoggedEvent,
  type NodeDefinition,
  type ParamValue,
  type Patch,
  type PatchEdit,
  type Runtime,
  type Transport,
} from '@flow-patcher/engine';
import { nodeRegistry, sampledVoice, skippedNotes } from '@flow-patcher/nodes';
import { formatEvents, loadEdits, loadPatch, runPatch, scriptedEdits, type RunEdit } from './lib/run';
import { ROOT } from '../test-support/golden';

const version = (type: string) => nodeRegistry.get(type)?.version ?? 1;
const node = (id: string, type: string, params: Record<string, ParamValue> = {}, typeVersion = version(type)) => ({ id, type, typeVersion, params, position: { x: 0, y: 0 } });
const cable = (from: string, fromPort: string, to: string, toPort: string) => ({ from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
function makePatch(nodes: unknown[], cables: unknown[], seed = 22): Patch {
  const parsed = parsePatch({ format: 'flowpatch', version: 1, seed, nodes, cables });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.patch;
}

describe('a knob change across a rewind (ADR 0021)', () => {
  // Reads the Clock's Transport and Phase at every event it gets, ticks and taps alike.
  const reader: NodeDefinition = {
    type: 'reader', version: 1, label: 'Reader', category: 'control-logic', description: '',
    ports: [
      { name: 'in', type: 'event', direction: 'in' },
      { name: 'transport', type: 'value', direction: 'in' },
      { name: 'phase', type: 'signal', direction: 'in' },
      { name: 'out', type: 'event', direction: 'out' },
    ],
    params: [],
    query: ({ inputs, value, signal }) => ({
      out: (inputs.in ?? []).map((e) => ({ time: e.time, channel: e.channel, beat: value('transport', e.time) as number, phase: signal('phase', e.time) })),
    }),
  };
  const pusher: NodeDefinition = { type: 'pusher', version: 1, label: 'Pusher', category: 'canvas-sources', description: '', ports: [{ name: 'out', type: 'event', direction: 'out' }], params: [] };
  const registry = new Map(nodeRegistry).set('reader', reader).set('pusher', pusher);
  const patch = () => makePatch(
    [node('clock', 'clock', { bpm: 120, division: '1/16' }), node('pusher', 'pusher'), node('read', 'reader')],
    [cable('clock', 'tick', 'read', 'in'), cable('pusher', 'out', 'read', 'in'), cable('clock', 'transport', 'read', 'transport'), cable('clock', 'phase', 'read', 'phase')],
  );

  /** The swap at 1.001 s takes effect at the window boundary 1.02 s; the tap at 1.002 s lands at 1.007 s, before it. */
  async function run(withTap: boolean) {
    const seen: { swapAt?: number; tapAt?: number; anchors?: number[] } = {};
    const anchors = (runtime: Runtime) => ((runtime.stateOf('clock') as { transport: Transport }).transport.anchors.map((a) => a.time));
    const edits: RunEdit[] = [{ time: 1.001, apply: (r) => void (seen.swapAt = r.edit([{ op: 'set-param', node: 'clock', param: 'bpm', value: 90 }]).time) }];
    if (withTap) {
      edits.push({
        time: 1.002,
        apply: (r) => {
          seen.tapAt = r.scheduler.push('pusher', 'out', { channel: 0 })!.time;
          seen.anchors = anchors(r.runtime);
        },
      });
    } else edits.push({ time: 1.002, apply: (r) => void (seen.anchors = anchors(r.runtime)) });
    const result = await runPatch(patch(), { seconds: 3, fps: 0, audio: false }, { registry, edits });
    return { ...seen, events: result.events, rewinds: result.scheduler.rewinds };
  }

  it('re-anchors Clock at the swap, not where the rewind starts replaying', async () => {
    const [tapped, plain] = [await run(true), await run(false)];
    const T = tapped.swapAt!;
    expect(T).toBeCloseTo(1.02, 9);
    expect(tapped.tapAt!).toBeLessThan(T);
    expect(tapped.rewinds).toBe(1);
    // Right after the rewind, the transport has its start and one anchor at the swap, as without it.
    expect(tapped.anchors).toEqual([0, T]);
    expect(plain.anchors).toEqual([0, T]);
    // Every tick, and every Transport and Phase read at a tick, matches the run without the tap.
    const withoutTap = (events: LoggedEvent[]) => events.filter((e) => e.time !== tapped.tapAt);
    expect(formatEvents(withoutTap(tapped.events))).toBe(formatEvents(plain.events));
    // The tap itself read the old tempo: 120 bpm is 2 beats a second.
    const tapRead = tapped.events.find((e) => e.node === 'read' && e.time === tapped.tapAt)!;
    expect(tapRead.beat).toBeCloseTo(tapped.tapAt! * 2, 9);
  });
});

describe('Hot swap gate: Clock → Euclidean → Probability → Make Note → Sampled Voice under 100 edits', () => {
  const SECONDS = 10;
  const EDITS = 100;
  const PAIRS = 10;

  const initial = () => makePatch(
    [
      node('clock', 'clock', { bpm: 132, division: '1/16' }),
      node('euclid', 'euclidean', { hits: 7, steps: 16 }),
      node('prob', 'probability', { chance: 0.8 }),
      node('note', 'make-note', { pitch: 57, length: 0.15 }),
      node('synth', 'sampled-voice', { instrument: 'vibes', release: 0.2, level: 0.8 }),
      node('out', 'output', { level: 0.7 }),
    ],
    [cable('clock', 'tick', 'euclid', 'tick'), cable('euclid', 'hit', 'prob', 'in'), cable('prob', 'out', 'note', 'trigger'), cable('note', 'note', 'synth', 'note'), cable('synth', 'audio', 'out', 'audio')],
  );

  const has = (p: Patch, id: string) => p.nodes.some((n) => n.id === id);
  const hasCable = (p: Patch, from: string, to: string) => p.cables.some((c) => c.from.node === from && c.to.node === to);
  type Kind = 'knob' | 'cable' | 'node';

  /** 100 seeded edits, each valid for the patch the ones before it leave. */
  function script(): { time: number; kind: Kind; target: string; edits: PatchEdit[] }[] {
    const rng = createRng(22);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rng.next() * list.length)]!;
    const int = (lo: number, hi: number) => lo + Math.floor(rng.next() * (hi - lo + 1));
    const round = (x: number) => Math.round(x * 100) / 100;
    // PAIRS of the edits come 0.4 ms after another, so both swaps land in one wake on one boundary.
    const single = Array.from({ length: EDITS - PAIRS }, () => round(0.3 + rng.next() * (SECONDS - 0.6)) + 0.0013);
    const times = [...single, ...single.slice(0, PAIRS).map((t) => t + 0.0004)].sort((a, b) => a - b);
    let p = initial();
    return times.map((time) => {
      const roll = rng.next();
      let kind: Kind = roll < 0.5 ? 'knob' : roll < 0.75 ? 'cable' : 'node';
      let target = '';
      let edits: PatchEdit[] = [];
      if (kind === 'cable') {
        if (has(p, 'prob') && rng.next() < 0.5) {
          // Bypass Euclidean or put it back: one cable out, another in.
          target = 'prob';
          const [from, port] = hasCable(p, 'euclid', 'prob') ? ['euclid', 'hit'] : ['clock', 'tick'];
          const [to, toPort] = from === 'euclid' ? ['clock', 'tick'] : ['euclid', 'hit'];
          edits = [{ op: 'remove-cable', from: { node: from, port }, to: { node: 'prob', port: 'in' } }, { op: 'add-cable', cable: cable(to, toPort, 'prob', 'in') }];
        } else {
          target = 'synth';
          edits = hasCable(p, 'note', 'synth')
            ? [{ op: 'remove-cable', from: { node: 'note', port: 'note' }, to: { node: 'synth', port: 'note' } }]
            : [{ op: 'add-cable', cable: cable('note', 'note', 'synth', 'note') }];
        }
      } else if (kind === 'node') {
        // Probability comes back sooner than it goes, so the main line plays most of the time.
        if (rng.next() < (has(p, 'prob') ? 0.6 : 0.3)) {
          // A second branch into the synth, added and removed whole.
          target = 'branch';
          edits = has(p, 'prob2')
            ? [{ op: 'remove-node', node: 'prob2' }, { op: 'remove-node', node: 'note2' }]
            : [
              { op: 'add-node', node: node('prob2', 'probability', { chance: round(0.3 + rng.next() * 0.6) }) },
              { op: 'add-node', node: node('note2', 'make-note', { pitch: int(60, 76), length: 0.1 }) },
              { op: 'add-cable', cable: cable('euclid', 'hit', 'prob2', 'in') },
              { op: 'add-cable', cable: cable('prob2', 'out', 'note2', 'trigger') },
              { op: 'add-cable', cable: cable('note2', 'note', 'synth', 'note') },
            ];
        } else {
          target = 'prob';
          edits = has(p, 'prob')
            ? [{ op: 'remove-node', node: 'prob' }]
            : [{ op: 'add-node', node: node('prob', 'probability', { chance: 0.7 }) }, { op: 'add-cable', cable: cable('euclid', 'hit', 'prob', 'in') }, { op: 'add-cable', cable: cable('prob', 'out', 'note', 'trigger') }];
        }
      } else {
        kind = 'knob';
        target = pick(['clock', 'clock', 'euclid', 'prob', 'note', 'synth', 'prob2', 'note2'].filter((id) => has(p, id)));
        const set = (param: string, value: number | string): PatchEdit => ({ op: 'set-param', node: target, param, value });
        switch (target) {
          case 'clock': edits = [rng.next() < 0.8 ? set('bpm', int(10, 16) * 10) : set('division', pick(['1/8', '1/16', '1/16T']))]; break;
          case 'euclid': edits = [pick([set('hits', int(4, 16)), set('steps', int(8, 16)), set('rotate', int(-4, 4))])]; break;
          case 'prob': case 'prob2': edits = [set('chance', round(0.4 + rng.next() * 0.6))]; break;
          case 'note': case 'note2': edits = [pick([set('pitch', int(48, 72)), set('length', round(0.05 + rng.next() * 0.25))])]; break;
          case 'synth': edits = [pick([set('release', round(0.05 + rng.next() * 0.4)), set('level', round(0.6 + rng.next() * 0.4))])]; break;
        }
      }
      p = applyPatchEdits(p, edits);
      return { time, kind, target, edits };
    });
  }

  /** Every Sampled Voice instance the run builds, by audio context, recording what it was handed. */
  interface Voice {
    live: Set<EngineEvent>;
    disposedAt: number | null;
    idleAtDispose: number;
  }
  /** `voices` and `failures` are per audio context: a live run that starts over gets a new one. */
  function recordingSynth(voices: Map<AudioContextLike, Voice[]>, failuresBy: Map<AudioContextLike, string[]>): NodeDefinition {
    return {
      ...sampledVoice,
      audio(ctx) {
        const inner = sampledVoice.audio!(ctx);
        const voice: Voice = { live: new Set(), disposedAt: null, idleAtDispose: 0 };
        if (!failuresBy.has(ctx.audio)) failuresBy.set(ctx.audio, []);
        const failures = failuresBy.get(ctx.audio)!;
        voices.set(ctx.audio, [...(voices.get(ctx.audio) ?? []), voice]);
        return {
          ...inner,
          schedule(port, events) {
            for (const e of events) {
              if (e.time < ctx.audio.currentTime - 1e-9) failures.push(`late note at ${e.time}, currentTime ${ctx.audio.currentTime}`);
              voice.live.add(e);
            }
            inner.schedule!(port, events);
          },
          cancel(port, events) {
            for (const e of events) {
              if (e.time < ctx.audio.currentTime - 1e-9) failures.push(`cancelled a note that had started: ${e.time} < ${ctx.audio.currentTime}`);
              if (!voice.live.delete(e)) failures.push(`cancelled a note never scheduled on this instance: ${e.time}`);
            }
            inner.cancel!(port, events);
          },
          dispose() {
            voice.disposedAt = ctx.audio.currentTime;
            voice.idleAtDispose = inner.idleAt!();
            inner.dispose!();
          },
        };
      },
    };
  }

  /** What each stateless node should have emitted, per plan, from the events logged into it. */
  function oracle(stages: { time: number; patch: Patch }[], events: LoggedEvent[], failures: string[]) {
    const byNode = (id: string, a: number, b: number) => events.filter((e) => e.node === id && e.time >= a && e.time < b);
    const strip = ({ node: _node, port: _port, ...event }: LoggedEvent): EngineEvent => event;
    for (const [k, { time: a, patch }] of stages.entries()) {
      const b = stages[k + 1]?.time ?? SECONDS;
      if (!(b > a)) continue;
      for (const id of ['euclid', 'prob', 'prob2', 'note', 'note2']) {
        const spec = patch.nodes.find((n) => n.id === id);
        const logged = byNode(id, a, b);
        if (!spec) {
          if (logged.length) failures.push(`${id} removed for [${a}, ${b}) but logged ${logged.length} events there`);
          continue;
        }
        const definition = nodeRegistry.get(spec.type)!;
        const inPort = definition.ports.find((p) => p.direction === 'in' && p.type === 'event')!.name;
        const outPort = definition.ports.find((p) => p.direction === 'out')!.name;
        const inputs = patch.cables.filter((c) => c.to.node === id && c.to.port === inPort)
          .flatMap((c) => byNode(c.from.node, a, b).filter((e) => e.port === c.from.port).map(strip)).sort(compareEvents);
        const ctx = createNodeContext({ nodeId: id, seed: patch.seed, definition, params: resolveParams(definition, spec.params), state: {} }, { events: [inPort] });
        const expected = definition.query!({ ...ctx, inputs: { [inPort]: inputs }, pushed: {}, t0: a, t1: b })[outPort] ?? [];
        const got = logged.map(strip);
        if (JSON.stringify(got) !== JSON.stringify(expected)) failures.push(`${id} in [${a}, ${b}): logged ${got.length} events, expected ${expected.length}`);
      }
    }
  }

  it('shows no duplicated, missing or stray events, and keeps state for surviving ids', async () => {
    const plan = script();
    const voices = new Map<AudioContextLike, Voice[]>();
    const synthFailures = new Map<AudioContextLike, string[]>();
    const registry = new Map(nodeRegistry).set('sampled-voice', recordingSynth(voices, synthFailures));
    // Per attempt (a live run may start over): the plans in force, the audio context, the taps.
    const fresh = (run: { runtime: Runtime; context: AudioContextLike | null; patch: Patch }) => ({ runtime: run.runtime, context: run.context, stages: [{ time: 0, patch: run.patch }], taps: [] as { time: number; crossed: boolean }[], failures: [] as string[] });
    let attempt: ReturnType<typeof fresh> | null = null;
    const anchorsOf = (runtime: Runtime) => JSON.parse(JSON.stringify((runtime.stateOf('clock') as { transport: Transport }).transport.anchors)) as Transport['anchors'];
    const edits: RunEdit[] = plan.map(({ time, edits }) => ({
      time,
      apply(run) {
        if (attempt?.runtime !== run.runtime) attempt = fresh(run);
        const ids = run.patch.nodes.map((n) => n.id);
        const before = new Map(ids.map((id) => [id, run.runtime.stateOf(id)]));
        const anchors = anchorsOf(run.runtime);
        const report = run.edit(edits);
        attempt.stages.push({ time: report.time, patch: run.patch });
        // Bookkeeping, true by construction of the stages: an id the swap didn't reset shares its state object.
        for (const id of ids) {
          if (report.removed.includes(id) || report.reset.includes(id)) continue;
          if (run.runtime.stateOf(id) !== before.get(id)) attempt.failures.push(`${id} lost its state object at the swap at ${report.time}`);
        }
        // The content: Clock's transport gains an anchor at the swap time when its knobs changed, and nothing else.
        const after = anchorsOf(run.runtime);
        const T = report.time;
        const expected = report.affected.has('clock') ? anchors.filter((a) => a.time < T) : anchors;
        if (JSON.stringify(report.affected.has('clock') ? after.slice(0, -1) : after) !== JSON.stringify(expected)
          || (report.affected.has('clock') && after.at(-1)!.time !== T)) attempt.failures.push(`clock anchors changed beyond one at ${T}`);
      },
    }));
    // Live taps on Clock's tick output, after every pair and every ninth edit, so rewinds replay
    // across swaps (one wake's pair of them included). Marked, to tell them from Clock's own ticks.
    const taps: RunEdit[] = plan.flatMap(({ time }, k) => (plan[k + 1]?.time === undefined || k % 9 === 0 || plan[k - 1]?.time === time - 0.0004 ? [{
      time: time + 0.0011,
      apply(run) {
        if (attempt?.runtime !== run.runtime) attempt = fresh(run);
        const tap = run.scheduler.push('clock', 'tick', { channel: 0, index: 1000 + k, live: true })!;
        attempt.taps.push({ time: tap.time, crossed: tap.time < attempt.stages.at(-1)!.time });
      },
    }] : []));
    const result = await runPatch(initial(), { seconds: SECONDS, fps: 0, live: true }, { registry, edits: [...edits, ...taps].sort((a, b) => a.time - b.time) });
    // The edits' closures set it; TypeScript can't see that.
    const run = attempt as ReturnType<typeof fresh> | null;
    if (!run) throw new Error('no edit ran');
    // Only the attempt that finished counts: one a lost suspend aborted may have left half-made checks.
    if (result.attempts > 1) console.warn(`[hot-swap gate] the live run took ${result.attempts} attempts; checking the last`);
    expect(run.context).not.toBeNull();
    const failures = [...run.failures, ...(synthFailures.get(run.context!) ?? [])];
    const { events } = result;
    expect(result.audio).not.toBeNull();
    const stages = run.stages;
    // The taps rewound, and several replayed across a swap that hadn't started yet.
    expect(run.taps.length).toBeGreaterThanOrEqual(PAIRS + 10);
    expect(result.scheduler.rewinds).toBe(run.taps.length);
    expect(run.taps.filter((t) => t.crossed).length).toBeGreaterThanOrEqual(5);
    expect(result.swaps.filter((s, i) => i > 0 && s.report.time === result.swaps[i - 1]!.report.time).length).toBeGreaterThanOrEqual(PAIRS);

    // The script mixes every kind of edit, and each took effect.
    const kinds = new Map<string, number>();
    for (const e of plan) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    expect(Math.min(...['knob', 'cable', 'node'].map((k) => kinds.get(k) ?? 0))).toBeGreaterThanOrEqual(15);
    expect(result.swaps.length).toBe(EDITS);
    expect(stages.length).toBe(EDITS + 1);

    // No duplicates: no node emits twice on one port at one time and channel.
    const seen = new Set<string>();
    for (const e of events) {
      const key = `${e.node}.${e.port}@${e.time}/${e.channel}`;
      if (seen.has(key)) failures.push(`duplicate ${key}`);
      seen.add(key);
    }
    // Clock is never touched by the other edits: its ticks are those of a run with only its own edits
    // (live too, so the edits land on the same render quanta and window boundaries).
    const clockOnly = await runPatch(initial(), { seconds: SECONDS, fps: 0, live: true }, {
      edits: [...scriptedEdits(plan.filter((e) => e.target === 'clock')), ...taps].sort((a, b) => a.time - b.time),
    });
    const ticks = (log: LoggedEvent[]) => formatEvents(log.filter((e) => e.node === 'clock'));
    if (ticks(events) !== ticks(clockOnly.events)) failures.push('clock ticks differ from a run with only the clock edits');
    // Clock is the only stateful node here; state carry-over for others (resets, added
    // nodes, delay inputs, rewinds across same-boundary swaps) is in packages/engine/test/hot-swap.test.ts.
    // The transport carried its state through every swap: each step fires exactly once.
    const indices = events.filter((e) => e.node === 'clock' && !e.live).map((e) => e.index);
    if (indices.some((index, i) => index !== i)) failures.push('clock step indices skip or repeat');
    // Each other node gave exactly what its plan makes of what reached it: nothing missing,
    // nothing extra, and nothing at all while it was removed.
    oracle(stages, events, failures);
    // The synth got exactly the notes logged into it, once each, across every rebuild.
    const notes: EngineEvent[] = [];
    for (const [k, { time: a, patch }] of stages.entries()) {
      const b = stages[k + 1]?.time ?? SECONDS;
      for (const c of patch.cables.filter((c) => c.to.node === 'synth' && c.to.port === 'note')) {
        notes.push(...events.filter((e) => e.node === c.from.node && e.port === c.from.port && e.time >= a && e.time < b));
      }
    }
    const instances = voices.get(run.context!)!;
    const key = (e: EngineEvent) => `${e.time}:${e.channel}:${e.pitch}:${e.duration}:${e.velocity}`;
    const played = instances.flatMap((v) => [...v.live]).filter((e) => e.time < SECONDS).map(key).sort();
    const logged = notes.map(key).sort();
    if (played.join() !== logged.join()) failures.push(`synth played ${played.length} notes, the log has ${logged.length}`);
    // Every rebuild found the instrument in the shared cache: no note went unvoiced while it loaded.
    expect(run.runtime.stateOf('synth')).toBeDefined();
    if (skippedNotes(run.runtime.stateOf('synth')) !== 0) failures.push(`synth skipped ${skippedNotes(run.runtime.stateOf('synth'))} notes`);
    // Rebuilt instances were disposed only once their last note had released.
    expect(instances.length).toBeGreaterThan(3);
    expect(instances.filter((v) => v.disposedAt !== null && v.disposedAt < SECONDS - 1e-6).length).toBeGreaterThan(0);
    for (const v of instances) if (v.disposedAt !== null && v.disposedAt < SECONDS - 1e-6 && v.disposedAt < v.idleAtDispose) failures.push(`disposed at ${v.disposedAt} with notes until ${v.idleAtDispose}`);
    expect(result.scheduler.lateScheduled + result.scheduler.lateImmediate + result.scheduler.uncancelled).toBe(0);

    expect(failures).toEqual([]);
    expect(events.filter((e) => e.node === 'note').length).toBeGreaterThan(20);
    expect(events.filter((e) => e.node === 'note2').length).toBeGreaterThan(5);
  });
});

describe('scripted edits beside a patch', () => {
  it('loads <name>.edits.json and applies each entry as one swap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-patcher-edits-'));
    try {
      const file = join(dir, 'blips.flowpatch');
      writeFileSync(file, JSON.stringify(loadPatch(join(ROOT, 'examples/clock-blips.flowpatch'))));
      expect(loadEdits(file)).toEqual([]);
      const script = [{ time: 1, edits: [{ op: 'set-param', node: 'clock', param: 'bpm', value: 60 }] }];
      writeFileSync(join(dir, 'blips.edits.json'), JSON.stringify(script));
      expect(loadEdits(file)).toEqual(script);
      const result = await runPatch(loadPatch(file), { seconds: 3, fps: 0, audio: false }, { edits: scriptedEdits(loadEdits(file)) });
      expect(result.swaps.map((s) => s.report.changed)).toEqual([['clock']]);
      const T = result.swaps[0]!.report.time;
      const gaps = result.events.filter((e) => e.node === 'clock' && e.time > T).map((e, i, all) => (i ? e.time - all[i - 1]!.time : null)).slice(1);
      // 60 bpm in eighths: half a second apart from the swap on.
      expect(gaps.every((g) => Math.abs(g! - 0.5) < 1e-9)).toBe(true);

      const rejects = (script: unknown, message: RegExp) => {
        writeFileSync(join(dir, 'blips.edits.json'), JSON.stringify(script));
        expect(() => loadEdits(file)).toThrow(message);
      };
      rejects({}, /blips\.edits\.json: top level/);
      rejects([{ time: -1, edits: [] }], /blips\.edits\.json: \[0\]\.time/);
      rejects([{ time: 1, edits: [{ op: 'rename' }] }], /\[0\]\.edits\[0\]: op must be one of/);
      rejects([{ time: 1, edits: [{ op: 'set-param', node: 'clock', value: 60 }] }], /\[0\]\.edits\[0\]: set-param needs node and param/);
      rejects([{ time: 1, edits: [{ op: 'add-node', node: { id: 'x', type: 'clock', typeVersion: 3, params: {} } }] }], /add-node needs node\.position/);
      rejects([{ time: 1, edits: [{ op: 'add-node', node: { id: 'x', type: 'clock', typeVersion: 3, params: {}, position: { x: 0, y: 0 }, pinned: [1] } }] }], /add-node needs node\.pinned/);
      rejects([{ time: 1, edits: [{ op: 'remove-cable', from: { node: 'a' }, to: { node: 'b', port: 'in' } }] }], /remove-cable needs from and to/);
      rejects([{ time: 1, edits: [{ op: 'unset-param', node: 'clock' }] }], /unset-param needs node and param/);
      rejects([{ time: 1, edits: [{ op: 'move-node', node: 'clock', position: { x: 1 } }] }], /move-node needs position/);
      rejects([{ time: 1, edits: [{ op: 'add-cable', cable: { from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }, index: 1.5 }] }], /add-cable needs an integer index/);
      rejects([{ time: 1, edits: [{ op: 'add-node', node: { id: 'x', type: 'clock', typeVersion: 3, params: {}, position: { x: 0, y: 0 } }, index: -1 }] }], /add-node needs an integer index/);
      rejects([{ time: 1, edits: [{ op: 'remove-cable', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' }, index: 'first' }] }], /remove-cable needs an integer index/);
      const accepted = [{ time: 1, edits: [
        { op: 'move-node', node: 'clock', position: { x: 10, y: 20 } },
        { op: 'unset-param', node: 'clock', param: 'bpm' },
        { op: 'add-node', node: { id: 'x', type: 'clock', typeVersion: 3, params: {}, position: { x: 0, y: 0 } }, index: 0 },
        { op: 'add-cable', cable: { from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }, index: 0 },
        { op: 'remove-cable', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' }, index: 0 },
      ] }];
      writeFileSync(join(dir, 'blips.edits.json'), JSON.stringify(accepted));
      expect(loadEdits(file)).toEqual(accepted);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an edit that does not compile and keeps the running plan', async () => {
    const patch = loadPatch(join(ROOT, 'examples/clock-blips.flowpatch'));
    const bad: PatchEdit[] = [{ op: 'add-cable', cable: cable('clock', 'tick', 'nowhere', 'in') }];
    await expect(runPatch(patch, { seconds: 1, fps: 0, audio: false }, { edits: scriptedEdits([{ time: 0.5, edits: bad }]) })).rejects.toThrow(/unknown node/);
    await expect(runPatch(patch, { seconds: 1, fps: 0 }, { edits: scriptedEdits([{ time: 0.5, edits: [] }]) })).rejects.toThrow(/live run/);
  });
});
