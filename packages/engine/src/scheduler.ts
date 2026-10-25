// The one scheduler (design.md, Timing and evaluation; ADRs 0008, 0017, 0019, 0033).
//
// Every 25 ms it asks the runtime for the events from its horizon to
// now + 120 ms (1.25 s while the page is hidden). Windows are contiguous, so
// each moment is queried once. A wake up to 100 ms past its horizon still
// queries the stretch it missed, moved to start now + 5 ms (the immediate
// offset, a lead like a tap's) so its events keep their spacing; a later wake is a stall and skips the missed windows. The first
// running wake starts the patch at 0: if the clock is already past it (the
// AudioContext started before the wake, as on the first tap), [0, now) is
// caught up the same way when it is within the limit. Past it, the patch
// starts at now, which doesn't count as a stall. A resume after a suspend
// or `halt` carries on from the horizon. Live input
// takes the immediate path: `push` stamps it currentTime + 5 ms and sends it
// down its cables at once, rewinding the nodes downstream of it.
//
// The clocks and the timer are injected, so the same code runs in the
// browser, headless and in tests that simulate stalls.
import type { EngineEvent } from './events';
import { pushable } from './input';
import type { LoggedEvent, Plan, RewindReport, Runtime, RuntimeCounters, SwapReport } from './runtime';

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
/** While the page is hidden, a push whose rewind is estimated to take longer than this many
 *  milliseconds is applied from the horizon instead (ADR 0026). Visible pushes always rewind. *(tune)* */
export const HIDDEN_PUSH_BUDGET_MS = 16;
/** Weight of the latest rewind in the smoothed milliseconds per query. */
const COST_SMOOTHING = 0.2;

export interface SchedulerClock {
  /** The audio clock in seconds: AudioContext.currentTime. */
  audioTime(): number;
  /** A wall clock in milliseconds: performance.now(). Measures push cost, and
   *  tells a blocked main thread (both clocks jump) from an audio clock jump. */
  wallTime(): number;
  /** False while the audio clock is suspended: wakes do nothing, pushes are held,
   *  and the next running wake resumes from the horizon (or from now, if the
   *  clock has passed it) without counting a stall. The very first running wake
   *  starts from 0 instead, catching up [0, now) if that is within the catch-up limit. Default true. */
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
  /** Milliseconds a rewind may be estimated to take while the page is hidden before the push
   *  falls back to the horizon. Default HIDDEN_PUSH_BUDGET_MS; Infinity never falls back. */
  hiddenPushBudgetMs?: number;
  /** Keep a log of every event, with rewinds applied, for `events()`. Headless runs and tests. */
  record?: boolean;
  /** Called after every push with what it cost. */
  onPush?(cost: PushCost): void;
  /** Called when a wake skips windows. */
  onStall?(stall: Stall): void;
}

/** One event of a push: `node` emits `fields` on its output `port`, at the time the push stamps. */
export interface PushTarget {
  node: string;
  port: string;
  fields: Omit<EngineEvent, 'time'>;
}

