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
//   so edits, tempo changes and a transport coming or going glide linearly over 40 ms on the grid.
// - Feedback, tone and mix are knobs, and follow cables; feedback never passes 0.42 (Flow's gesture echo).
//   Flow sent the echo with a wet level only; here Mix is an equal-power insert mix, as on Reverb.
import {
  AUTOMATION_MEMORY,
  AUTOMATION_RATE,
  AUTOMATION_RENDER_MARGIN,
  automationTimes,
  editRamp,
  paramAutomation,
  transportTempo,
  type NodeDefinition,
} from '@flow-patcher/engine';
import { mixGains } from './mix';

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

/** Where a reading is taken to find the tempo a change came from: this long before the change. */
const BEFORE_CHANGE = 1e-6;
/** How many tempo changes, each less than DELAY_GLIDE after the one before, a glide looks back through. */
const MAX_CHAIN = 16;
/** Repeats until feedback at the cap has fallen 60 dB: 0.42^8 ≈ 0.001. */
const TAIL_REPEATS = 8;

/** How many repeats sound until they are 60 dB down at `feedback`, the first echo included. */
export function audibleRepeats(feedback: number): number {
  const f = cappedFeedback(feedback);
  return 1 + (f > 0 ? Math.min(TAIL_REPEATS, Math.ceil(Math.log(1e-3) / Math.log(f))) : 0);
}

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
    const freeTime = glides(params.time as number);
    /** The free time at t, used with no transport. */
    const free = (t: number): number => clampDelay(cabled.time ? param('time', t) : freeTime.at(t));
    /**
     * The delay at t on the transport: the division at its exact tempo (ADR 0034), gliding linearly over
     * DELAY_GLIDE from each tempo change, starting where the delay was just before the change (itself
     * mid-glide when changes come quicker than that, as a modulated tempo's ticks can). A pure function
     * of t and the readings, so re-runs and rewinds give the same course. Null with no transport.
     */
    // It reads the transport before t: up to MAX_CHAIN glides back, about 640 ms before the chunk's t0. That is
    // outside value()'s "t0 ≤ t < t1" contract (NodeState); it relies on Clock keeping TRANSPORT_HISTORY (2 s) of
    // anchors behind its window, so those reads stay exact.
    const synced = (t: number, depth = 0): number | null => {
      const tempo = transportTempo({ value }, 'transport', t);
      if (!tempo) return null;
      const target = delaySeconds(beats.at(t), tempo.beatsPerSecond);
      const into = t - tempo.since;
      if (!(into >= 0 && into < DELAY_GLIDE) || depth >= MAX_CHAIN) return target;
      const before = tempo.since - BEFORE_CHANGE, previous = transportTempo({ value }, 'transport', before);
      // The transport's first tempo (a Clock starting) has nothing before it to glide from.
      if (!previous || !(previous.since < tempo.since)) return target;
      // Not null: `previous` is a usable reading at `before`.
      const from = synced(before, depth + 1)!;
      return from + ((target - from) * into) / DELAY_GLIDE;
    };
    /** The delay at t from the tempo or the free time, before any switch between the two. */
    const course = (t: number): { synced: boolean; value: number } => {
      const on = synced(t);
      return on === null ? { synced: false, value: free(t) } : { synced: true, value: on };
    };
    // Grid points automate has worked out, in time order, and the switches between free time and
    // the transport (a Transport cable added or removed in a swap that keeps the instance): each
    // glides from the delay at the grid point before it. A re-run drops both from its t0 on and
    // works them out again, so the course depends only on the cables each chunk ran under.
    let history: { time: number; synced: boolean; value: number }[] = [];
    let switches: { at: number; from: number }[] = [];
    const scheduled = new Map<number, number>();
    line.delayTime.value = course(audio.currentTime).value;
    // The latest time automate covered, and the feedback from then on, for idleAt.
    let lastT1 = audio.currentTime, lastFeedback = cabled.feedback ? FEEDBACK_CAP : (params.feedback as number);

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
        lastT1 = Math.max(lastT1, t1);
        history = history.filter((h) => h.time < t0 && h.time >= t0 - AUTOMATION_MEMORY);
        switches = switches.filter((w) => w.at < t0 && w.at >= t0 - AUTOMATION_MEMORY - DELAY_GLIDE);
        scheduled.clear();
        for (const t of automationTimes(t0, t1)) {
          const now = course(t), previous = history.at(-1);
          if (previous && previous.synced !== now.synced) switches.push({ at: t, from: previous.value });
          const last = switches.at(-1);
          const v = last && t - last.at < DELAY_GLIDE ? last.from + ((now.value - last.from) * (t - last.at)) / DELAY_GLIDE : now.value;
          history.push({ time: t, synced: now.synced, value: v });
          scheduled.set(t, v);
        }
        // Always: the tempo on the transport can change whatever the cables into params.
        automation.time.follow(t0, t1, (t) => scheduled.get(t)!, clock);
        // A bus has no event channels: modulation is read on channel 0.
        if (cabled.feedback) automation.feedback.follow(t0, t1, (t) => cappedFeedback(param('feedback', t)), clock);
        if (cabled.tone) automation.tone.follow(t0, t1, (t) => param('tone', t), clock);
        if (cabled.mix) {
          automation.dry.follow(t0, t1, (t) => mixGains(param('mix', t)).dry, clock);
          automation.wet.follow(t0, t1, (t) => mixGains(param('mix', t)).wet, clock);
        }
        // No re-run reaches further back than paramAutomation remembers.
        beats.forget(t0 - AUTOMATION_MEMORY);
        freeTime.forget(t0 - AUTOMATION_MEMORY);
      },
      update(next, time) {
        // Division and Time: the swap re-runs automate from `time`, and `seconds` reads the glide.
        beats.set(divisionBeats(next.division), time);
        if (!cabled.time) freeTime.set(next.time as number, time);
        if (!cabled.feedback) lastFeedback = next.feedback as number;
        // Cabled params follow the re-run's automate, which reads the new base.
        if (!cabled.feedback) edits.feedback.set(cappedFeedback(next.feedback as number), time);
        if (!cabled.tone) edits.tone.set(next.tone as number, time);
        if (!cabled.mix) {
          const gains = mixGains(next.mix as number);
          edits.dry.set(gains.dry, time);
          edits.wet.set(gains.wet, time);
        }
      },
      // Retired by a rebuild (a cable change, a seed change), it echoes on until its repeats are 60 dB
      // down: input reaches it until the last time it covered.
      idleAt() {
        const seconds = history.at(-1)?.value ?? line.delayTime.value;
        return lastT1 + audibleRepeats(lastFeedback) * seconds + DELAY_GLIDE;
      },
      dispose() {
        for (const node of [input, dry, wet, out, line, tone, feedback]) node.disconnect();
      },
    };
  },
};
