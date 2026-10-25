// The AudioContext as the runtime sees it (AudioContextLike). Every method the
// engine's type lists is forwarded here by hand, so a method added there must be
// added here too: one left out typechecks only if it is optional, and then fails
// in the browser alone (#88's Pan). test/audio-context.test.ts checks each one.
import type { AudioContextLike } from '@flow-patcher/engine';

/** Called on every oscillator or buffer source start(): when it starts sounding (never before
 *  the clock), and `clock`, currentTime when start() was called. */
export type StartListener = (time: number, clock: number) => void;

/** Wraps `context` for the runtime, telling `onStart` about every oscillator and buffer source start. */
export function observeStarts(context: AudioContext, onStart: StartListener): AudioContextLike {
  return {
    get currentTime() {
      return context.currentTime;
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
        const now = context.currentTime;
        onStart(Math.max(when, now), now);
        start(when);
      };
      return osc;
    },
    createBufferSource: () => {
      const source = context.createBufferSource();
      const start = source.start.bind(source);
      source.start = (when = 0, offset?: number, duration?: number) => {
        const now = context.currentTime;
        onStart(Math.max(when, now), now);
        start(when, offset, duration);
      };
      return source;
    },
  };
}
