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

/** The M0 gate's tap test: plays a blip at currentTime + 10 ms and returns the latency log line. */
export async function playTestNote(e: React.PointerEvent) {
  const tapPerf = e.timeStamp;
  const y = e.clientY / window.innerHeight;
  const cold = getCtx().state !== 'running';
  const c = await ensureRunning();
  // The pointerdown's time on the audio clock (the gate's reference point):
  // currentTime, minus how long the event took to reach this handler.
  const tapAudio = c.currentTime - (performance.now() - tapPerf) / 1000;
  const when = Math.max(c.currentTime, tapAudio) + 0.01;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.frequency.value = 220 + 660 * (1 - y);
  gain.gain.setValueAtTime(0.2, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + 0.3);
  osc.connect(gain).connect(c.destination);
  osc.start(when);
  osc.stop(when + 0.3);
  const ms = (when - tapAudio) * 1000;
  const out = (c.outputLatency || c.baseLatency) * 1000;
  // A cold tap waits for resume(), so its figure includes startup; leave it out of the gate numbers.
  const line = `tap-to-sound ${ms.toFixed(1)} ms (gate ≤ 20), + output latency ${out.toFixed(1)} ms${cold ? ' (cold start)' : ''}`;
  console.log('[spike] tap', line);
  return line;
}
