// M2 gate: Flow's Paint, Conduct, Space and Orbit, rebuilt as patches in examples/modes/
// (ADR 0006). Each replays its scripted input stream for the stream's length plus a tail,
// twice in one process, and must give the event log in golden/mode-events.json both times.
// examples.test.ts still runs their first 4 s like every other example.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatEvents, loadInputs, loadPatch, runPatch } from './lib/run';
import { expectGolden, ROOT } from '../test-support/golden';
import { expectCatalogTypes } from '../test-support/catalog';

const MODES = ['conduct', 'orbit', 'paint', 'space'];
/** Seconds after the stream's last event, so tails, releases and smoothing settle into the log. */
const TAIL = 2;
const DIR = join(ROOT, 'examples', 'modes');

const replay = async (mode: string) => {
  const path = join(DIR, `${mode}.flowpatch`);
  const inputs = loadInputs(path);
  const seconds = Math.ceil(inputs.at(-1)!.time + TAIL);
  return formatEvents((await runPatch(loadPatch(path), { seconds, fps: 0, audio: false }, { inputs })).events);
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
      expect(first).not.toBe('[]\n');
      expect(await replay(mode), mode).toBe(first);
      logs[mode] = JSON.parse(first);
    }
    expectGolden('mode-events', logs);
  });
});
