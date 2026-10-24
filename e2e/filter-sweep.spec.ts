import { expect, test, type Locator, type Page } from '@playwright/test';
import type { LivePatch } from '../packages/editor/src/live';

/** What the init script below records about the patch's Filter. */
interface SweepProbe {
  recording: boolean;
  /** The cutoff's automation, mirrored onto a ConstantSourceNode and recorded sample by sample: [first frame, samples]. */
  mirror: [number, Float32Array][];
  /** The Filter's output, channel 0, recorded the same way. */
  out: [number, Float32Array][];
  /** Every cancelScheduledValues on the cutoff while recording: its time, currentTime when called, and how far
   *  the automation already reached (the last ramp's end), so a re-run's cancel can be told from a fresh chunk's.
   *  A re-run that starts inside a ramp cancels from that ramp's end, after adding a point at its start. */
  cancels: { t0: number; now: number; reached: number }[];
  sampleRate: number;
  filters: number;
}

declare global {
  interface Window {
    flowPatcher?: LivePatch;
    sweep?: SweepProbe;
  }
}

// Filter (#88): a Signal-swept cutoff on a sustained note, through the browser's
// Web Audio. The cutoff's automation is mirrored call for call onto a
// ConstantSourceNode's offset, whose output an AudioWorklet records sample by
// sample. Knob turns on the cabled cutoff re-run the windows from the swap
// (ADR 0031): automate keeps the ramp in progress up to t0, cancels the rest and
// schedules again from there, in the same task. ADR 0031, Consequences: a browser that renders between the
// two calls could hold the previous value for one render quantum. The sweep never
// stands still, so a hold shows up as a flat quantum in the mirror. Before #103 an
// exposed re-run (one within a grid step of the clock) gave the ramp in progress a
// new end, so the param stepped by the knob change times the share of the ramp
// already played (80–340 Hz). Now the re-run keeps that ramp up to its t0 and
// ramps to the new base by the next grid point: the course bends at t0 but never
// jumps. The test requires no hold and no step, and logs the bends.

const field = (page: Page, node: string, param: string) =>
  page.locator(`.react-flow__node[data-id="${node}"] .param-row[data-param="${param}"] [data-testid="param-field"]`);
const stats = (page: Page) => page.evaluate(() => window.flowPatcher!.stats);

/** Drags horizontally by `dx` in steps, as a hand would. */
async function dragBy(page: Page, target: Locator, dx: number) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x + (dx * i) / 12, y);
  await page.mouse.up();
}

