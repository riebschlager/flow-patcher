// The runtime's voice pool (ADR 0011: 64 voices, oldest stolen first). One per
// Runtime per audio context; audio nodes reach it as `AudioSetupContext.voices`
// and claim a voice for every note they schedule, so the limit holds across the
// whole patch and instruments keep no voice limits of their own.
//
// Times are audio-clock seconds. Notes are scheduled ahead of currentTime, so a
// voice is an interval [start, end) that may lie in the future. The pool keeps
// at most `size` voices sounding at every instant: a claim, or an end moved
// later, checks each start inside the time it adds, and while more than `size`
// voices sound there it steals the one with the earliest start (the first
// claimed among equal starts). Stealing calls the voice's stop(at), with `at`
// that start, and drops it from the pool; the node fades it out there.
//
// Steals are decided at schedule time and never undone. If the stealing note is
// later withdrawn (a rewind's cancel, ADR 0019, or a hot swap's), the node
// releases it and its slot frees, but the voice it stole stays cut. Undoing it
// would mean putting the voice back in the pool, which could push a later start
// over the limit again and start another round of steals. It takes a full pool
// plus a rewind or swap to happen at all (ADR 0024).
//
// Voices whose end has passed (end <= currentTime) are reclaimed lazily, at the
// next claim or count. Audio nodes never get times before currentTime, so a
// reclaimed voice couldn't be sounding at any start a claim checks: which voices
// get stolen depends only on the claims and their order, not on when the clock
// was read, and a run that schedules the same notes in the same order steals
// the same voices.
import { VOICE_LIMIT } from '../limits';

/** What a node hands the pool for one note. */
export interface VoiceClaim {
  /** Audio-clock time the voice starts sounding. */
  start: number;
  /** Audio-clock time it is silent again: its release end. Infinity while unknown. */
  end: number;
  /**
   * Cuts the voice short: fade it out from `at` and stop it. The pool calls it
   * once, when it steals the voice. It may run inside `claim` itself, for this
   * claim (when the new voice is the oldest at a later start) or for an older one.
   */
  stop(at: number): void;
}

/** A claimed voice. Hand it back to `release` or `setEnd`. */
export interface VoiceHandle {
  readonly start: number;
  /** The release end, or the time it was stolen at. */
  readonly end: number;
  /** True once the pool has stolen it. */
  readonly stolen: boolean;
}

class Voice implements VoiceHandle {
  stolen = false;
  constructor(readonly start: number, public end: number, readonly stop: (at: number) => void) {}
}

