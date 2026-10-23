import type { EngineEvent, Runtime } from '@flow-patcher/engine';

/** How far back a probe's history reaches, seconds (design system Probe: "−2.0 s … now"). */
export const PROBE_HISTORY = 2;

/** What a track reads from the runtime. */
export type EventSource = Pick<Runtime, 'eventsAt' | 'retainedFrom'>;

/** An Event output's events as they sound. It reads ahead each frame and after every push and swap (which can
 *  add events the next wake prunes), so what the runtime has stopped retaining (`Runtime.retainedFrom`) still
 *  comes from the copy read then. The runtime prunes by currentTime, ahead of `now` by the output latency. */
export class EventTrack {
  /** Events past the last frame's `now`, as last read. */
  private ahead: Readonly<EngineEvent>[] = [];
  /** What sounded in the last frame, and over the history. */
  sounded: Readonly<EngineEvent>[] = [];
  readonly history: Readonly<EngineEvent>[] = [];
  users = 0;

  constructor(readonly node: string, readonly port: string, private prev: number) {}

  /** Reads ahead again: what the runtime retains now, and the earlier copy of what it has pruned. A rewind or
   *  swap only replaces events at or after currentTime, so what was pruned (before it) can't have changed. */
  refresh(runtime: EventSource): void {
    const prev = this.prev;
    const from = runtime.retainedFrom ?? -Infinity;
    const kept = this.ahead.filter((e) => e.time > prev && e.time < from);
    this.ahead = [...kept, ...runtime.eventsAt(this.node, this.port, Math.max(prev, from), Infinity).filter((e) => e.time > prev)];
  }

  update(runtime: EventSource, now: number): void {
    if (now <= this.prev) {
      this.sounded = [];
      return;
    }
    this.refresh(runtime);
    this.prev = now;
    this.sounded = this.ahead.filter((e) => e.time <= now);
    this.ahead = this.ahead.filter((e) => e.time > now);
    this.history.push(...this.sounded);
    let old = 0;
    while (old < this.history.length && this.history[old]!.time <= now - PROBE_HISTORY) old++;
    this.history.splice(0, old);
  }
}