/** What one push cost on the immediate path. */
export interface PushCost {
  /** The event's time as applied: its stamp, or the horizon when it fell back. */
  time: number;
  /** Set when the push fell back (ADR 0026): hidden, and its rewind over the budget, so it was
   *  applied from the horizon. `stamped` is the time it would have had; `estimatedMs` the
   *  rewind's estimated cost. Null when it was applied at its stamp. */
  fallback: { stamped: number; estimatedMs: number } | null;
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
  /** Pushes held while the audio clock was suspended, and stamped at the resume. */
  deferredPushes: number;
  /** Plans swapped in (`swap`). */
  swaps: number;
  /** Pushes applied from the horizon because the page was hidden and their rewind was over budget (ADR 0026). */
  pushFallbacks: number;
  /** Smoothed wall-clock milliseconds per query of the rewinds while visible and while hidden; null before the first. */
  msPerQuery: { visible: number | null; hidden: number | null };
  /** The audio clock at the first running wake, the one before any window was queried; null before it. Within
   *  catchUpLimit, that wake caught up [0, firstWake); past it, it started at firstWake and a t=0 event was dropped (ADR 0033). */
  firstWake: number | null;
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
  private readonly hiddenPushBudgetMs: number;
  /** Smoothed ms per query of the rewinds made while visible and while hidden: queries cost more
   *  hidden, where windows are wider, so one average would mispredict after a visibility change. */
  private readonly msPerQuery: { visible: number | null; hidden: number | null } = { visible: null, hidden: null };
  private next: number | null = null;
  private firstWake: number | null = null;
  private last: { wall: number; audio: number } | null = null;
  /** The next running wake resumes rather than catching up or counting a stall. */
  private fresh = true;
  /** Pushes held while the audio clock is suspended. */
  private readonly deferred: (readonly PushTarget[])[] = [];
  /** A live clock read for the runtime's hand-overs (`DeliveryTiming.currentTime`). */
  private readonly audioTime = (): number => this.clock.audioTime();
  private stop: (() => void) | null = null;
  private log: LoggedEvent[] | null;
  private readonly own = { windows: 0, skipped: 0, stalls: 0, catchUps: 0, catchUpMaxMs: 0, pushes: 0, rewinds: 0, pushQueries: 0, pushMsMax: 0, pushMsTotal: 0, deferredPushes: 0, swaps: 0, pushFallbacks: 0 };

  constructor(runtime: Runtime, options: SchedulerOptions) {
    this.runtime = runtime;
    this.options = options;
    this.clock = options.clock;
    this.wakeInterval = options.wakeInterval ?? WAKE_INTERVAL;
    this.lookahead = options.lookahead ?? LOOKAHEAD;
    this.hiddenLookahead = options.hiddenLookahead ?? HIDDEN_LOOKAHEAD;
    this.catchUpLimit = options.catchUpLimit ?? CATCH_UP_LIMIT;
    this.immediateOffset = options.immediateOffset ?? IMMEDIATE_OFFSET;
    this.hiddenPushBudgetMs = options.hiddenPushBudgetMs ?? HIDDEN_PUSH_BUDGET_MS;
    this.log = options.record ? [] : null;
    runtime.keepHistory(() => this.clock.wallTime());
  }

  /** The end of the last queried window, or null before the first wake. Kept across a suspend or halt. */
  get horizon(): number | null {
    return this.next;
  }

  get stats(): SchedulerStats {
    return { ...this.runtime.counters, ...this.own, msPerQuery: { ...this.msPerQuery }, firstWake: this.firstWake };
  }

  /** Wakes now and then every wakeInterval on the injected timer. */
  start(): void {
    if (this.stop) return;
    const timer = this.options.timer;
    if (!timer) throw new Error('Scheduler.start needs a timer; call wake() yourself instead');
    this.stop = timer.every(this.wakeInterval * 1000, () => this.wake());
    this.wake();
  }

  /** Stops the timer. The next wake resumes like after a suspend: from the horizon, or from now if that has passed
   *  (before any window was queried, it is still the first wake, which starts from 0 within the catch-up limit). */
  halt(): void {
    this.stop?.();
    this.stop = null;
    this.fresh = true;
    this.last = null;
  }

