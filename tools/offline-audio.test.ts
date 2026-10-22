// Gate check "Offline audio" (docs/milestones.md, M1): a sustained patch,
// rendered on a native OfflineAudioContext with the scheduler waking during the
// render and edits applied at suspend() points, has no silent gap and never
// passes the Output ceiling.
//
// The edits are what the engine can change live today: immediate-path pushes
// (each rewinds Clock, Make Note and Simple Synth from the push to the
// horizon) and Output level changes. Hot swap (#22) adds knob changes and cable
// and node adds and removes to this test.
import { describe, expect, it } from 'vitest';
import { createOutputStage, OUTPUT_CEILING, parsePatch, type NodeDefinition, type OutputStage, type Patch } from '@flow-patcher/engine';
import { nodeRegistry, output } from '@flow-patcher/nodes';
import { longestSilence, maxDifference, peak, RENDER_TOLERANCE, SuspendRaceError } from './lib/audio';
import { formatEvents, runPatch, type RunEdit } from './lib/run';

const SECONDS = 4;

/** Clock eighths at 120 bpm (0.25 s) into notes 0.6 s long, so every note overlaps the next. */
function sustainedPatch(): Patch {
  const node = (id: string, type: string, typeVersion: number, params: Record<string, unknown>) => ({ id, type, typeVersion, params, position: { x: 0, y: 0 } });
  const cable = (from: string, fromPort: string, to: string, toPort: string) => ({ from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
  const parsed = parsePatch({
    format: 'flowpatch',
    version: 1,
    seed: 26,
    nodes: [
      node('clock', 'clock', nodeRegistry.get('clock')!.version, { bpm: 120, division: '1/8' }),
      node('note', 'make-note', nodeRegistry.get('make-note')!.version, { pitch: 48, velocity: 0.8, length: 0.6 }),
      node('synth', 'simple-synth', nodeRegistry.get('simple-synth')!.version, { wave: 'sawtooth', attack: 0.005, release: 0.3, level: 0.3 }),
      node('out', 'output', output.version, { level: 0.7 }),
    ],
    cables: [cable('clock', 'tick', 'note', 'trigger'), cable('note', 'note', 'synth', 'note'), cable('synth', 'audio', 'out', 'audio')],
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.patch;
}

/**
 * The gate's edits: live ticks and Output level changes. The Output node keeps
 * its stage to itself until #22 brings knob changes, so a stand-in builds the
 * same stage and lets the edits change its level.
 */
function liveEdits() {
  const stages: OutputStage[] = [];
  const counts = { pushes: 0, levels: 0, levelsApplied: 0 };
  const testOutput: NodeDefinition = {
    ...output,
    audio({ audio, params }) {
      const stage = createOutputStage(audio, params.level as number);
      stage.output.connect(audio.destination);
      stages.push(stage);
      // A run that starts over (SuspendRaceError) builds a new stage; count only its edits.
      counts.levelsApplied = 0;
      return { inputs: { audio: stage.input }, dispose: () => stage.output.disconnect() };
    },
  };
  const registry = new Map(nodeRegistry).set('output', testOutput);

  const edits: RunEdit[] = [];
  // A live tick every 170 ms, between and on the clock's own ticks.
  for (let t = 0.13; t < SECONDS - 0.2; t += 0.17, counts.pushes++) {
    edits.push({ time: t, apply: ({ scheduler }) => void scheduler.push('clock', 'tick', { channel: 0 }) });
  }
  // The master level swings between 0.3 and 1 every 290 ms.
  for (let t = 0.21; t < SECONDS - 0.2; t += 0.29, counts.levels++) {
    const level = counts.levels % 2 ? 0.3 : 1;
    edits.push({
      time: t,
      apply: () => {
        stages.at(-1)!.setLevel(level);
        counts.levelsApplied++;
      },
    });
  }
  return { registry, edits, counts };
}

describe('offline audio with live edits', () => {
  it('Offline audio gate: no silent gap over 5 ms and no peak above the ceiling', async () => {
    const { registry, edits, counts } = liveEdits();
    const result = await runPatch(sustainedPatch(), { seconds: SECONDS, fps: 0, live: true }, { registry, edits });
    const audio = result.audio!;
    const gap = longestSilence(audio, 1e-4, 0.1, SECONDS - 0.1);
    expect(gap).toBeLessThanOrEqual(0.005);
    expect(peak(audio)).toBeLessThanOrEqual(OUTPUT_CEILING);

    // The edits really happened: every push rewound and added one note to the clock's 16.
    const stats = result.scheduler;
    expect(stats.pushes).toBe(counts.pushes);
    expect(counts.levelsApplied).toBe(counts.levels);
    expect(stats.rewinds).toBe(stats.pushes);
    expect(result.events.filter((e) => e.node === 'note').length).toBe(16 + stats.pushes);
    expect(stats.uncancelled).toBe(0);
    expect(stats.lateScheduled + stats.lateImmediate + stats.skipped).toBe(0);
    expect(stats.windows).toBeGreaterThan(SECONDS / 0.025 - 2);
  });

  it('starts a live run over when a suspend does not take, and gets the clean run', async () => {
    const clean = liveEdits(), retried = liveEdits();
    const options = { seconds: SECONDS, fps: 0, live: true };
    const [a, b] = [
      await runPatch(sustainedPatch(), options, { registry: clean.registry, edits: clean.edits }),
      await runPatch(sustainedPatch(), options, { registry: retried.registry, edits: retried.edits, testLateSuspend: (attempt) => attempt === 1 }),
    ];
    // At least 2: a natural race on attempt 2 can add another.
    expect(b.attempts).toBeGreaterThanOrEqual(2);
    expect(formatEvents(b.events)).toBe(formatEvents(a.events));
    expect(maxDifference(b.audio!, a.audio!)).toBeLessThanOrEqual(RENDER_TOLERANCE);
    expect(b.scheduler.pushes).toBe(retried.counts.pushes);
    expect(retried.counts.levelsApplied).toBe(retried.counts.levels);
  });

  it('fails loudly when every attempt loses a suspend', async () => {
    const { registry, edits } = liveEdits();
    await expect(runPatch(sustainedPatch(), { seconds: 1, fps: 0, live: true }, { registry, edits: edits.filter((e) => e.time < 0.9), testLateSuspend: () => true })).rejects.toThrow(SuspendRaceError);
  });

  it('renders the same samples live as with every window queried up front, when nothing is edited', async () => {
    // Without edits, waking during the render hands the synth the same events
    // before their times, so the audio must not change, up to the order
    // node-web-audio-api sums voices in (RENDER_TOLERANCE).
    const [live, batch] = await Promise.all([
      runPatch(sustainedPatch(), { seconds: SECONDS, fps: 0, live: true }),
      runPatch(sustainedPatch(), { seconds: SECONDS, fps: 0 }),
    ]);
    expect(peak(live.audio!)).toBeGreaterThan(0.1);
    expect(maxDifference(live.audio!, batch.audio!)).toBeLessThanOrEqual(RENDER_TOLERANCE);
    expect(live.events).toEqual(batch.events);
  });
});