/** The first index in ascending `items` whose key is greater than `t` (or, `orEqual`, at least `t`). */
function above<T>(items: readonly T[], t: number, key: (item: T) => number, orEqual = false): number {
  let lo = 0, hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const k = key(items[mid]!);
    if (orEqual ? k < t : k <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
const self = (t: number) => t;
const startOf = (v: Voice) => v.start;

/**
 * Cost: a patch at its event budget can claim 2,048 voices in one window, and
 * with short notes none of them is stolen or over yet, so the pool holds them
 * all. Counting the voices sounding at an instant is two binary searches
 * (starts up to it, minus ends up to it: a voice that has ended has started),
 * so a claim costs O(log n) plus the array insertions, which are appends when
 * claims come in time order. A steal scans from the earliest start for the
 * first voice still sounding, past any that are over but not yet reclaimed.
 * Measured on an M-series laptop, 2,048 claims in one window take about 1 ms
 * with short notes, and with long ones that steal from the 65th claim on; a
 * linear count per claim took 80 ms. The worst found is 1,024 short notes and
 * then 1,024 long ones in the same window, every steal scanning past the short
 * ones: about 9 ms, once, for a patch already at both budgets. The main thread
 * has scheduling and UI to run (ADR 0016), so keep it well under a frame.
 */
export class VoicePool {
  /** Pooled voices by start, then claim order. */
  private voices: Voice[] = [];
  /** Their ends, ascending. */
  private ends: number[] = [];

  /** `now` reads the audio clock (the context's currentTime). */
  constructor(private readonly now: () => number, readonly size: number = VOICE_LIMIT) {}

  /**
   * Takes a voice for [start, end), stealing older voices where the pool is
   * full. `end` may be Infinity, until `setEnd` says otherwise. A claim that
   * would never sound (a start that isn't finite, or an end that isn't after
   * it, NaN included) takes no slot: its handle is already over, ending at its start.
   */
  claim(claim: VoiceClaim): VoiceHandle {
    this.reclaim();
    const { start, end } = claim;
    if (!Number.isFinite(start) || !(end > start)) return new Voice(start, start, claim.stop);
    const voice = new Voice(start, end, claim.stop);
    this.voices.splice(above(this.voices, start, startOf), 0, voice);
    this.ends.splice(above(this.ends, end, self), 0, end);
    this.enforce(start, end);
    return voice;
  }

  /** Frees a voice's slot: the node withdrew its note or stopped it for good. Does nothing for a stolen or reclaimed voice. */
  release(handle: VoiceHandle): void {
    this.remove(handle as Voice);
  }

  /**
   * Moves a voice's end, such as a note-off that came earlier or later than first
   * scheduled. Earlier frees its slot sooner; later can steal, from the old end
   * on, like a claim. An end at or before the start (or NaN) ends the voice at
   * its start and frees the slot. Does nothing for a stolen voice or one whose
   * end the clock has passed.
   */
  setEnd(handle: VoiceHandle, end: number): void {
    // A voice that is over stays over: reclaim first, so it isn't extended.
    this.reclaim();
    const voice = handle as Voice;
    if (this.indexOf(voice) < 0) return;
    if (!(end > voice.start)) {
      this.remove(voice);
      voice.end = voice.start;
      return;
    }
    const before = voice.end;
    // Only its end moves: it keeps its place among equal starts.
    this.ends.splice(above(this.ends, before, self) - 1, 1);
    this.ends.splice(above(this.ends, end, self), 0, end);
    voice.end = end;
    if (end > before) this.enforce(before, end);
  }

  /** Voices claimed and not yet over: sounding now or scheduled to. */
  inUse(): number {
    this.reclaim();
    return this.voices.length;
  }

  /** Where a pooled voice sits in `voices`, or -1. */
  private indexOf(voice: Voice): number {
    // Equal starts sit together; the voice is among them, if pooled at all.
    for (let i = above(this.voices, voice.start, startOf) - 1; i >= 0 && this.voices[i]!.start === voice.start; i--) {
      if (this.voices[i] === voice) return i;
    }
    return -1;
  }

  /** Takes a voice out of the pool. False if it wasn't in. */
  private remove(voice: Voice): boolean {
    const i = this.indexOf(voice);
    if (i < 0) return false;
    this.voices.splice(i, 1);
    this.ends.splice(above(this.ends, voice.end, self) - 1, 1);
    return true;
  }

  /** Drops voices that are over, once the clock has passed the earliest end. */
  private reclaim(): void {
    const now = this.now();
    if (!(this.ends[0]! <= now)) return;
    this.voices = this.voices.filter((v) => !(v.end <= now));
    this.ends.splice(0, above(this.ends, now, self));
  }

  /** Keeps at most `size` voices sounding at each start in [from, to). Concurrency only rises at a start, so that covers every instant. */
  private enforce(from: number, to: number): void {
    const starts: number[] = [];
    for (let i = above(this.voices, from, startOf, true); i < this.voices.length && this.voices[i]!.start < to; i++) {
      if (this.voices[i]!.start !== starts[starts.length - 1]) starts.push(this.voices[i]!.start);
    }
    for (const at of starts) {
      let sounding = above(this.voices, at, startOf) - above(this.ends, at, self);
      while (sounding > this.size) {
        // The first voice in start order still sounding at `at`: the earliest start, then the first claimed.
        const victim = this.voices.find((v) => v.end > at)!;
        this.remove(victim);
        sounding--;
        victim.end = at;
        victim.stolen = true;
        victim.stop(at);
      }
    }
  }
}
