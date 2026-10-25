// Delay ★: a tempo-synced echo with a filtered feedback path, from Flow. The divisions and the
// seconds they give are timing.js (`echoDivisions`, `delaySeconds`, `maxDelaySeconds`); the chain is
// the gesture echo in AmbientAudio.initialize (../flow/public/music.js): delay → low-pass → feedback
// gain → back into the delay, with the wet signal taken after the low-pass, and feedback at 0.42.
//
// Changes from Flow:
// - The tempo comes from the Transport cable (ADR 0018, ADR 0034), exactly, rate included; Flow
//   read its global bpm and percussion rate. With no transport the time is a knob in seconds.
// - Flow clamped the tempo to 30–300 bpm. Clock goes from 20 bpm at a quarter rate, so here the
//   time itself is clamped to Flow's 32 s ceiling instead: a division longer than that plays at 32 s.
// - Flow glided time changes with setTargetAtTime (a 40 ms time constant). ADR 0031 rules that out,
//   so edits glide linearly over 40 ms on the automation grid (`glideAt`).
// - Feedback, tone and mix are knobs, and follow cables; feedback never passes 0.42 (Flow's gesture echo).
//   Flow sent the echo with a wet level only; here Mix is an equal-power insert mix, as on Reverb.
import {
  AUTOMATION_MEMORY,
  AUTOMATION_RATE,
  AUTOMATION_RENDER_MARGIN,
  editRamp,
  paramAutomation,
  transportTempo,
  type NodeDefinition,
} from '@flow-patcher/engine';
import { mixGains } from './reverb';

/** Divisions in beats (a quarter note is one), 1/64 to two bars, as Flow's echo menu. "T" is a triplet, "." dotted. */
export const DELAY_DIVISIONS: Readonly<Record<string, number>> = {
  '1/64': 1 / 16, '1/32T': 1 / 12, '1/64.': 3 / 32, '1/32': 1 / 8, '1/16T': 1 / 6, '1/32.': 3 / 16,
  '1/16': 1 / 4, '1/8T': 1 / 3, '1/16.': 3 / 8, '1/8': 1 / 2, '1/4T': 2 / 3, '1/8.': 3 / 4,
  '1/4': 1, '1/2T': 4 / 3, '1/4.': 3 / 2, '1/2': 2, '1/1T': 8 / 3, '1/2.': 3, '1/1': 4, '1/1.': 6, '2/1': 8,
};
/** Flow's default: a dotted eighth. */
export const DEFAULT_DIVISION = '1/8.';
/** Feedback never goes past this, whatever the knob or its cables say. */
export const FEEDBACK_CAP = 0.42;
/** The longest delay, seconds (Flow's maxDelaySeconds: 8 beats at 30 bpm and half speed). */
export const MAX_DELAY = 32;
/** The shortest: Web Audio holds a delay inside a feedback loop to one render quantum or more anyway. */
export const MIN_DELAY = 0.001;
/** How long a Division or Time edit glides, seconds (Flow's delayGlide). *(tune)* */
export const DELAY_GLIDE = 0.04;
/**
 * How long after an edit's swap time the glide starts: the most the swap's re-run keeps of the ramps
 * already scheduled (two grid steps plus the render margin, ADR 0031). Starting there, all of the
 * glide plays; the time holds until then.
 */
export const GLIDE_LEAD = 2 / AUTOMATION_RATE + AUTOMATION_RENDER_MARGIN;

/** A division's length in beats; an unknown one is Flow's fallback, a dotted eighth. */
export const divisionBeats = (division: unknown): number => (typeof division === 'string' && Object.hasOwn(DELAY_DIVISIONS, division) ? DELAY_DIVISIONS[division]! : DELAY_DIVISIONS[DEFAULT_DIVISION]!);

/** Clamped to MIN_DELAY–MAX_DELAY; NaN gives MIN_DELAY. */
export const clampDelay = (seconds: number): number => (Number.isNaN(seconds) ? MIN_DELAY : Math.max(MIN_DELAY, Math.min(MAX_DELAY, seconds)));

/** `beats` at `beatsPerSecond`, in seconds (Flow's delaySeconds), clamped. */
export const delaySeconds = (beats: number, beatsPerSecond: number): number => clampDelay(beats / beatsPerSecond);

/** Feedback as the node plays it: 0 to FEEDBACK_CAP, NaN as 0. */
export const cappedFeedback = (feedback: number): number => (Number.isNaN(feedback) ? 0 : Math.max(0, Math.min(FEEDBACK_CAP, feedback)));

/** A value that glides linearly from `from` to `to` over DELAY_GLIDE from `at`. */
interface Glide {
  at: number;
  from: number;
  to: number;
}

/** Knob edits on one value as glides, in time order: a pure function of t, so re-runs and rewinds read it alike. */
function glides(initial: number) {
  let base = initial;
  const list: Glide[] = [];
  const at = (t: number): number => {
    let value = base;
    for (const g of list) {
      if (t < g.at) break;
      value = t < g.at + DELAY_GLIDE ? g.from + ((g.to - g.from) * (t - g.at)) / DELAY_GLIDE : g.to;
    }
    return value;
  };
  return {
    at,
    /** Glides to `value` from `time` + GLIDE_LEAD, from wherever the earlier glides have it then. */
    set(value: number, time: number) {
      if (!Number.isFinite(value) || !Number.isFinite(time)) return;
      if (value === at(Infinity)) return;
      const start = Math.max(time + GLIDE_LEAD, list.at(-1)?.at ?? -Infinity);
      list.push({ at: start, from: at(start), to: value });
    },
    /** Forgets glides over before `time`, folding them into the base. */
    forget(time: number) {
      while (list.length && list[0]!.at + DELAY_GLIDE < time) base = list.shift()!.to;
    },
  };
}

