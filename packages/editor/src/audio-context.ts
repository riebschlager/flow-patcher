// The AudioContext as the runtime sees it (AudioContextLike). Every method the
// engine's type lists is forwarded here by hand, so a method added there must be
// added here too: one left out typechecks only if it is optional, and then fails
// in the browser alone (#88's Pan). test/audio-context.test.ts checks each one.
import type { AudioContextLike } from '@flow-patcher/engine';

/** Called on every oscillator or buffer source start(): when it starts sounding (never before
 *  the clock), `clock`, currentTime just before start() was called, and `after`, just after it returned. */
export type StartListener = (time: number, clock: number, after: number) => void;

/** Two currentTime reads at most this far apart in wall time, ms, see at most one move of the
 *  clock: less than a 128-frame render quantum at any rate Web Audio runs (2.67 ms at 48 kHz). */
export const STEP_GAP_MS = 1;

/** The AudioContext as the runtime sees it, plus what its clock reads have shown of it. */
export interface ObservedContext extends AudioContextLike {
  /** The largest move of currentTime between two of its reads (through this wrapper) at most
   *  STEP_GAP_MS apart in wall time, in seconds: one clock step, as the code reading it met it.
   *  Reads further apart are left out, so a main-thread stall between them isn't counted as a step. */
  readonly largestStep: number;
}

/** Wraps `context` for the runtime, telling `onStart` about every oscillator and buffer source start.
 *  Every currentTime read goes through `read`, which also keeps `largestStep`. `wall` is the wall clock in ms. */
export function observeStarts(context: AudioContext, onStart: StartListener, wall: () => number = () => performance.now()): ObservedContext {
  let largestStep = 0, lastClock = NaN, lastWall = NaN;
  const read = (): number => {
    const clock = context.currentTime, at = wall();
    if (at - lastWall <= STEP_GAP_MS && clock - lastClock > largestStep) largestStep = clock - lastClock;
    lastClock = clock;
    lastWall = at;
    return clock;
  };
  return {
    get currentTime() {
      return read();
    },
    get largestStep() {
      return largestStep;
    },
    get sampleRate() {
      return context.sampleRate;
    },
    get outputLatency() {
      return context.outputLatency;
    },
    get baseLatency() {
      return context.baseLatency;
    },
    destination: context.destination,
    createGain: () => context.createGain(),
    createDynamicsCompressor: () => context.createDynamicsCompressor(),
    createWaveShaper: () => context.createWaveShaper(),
    createBiquadFilter: () => context.createBiquadFilter(),
    createStereoPanner: () => context.createStereoPanner(),
    createConvolver: () => context.createConvolver(),
    createDelay: (maxDelayTime) => (maxDelayTime === undefined ? context.createDelay() : context.createDelay(maxDelayTime)),
    createBuffer: (numberOfChannels, length, sampleRate) => context.createBuffer(numberOfChannels, length, sampleRate),
    decodeAudioData: (data) => context.decodeAudioData(data),
    createOscillator: () => {
      const osc = context.createOscillator();
      const start = osc.start.bind(osc);
      osc.start = (when = 0) => {
        const now = read();
        start(when);
        onStart(Math.max(when, now), now, read());
      };
      return osc;
    },
    createBufferSource: () => {
      const source = context.createBufferSource();
      const start = source.start.bind(source);
      source.start = (when = 0, offset?: number, duration?: number) => {
        const now = read();
        start(when, offset, duration);
        onStart(Math.max(when, now), now, read());
      };
      return source;
    },
  };
}