test('a cabled Filter cutoff sweeps a sustained note, and re-runs on knob turns neither hold a quantum nor step', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && !message.text().includes('favicon') && errors.push(message.text()));

  await page.addInitScript(() => {
    const probe: SweepProbe = { recording: false, mirror: [], out: [], cancels: [], sampleRate: 0, filters: 0 };
    window.sweep = probe;
    const createFilter = BaseAudioContext.prototype.createBiquadFilter;
    BaseAudioContext.prototype.createBiquadFilter = function (this: BaseAudioContext) {
      const filter = createFilter.call(this);
      if (probe.filters++) return filter;
      const context = filter.context;
      probe.sampleRate = context.sampleRate;
      const param = filter.frequency;
      const mirror = context.createConstantSource();
      mirror.offset.value = param.value;
      const value = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value')!;
      Object.defineProperty(param, 'value', {
        get: () => value.get!.call(param),
        set: (v: number) => {
          value.set!.call(param, v);
          mirror.offset.value = v;
        },
      });
      let reached = -Infinity;
      for (const name of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues'] as const) {
        const call = AudioParam.prototype[name] as (this: AudioParam, ...args: number[]) => AudioParam;
        Object.defineProperty(param, name, {
          value: (...args: number[]) => {
            if (name === 'cancelScheduledValues') {
              if (probe.recording) probe.cancels.push({ t0: args[0]!, now: context.currentTime, reached });
              reached = Math.min(reached, args[0]!);
            } else reached = Math.max(reached, args[1]!);
            const result = call.apply(param, args);
            call.apply(mirror.offset, args);
            return result;
          },
        });
      }
      mirror.start();
      const code = `registerProcessor('rec', class extends AudioWorkletProcessor {
        process(inputs) { const input = inputs[0]; if (input && input.length) this.port.postMessage([currentFrame, input[0].slice()]); return true; }
      });`;
      void context.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))).then(() => {
        const recorder = (into: [number, Float32Array][]) => {
          const node = new AudioWorkletNode(context, 'rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          const sink = context.createGain();
          sink.gain.value = 0;
          node.connect(sink);
          sink.connect(context.destination);
          node.port.onmessage = (event: MessageEvent<[number, Float32Array]>) => probe.recording && into.push(event.data);
          return node;
        };
        mirror.connect(recorder(probe.mirror));
        filter.connect(recorder(probe.out));
      });
      return filter;
    };
  });

  await page.goto('/?patch=filter-sweep');
  await expect(page.getByTestId('compile-status')).toHaveText('6 nodes compiled');
  await page.getByTestId('performance-canvas').click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('audio-state')).toHaveText('live');
  await expect.poll(async () => (await stats(page)).delivered, { timeout: 6000 }).toBeGreaterThan(0);
  // Past the first automate call, whose first ramp starts at the call, off the grid.
  await page.waitForTimeout(500);
  await page.evaluate(() => (window.sweep!.recording = true));
  const first = await stats(page);

  // Knob turns on the cabled cutoff: each is an in-place edit that re-runs the windows from its swap.
  const cutoff = field(page, 'filter', 'cutoff');
  const TURNS = 16;
  for (let i = 0; i < TURNS; i++) {
    const before = (await stats(page)).swaps;
    await dragBy(page, cutoff, i % 2 ? -8 : 8);
    await expect.poll(async () => (await stats(page)).swaps).toBeGreaterThan(before);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window.sweep!.recording = false));
  const final = await stats(page);

  const result = await page.evaluate(() => {
    const probe = window.sweep!;
    const rate = probe.sampleRate;
    const stitch = (blocks: [number, Float32Array][]) => {
      const from = blocks[0]![0], to = blocks.at(-1)![0] + blocks.at(-1)![1].length;
      const data = new Float64Array(to - from).fill(NaN);
      for (const [frame, samples] of blocks) data.set(samples, frame - from);
      return { from, data };
    };
    const mirror = stitch(probe.mirror), out = stitch(probe.out);
    const gaps = mirror.data.filter(Number.isNaN).length;
    // Re-run cancels: t0 before what the automation already reached. Exposed ones land within one grid
    // step of the clock, so they withdraw the ramp the render thread is in.
    const reruns = probe.cancels.filter((c) => c.t0 < c.reached);
    const exposed = reruns.filter((c) => c.t0 - c.now < 1 / 60);
    const v = mirror.data;
    let smallest = Infinity, largest = -Infinity;
    for (const x of v) {
      if (!Number.isFinite(x)) continue;
      smallest = Math.min(smallest, x);
      largest = Math.max(largest, x);
    }
    // Holds: a whole render quantum where the cutoff stands still. The sweep never does (its slope is
    // 2400 Hz per 4 s, 0.0125 Hz a sample at 48 kHz, steeper at the wrap); a held quantum is flat.
    const holds: number[] = [];
    for (let q = Math.ceil(mirror.from / 128) * 128 - mirror.from; q + 128 < v.length; q += 128) {
      let most = 0;
      // The 127 changes inside the quantum: a hold that ends with a jump back at the next quantum is still flat.
      for (let i = q + 1; i < q + 128; i++) most = Math.max(most, Math.abs(v[i]! - v[i - 1]!));
      if (most < 0.002) holds.push((mirror.from + q) / rate);
    }
    // Steps: a sample-to-sample change far past any slope the automation has (its steepest, the wrap,
    // is 2400 Hz over one 1/60 s grid step, 3 Hz a sample), off the 60 Hz grid, and outside the range of
    // the changes on either side by more than 0.5 Hz: a jump in value. Before #103 an exposed re-run cancel
    // made one. A bend, where a re-run's ramp to the new base starts, changes the slope from one sample on
    // and lands between its neighbours (or equal to one); bends are counted, with the steepest new slope.
    // The mirror is a proxy param: it gets each call just after the real one, in the same task.
    // A quantum missing from the recording comes with an audio-thread glitch (seen once in a few runs,
    // with a small step a quantum before it), so steps within three quanta of one are left out and counted.
    const steps: { time: number; size: number }[] = [];
    let besideGaps = 0, bends = 0, steepest = 0;
    for (let i = 2; i + 1 < v.length; i++) {
      const before = v[i - 1]! - v[i - 2]!, d = v[i]! - v[i - 1]!, after = v[i + 1]! - v[i]!;
      if (!(Math.abs(d) > 0.5) || Math.abs(d - before) < 0.5) continue;
      const frame = mirror.from + i, time = frame / rate, k = Math.round((frame * 60) / rate);
      if (Math.abs(frame - (k * rate) / 60) <= 2) continue;
      if (v.subarray(Math.max(0, i - 384), i + 384).some(Number.isNaN)) {
        besideGaps++;
        continue;
      }
      const outside = Math.max(d - Math.max(before, after), Math.min(before, after) - d);
      if (outside > 0.5) steps.push({ time, size: outside });
      else {
        bends++;
        steepest = Math.max(steepest, Math.abs(after));
      }
    }
    // The note's brightness against the cutoff, per 50 ms block while the note sounds.
    const block = Math.round(rate * 0.05), pairs: [number, number][] = [];
    for (let start = 0; start + block <= out.data.length; start += block) {
      let sum = 0, diff = 0, cut = 0, n = 0;
      for (let i = start; i < start + block; i++) {
        const x = out.data[i]!, prev = out.data[i - 1] ?? x;
        sum += x * x;
        diff += (x - prev) ** 2;
        cut += mirror.data[i + out.from - mirror.from] ?? NaN;
        n++;
      }
      const rms = Math.sqrt(sum / n);
      if (rms > 0.01 && Number.isFinite(cut)) pairs.push([cut / n, Math.sqrt(diff / n) / rms]);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
    const cov = mean(pairs.map(([x, y]) => (x - mx) * (y - my)));
    const r = cov / Math.sqrt(mean(pairs.map(([x]) => (x - mx) ** 2)) * mean(pairs.map(([, y]) => (y - my) ** 2)));
    return {
      seconds: v.length / rate, gaps, besideGaps, holds, steps, bends, steepest, smallest, largest,
      cancels: probe.cancels.length, reruns: reruns.length, exposed: exposed.length,
      leads: exposed.map((c) => +((c.t0 - c.now) * 1000).toFixed(2)).slice(0, 20),
      blocks: pairs.length, r, filters: probe.filters, rate,
    };
  });
  console.log(
    `filter sweep: ${result.seconds.toFixed(2)} s recorded at ${result.rate} Hz, cutoff ${result.smallest.toFixed(0)}–${result.largest.toFixed(0)} Hz; ` +
      `${final.swaps - first.swaps} swaps; ${result.cancels} cancels, ${result.reruns} re-run cancels, ${result.exposed} within one grid step of the clock (leads ms: ${result.leads.join(', ')}); ` +
      `${result.holds.length} held quanta ${JSON.stringify(result.holds)}; ${result.steps.length} steps off the grid ${JSON.stringify(result.steps)}; ` +
      `${result.bends} bends off the grid (steepest ${result.steepest.toFixed(2)} Hz a sample); ${result.gaps} samples missing from the recording, ${result.besideGaps} steps beside them; brightness vs cutoff r = ${result.r.toFixed(3)} over ${result.blocks} blocks; ` +
      `late ${final.lateScheduled} (${first.lateScheduled} before the turns), skipped ${final.skipped}`,
  );

  expect(result.filters).toBe(1);
  // The recorder can miss a quantum's message now and then; a missing quantum is skipped, not counted as a hold.
  expect(result.gaps).toBeLessThan(result.seconds * result.rate * 0.01);
  expect(final.swaps - first.swaps).toBeGreaterThanOrEqual(TURNS);
  // The swaps re-ran windows the automation had covered, some close enough to the clock to withdraw the ramp in progress.
  expect(result.reruns).toBeGreaterThan(0);
  // And some within one grid step of the clock, the only ones that can withdraw the ramp being played: without them the hold and step checks mean nothing.
  expect(result.exposed).toBeGreaterThan(0);
  // The cutoff swept, and the sustained note's brightness followed it.
  expect(result.largest - result.smallest).toBeGreaterThan(1500);
  expect(result.blocks).toBeGreaterThan(40);
  expect(result.r).toBeGreaterThan(0.8);
  // No quantum held at the previous value (ADR 0031, Consequences).
  expect(result.holds).toEqual([]);
  // No jump: re-runs keep the ramp in progress up to their start (#103).
  expect(result.steps).toEqual([]);
  expect(final.lateScheduled - first.lateScheduled).toBe(0);
  expect(final.skipped).toBe(0);
  await page.screenshot({ path: 'test-results/filter-sweep.png' });
  expect(errors).toEqual([]);
});
