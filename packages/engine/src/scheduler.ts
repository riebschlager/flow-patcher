// The one scheduler (design.md, Timing and evaluation; ADRs 0008, 0017, 0019).
//
// Every 25 ms it asks the runtime for the events from its horizon to
// now + 120 ms (1.25 s while the page is hidden). Windows are contiguous, so
// each moment is queried once. A wake up to 100 ms past its horizon still
// queries the stretch it missed, moved to start now so its events keep their
// spacing; a later wake is a stall and skips the missed windows. Live input
// takes the immediate path: `push` stamps it currentTime + 5 ms and sends it
// down its cables at once, rewinding the nodes downstream of it.
//
// The clocks and the timer are injected, so the same code runs in the
// browser, headless and in tests that simulate stalls.
import type { EngineEvent } from './events';
import type { LoggedEvent, RewindReport, Runtime, RuntimeCounters } from './runtime';

/** Seconds between wakes. */
export const WAKE_INTERVAL = 0.025;
/** Seconds queried ahead of now. */
export const LOOKAHEAD = 0.12;
/** Lookahead while the page is hidden and timers are throttled. */
export const HIDDEN_LOOKAHEAD = 1.25;
/** A wake at most this far past its horizon catches up; a later one is a stall. *(tune)* */
export const CATCH_UP_LIMIT = 0.1;
/** Live input is stamped this far after currentTime. *(tune)* */
export const IMMEDIATE_OFFSET = 0.005;

export interface SchedulerClock {
  /** The audio clock in seconds: AudioContext.currentTime. */
  audioTime(): number;
  /** A wall clock in milliseconds: performance.now(). Measures push cost, and
   *  tells a blocked main thread (both clocks jump) from an audio clock jump. */
  wallTime(): number;
  /** False while the audio clock is suspended: wakes do nothing, and the next
   *  running wake starts fresh rather than counting a stall. Default true. */
  running?(): boolean;
  /** True while the page is hidden, for the long lookahead. Default false. The
   *  host should also call `wake()` when visibility changes. */
  hidden?(): boolean;
}

export interface SchedulerTimer {
  /** Calls `tick` about every `ms` milliseconds until the returned function is called. */
  every(ms: number, tick: () => void): () => void;
}

export interface SchedulerOptions {
  clock: SchedulerClock;
  /** Drives `start()`. Headless runs and tests can call `wake()` themselves instead. */
  timer?: SchedulerTimer;
  wakeInterval?: number;
  lookahead?: number;
  hiddenLookahead?: number;
  catchUpLimit?: number;
  immediateOffset?: number;
  /** Keep a log of every event, with rewinds applied, for `events()`. Headless runs and tests. */
  record?: boolean;
  /** Called after every push with what it cost. */
  onPush?(cost: PushCost): void;
  /** Called when a wake skips windows. */
  onStall?(stall: Stall): void;
}

/** What one push cost on the immediate path. */
export interface PushCost {
  /** The stamped event time. */
  time: number;
  /** The rewind, or null when the push ran a wake instead (nothing queried past its time yet). */
  rewind: Omit<RewindReport, 'added'> | null;
  /** Node queries the push made, wake included. */
  queries: number;
  /** Wall-clock milliseconds the push took. */
  ms: number;
}

export interface Stall {
  /** Audio time of the wake that found the stall. */
  at: number;
  /** Seconds past the horizon. */
  late: number;
  skipped: number;
  /** Since the previous wake: both clocks, in ms. A blocked thread moves both alike. */
  wallMs: number | null;
  audioMs: number | null;
}

export interface SchedulerStats extends RuntimeCounters {
  /** Wakes that queried a window. */
  windows: number;
  /** Windows lost to stalls. */
  skipped: number;
  stalls: number;
  /** Wakes that caught up a late stretch (`caughtUp` counts their events). */
  catchUps: number;
  /** The latest a catch-up wake has been, in ms past the horizon. */
  catchUpMaxMs: number;
  pushes: number;
  /** Pushes that rewound. */
  rewinds: number;
  /** Node queries made by pushes. */
  pushQueries: number;
  pushMsMax: number;
  pushMsTotal: number;
}

/** The scheduler. One per running patch. */
export class Scheduler {
  readonly runtime: Runtime;
  private readonly clock: SchedulerClock;
  private readonly options: SchedulerOptions;
  private readonly wakeInterval: number;
  private readonly lookahead: number;
  private readonly hiddenLookahead: number;
  private readonly catchUpLimit: number;
  private readonly immediateOffset: number;
  private next: number | null = null;
  private last: { wall: number; audio: number } | null = null;
  private stop: (() => void) | null = null;
  private log: LoggedEvent[] | null;
  private readonly own = { windows: 0, skipped: 0, stalls: 0, catchUps: 0, catchUpMaxMs: 0, pushes: 0, rewinds: 0, pushQueries: 0, pushMsMax: 0, pushMsTotal: 0 };

