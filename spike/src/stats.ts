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
};

export function recordTap(line: string) {
  console.log('[spike] tap', line);
  stats.taps = [line, ...stats.taps].slice(0, 8);
}

export function recordSunk(time: number) {
  stats.sunk.push(time);
  if (stats.sunk.length > 256) stats.sunk.shift();
}
