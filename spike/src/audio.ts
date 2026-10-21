// One AudioContext for the whole spike: the patch and the tap test note share it.
let ctx: AudioContext | null = null;

export const getCtx = () => (ctx ??= new AudioContext({ latencyHint: 'interactive' }));

export async function ensureRunning() {
  const c = getCtx();
  if (c.state !== 'running') await c.resume();
  return c;
}

/** Glide an AudioParam to a value; the time constant is short enough to feel immediate and long enough to avoid zipper noise. */
export function ramp(param: AudioParam, value: number, timeConstant = 0.015) {
  const c = getCtx();
  param.cancelScheduledValues(c.currentTime);
  param.setTargetAtTime(value, c.currentTime, timeConstant);
}
