// M2 gate: Flow's Paint, Conduct, Space and Orbit, rebuilt as patches in examples/modes/
// (ADR 0006). Each replays its scripted input stream for the stream's length plus a tail,
// twice in one process, and must give the event log in golden/mode-events.json both times.
// Most of what Conduct, Space and Orbit do is signal shaping that no event shows, so the
// golden also holds the params they shape, sampled every 0.1 s through the run.
// examples.test.ts still runs their first 4 s like every other example.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatEvents, loadInputs, loadPatch, runPatch, type RunEdit } from './lib/run';
import { expectGolden, ROOT } from '../test-support/golden';
import { expectCatalogTypes } from '../test-support/catalog';

const MODES = ['conduct', 'orbit', 'paint', 'space'];
/** Seconds after the stream's last event, so tails, releases and smoothing settle into the log. */
const TAIL = 2;
const DIR = join(ROOT, 'examples', 'modes');
/** The params each mode shapes, as node.param. */
const SHAPED: Record<string, string[]> = {
  conduct: ['filter.cutoff', 'pan.pan'],
  orbit: ['filter.q', 'pan.pan', 'echo.mix', 'space.mix'],
  paint: ['filter.cutoff', 'level.gain', 'room.mix'],
  space: ['space.mix', 'echo.mix'],
};
const SAMPLE = 0.1;

/** The run's event log and its shaped params, one line per sample time. */
const replay = async (mode: string) => {
  const path = join(DIR, `${mode}.flowpatch`);
  const inputs = loadInputs(path);
  const seconds = Math.ceil(inputs.at(-1)!.time + TAIL);
  const params: string[] = [];
  const edits: RunEdit[] = Array.from({ length: Math.round(seconds / SAMPLE) }, (_, k) => ({
    time: k * SAMPLE,
    apply: (run) => {
      const values = SHAPED[mode]!.map((key) => {
        const [node, param] = key.split('.') as [string, string];
        return `${key} ${run.runtime.paramAt(node, param, run.time)?.toFixed(4)}`;
      });
      params.push(`${run.time.toFixed(1)}: ${values.join(', ')}`);
    },
  }));
  const result = await runPatch(loadPatch(path), { seconds, fps: 0, audio: false }, { inputs, edits });
  return { events: formatEvents(result.events), params };
};

describe('mode patches', () => {
  it('are exactly Paint, Conduct, Space and Orbit, each with an input stream', () => {
    const files = readdirSync(DIR).sort();
    expect(files.filter((f) => f.endsWith('.flowpatch'))).toEqual(MODES.map((m) => `${m}.flowpatch`));
    expect(files.filter((f) => f.endsWith('.inputs.json'))).toEqual(MODES.map((m) => `${m}.inputs.json`));
  });

  for (const mode of MODES) {
    it(`${mode} uses only catalog node types`, () => expectCatalogTypes(loadPatch(join(DIR, `${mode}.flowpatch`)), `modes/${mode}`));
  }

  it('replay their recorded event logs exactly, twice in a row', async () => {
    const logs: Record<string, unknown> = {};
    for (const mode of MODES) {
      const first = await replay(mode);
      expect(first.events).not.toBe('[]\n');
      expect(await replay(mode), mode).toEqual(first);
      logs[mode] = { events: JSON.parse(first.events), params: first.params };
    }
    expectGolden('mode-events', logs);
  });
});
