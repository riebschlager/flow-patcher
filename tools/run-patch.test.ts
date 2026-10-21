import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUTPUT_CEILING } from '@flow-patcher/engine';
import { formatEvents, loadPatch, runPatch, writeRun } from './lib/run';
import { ROOT } from '../test-support/golden';

const EXAMPLE = join(ROOT, 'examples/clock-blips.flowpatch');

describe('headless runner', () => {
  it('gives byte-identical event logs run to run', async () => {
    const a = await runPatch(loadPatch(EXAMPLE), { seconds: 3, audio: false });
    const b = await runPatch(loadPatch(EXAMPLE), { seconds: 3, audio: false });
    expect(a.events.length).toBeGreaterThan(0);
    expect(formatEvents(b.events)).toBe(formatEvents(a.events));
  });

  it('gives the same events whatever the window size', async () => {
    const events = async (window: number) => formatEvents((await runPatch(loadPatch(EXAMPLE), { seconds: 5, window, fps: 0, audio: false })).events);
    const reference = await events(0.025);
    expect(await events(0.1)).toBe(reference);
    expect(await events(0.0173)).toBe(reference);
    expect(await events(5)).toBe(reference);
  });

  it('renders audio under the Output ceiling and writes every output file', async () => {
    const result = await runPatch(loadPatch(EXAMPLE), { seconds: 2 });
    expect(result.audio).not.toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'flow-patcher-run-'));
    try {
      const written = writeRun(result, dir, 'clock-blips').map((p) => p.slice(dir.length + 1));
      expect(written.sort()).toEqual(['audio.wav', 'events.json', 'frame-fluid.png', 'summary.json']);
      const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
      expect(summary.audio.peak).toBeGreaterThan(0.01);
      expect(summary.audio.peak).toBeLessThanOrEqual(OUTPUT_CEILING);
      expect(readFileSync(join(dir, 'frame-fluid.png')).subarray(1, 4).toString()).toBe('PNG');
      expect(readFileSync(join(dir, 'audio.wav')).subarray(0, 4).toString()).toBe('RIFF');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid patches with readable errors', async () => {
    const patch = loadPatch(EXAMPLE);
    patch.nodes.push({ id: 'ghost', type: 'no-such-node', typeVersion: 1, params: {}, position: { x: 0, y: 0 } });
    await expect(runPatch(patch)).rejects.toThrow(/unknown type "no-such-node"/);
  });
});
