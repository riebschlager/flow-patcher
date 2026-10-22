// Frame-rate signals (Pointer x, Fluid Probe) are pushed once per frame and
// read at event times: linear between samples, held before the first and after
// the last, per channel. A track is plain data so it can live in node state and
// survive a snapshot (structuredClone).

export interface SignalSamples {
  times: number[];
  values: number[];
}

/** Samples per channel id, times ascending. */
export type SignalTrack = Record<number, SignalSamples>;

export const createSignalTrack = (): SignalTrack => ({});

/** Adds a sample. A sample at an existing time replaces it; non-finite input is ignored. */
export function pushSignal(track: SignalTrack, time: number, channel: number, value: number): void {
  if (!Number.isFinite(time) || !Number.isFinite(value) || !Number.isFinite(channel)) return;
  const { times, values } = (track[channel] ??= { times: [], values: [] });
  const i = upperBound(times, time);
  if (i > 0 && times[i - 1] === time) values[i - 1] = value;
  else {
    times.splice(i, 0, time);
    values.splice(i, 0, value);
  }
}

/** The signal at time t on a channel; 0 for a channel with no samples or a non-finite t. */
export function signalAt(track: SignalTrack, t: number, channel = 0): number {
  const samples = track[channel];
  if (!samples?.times.length || !Number.isFinite(t)) return 0;
  const { times, values } = samples;
  const i = upperBound(times, t);
  if (i === 0) return values[0]!;
  if (i === times.length) return values[i - 1]!;
  const ta = times[i - 1]!, tb = times[i]!, a = values[i - 1]!, b = values[i]!;
  return a + ((b - a) * (t - ta)) / (tb - ta);
}

/** Channels that have samples, in ascending order. */
export const signalChannels = (track: SignalTrack): number[] =>
  Object.keys(track).map(Number).filter((channel) => track[channel]!.times.length).sort((a, b) => a - b);

/** Forgets samples before t, keeping the last one before it so reads at t and later are unchanged. */
export function trimSignal(track: SignalTrack, t: number): void {
  for (const { times, values } of Object.values(track)) {
    const drop = upperBound(times, t) - 1;
    if (drop > 0) {
      times.splice(0, drop);
      values.splice(0, drop);
    }
  }
}

/** Index of the first time greater than t. */
function upperBound(times: readonly number[], t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
