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
   * It must not call back into the pool (claim, release, setEnd): the pool is
   * mid-sweep, with cursors into its arrays that a change would invalidate.
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

/** Seconds a stolen voice takes to fade before its source stops (Flow's 64-voice cut). */
export const STEAL_FADE = 0.05;

/** When a voice is silent: its release end, or its steal plus STEAL_FADE. */
export const voiceEnd = (voice: { readonly handle: VoiceHandle }): number => (voice.handle.stolen ? voice.handle.end + STEAL_FADE : voice.handle.end);

/**
 * What an audio node sees of the pool (`AudioSetupContext.voices`): the pool
 * itself, or the runtime's per-node view of it (`VoicePool.forNode`), which
 * tags each claim with the node so its steals count toward it.
 */
export interface Voices {
  readonly size: number;
  claim(claim: VoiceClaim): VoiceHandle;
  release(handle: VoiceHandle): void;
  setEnd(handle: VoiceHandle, end: number): void;
  inUse(): number;
}

class Voice implements VoiceHandle {
  stolen = false;
  constructor(readonly start: number, public end: number, readonly stop: (at: number) => void, readonly owner: string | null) {}
}

/** One node's view of the pool: claims through it are the node's. */
class NodeVoices implements Voices {
  constructor(private readonly pool: VoicePool, readonly owner: string) {}
  get size(): number {
    return this.pool.size;
  }
  claim(claim: VoiceClaim): VoiceHandle {
    return this.pool.claim(claim, this.owner);
  }
  release(handle: VoiceHandle): void {
    this.pool.release(handle);
  }
  setEnd(handle: VoiceHandle, end: number): void {
    this.pool.setEnd(handle, end);
  }
  inUse(): number {
    return this.pool.inUse();
  }
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
 * all. A claim is a binary search and an array insertion (an append when
 * claims come in time order), then a sweep over the starts inside the time it
 * adds, counting the voices sounding at each from two cursors (starts up to
 * it, minus ends up to it: a voice that has ended has started).
 *
 * Three shortcuts keep the sweep and the steals from going quadratic, without
 * changing which voice is stolen:
 * - Before a claim, at most `size` voices sound at every start, and the claim
 *   adds one. So a start needs at most one steal, and once it steals, every
 *   start up to the stolen voice's old end has the new voice in and the stolen
 *   one out, and needs none: the sweep jumps there.
 * - Each start adds at most one voice, so with `room` slots free at one start,
 *   none of the next `room` voices' starts can be over: the sweep jumps past
 *   them, by binary search when the jump is long.
 * - A steal takes the first voice in start order still sounding. The pool
 *   remembers how far the last search got (`skip`, the voices before it all
 *   over by `skipEnd`), so the next steal at or after `skipEnd` starts there
 *   instead of scanning again past voices that are over but not reclaimed.
 *
 * Measured on an M-series laptop (Node 24; medians of 30 runs after warm-up,
 * five sessions), 2,048 claims in one 120 ms window take about 0.3 ms with
 * short notes and 0.4 ms with long ones that steal from the 65th claim on.
 * The case ADR 0024 measured at about 9 ms, 1,024 short notes and then 1,024
 * long ones after them, takes 0.4 ms (3.9 ms before, on this laptop). On the
 * same starts it took 66 ms before these shortcuts (every long claim swept
 * every later short start) and takes about 1 ms now; claimed latest start
 * first, 1.8 to 3.3 ms. The worst found is that last case with short notes
 * 60 deep, so nearly every start is one short of full and the sweep steps
 * through all of them: 3.1 to 3.5 ms, 3.9 at worst (ADR 0025). The main
 * thread has scheduling and UI to run (ADR 0016's ~4 ms), so keep it there.
 * Going lower needs a range-max structure over the starts.
 */
export class VoicePool implements Voices {
  /** Pooled voices by start, then claim order. */
  private voices: Voice[] = [];
  /** Their ends, ascending. */
  private ends: number[] = [];
  /** Every voice before index `skip` in `voices` ends at or before `skipEnd`. */
  private skip = 0;
  private skipEnd = -Infinity;
  private stolen = 0;
  private readonly views = new Map<string, NodeVoices>();
  /**
   * Called on every steal, after the voice's stop: `owner` is the node whose
   * claim or later end caused it (null for a claim made on the pool itself),
   * `at` the time the voice was cut. The runtime raises its warning from here.
   * Like `VoiceClaim.stop`, it must not call back into the pool (claim,
   * release, setEnd): the sweep that stole keeps cursors into its arrays.
   */
  onSteal: ((owner: string | null, at: number) => void) | null = null;

  /** `now` reads the audio clock (the context's currentTime). */
  constructor(private readonly now: () => number, readonly size: number = VOICE_LIMIT) {}

  /** Voices stolen so far. */
  get steals(): number {
    return this.stolen;
  }

  /** The pool as node `id` sees it: the same view every time, so a hot swap's rebuilt instance shares it. */
  forNode(id: string): Voices {
    let view = this.views.get(id);
    if (!view) this.views.set(id, (view = new NodeVoices(this, id)));
    return view;
  }

  /**
   * Takes a voice for [start, end), stealing older voices where the pool is
   * full. `end` may be Infinity, until `setEnd` says otherwise. A claim that
   * would never sound (a start that isn't finite, or an end that isn't after
   * it, NaN included) takes no slot: its handle is already over, ending at its start.
   * `owner` is the node claiming (`forNode` passes it), for `onSteal`.
   */
  claim(claim: VoiceClaim, owner: string | null = null): VoiceHandle {
    this.reclaim();
    const { start, end } = claim;
    if (!Number.isFinite(start) || !(end > start)) return new Voice(start, start, claim.stop, owner);
    const voice = new Voice(start, end, claim.stop, owner);
    const at = above(this.voices, start, startOf);
    this.voices.splice(at, 0, voice);
    if (at < this.skip) {
      if (end <= this.skipEnd) this.skip++;
      else this.skip = at;
    }
    this.ends.splice(above(this.ends, end, self), 0, end);
    this.enforce(start, end, owner);
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
    const i = this.indexOf(voice);
    if (i < 0) return;
    if (!(end > voice.start)) {
      this.removeAt(i);
      voice.end = voice.start;
      return;
    }
    const before = voice.end;
    // Only its end moves: it keeps its place among equal starts.
    this.ends.splice(above(this.ends, before, self) - 1, 1);
    this.ends.splice(above(this.ends, end, self), 0, end);
    voice.end = end;
    if (i < this.skip && end > this.skipEnd) this.skip = i;
    if (end > before) this.enforce(before, end, voice.owner);
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

  /** Takes a voice out of the pool, if it is in. */
  private remove(voice: Voice): void {
    const i = this.indexOf(voice);
    if (i >= 0) this.removeAt(i);
  }

  private removeAt(i: number): void {
    const voice = this.voices[i]!;
    this.voices.splice(i, 1);
    this.ends.splice(above(this.ends, voice.end, self) - 1, 1);
    if (i < this.skip) this.skip--;
  }

  /** Drops voices that are over, once the clock has passed the earliest end. */
  private reclaim(): void {
    const now = this.now();
    if (!(this.ends[0]! <= now)) return;
    const voices = this.voices;
    let kept = 0, skip = 0;
    for (let i = 0; i < voices.length; i++) {
      const voice = voices[i]!;
      if (voice.end <= now) continue;
      if (i < this.skip) skip++;
      voices[kept++] = voice;
    }
    voices.length = kept;
    this.skip = skip;
    this.ends.splice(0, above(this.ends, now, self));
  }

  /**
   * Keeps at most `size` voices sounding at each start in [from, to), the time
   * a claim or a later end added. Concurrency only rises at a start, so that
   * covers every instant. `owner` caused the steals.
   */
  private enforce(from: number, to: number, owner: string | null): void {
    const voices = this.voices, ends = this.ends;
    let i = above(voices, from, startOf, true);
    if (i >= voices.length || voices[i]!.start >= to) return;
    let at = voices[i]!.start;
    // Voices started by `at`, and ends reached by it.
    let started = above(voices, at, startOf);
    let ended = above(ends, at, self);
    for (;;) {
      let sounding = started - ended;
      if (sounding > this.size) {
        const once = sounding === this.size + 1;
        let cut = at;
        while (sounding > this.size) {
          // Started by `at` and ending after it: removing it leaves `ended` as is.
          cut = this.steal(at, owner);
          started--;
          sounding--;
        }
        if (once) {
          // Up to `cut`, the claim's voice is in and the stolen one out: nothing more to steal there.
          i = above(voices, cut, startOf, true);
          if (i >= voices.length || voices[i]!.start >= to) return;
          at = voices[i]!.start;
          started = above(voices, at, startOf);
          ended = above(ends, at, self);
          continue;
        }
      }
      // `sounding` is at most `size` now. Each later start adds at most one, so
      // before the start of the voice `room` places on, none can be over.
      const room = this.size - sounding;
      const next = started + room;
      if (next >= voices.length || voices[next]!.start >= to) return;
      at = voices[next]!.start;
      if (room < 8) {
        while (started < voices.length && voices[started]!.start <= at) started++;
        while (ended < ends.length && ends[ended]! <= at) ended++;
      } else {
        started = above(voices, at, startOf);
        ended = above(ends, at, self);
      }
    }
  }

  /**
   * Steals the first voice in start order still sounding at `at` (the earliest
   * start, then the first claimed): stops it there and takes it out. Returns
   * the end it had. There is one: more than `size` voices sound at `at`.
   */
  private steal(at: number, owner: string | null): number {
    const voices = this.voices;
    if (this.skipEnd > at) {
      this.skip = 0;
      this.skipEnd = -Infinity;
    }
    let i = this.skip;
    for (let end = voices[i]!.end; end <= at; end = voices[++i]!.end) if (end > this.skipEnd) this.skipEnd = end;
    this.skip = i;
    const victim = voices[i]!;
    const cut = victim.end;
    this.removeAt(i);
    victim.end = at;
    victim.stolen = true;
    this.stolen++;
    victim.stop(at);
    this.onSteal?.(owner, at);
    return cut;
  }
}
