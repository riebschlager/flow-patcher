// Every example patch is also a regression test: a headless run must give the
// event log recorded in golden/example-events.json, and the same log whatever
// the window size. A canvas source's input is scripted in <name>.inputs.json beside the patch.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatEvents, loadInputs, loadPatch, runPatch } from './lib/run';
import { expectGolden, ROOT } from '../test-support/golden';

const SECONDS = 4;
const files = readdirSync(join(ROOT, 'examples'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.flowpatch')).sort();
const run = async (file: string, window: number) => {
  const path = join(ROOT, 'examples', file);
  return (await runPatch(loadPatch(path), { seconds: SECONDS, window, fps: 0, audio: false }, { inputs: loadInputs(path) })).events;
};

describe('example patches', () => {
  it('give their recorded event logs', async () => {
    const logs: Record<string, unknown> = {};
    for (const file of files) logs[file] = await run(file, 0.025);
    expectGolden('example-events', logs);
  });

  for (const file of files) {
    it(`${file} gives the same events in 25 ms windows and in one window`, async () => {
      expect(formatEvents(await run(file, SECONDS))).toBe(formatEvents(await run(file, 0.025)));
    });
  }
});