  /**
   * One wake: query from the horizon to now + lookahead. A wake up to
   * catchUpLimit past the horizon still queries what it missed, moved later
   * to start at now + immediateOffset; a later one skips the missed windows. The first running
   * wake treats 0 as its horizon: up to catchUpLimit past it, it catches up
   * [0, now); later, it starts at now without counting a stall. A window
   * never starts before the runtime's horizon, so no stretch is queried twice.
   */
  wake(): void {
    if (this.clock.running && !this.clock.running()) {
      // Suspended: not a stall. The first running wake resumes without counting one.
      this.fresh = true;
      this.last = null;
      return;
    }
    const now = this.clock.audioTime(), wall = this.clock.wallTime();
    const last = this.last;
    this.last = { wall, audio: now };
    let t0: number;
    let catchUp: { until: number; shift: number } | undefined;
    if (this.next === null) {
      // The first running wake: nothing has been queried, so the patch starts at 0. If the clock
      // is already past 0 (it started before this wake: the first tap resumed the AudioContext),
      // [0, now) is caught up below, so a t=0 event sounds at the resume, but only up to
      // catchUpLimit, as for any late wake (ADR 0017: no bursts). Past it, the patch starts at
      // now, without counting a stall: nothing was ever heard, so nothing was dropped mid-play.
      t0 = now <= this.catchUpLimit ? 0 : now;
      this.firstWake = now;
      this.fresh = false;
    } else if (this.fresh) {
      // Resuming after a suspend or halt: carry on from the horizon, or from now if the clock has moved past it.
      t0 = Math.max(now, this.next);
      this.fresh = false;
    } else {
      t0 = this.next;
      const late = now - t0;
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
      }
    }
    // Whoever queried the runtime last, never query a stretch twice.
    t0 = Math.max(t0, this.runtime.horizon ?? -Infinity);
    // What's still missed after that, [t0, now), is caught up: moved to start at now + immediateOffset,
    // the lead a tap's note gets (ADR 0033, #97). Handed over at now with no lead, a clock burst during
    // the wake's query and schedule() left its first events late by the burst plus that work.
    // (A resume, a stall and a first wake past the limit all begin at now or later, so they
    // never catch up; within the limit, `late` was at most catchUpLimit, and the clamp only
    // shrinks it. So no catch-up is ever longer than catchUpLimit, whoever queried before.)
    if (t0 < now) {
      catchUp = { until: now, shift: now - t0 + this.immediateOffset };
      this.own.catchUps++;
      this.own.catchUpMaxMs = Math.max(this.own.catchUpMaxMs, (now - t0) * 1000);
    }
    const t1 = now + (this.clock.hidden?.() ? this.hiddenLookahead : this.lookahead);
    // An extra wake (a visibility change, a push, a resume) may find the window already queried.
    if (t1 > t0) {
      const events = this.runtime.query(t0, t1, { now, currentTime: this.audioTime, catchUp, path: 'scheduled' });
      this.log?.push(...events);
      this.next = t1;
      this.own.windows++;
      // Live events are stamped after now, so nothing earlier can be rewound into.
      this.runtime.retain(now);
    }
    // Pushes made while the clock was suspended are stamped now, relative to the resume.
    // One at a time, so a push that throws leaves the rest held for the next wake. A swap
    // while suspended may have removed some of a push's targets: the rest still get it, at one stamp.
    while (this.deferred.length) {
      const targets = this.deferred.shift()!.filter((t) => this.hasEventOutput(t.node, t.port));
      if (targets.length) this.pushAll(targets);
    }
  }

  /**
   * The immediate path: `nodeId` emits an event on its output `port`, stamped
   * currentTime + immediateOffset, and the nodes downstream of it run now,
   * without waiting for a wake. Returns the stamped event.
   *
   * While the audio clock is suspended there is no currentTime to stamp
   * against, so the push is held and returns null: the first running wake
   * stamps it at its own currentTime + immediateOffset and runs it then.
   * The node and port are checked at once either way.
   *
   * While the page is hidden, a push whose rewind is estimated (rewindCost ×
   * the smoothed ms per hidden query) to cost more than `hiddenPushBudgetMs`
   * falls back (ADR 0026): it is applied at the horizon, which re-queries
   * nothing, counted in `pushFallbacks` and warned on the node. The returned
   * event has the applied time, and that is what is logged, so a recorded
   * input stream replays the same. Visible pushes always rewind. If the clock
   * hasn't moved since the horizon was set (a second push at once, or held
   * pushes replayed by the resume wake), nothing new is queried, and the next
   * wake delivers it.
   */
  push(nodeId: string, port: string, fields: Omit<EngineEvent, 'time'>): EngineEvent | null {
    return this.pushAll([{ node: nodeId, port, fields }])?.[0] ?? null;
  }

  /**
   * One push onto several outputs: one browser event reaching every source
   * node that reads it (ADR 0029). The clock is read once, so every target
   * gets the same stamp, and the fallback is decided once, on the rewind of
   * all of them together, so it can't split them (ADR 0026). Otherwise as
   * `push`: returns one event per target, in order, all at the applied time;
   * or null while the clock is suspended, when the targets are held together
   * (every node and port checked first; a target a swap removes before the
   * resume is left out, the rest keep one stamp). It counts as one push in the stats;
   * a fallback warns on every target's node. No targets: nothing happens, and
   * it returns [].
   */
  pushAll(targets: readonly PushTarget[]): EngineEvent[] | null {
    if (!targets.length) return [];
    if (this.clock.running && !this.clock.running()) {
      for (const { node, port } of targets) if (!this.hasEventOutput(node, port)) throw new Error(`push: node "${node}" has no event output "${port}"`);
      this.deferred.push([...targets]);
      this.own.deferredPushes++;
      return null;
    }
    const started = this.clock.wallTime();
    const now = this.clock.audioTime();
    const hidden = this.clock.hidden?.() ?? false;
    const stamped = now + this.immediateOffset;
    let time = stamped, fallback: PushCost['fallback'] = null;
    const perQuery = this.msPerQuery.hidden;
    const nodes = [...new Set(targets.map((t) => t.node))];
    if (hidden && perQuery !== null) {
      const queries = this.runtime.rewindCost(nodes, stamped);
      const estimatedMs = queries === null ? 0 : queries * perQuery;
      if (estimatedMs > this.hiddenPushBudgetMs) {
        // The horizon: nothing is queried there yet, so the push re-queries nothing.
        time = this.runtime.horizon!;
        fallback = { stamped, estimatedMs };
      }
    }
    const events = targets.map(({ fields }) => ({ time, ...fields }) as EngineEvent);
    const queriesBefore = this.runtime.counters.queries;
    let rewind: PushCost['rewind'] = null;
    const report = this.runtime.pushAll(targets.map(({ node, port }, i) => ({ node, port, event: events[i]! })), { now, currentTime: this.audioTime, path: 'immediate' });
    // The rewind's own cost, for the ms-per-query average: without the log update or a wake.
    const pushed = this.clock.wallTime();
    const pushQueries = this.runtime.counters.queries - queriesBefore;
    if (fallback) {
      this.own.pushFallbacks++;
      for (const node of nodes) this.runtime.pushFellBack(node, time);
    }
    if (report) {
      const { added, ...cost } = report;
      rewind = cost;
      this.own.rewinds++;
      if (this.log) {
        const { affected, time } = report;
        this.log = this.log.filter((e) => !(affected.has(e.node) && e.time >= time));
        this.log.push(...added);
      }
    } else if (this.next === null || time >= this.next) {
      // Nothing has been queried that far yet: wake now and the window covering the events picks them up.
      this.wake();
    }
    const queries = this.runtime.counters.queries - queriesBefore;
    const ms = this.clock.wallTime() - started;
    if (report && pushQueries > 0) {
      const mode = hidden ? 'hidden' : 'visible', last = this.msPerQuery[mode], perQuery = (pushed - started) / pushQueries;
      this.msPerQuery[mode] = last === null ? perQuery : last + COST_SMOOTHING * (perQuery - last);
    }
    this.own.pushes++;
    this.own.pushQueries += queries;
    this.own.pushMsTotal += ms;
    this.own.pushMsMax = Math.max(this.own.pushMsMax, ms);
    this.options.onPush?.({ time, fallback, rewind, queries, ms });
    return events;
  }

  /** Whether the latest plan has `nodeId` with an Event or Note output `port` (or a push-only port, `pushable`), so it can be pushed onto. */
  private hasEventOutput(nodeId: string, port: string): boolean {
    const definition = this.runtime.plan.order.find((n) => n.id === nodeId)?.definition;
    return definition !== undefined && pushable(definition, port);
  }

  /**
   * Hot patching: `plan` (compiled from the edited patch) takes over at the
   * next window boundary at least SWAP_MARGIN past currentTime, re-running the windows
   * already queried from there (`Runtime.swap`, ADR 0023). The recorded log
   * drops what the removed and re-run nodes had logged from then on and takes
   * the re-run's events.
   */
  swap(plan: Plan): SwapReport {
    const now = this.clock.audioTime();
    const report = this.runtime.swap(plan, { now, currentTime: this.audioTime, path: 'scheduled' });
    this.own.swaps++;
    if (this.log && report.windows > 0) {
      const { replaced, time } = report;
      this.log = this.log.filter((e) => !(replaced.has(e.node) && e.time >= time));
      this.log.push(...report.events);
    }
    return report;
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
