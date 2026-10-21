// Gate measurements, shown on screen and logged under [spike].
export const stats = {
  /** Scheduler windows queried. */
  windows: 0,
  /** Windows lost to a stall: skipped, never burst. */
  skipped: 0,
  /** Events that reached a sink after their time had passed. */
  late: 0,
  /** Sampled voices sounding after the latest note, and the most seen (the budget is 64). */
  voices: 0,
  peakVoices: 0,
  /** Sample peak at the speakers over the last ~0.7 s, and the highest since load or the last reset. */
  peak: 0,
  peakMax: 0,
  /** The limiter's peak before the guard, the highest since load or reset, and meter polls that found it above the ceiling (the guard clipping). */
  preGuard: 0,
  preGuardMax: 0,
  guardHits: 0,
  /** Fluid step time in ms: a running average, and the highest since load. Logged every 5 s with the grid. */
  fluidMs: 0,
  fluidMaxMs: 0,
  /** The fluid grid, e.g. "224×156". */
  fluidGrid: '',
  /** Renderer draw time in ms since the fluid's last log line, to tell render cost from solver cost. */
  render: { count: 0, total: 0, max: 0 },
  /** The output latency the frame clock subtracts, so splashes match when notes are heard. */
  outputLatencyMs: 0,
  /** How far past their time splats landed, in ms, since the fluid's last log line: at most a frame when in sync. */
  splatLag: { count: 0, total: 0, max: 0 },
  /** Audio times of the last 256 events sinks scheduled, to spot gaps and doubles. */
  sunk: [] as number[],
  /** Tap-to-sound log lines, newest first. */
  taps: [] as string[],
  /** Tap-to-sound of every warm tap since load or the last reset, in ms; cold-start taps include AudioContext startup and are left out. */
  tapMs: [] as number[],
  /** Cable edits (connect or remove) since load or reset, and windows skipped while one was in progress or within REWIRE_TAIL after. */
  rewires: 0,
  rewireSkipped: 0,
  /** performance.now() until which skipped windows count as rewiring; Infinity while a cable is being dragged. */
  rewiringUntil: 0,
  /** The last 600 fluid step times in ms, for the report's p95. */
  fluidSteps: [] as number[],
};

const REWIRE_TAIL = 1000; // ms after a cable edit that skipped windows still count against it

export function recordTap(line: string, ms: number, cold: boolean) {
  console.log('[spike] tap', line);
  stats.taps = [line, ...stats.taps].slice(0, 8);
  if (!cold) stats.tapMs.push(ms);
}

/** A cable drag started: count skipped windows until it ends. */
export function rewireStart() {
  stats.rewiringUntil = Infinity;
}

/** A cable drag ended, or a cable was added or removed. */
export function rewireEnd(edited: boolean) {
  stats.rewiringUntil = performance.now() + REWIRE_TAIL;
  if (edited) stats.rewires++;
}

export function recordFluidStep(ms: number) {
  stats.fluidSteps.push(ms);
  if (stats.fluidSteps.length > 600) stats.fluidSteps.shift();
}

/** Clear the gate measurements, so a run starts from zero once the patch is warm. */
export function resetMeasurements() {
  Object.assign(stats, { skipped: 0, late: 0, tapMs: [], rewires: 0, rewireSkipped: 0, fluidMaxMs: 0, fluidSteps: [], peakVoices: 0, guardHits: 0 });
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const ms = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—');

/** The gate measurements as text to paste into docs/spike-notes.md. */
export function report(ctx: AudioContext) {
  const taps = stats.tapMs;
  return [
    `device: ${navigator.userAgent}`,
    `screen: ${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x, sample rate ${ctx.sampleRate} Hz, base latency ${ms(ctx.baseLatency * 1000)} ms, output latency ${ms(stats.outputLatencyMs)} ms`,
    `tap-to-sound (warm, gate ≤ 20 ms): n ${taps.length}, median ${ms(quantile(taps, 0.5))} ms, worst ${ms(taps.length ? Math.max(...taps) : NaN)} ms`,
    `rewiring with the Clock running: ${stats.rewires} cable edits, ${stats.rewireSkipped} windows skipped while rewiring (${stats.skipped} skipped overall, ${stats.late} late, ${stats.windows} windows)`,
    `fluid step: avg ${ms(stats.fluidMs)} ms, p95 ${ms(quantile(stats.fluidSteps, 0.95))} ms, max ${ms(stats.fluidMaxMs)} ms, grid ${stats.fluidGrid || 'none'}`,
    `voices: peak ${stats.peakVoices}; guard hits ${stats.guardHits}`,
  ].join('\n');
}

export function recordSunk(time: number) {
  stats.sunk.push(time);
  if (stats.sunk.length > 256) stats.sunk.shift();
}
