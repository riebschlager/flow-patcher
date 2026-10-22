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
// releases it and its slot frees, but the voice it stole stays cut: Web Audio
// can't take back a scheduled stop cheaply, and the cut happens ahead of time,
// usually before anyone could hear the difference.
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

export class VoicePool {
  /** Pooled voices in claim order. */
  private voices: Voice[] = [];

  /** `now` reads the audio clock (the context's currentTime). */
  constructor(private readonly now: () => number, readonly size: number = VOICE_LIMIT) {}

  /** Takes a voice for [start, end), stealing older voices where the pool is full. */
  claim(claim: VoiceClaim): VoiceHandle {
    this.reclaim();
    const voice = new Voice(claim.start, Math.max(claim.start, claim.end), claim.stop);
    this.voices.push(voice);
    this.enforce(voice.start, voice.end);
    return voice;
  }

  /** Frees a voice's slot: the node withdrew its note or stopped it for good. Does nothing for a stolen or reclaimed voice. */
  release(handle: VoiceHandle): void {
    const index = this.voices.indexOf(handle as Voice);
    if (index >= 0) this.voices.splice(index, 1);
  }

  /**
   * Moves a voice's end, such as a note-off that came earlier or later than first
   * scheduled. Earlier frees its slot sooner; later can steal, from the old end
   * on, like a claim. Does nothing for a stolen or reclaimed voice.
   */
  setEnd(handle: VoiceHandle, end: number): void {
    const voice = handle as Voice;
    if (!this.voices.includes(voice)) return;
    const before = voice.end;
    voice.end = Math.max(voice.start, end);
    if (voice.end > before) this.enforce(before, voice.end);
  }

  /** Voices claimed and not yet over: sounding now or scheduled to. */
  inUse(): number {
    this.reclaim();
    return this.voices.length;
  }

  /** Drops every voice without stopping it, for a runtime that is shutting audio down. */
  clear(): void {
    this.voices = [];
  }

  private reclaim(): void {
    const now = this.now();
    this.voices = this.voices.filter((v) => !(v.end <= now));
  }

  /** Keeps at most `size` voices sounding at each start in [from, to). Concurrency only rises at a start, so that covers every instant. */
  private enforce(from: number, to: number): void {
    const starts = [...new Set(this.voices.map((v) => v.start).filter((t) => t >= from && t < to))].sort((a, b) => a - b);
    for (const at of starts) {
      let sounding = this.voices.filter((v) => v.start <= at && at < v.end);
      while (sounding.length > this.size) {
        // Claim order breaks ties, and `sounding` keeps it, so the first minimum is the first claimed.
        const victim = sounding.reduce((oldest, v) => (v.start < oldest.start ? v : oldest));
        sounding = sounding.filter((v) => v !== victim);
        this.voices.splice(this.voices.indexOf(victim), 1);
        victim.end = at;
        victim.stolen = true;
        victim.stop(at);
      }
    }
  }
}
