// The editor's AudioContext wrapper forwards every method of AudioContextLike
// (#88's Pan broke in the browser when one was missing), checked on a fake and
// on node-web-audio-api's real OfflineAudioContext.
import type { AudioContextLike } from '@flow-patcher/engine';
import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import { observeStarts } from '../src/audio-context';

type Method = { [K in keyof AudioContextLike]-?: NonNullable<AudioContextLike[K]> extends (...args: never[]) => unknown ? K : never }[keyof AudioContextLike];

/** Arguments to call each method with. A Record over every method, so a method added to
 *  AudioContextLike fails the typecheck here until it is listed (and forwarded). */
const CALLS: Record<Method, unknown[]> = {
  createGain: [],
  createOscillator: [],
  createDynamicsCompressor: [],
  createWaveShaper: [],
  createBufferSource: [],
  createBiquadFilter: [],
  createStereoPanner: [],
  createConvolver: [],
  createDelay: [2.5],
  createBuffer: [2, 480, 48000],
  decodeAudioData: [new ArrayBuffer(8)],
};

describe('observeStarts', () => {
  it('forwards every AudioContextLike method to the context, with its arguments', () => {
    const calls: [string, unknown[]][] = [];
    const fake = new Proxy({ currentTime: 1.5, sampleRate: 44100, outputLatency: 0.02, baseLatency: 0.01, destination: { node: 'destination' } }, {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : (...args: unknown[]) => {
        calls.push([String(key), args]);
        return { made: key, start: () => {} };
      }),
    }) as unknown as AudioContext;
    const like = observeStarts(fake, () => {});
    for (const [method, args] of Object.entries(CALLS)) {
      const made = (like[method as Method] as (...a: unknown[]) => unknown)(...args);
      expect(made).toMatchObject({ made: method });
      expect(calls.at(-1)).toEqual([method, args]);
    }
    expect(calls).toHaveLength(Object.keys(CALLS).length);
    expect([like.currentTime, like.sampleRate, like.outputLatency, like.baseLatency, like.destination]).toEqual([1.5, 44100, 0.02, 0.01, { node: 'destination' }]);
    // createDelay with no argument keeps Web Audio's default rather than passing undefined.
    like.createDelay();
    expect(calls.at(-1)).toEqual(['createDelay', []]);
  });

  it('builds a working convolver, delay and buffer on a real context', async () => {
    const rate = 48000;
    const context = new OfflineAudioContext(1, rate / 10, rate);
    const starts: number[] = [];
    const like = observeStarts(context as unknown as AudioContext, (time) => starts.push(time));
    // A click at frame 0, through an impulse response with its tap at frame 100 and a 1 ms delay.
    const click = like.createBuffer(1, 1, rate);
    click.getChannelData(0)[0] = 1;
    const impulse = like.createBuffer(1, 200, rate);
    impulse.getChannelData(0)[100] = 0.5;
    const convolver = like.createConvolver();
    convolver.normalize = false;
    convolver.buffer = impulse;
    const delay = like.createDelay(0.5);
    delay.delayTime.value = 0.001;
    const source = like.createBufferSource();
    source.buffer = click;
    source.connect(convolver);
    convolver.connect(delay);
    delay.connect(like.destination);
    source.start(0);
    expect(starts).toEqual([0]);
    const out = (await context.startRendering()).getChannelData(0);
    const peak = out.reduce((best, v, i) => (Math.abs(v) > Math.abs(out[best]!) ? i : best), 0);
    expect(peak).toBe(100 + rate * 0.001);
    expect(out[peak]).toBeCloseTo(0.5, 5);
  });
});