export const delay: NodeDefinition = {
  type: 'delay',
  version: 1,
  label: 'Delay',
  category: 'effects-mix',
  description: 'Echo synced to a Clock\'s transport, 1/64 to two bars, with each repeat darkened by Tone. Feedback stops at 0.42, so repeats always die away. With no transport, Time sets the delay in seconds.',
  ports: [
    { name: 'in', type: 'audio', direction: 'in', label: 'In' },
    { name: 'transport', type: 'value', direction: 'in', label: 'Transport', unwiredHint: 'No transport: free time in seconds' },
    { name: 'out', type: 'audio', direction: 'out', label: 'Out' },
  ],
  params: [
    { name: 'division', kind: 'enum', options: Object.keys(DELAY_DIVISIONS), default: DEFAULT_DIVISION, label: 'Division' },
    // Used with no transport. Log-scaled: a cable's depth is in octaves, one octave is double the time (ADR 0032).
    { name: 'time', kind: 'number', min: 0.01, max: 4, default: 0.4, unit: 's', label: 'Time', scale: 'log' },
    // The knob stops at the cap; the node caps cables into it too.
    { name: 'feedback', kind: 'number', min: 0, max: FEEDBACK_CAP, default: 0.36, label: 'Feedback' },
    { name: 'tone', kind: 'number', min: 200, max: 20000, default: 3100, unit: 'Hz', label: 'Tone', scale: 'log' },
    { name: 'mix', kind: 'number', min: 0, max: 1, default: 0.35, label: 'Mix' },
  ],
  // Every knob changes in place: Division and Time glide, the rest ramp (ADR 0031).
  liveParams: ['division', 'time', 'feedback', 'tone', 'mix'],
  audio({ audio, params, param, value, connected }) {
    const input = audio.createGain(), dry = audio.createGain(), wet = audio.createGain(), out = audio.createGain();
    const line = audio.createDelay(MAX_DELAY), tone = audio.createBiquadFilter(), feedback = audio.createGain();
    // The loop stays inside Web Audio: the delay node is what makes it legal there, and the event
    // cycle checker never sees it (audio cables carry no events).
    input.connect(dry);
    input.connect(line);
    line.connect(tone);
    tone.connect(feedback);
    feedback.connect(line);
    tone.connect(wet);
    dry.connect(out);
    wet.connect(out);
    // Low-pass at Web Audio's default Q, as Flow's.
    tone.type = 'lowpass';
    tone.frequency.value = params.tone as number;
    feedback.gain.value = cappedFeedback(params.feedback as number);
    const start = mixGains(params.mix as number);
    dry.gain.value = start.dry;
    wet.gain.value = start.wet;

    // Fixed for the instance's life: a change to the cables into params builds a new one.
    const cabled = { time: connected('time'), feedback: connected('feedback'), tone: connected('tone'), mix: connected('mix') };
    const beats = glides(divisionBeats(params.division));
    const free = glides(params.time as number);
    /** The delay at t: the division at the transport's exact tempo, or the free time with no transport. */
    const seconds = (t: number): number => {
      const tempo = transportTempo({ value }, 'transport', t);
      if (tempo) return delaySeconds(beats.at(t), tempo.beatsPerSecond);
      return clampDelay(cabled.time ? param('time', t) : free.at(t));
    };
    line.delayTime.value = seconds(audio.currentTime);

    const edits = {
      feedback: editRamp(feedback.gain, feedback.gain.value),
      tone: editRamp(tone.frequency, tone.frequency.value),
      dry: editRamp(dry.gain, start.dry),
      wet: editRamp(wet.gain, start.wet),
    };
    const automation = {
      time: paramAutomation(line.delayTime),
      feedback: paramAutomation(feedback.gain),
      tone: paramAutomation(tone.frequency),
      dry: paramAutomation(dry.gain),
      wet: paramAutomation(wet.gain),
    };
    return {
      inputs: { in: input },
      outputs: { out },
      automate(t0, t1, clock) {
        // Always: the tempo on the transport can change whatever the cables into params.
        automation.time.follow(t0, t1, seconds, clock);
        // A bus has no event channels: modulation is read on channel 0.
        if (cabled.feedback) automation.feedback.follow(t0, t1, (t) => cappedFeedback(param('feedback', t)), clock);
        if (cabled.tone) automation.tone.follow(t0, t1, (t) => param('tone', t), clock);
        if (cabled.mix) {
          automation.dry.follow(t0, t1, (t) => mixGains(param('mix', t)).dry, clock);
          automation.wet.follow(t0, t1, (t) => mixGains(param('mix', t)).wet, clock);
        }
        // No re-run reaches further back than paramAutomation remembers.
        beats.forget(t0 - AUTOMATION_MEMORY);
        free.forget(t0 - AUTOMATION_MEMORY);
      },
      update(next, time) {
        // Division and Time: the swap re-runs automate from `time`, and `seconds` reads the glide.
        beats.set(divisionBeats(next.division), time);
        if (!cabled.time) free.set(next.time as number, time);
        // Cabled params follow the re-run's automate, which reads the new base.
        if (!cabled.feedback) edits.feedback.set(cappedFeedback(next.feedback as number), time);
        if (!cabled.tone) edits.tone.set(next.tone as number, time);
        if (!cabled.mix) {
          const gains = mixGains(next.mix as number);
          edits.dry.set(gains.dry, time);
          edits.wet.set(gains.wet, time);
        }
      },
      dispose() {
        for (const node of [input, dry, wet, out, line, tone, feedback]) node.disconnect();
      },
    };
  },
};
