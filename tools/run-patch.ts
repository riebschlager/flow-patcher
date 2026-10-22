// pnpm run-patch <file.flowpatch> [--seconds 4] [--windows N] [--frames N]
//                 [--window 0.025] [--fps 60] [--no-audio] [--live] [--out out/<name>]
//
// --live wakes the scheduler during the audio render (suspending it at each
// wake) instead of querying every window before rendering.
//
// Writes events.json, summary.json, audio.wav (when the patch has audio nodes)
// and frame-<node>.png (one per visual node, last frame) to the out directory.
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { loadPatch, patchName, PatchError, runPatch, writeRun } from './lib/run';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seconds: { type: 'string' },
    windows: { type: 'string' },
    frames: { type: 'string' },
    window: { type: 'string', default: '0.025' },
    fps: { type: 'string', default: '60' },
    'no-audio': { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const file = positionals[0];
if (values.help || !file) {
  console.log('Usage: pnpm run-patch <file.flowpatch> [--seconds S | --windows N | --frames N] [--window 0.025] [--fps 60] [--no-audio] [--live] [--out DIR]');
  process.exit(file ? 0 : 1);
}

const number = (name: string, value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`--${name} must be a positive number`);
    process.exit(1);
  }
  return n;
};

const window = number('window', values.window)!;
const fps = number('fps', values.fps)!;
const windows = number('windows', values.windows), frames = number('frames', values.frames);
const seconds = number('seconds', values.seconds) ?? (windows ? windows * window : frames ? frames / fps : 4);

try {
  const name = patchName(file);
  const result = await runPatch(loadPatch(file), { seconds, window, fps, audio: !values['no-audio'], live: values.live });
  const written = writeRun(result, values.out ?? join('out', name), name);
  console.log(`${name}: ${result.events.length} events, ${result.frames} frames, ${seconds}s`);
  for (const path of written) console.log(`  ${path}`);
} catch (error) {
  if (error instanceof PatchError) {
    console.error(`Patch rejected:\n  ${error.errors.join('\n  ')}`);
    process.exit(2);
  }
  throw error;
}
