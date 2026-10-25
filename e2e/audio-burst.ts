import { expect, type Page } from '@playwright/test';

/** What the burst probe has seen so far (ADR 0027). */
export interface BurstProbe {
  /** The most render quanta the audio thread ran back to back, in one burst. */
  largest: number;
  /** process() calls so far. */
  calls: number;
  /** The worklet scope's clock the bursts were told apart by. */
  clock: 'performance' | 'Date';
  /** The largest burst's quanta × 128 frames, in seconds: how far currentTime can jump at once. */
  step: number;
  sampleRate: number;
  /** The worklet module loaded and the node is in the graph. It runs once the context does. */
  ready: boolean;
}

const NO_PROBE = Boolean(process.env.FP_NO_BURST_PROBE);

declare global {
  interface Window {
    fpBurstProbe?: BurstProbe;
  }
}

// The worklet: counts process() calls that come back to back. The audio thread renders a callback's
// quanta in one go, microseconds apart, then waits for the next callback, at least a quantum
// (2.67 ms at 48 kHz, 2.9 ms at 44.1 kHz) later. So a gap of at most GAP_MS between two calls means
// one burst. AudioWorkletGlobalScope has no `performance` in Chromium today, only Date.now() (1 ms
// resolution); calls in one burst then read 0 or 1 ms apart, and calls a quantum apart 2 ms or more,
// so 1 ms tells them apart at up to 48 kHz. With a finer clock, half a quantum does. This needs no
// main thread: telling bursts apart by currentFrame against message arrival would put the main
// thread's lateness, the thing the specs measure, back into the probe.
const WORKLET = `
const fine = typeof performance !== 'undefined' && typeof performance.now === 'function';
const now = fine ? () => performance.now() : () => Date.now();
const GAP_MS = fine ? 64 / sampleRate * 1000 : 1;
registerProcessor('fp-burst-probe', class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.last = -Infinity;
    this.run = 0;
    this.largest = 0;
    this.calls = 0;
  }
  process() {
    const at = now();
    this.run = at - this.last <= GAP_MS ? this.run + 1 : 1;
    this.last = at;
    this.calls++;
    if (this.run > this.largest || this.calls % 256 === 0) {
      this.largest = Math.max(this.largest, this.run);
      this.port.postMessage({ largest: this.largest, calls: this.calls, clock: fine ? 'performance' : 'Date' });
    }
    return true;
  }
});
`;

/**
 * Test only: every AudioContext the page makes gets the burst probe, a silent AudioWorkletNode into
 * the destination through a zero gain, from before the first tap resumes the context to the end of
 * the test, so the bursts around the resume count. Results go to `window.fpBurstProbe`. Call it
 * before `page.goto`.
 */
export async function installBurstProbe(page: Page): Promise<void> {
  // FP_NO_BURST_PROBE=1 runs without it, to compare (ADR 0027: the worklet can change Chromium's render path).
  if (NO_PROBE) return;
  await page.addInitScript((source: string) => {
    const Base = window.AudioContext;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    window.AudioContext = class extends Base {
      constructor(options?: AudioContextOptions) {
        super(options);
        const context = this as AudioContext;
        const probe: BurstProbe = (window.fpBurstProbe = { largest: 0, calls: 0, clock: 'Date', step: 0, sampleRate: context.sampleRate, ready: false });
        void context.audioWorklet.addModule(url).then(() => {
          const node = new AudioWorkletNode(context, 'fp-burst-probe', { numberOfInputs: 0, numberOfOutputs: 1 });
          const silent = context.createGain();
          silent.gain.value = 0;
          node.connect(silent).connect(context.destination);
          node.port.onmessage = ({ data }: MessageEvent<{ largest: number; calls: number; clock: 'performance' | 'Date' }>) => {
            Object.assign(probe, data, { step: (data.largest * 128) / context.sampleRate });
          };
          probe.ready = true;
        });
      }
    } as typeof AudioContext;
  }, WORKLET);
}

/** Waits until the probe is in the graph, so it sees the resume: call it before the first tap. Its process()
 *  calls start only once the tap resumes the context; audioCallback checks that they did. */
export async function burstProbeReady(page: Page): Promise<void> {
  if (NO_PROBE) return;
  await expect.poll(() => page.evaluate(() => window.fpBurstProbe?.ready ?? false), { message: 'the burst probe never loaded' }).toBe(true);
}