  constructor(runtime: Runtime, options: SchedulerOptions) {
    this.runtime = runtime;
    this.options = options;
    this.clock = options.clock;
    this.wakeInterval = options.wakeInterval ?? WAKE_INTERVAL;
    this.lookahead = options.lookahead ?? LOOKAHEAD;
    this.hiddenLookahead = options.hiddenLookahead ?? HIDDEN_LOOKAHEAD;
    this.catchUpLimit = options.catchUpLimit ?? CATCH_UP_LIMIT;
    this.immediateOffset = options.immediateOffset ?? IMMEDIATE_OFFSET;
    this.log = options.record ? [] : null;
    runtime.keepHistory();
  }

  /** The end of the last queried window, or null before the first wake (or while suspended). */
  get horizon(): number | null {
    return this.next;
  }

  get stats(): SchedulerStats {
    return { ...this.runtime.counters, ...this.own };
  }

  /** Wakes now and then every wakeInterval on the injected timer. */
  start(): void {
    if (this.stop) return;
    const timer = this.options.timer;
    if (!timer) throw new Error('Scheduler.start needs a timer; call wake() yourself instead');
    this.stop = timer.every(this.wakeInterval * 1000, () => this.wake());
    this.wake();
  }

  /** Stops the timer. The next wake starts fresh at currentTime. */
  halt(): void {
    this.stop?.();
    this.stop = null;
    this.next = null;
    this.last = null;
  }

  /**
   * One wake: query from the horizon to now + lookahead. A wake up to
   * catchUpLimit past the horizon still queries what it missed, moved later
   * to start now; a later one skips the missed windows.
   */
  wake(): void {
    if (this.clock.running && !this.clock.running()) {
      this.next = null;
      this.last = null;
      return;
    }
    const now = this.clock.audioTime(), wall = this.clock.wallTime();
    const last = this.last;
    this.last = { wall, audio: now };
    let t0 = this.next ?? now;
    const late = now - t0;
    let catchUp: { until: number; shift: number } | undefined;
    if (late > this.catchUpLimit) {
      // A stall: skip the missed windows rather than bursting them.
      const skipped = Math.ceil(late / this.wakeInterval - 1e-9);
      this.own.skipped += skipped;
      this.own.stalls++;
      this.options.onStall?.({
        at: now,
        late,
        skipped,
        wallMs: last ? wall - last.wall : null,
        audioMs: last ? (now - last.audio) * 1000 : null,
      });
      t0 = now;
    } else if (late > 0) {
      catchUp = { until: now, shift: late };
      this.own.catchUps++;
      this.own.catchUpMaxMs = Math.max(this.own.catchUpMaxMs, late * 1000);
    }
    const t1 = now + (this.clock.hidden?.() ? this.hiddenLookahead : this.lookahead);
    // An extra wake (a visibility change, a push) may find the window already queried.
    if (t1 <= t0) return;
    const events = this.runtime.query(t0, t1, { now, catchUp, path: 'scheduled' });
    this.log?.push(...events);
    this.next = t1;
    this.own.windows++;
    // Live events are stamped after now, so nothing earlier can be rewound into.
    this.runtime.retain(now);
  }

  /**
   * The immediate path: `nodeId` emits an event on its output `port`, stamped
   * currentTime + immediateOffset, and the nodes downstream of it run now,
   * without waiting for a wake. Returns the stamped event.
   */
  push(nodeId: string, port: string, fields: Omit<EngineEvent, 'time'>): EngineEvent {
    const started = this.clock.wallTime();
    const now = this.clock.audioTime();
    const event = { time: now + this.immediateOffset, ...fields } as EngineEvent;
    const queriesBefore = this.runtime.counters.queries;
    let rewind: PushCost['rewind'] = null;
    const report = this.runtime.push(nodeId, port, event, { now, path: 'immediate' });
    if (report) {
      const { added, ...cost } = report;
      rewind = cost;
      this.own.rewinds++;
      if (this.log) {
        const { affected, time } = report;
        this.log = this.log.filter((e) => !(affected.has(e.node) && e.time >= time));
        this.log.push(...added);
      }
    } else if (this.next === null || event.time >= this.next) {
      // Nothing has been queried that far yet: wake now and the window covering the event picks it up.
      this.wake();
    }
    const queries = this.runtime.counters.queries - queriesBefore;
    const ms = this.clock.wallTime() - started;
    this.own.pushes++;
    this.own.pushQueries += queries;
    this.own.pushMsTotal += ms;
    this.own.pushMsMax = Math.max(this.own.pushMsMax, ms);
    this.options.onPush?.({ time: event.time, rewind, queries, ms });
    return event;
  }

  /** The recorded log in log order, with every rewind applied. Needs `record`. */
  events(): LoggedEvent[] {
    if (!this.log) throw new Error('Scheduler.events needs { record: true }');
    return this.runtime.sortLog([...this.log]);
  }
}

/** A clock you move by hand, for headless runs and tests. */
export class ManualClock implements SchedulerClock {
  audio = 0;
  wall = 0;
  isHidden = false;
  isRunning = true;

  audioTime(): number {
    return this.audio;
  }

  wallTime(): number {
    return this.wall;
  }

  running(): boolean {
    return this.isRunning;
  }

  hidden(): boolean {
    return this.isHidden;
  }

  /** Sets the audio clock to `seconds`; the wall clock moves by the same amount, as a blocked thread's would. */
  set(seconds: number): void {
    this.wall += (seconds - this.audio) * 1000;
    this.audio = seconds;
  }
}
