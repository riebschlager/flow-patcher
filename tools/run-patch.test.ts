import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUTPUT_CEILING } from '@flow-patcher/engine';
import { maxDifference, peak, RENDER_TOLERANCE } from './lib/audio';
import { formatEvents, loadInputs, loadPatch, runPatch, writeRun } from './lib/run';
import { ROOT } from '../test-support/golden';

const EXAMPLE = join(ROOT, 'examples/clock-blips.flowpatch');

describe('headless runner', () => {
  // M1 gate: Determinism. Two fresh runs in one process, so module-level state
  // or unseeded randomness would show up as a difference.
  for (const file of readdirSync(join(ROOT, 'examples')).filter((f) => f.endsWith('.flowpatch')).sort()) {
    it(`${file}: the same patch and seed give byte-identical event logs run to run`, async () => {
      const path = join(ROOT, 'examples', file);
      const run = async () => formatEvents((await runPatch(loadPatch(path), { seconds: 4, fps: 0, audio: false }, { inputs: loadInputs(path) })).events);
      const first = await run();
      expect(first).not.toBe('[]\n');
      expect(await run()).toBe(first);
    });
  }

  it('pushes the scripted inputs beside an example onto its nodes', async () => {
    const path = join(ROOT, 'examples/pointer-notes.flowpatch');
    const inputs = loadInputs(path);
    const result = await runPatch(loadPatch(path), { seconds: 4, fps: 0, audio: false }, { inputs });
    const downs = inputs.filter((i) => i.port === 'down').map((i) => i.event.time);
    expect(downs.length).toBeGreaterThan(1);
    expect(result.events.filter((e) => e.node === 'note' && e.port === 'note').map((e) => e.time)).toEqual(downs);
    expect(loadInputs(EXAMPLE)).toEqual([]);
  });

  it('gives a seeded patch different events under a different seed', async () => {
    const run = async (seed: number) => formatEvents((await runPatch({ ...loadPatch(EXAMPLE), seed }, { seconds: 4, fps: 0, audio: false })).events);
    const original = loadPatch(EXAMPLE).seed;
    expect(await run(original + 1)).not.toBe(await run(original));
  });

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

  it('gives the same events and audio samples in a live run as in the default one', async () => {
    for (const file of ['clock-blips.flowpatch', 'delay-echo.flowpatch']) {
      const patch = () => loadPatch(join(ROOT, 'examples', file));
      const [batch, live] = await Promise.all([runPatch(patch(), { seconds: 2, fps: 0 }), runPatch(patch(), { seconds: 2, fps: 0, live: true })]);
      expect(formatEvents(live.events)).toBe(formatEvents(batch.events));
      expect(batch.audio).not.toBeNull();
      expect(peak(live.audio!)).toBeGreaterThan(0.01);
      expect(maxDifference(live.audio!, batch.audio!)).toBeLessThanOrEqual(RENDER_TOLERANCE);
    }
  });

  it('rejects invalid patches with readable errors', async () => {
    const patch = loadPatch(EXAMPLE);
    patch.nodes.push({ id: 'ghost', type: 'no-such-node', typeVersion: 1, params: {}, position: { x: 0, y: 0 } });
    await expect(runPatch(patch)).rejects.toThrow(/unknown type "no-such-node"/);
  });
});
