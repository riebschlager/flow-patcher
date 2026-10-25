// Reverb ★: convolution with a generated impulse, from Flow's AmbientAudio
// (../flow/public/music.js, `initialize`): low-passed noise, prev = prev·a + n·(1 − a),
// under a (1 − t / length)^2.8 fade with a short fade-in, one stream per channel.
//
// Changes from Flow:
// - Deterministic: the noise comes from `rngAt(seed, nodeId, 'impulse', variant, channel)`, never
//   Math.random, so each Reverb in a patch has its own impulse and Variant picks another.
// - Flow's impulse was fixed at 5 s and a 0.6 pole. Decay (its length), Damping (the pole) and
//   Predelay (leading silence) are knobs, and the 900-sample fade-in is 20 ms, so the shape is the
//   same at any sample rate.
// - Flow let Web Audio normalize the impulse, which makes the wet level grow with the square root of
//   the length (measured: 0.14 of the dry level at 0.3 s, 0.71 at 8 s). The impulse is scaled here
//   instead, so low tones come back at their own level whatever Decay or the sample rate, and Damping
//   takes off highs rather than boosting lows (`reverbImpulse`).
// - Flow fed the reverb as a send with a separate dry level. Here it is an insert with one Mix
//   knob, equal-power, so a half mix doesn't dip.
import {
  editRamp,
  paramAutomation,
  rngAt,
  type AudioContextLike,
  type ConvolverNodeLike,
  type EditRamp,
  type GainNodeLike,
  type NodeDefinition,
  type ParamValues,
} from '@flow-patcher/engine';

/** Flow's envelope exponent: the tail falls as (1 − t / decay)^2.8. */
const DECAY_CURVE = 2.8;
/** Fade-in at the impulse's start, seconds (Flow: 900 samples). */
const FADE_IN = 0.02;
/** How long a Decay, Damping, Predelay or Variant edit crossfades between impulses, seconds. *(tune)* */
export const IMPULSE_CROSSFADE = 0.05;
/** Convolvers left ringing at once: the playing one and the tails of up to three before it. *(tune)* */
export const MAX_TAILS = 4;

export const REVERB_LIMITS = { decay: [0.3, 8], damping: [0, 0.95], predelay: [0, 0.2] } as const;

export interface ImpulseOptions {
  /** Tail length in seconds. */
  decay: number;
  /** One-pole smoothing of the noise, 0 (white) to 0.95 (dark). Flow used 0.6. */
  damping: number;
  /** Silence before the tail, seconds. */
  predelay: number;
  /** Which noise: different variants give different impulses of the same shape. */
  variant: number;
}

/** Whose impulse: the patch seed and the node id key its noise. */
export interface ImpulseKey {
  seed: number;
  nodeId: string;
}

const clamp = (v: number, [lo, hi]: readonly [number, number], fallback: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback);

/**
 * The impulse response, one Float32Array per channel (stereo: two independent noise streams,
 * so a mono input comes back wide). Each is scaled so its expected power gain at low frequencies
 * is 1: unit energy (white noise in, white noise out at the same level) times (1 − a) / (1 + a) for
 * the damping pole a, whose low-pass gathers the energy below its corner. A pure function of its
 * arguments: the same key, options and sample rate give the same samples. Out-of-range options are
 * clamped, NaN takes the default.
 */
export function reverbImpulse(sampleRate: number, { seed, nodeId }: ImpulseKey, options: ImpulseOptions, channels = 2): Float32Array[] {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const decay = clamp(options.decay, REVERB_LIMITS.decay, 3);
  const damping = clamp(options.damping, REVERB_LIMITS.damping, 0.6);
  const predelay = clamp(options.predelay, REVERB_LIMITS.predelay, 0);
  const variant = Number.isFinite(options.variant) ? Math.trunc(options.variant) : 0;
  const lead = Math.round(predelay * rate), tail = Math.max(1, Math.round(decay * rate)), fade = FADE_IN * rate;
  const out: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    const data = new Float32Array(lead + tail);
    const rng = rngAt(seed, nodeId, 'impulse', variant, ch);
    let prev = 0, energy = 0;
    for (let i = 0; i < tail; i++) {
      prev = prev * damping + (rng.next() * 2 - 1) * (1 - damping);
      const v = prev * Math.pow(1 - i / tail, DECAY_CURVE) * Math.min(1, i / fade);
      data[lead + i] = v;
      energy += v * v;
    }
    if (energy > 0) {
      const scale = Math.sqrt((1 - damping) / (1 + damping) / energy);
      for (let i = lead; i < data.length; i++) data[i]! *= scale;
    }
    out.push(data);
  }
  return out;
}

/** Dry and wet gains for a mix of 0–1, equal-power. */
export function mixGains(mix: number): { dry: number; wet: number } {
  const m = Number.isFinite(mix) ? Math.max(0, Math.min(1, mix)) : 0;
  return { dry: Math.cos((m * Math.PI) / 2), wet: Math.sin((m * Math.PI) / 2) };
}

const impulseOf = (params: ParamValues): ImpulseOptions => ({
  decay: params.decay as number,
  damping: params.damping as number,
  predelay: params.predelay as number,
  variant: params.variant as number,
});
const sameImpulse = (a: ImpulseOptions, b: ImpulseOptions) => a.decay === b.decay && a.damping === b.damping && a.predelay === b.predelay && a.variant === b.variant;

/** One impulse: input → send → convolver → return → wet. */
interface Slot {
  send: GainNodeLike;
  convolver: ConvolverNodeLike;
  ret: GainNodeLike;
  sendRamp: EditRamp;
  returnRamp: EditRamp;
  /** The impulse's length, seconds. */
  length: number;
  /** Audio-clock time from which it is silent, once it stops being the playing one. */
  silentAt: number;
  /** Cut short on its return (`MAX_TAILS`). */
  evicted: boolean;
}

