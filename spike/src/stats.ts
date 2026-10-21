// Gate measurements, shown on screen and logged under [spike].
export const stats = {
  /** Scheduler windows queried. */
  windows: 0,
  /** Windows lost to a stall: skipped, never burst. */
  skipped: 0,
  /** Events that reached a sink after their time had passed. */
  late: 0,
  /** Audio times of the last 256 events sinks scheduled, to spot gaps and doubles. */
  sunk: [] as number[],
};

export function recordSunk(time: number) {
  stats.sunk.push(time);
  if (stats.sunk.length > 256) stats.sunk.shift();
}