function buildSlot(audio: AudioContextLike, key: ImpulseKey, input: GainNodeLike, wet: GainNodeLike, options: ImpulseOptions, level: number): Slot {
  const data = reverbImpulse(audio.sampleRate, key, options);
  const buffer = audio.createBuffer(data.length, data[0]!.length, audio.sampleRate);
  data.forEach((channel, i) => buffer.getChannelData(i).set(channel));
  const send = audio.createGain(), convolver = audio.createConvolver(), ret = audio.createGain();
  send.gain.value = level;
  // reverbImpulse normalizes it already (unit energy), the same in every browser.
  convolver.normalize = false;
  convolver.buffer = buffer;
  input.connect(send);
  send.connect(convolver);
  convolver.connect(ret);
  ret.connect(wet);
  return { send, convolver, ret, sendRamp: editRamp(send.gain, level, IMPULSE_CROSSFADE), returnRamp: editRamp(ret.gain, 1, IMPULSE_CROSSFADE),
    length: data[0]!.length / audio.sampleRate, silentAt: Infinity, evicted: false };
}

function disposeSlot(slot: Slot): void {
  slot.send.disconnect();
  slot.convolver.disconnect();
  slot.ret.disconnect();
}

export const reverb: NodeDefinition = {
  type: 'reverb',
  version: 1,
  label: 'Reverb',
  category: 'effects-mix',
  description: 'Convolution reverb with a generated tail. Decay sets how long it rings, Damping how dark, Mix the wet share. Turning Decay, Damping, Predelay or Variant crossfades to a new tail while the old one rings out.',
  ports: [
    { name: 'in', type: 'audio', direction: 'in', label: 'In' },
    { name: 'out', type: 'audio', direction: 'out', label: 'Out' },
  ],
  params: [
    // A new impulse per value, so not modulatable; log-scaled so short rooms get as much travel as long halls (ADR 0032).
    { name: 'decay', kind: 'number', min: 0.3, max: 8, default: 3, unit: 's', label: 'Decay', scale: 'log', modulatable: false },
    { name: 'damping', kind: 'number', min: 0, max: 0.95, default: 0.6, label: 'Damping', modulatable: false },
    { name: 'predelay', kind: 'number', min: 0, max: 0.2, default: 0, unit: 's', label: 'Predelay', modulatable: false },
    { name: 'mix', kind: 'number', min: 0, max: 1, default: 0.35, label: 'Mix' },
    { name: 'variant', kind: 'number', min: 0, max: 15, default: 0, step: 1, label: 'Variant', modulatable: false },
  ],
  // Every knob changes in place: Mix ramps, the rest crossfade to a new impulse (ADR 0031).
  liveParams: ['decay', 'damping', 'predelay', 'mix', 'variant'],
  audio({ audio, params, param, connected, seed, nodeId }) {
    const key: ImpulseKey = { seed, nodeId };
    const input = audio.createGain(), dry = audio.createGain(), wet = audio.createGain(), out = audio.createGain();
    const start = mixGains(params.mix as number);
    dry.gain.value = start.dry;
    wet.gain.value = start.wet;
    input.connect(dry);
    dry.connect(out);
    wet.connect(out);
    let impulse = impulseOf(params);
    // The playing impulse is last; earlier ones ring out their tails and are dropped once silent.
    const slots: Slot[] = [buildSlot(audio, key, input, wet, impulse, 1)];
    const prune = () => {
      for (let i = slots.length - 2; i >= 0; i--) {
        if (slots[i]!.silentAt <= audio.currentTime) disposeSlot(slots.splice(i, 1)[0]!);
      }
    };
    // Fixed for the instance's life: a change to the cables into params builds a new one.
    const cabled = connected('mix');
    const edits = { dry: editRamp(dry.gain, start.dry), wet: editRamp(wet.gain, start.wet) };
    const automation = { dry: paramAutomation(dry.gain), wet: paramAutomation(wet.gain) };
    return {
      inputs: { in: input },
      outputs: { out },
      automate(t0, t1, clock) {
        prune();
        // A bus has no event channels: modulation is read on channel 0.
        if (!cabled) return;
        automation.dry.follow(t0, t1, (t) => mixGains(param('mix', t)).dry, clock);
        automation.wet.follow(t0, t1, (t) => mixGains(param('mix', t)).wet, clock);
      },
      update(next, time) {
        prune();
        if (!cabled) {
          const gains = mixGains(next.mix as number);
          edits.dry.set(gains.dry, time);
          edits.wet.set(gains.wet, time);
        }
        const wanted = impulseOf(next);
        if (sameImpulse(wanted, impulse)) return;
        impulse = wanted;
        // A new impulse fades in on the input while the playing one fades out there, so its tail
        // rings on and the wet signal never steps or drops out. The old one is silent once its
        // tail has played through.
        const playing = slots.at(-1)!;
        playing.sendRamp.set(0, time);
        playing.silentAt = time + IMPULSE_CROSSFADE + playing.length;
        slots.push(buildSlot(audio, key, input, wet, impulse, 0));
        slots.at(-1)!.sendRamp.set(1, time);
        // Too many tails (a knob dragged through many values): the oldest fade out on their return.
        const ringing = slots.filter((slot) => !slot.evicted);
        for (const old of ringing.slice(0, Math.max(0, ringing.length - MAX_TAILS))) {
          old.returnRamp.set(0, time);
          old.silentAt = Math.min(old.silentAt, time + IMPULSE_CROSSFADE);
          old.evicted = true;
        }
      },
      dispose() {
        for (const slot of slots) disposeSlot(slot);
        for (const node of [input, dry, wet, out]) node.disconnect();
      },
    };
  },
};
