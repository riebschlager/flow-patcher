// Runs a patch in the browser: one AudioContext, the real Scheduler on the
// audio clock, the frame loop on requestAnimationFrame with the fluid in a
// Worker, and the performance canvas's pointer events on the immediate path
// (design.md, Timing and evaluation; Visual nodes run on the frame clock;
// Platform rules; ADR 0016, 0020).
import {
  compilePatch,
  PATCH_FORMAT,
  PATCH_VERSION,
  FLUID_BACKGROUND,
  FluidHost,
  FrameLoop,
  inputRouter,
  outputLatencyOf,
  Runtime,
  Scheduler,
  type AudioContextLike,
  type EngineEvent,
  type FluidHostStats,
  type HostServices,
  type InputEventType,
  type InputFields,
  type InputRouter,
  type NodeStatus,
  type NodeWarning,
  type Patch,
  type Permission,
  type Plan,
  type PlanNode,
  type PortType,
  type SchedulerStats,
  type StatusContext,
  type VoiceStats,
} from '@flow-patcher/engine';
import { nodeRegistry, rendererImage } from '@flow-patcher/nodes';
import { CANVAS_TYPES, CanvasLifecycle } from './canvas-lifecycle';
import { EventTrack, PROBE_HISTORY } from './event-track';
import { HeldKeys, isApplePlatform, keyStartsAudio, type KeyFields } from './keys';
import { MidiHost } from './midi';
import { browserRequesters, neededPermissions, Permissions } from './permissions';

/** Pointer events the canvas forwards: the four phases, and entering and leaving the canvas (hover state). */
export type PointerPort = 'down' | 'move' | 'up' | 'cancel' | 'enter' | 'leave';

/** The input stream type (ADR 0029) of each pointer event the canvas forwards. */
const POINTER_TYPES: Readonly<Record<PointerPort, InputEventType>> = {
  down: 'pointerdown', move: 'pointermove', up: 'pointerup', cancel: 'pointercancel', enter: 'pointerenter', leave: 'pointerleave',
};

/**
 * Input events dropped, not held, while the AudioContext isn't running. Held pushes all replay at one
 * stamp when it starts, as a burst of rewinds that the event cap can cut the important ones out of.
 * Hover moves (coalesced samples too) before the first tap: the Down carries the position anyway.
 * Enter and leave: enter only updates hover state, and a leave ends a hover, which with hover moves dropped
 * no source has seen (Pointer marks no leave for a pointer with no Down, Move, Up or Cancel since it took
 * its slot). Held, pairs would pile up unbounded while hovering in and out.
 * MIDI: it never starts audio, so a suspended or interrupted context (an iOS call) would otherwise collect
 * every CC sent meanwhile.
 * The canvas's lifecycle (resize, focus, blur, visibilitychange): dragging the pane or tabbing about before
 * the first tap would pile them up. The host keeps the canvas's state instead and sends what changed when
 * audio starts (`CanvasLifecycle.start`).
 */
export const droppedWhileCold = (type: InputEventType): boolean =>
  type === 'pointermove' || type === 'pointerenter' || type === 'pointerleave' || type === 'midi' || CANVAS_TYPES.has(type);

/** The payload of one pointer event (docs/nodes/canvas-sources.md, Event payload): the raw pointerId as `channel`. */
export interface PointerFields {
  channel: number;
  x: number;
  y: number;
  pressure: number;
  pointerType: string;
  /** Contact size in CSS pixels, where the hardware reports it (a mouse reports 1). */
  width?: number;
  height?: number;
  /** The button that changed (−1 on a move), and the buttons held, as the browser reports them. */
  button?: number;
  buttons?: number;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  /** Seconds since this pointer's previous sample, from the events' timeStamps (#74). Left out on its first. */
  interval?: number;
}

/** One pointerdown, for the Immediate path gate check (docs/milestones.md, M1). */
export interface Tap {
  /** currentTime when the handler ran, in seconds. */
  at: number;
  /** The pointerdown on the audio clock: `at` less the time the event waited before its handler ran
   *  (performance.now() − event.timeStamp). currentTime only moves once per audio callback, so this is
   *  `at`'s granularity, not a sample-exact mapping; what it adds is the main-thread wait ADR 0016 guards. */
  down: number;
  /** The time the push was stamped, or null when it was held for the AudioContext to start. */
  stamped: number | null;
  /** When the first note it caused starts sounding: the earliest oscillator start scheduled during the push.
   *  A cold tap's push runs on a later wake, so it takes the next oscillator start instead (approximate). */
  note: number | null;
  /** The push had to start the AudioContext, so its timing includes startup. */
  cold: boolean;
  /** currentTime when the push's first start() was called, or null with none (#97). Against `stamped`
   *  less the immediate offset (the push's own clock read), it is how far the clock moved before the
   *  note reached Web Audio: past the offset, the note is late (ADR 0027). */
  startClock: number | null;
  /** currentTime right after the push, the upper bound on `startClock` (#97). */
  after: number;
  /** Wall time the push took, ms, at performance.now()'s resolution (#97). */
  pushMs: number;
  /** The tap's splash (ADR 0020), null until it is drawn, or with no Renderer:
   *  - `handed`: frames after the push until a frame handed the tap's own event to a visual node (1 = the
   *    next frame, skipping the output-latency shift);
   *  - `frames`, `ms`: frames after the push, and ms after the pointerdown, until the Renderer drew the
   *    Fluid step that carried it. */
  splash: { handed: number; frames: number; ms: number } | null;
  /** The Fluid step carrying the splash was dropped (Worker failure, reset or splat cap), so it was never drawn. */
  splashLost: boolean;
}

/** The frame loop's counters, for the Immediate path under load gate check. */
export interface FrameStats {
  /** Frames ticked. */
  frames: number;
  /** Frames the Renderer had a picture for. */
  drawn: number;
  /** The fluid Worker's steps and timings, or null with no Fluid. */
  fluid: FluidHostStats | null;
}

/** A splash on its way to the canvas: handed to a visual node by a frame (`Runtime.lastFrame.taps`), then
 *  drawn once the Fluid has latched the step that frame took. */
interface PendingSplash {
  tap: Tap;
  /** The push's stamp, as the frame report lists it. */
  time: number;
  /** Wall time of the pointerdown, ms. */
  downWall: number;
  /** Frames ticked when the push ran. */
  frame: number;
  /** Once a frame handed it over: frames since the push, and the Fluid's step count after that frame. */
  carried: { handed: number; step: number } | null;
}

/** Sampled Voice's samples, served from the repo's vendor/ (packages/editor/vite.config.ts). */
async function fetchSample(file: string): Promise<string> {
  // Relative to the page, so it follows wherever the editor is served from.
  const response = await fetch(`vendor/${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(`Couldn't load ${file} (HTTP ${response.status})`);
  return response.text();
}

export type { NodeStatus, NodeWarning, VoiceStats };

/** What `update` did with a document: swapped it in, or kept the last plan because it doesn't compile.
 *  `cycles` lists the node ids of each loop with no delay edge, when that's why. */
export type UpdateResult = { ok: true } | { ok: false; errors: string[]; cycles: string[][] };

export { PROBE_HISTORY };

/** What a probe shows of one port, as of `now` (the audio clock less the output latency: what you hear). */
export interface ProbeView {
  type: PortType;
  now: number;
  /** Event and Note: what sounded in the last PROBE_HISTORY seconds, oldest first. */
  events: Readonly<EngineEvent>[];
  /** Signal: channel 0 sampled once a frame over the last PROBE_HISTORY seconds, oldest first. */
  samples: { t: number; v: number }[];
  /** Value: the latest value; Signal: the latest sample. */
  value: unknown;
}

interface ProbeTrack {
  node: string;
  port: string;
  direction: 'in' | 'out';
  view: ProbeView;
  listeners: Set<() => void>;
  /** The Event outputs it shows: the port itself, or for an input, every Event cable's source. */
  sources: EventTrack[];
}

export interface LiveStatus {
  audio: AudioContextState;
  pointers: number;
}

export class LivePatch {
  readonly scheduler: Scheduler;
  readonly taps: Tap[] = [];
  /** Browser permissions the running patch's sources need, asked when it first plays. */
  readonly permissions = new Permissions(browserRequesters({ midi: (access) => this.midi.attach(access) }));
  /** MIDI inputs, once the midi permission is granted: each message is one input event, as a pointer event is (ADR 0004, 0029). */
  readonly midi = new MidiHost((event, timeStamp) => this.input(event, timeStamp));
  private readonly context: AudioContext;
  /** The context as the runtime sees it: the instrument cache is keyed by this object. */
  private readonly audio: AudioContextLike;
  private readonly services: HostServices;
  private readonly runtime: Runtime;
  /** The plan running now: the last document `update` compiled. */
  private plan: Plan;
  /** The running document, less what doesn't reach the plan (positions), to skip swaps that change nothing. */
  private planKey = '';
  /** Unsubscribes the running plan's nodes' status watchers. */
  private unwatch: (() => void)[] = [];
  /** Routes canvas events to the running plan's source nodes, by their definitions' `input` (ADR 0029),
   *  as the headless runner replays a stream. */
  private router: InputRouter = inputRouter({ order: [] });
  /** Source nodes that read pointerdown, for the canvas's hint. */
  private pointers = 0;
  /** Permissions the running plan's nodes declare. */
  private needed: Permission[] = [];
  private readonly unwatchPermissions: () => void;
  /** Oscillator starts scheduled while a push runs, collected for its Tap. */
  private starts: number[] | null = null;
  /** currentTime at the first start() during a push (#97). */
  private startClock: number | null = null;
  /** A cold tap still waiting for its held push to run. */
  private coldTap: Tap | null = null;
  private readonly frames: FrameLoop;
  /** The fluid's host. Its Worker starts when a Fluid first sends it work, so one can be added mid-session. */
  private readonly fluid: { host: FluidHost; worker: () => Worker | null };
  private hasFluid = false;
  /** The Renderer the canvas shows: the first in plan order (one per patch). */
  private renderer: string | null = null;
  private canvas: HTMLCanvasElement | null = null;
  /** The fluid's pixels at grid size, scaled onto the canvas. */
  private readonly ink = document.createElement('canvas');
  private readonly frameCounts = { frames: 0, drawn: 0 };
  private readonly splashes: PendingSplash[] = [];
  private raf = 0;
  private workerStalled = false;
  private readonly listeners = new Set<() => void>();
  private warningsSeen = -1;
  /** Event outputs being followed, by `node.port`: for probes and for cable flashes. */
  private readonly eventTracks = new Map<string, EventTrack>();
  private readonly probes = new Map<string, ProbeTrack>();
  private readonly firing = new Map<string, Set<() => void>>();
  private readonly onVisibility = () => this.scheduler.wake();
  /** The canvas's lifecycle for the Canvas node: its size, focus and the page's visibility. */
  private readonly lifecycle = new CanvasLifecycle({
    send: (event) => this.input(event),
    running: () => this.context.state === 'running',
    now: () => this.context.currentTime,
  }, document.visibilityState);
  /** The page's visibility for the Canvas node's Hidden and Visible, apart from `onVisibility`, the scheduler's. */
  private readonly onPageVisibility = () => this.canvasVisibility(document.visibilityState);
  private wasRunning = false;
  /** Keys down on the canvas, to send the keyups the browser won't (Key node). */
  private readonly keys = new HeldKeys(isApplePlatform(navigator.platform));

  /** Starts with an empty patch; `update` brings the document in. */
  constructor() {
    const compiled = compilePatch({ format: PATCH_FORMAT, version: PATCH_VERSION, seed: 0, nodes: [], cables: [] }, nodeRegistry);
    if (!compiled.ok) throw new Error(compiled.errors.join('; '));
    this.plan = compiled.plan;
    this.fluid = createFluidWorker();
    this.services = { fluid: this.fluid.host, samples: fetchSample };
    this.runtime = new Runtime(compiled.plan, { services: this.services });
    // The cards show warnings (`warnings`); the console keeps a line for each one raised.
    this.runtime.onWarning = (message) => console.debug(`[live] warning: ${message}`);
    this.context = new AudioContext({ latencyHint: 'interactive' });
    this.audio = this.observeStarts(this.context);
    this.wasRunning = this.context.state === 'running';
    this.runtime.attachAudio(this.audio);
    const context = this.context;
    this.scheduler = new Scheduler(this.runtime, {
      clock: {
        audioTime: () => context.currentTime,
        wallTime: () => performance.now(),
        running: () => context.state === 'running',
        hidden: () => document.hidden,
      },
      // A due Canvas size is sent after the wakes too: they go on while the page is hidden and frames don't.
      timer: this.lifecycle.pace({
        every(ms, tick) {
          const id = setInterval(tick, ms);
          return () => clearInterval(id);
        },
      }),
      onStall: (stall) => console.warn(`[live] stall: ${stall.skipped} window(s) skipped, ${(stall.late * 1000).toFixed(1)} ms late`),
    });
    context.addEventListener('statechange', () => {
      // Held pushes run on the first wake after the context starts.
      this.scheduler.wake();
      // Then the canvas's lifecycle, dropped while audio was stopped, catches up.
      const running = context.state === 'running';
      if (running && !this.wasRunning) this.lifecycle.start();
      else this.lifecycle.tick();
      this.wasRunning = running;
      this.emit();
    });
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('visibilitychange', this.onPageVisibility);
    this.unwatchPermissions = this.permissions.subscribe(() => this.emit());
    this.scheduler.start();
    this.frames = new FrameLoop(this.runtime, {
      clock: {
        audioTime: () => context.currentTime,
        wallTime: () => performance.now(),
        outputLatency: () => outputLatencyOf(context),
      },
    });
    const run = () => {
      // Ask for the next frame first, so a frame that throws doesn't stop the loop.
      this.raf = requestAnimationFrame(run);
      this.frame();
    };
    this.raf = requestAnimationFrame(run);
  }

  get status(): LiveStatus {
    return { audio: this.context.state, pointers: this.pointers };
  }

  /**
   * Brings an edited document in: compiles it and swaps the plan at the next
   * window boundary (hot patching, ADR 0023), keeping the state of nodes whose
   * id survives. A document that doesn't compile leaves the last plan playing.
   */
  update(patch: Patch): UpdateResult {
    const key = JSON.stringify([patch.seed, patch.nodes.map(({ id, type, typeVersion, params }) => [id, type, typeVersion, params]), patch.cables]);
    if (key === this.planKey) return { ok: true };
    const compiled = compilePatch(patch, nodeRegistry);
    if (!compiled.ok) return { ok: false, errors: compiled.errors, cycles: (compiled.cycles ?? []).map((c) => c.nodes) };
    const swapped = this.scheduler.swap(compiled.plan);
    this.refreshTracks();
    this.planKey = key;
    this.adopt(compiled.plan, swapped.time);
    return { ok: true };
  }

  /** What a node's card shows inline, from its definition's status hook (an instrument loading, say). Null when there's nothing to say. */
  nodeStatus(nodeId: string): NodeStatus | null {
    const node = this.plan.order.find((n) => n.id === nodeId);
    return node?.definition.status?.(this.statusContext(node)) ?? null;
  }

  /** The action on an error status, such as loading an instrument again. */
  retry(nodeId: string): void {
    const node = this.plan.order.find((n) => n.id === nodeId);
    if (node) node.definition.retry?.(this.statusContext(node));
  }

  /** A node's warnings from the running patch (event caps, voice steals), in kind order. */
  warnings(nodeId: string): NodeWarning[] {
    return this.runtime.warnings(nodeId);
  }

  /** Dismisses a node's warnings; one that happens again is raised again. */
  clearWarnings(nodeId: string): void {
    this.runtime.clearWarnings(nodeId);
    this.emit();
  }

  /** Voices in use against the pool's limit, and steals, for the budget readout. */
  voiceStats(): VoiceStats {
    return this.runtime.voiceStats();
  }

  /**
   * Follows a port for a probe until the returned function is called: `listener` runs every frame (the
   * history scrolls), and `probe` reads it. Event and Note ports keep what sounded, Signal ports a sample a frame, over the
   * last PROBE_HISTORY seconds; Value ports their latest value. An Event input shows every cable into it.
   */
  watchProbe(node: string, port: string, direction: 'in' | 'out', type: PortType, listener: () => void): () => void {
    const key = `${node}.${direction}.${port}`;
    let track = this.probes.get(key);
    if (!track) {
      track = { node, port, direction, view: { type, now: this.heard(), events: [], samples: [], value: undefined }, listeners: new Set(), sources: [] };
      this.probes.set(key, track);
      this.followProbe(track);
    }
    track.listeners.add(listener);
    const it = track;
    return () => {
      it.listeners.delete(listener);
      if (it.listeners.size || this.probes.get(key) !== it) return;
      this.probes.delete(key);
      for (const source of it.sources) this.release(source);
    };
  }

  /** The latest view of a watched port, or null when nothing watches it. */
  probe(node: string, port: string, direction: 'in' | 'out' = 'out'): ProbeView | null {
    return this.probes.get(`${node}.${direction}.${port}`)?.view ?? null;
  }

  /** Calls `listener` on each frame in which an Event output sent something that's now sounding, until the returned function is called. */
  watchFiring(node: string, port: string, listener: () => void): () => void {
    const key = `${node}.${port}`;
    const track = this.follow(node, port);
    let set = this.firing.get(key);
    if (!set) this.firing.set(key, (set = new Set()));
    set.add(listener);
    const it = set;
    return () => {
      it.delete(listener);
      if (!it.size && this.firing.get(key) === it) this.firing.delete(key);
      this.release(track);
    };
  }

  get stats(): SchedulerStats {
    return this.scheduler.stats;
  }

  /** The AudioContext's clock, for e2e: currentTime, and baseLatency (in Chromium, one audio callback's buffer). */
  get clock(): { currentTime: number; baseLatency: number } {
    return { currentTime: this.context.currentTime, baseLatency: this.context.baseLatency };
  }

  /** A number param as the node reads it now, cables included: the knob's modulation ring. It reads the latest
   *  plan at currentTime, so it can lead a pending swap by a window and what you hear by the output latency. */
  paramAt(nodeId: string, name: string): number | undefined {
    return this.runtime.paramAt(nodeId, name, this.context.currentTime);
  }

  /** A node's state, for e2e and the console (such as Sampled Voice's skipped-note count). */
  stateOf(nodeId: string): Readonly<Record<string, unknown>> | undefined {
    return this.runtime.stateOf(nodeId);
  }

  get frameStats(): FrameStats {
    return { ...this.frameCounts, fluid: this.hasFluid ? { ...this.fluid.host.stats } : null };
  }

  /** The canvas the Renderer draws into, or null to stop drawing. */
  attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sends one pointer event to every source node that reads it. x and y are 0–1, y = 0 at the top. */
  pointer(
    port: PointerPort,
    fields: PointerFields,
    /** The event's timeStamp (performance.now() time), when it came from a real input event. */
    timeStamp?: number,
  ): void {
    this.input({ type: POINTER_TYPES[port], ...fields }, timeStamp);
  }

  /** Whether a source node in the running plan reads this canvas event type, such as `contextmenu` (Platform rules). */
  reads(type: InputEventType): boolean {
    return this.router.reads(type);
  }

  /** Whether a source in the running plan reads coalesced move samples (Pointer (high rate)), so the canvas sends them. */
  get readsCoalesced(): boolean {
    return this.router.route({ type: 'pointermove', channel: 0, coalesced: true }).length > 0;
  }

  /**
   * Several canvas events from one browser event, such as a pointermove's coalesced samples
   * and the move itself, as one push stamped once, so the samples keep their order and share
   * a time (each carries its own `interval`). Moves only: a pointerdown goes through `input`, which
   * starts audio. Dropped while audio is stopped, like hover moves. Returns the pushed events,
   * flattened per target (one per source node an event reached), all at the applied stamp: an M4
   * recorder should keep that stamp with the input events themselves (ADR 0029), not these.
   */
  inputAll(events: readonly InputFields[]): EngineEvent[] | null {
    if (this.context.state !== 'running' && events.some((event) => droppedWhileCold(event.type))) return null;
    const targets = events.flatMap((event) => this.router.route(event));
    if (!targets.length) return null;
    try {
      return this.scheduler.pushAll(targets);
    } finally {
      this.refreshTracks();
    }
  }

  /** Every canvas event type a source node in the running plan reads. */
  get inputTypes(): ReadonlySet<InputEventType> {
    return this.router.types;
  }

  /**
   * One input event, from the canvas or a MIDI device, fanned out to every source node that reads its
   * type (ADR 0029), as one push stamped once (`Scheduler.pushAll`), so every source sees it at the
   * same time. Returns the pushed events, all at the applied time; null when it was held for the
   * AudioContext to start, or dropped (no source reads it, or `droppedWhileCold` while audio isn't running).
   */
  input(event: InputFields, timeStamp?: number): EngineEvent[] | null {
    const cold = this.context.state !== 'running';
    const down = event.type === 'pointerdown';
    // The first pointerdown starts audio. Its push is held until then, so the first touch still sounds (Platform rules).
    // A keydown on the canvas does too (`keyStartsAudio`): a key press is a user gesture, so the keyboard alone can play.
    // It also asks for the permissions the patch's sources need: a patch asks when it first plays.
    if (cold && (down || keyStartsAudio(event))) {
      void this.context.resume();
      this.permissions.request(this.needed);
    }
    const targets = this.router.route(event);
    if (!targets.length || (cold && droppedWhileCold(event.type))) return null;
    const at = this.context.currentTime;
    const wall = performance.now();
    const waited = timeStamp !== undefined && timeStamp <= wall ? (wall - timeStamp) / 1000 : 0;
    this.starts = [];
    let pushed: EngineEvent[] | null = null;
    try {
      pushed = this.scheduler.pushAll(targets);
    } finally {
      const after = down ? this.context.currentTime : 0, pushMs = down ? performance.now() - wall : 0;
      this.refreshTracks();
      const starts = this.starts, startClock = this.startClock;
      this.starts = null;
      this.startClock = null;
      if (down) {
        const stamped = pushed?.[0]?.time ?? null;
        const tap: Tap = { at, down: at - waited, stamped, note: starts.length ? Math.min(...starts) : null, cold, startClock, after, pushMs, splash: null, splashLost: false };
        if (cold && tap.note === null) this.coldTap = tap;
        if (this.renderer && this.hasFluid && stamped !== null) {
          this.splashes.push({ tap, time: stamped, downWall: wall - waited * 1000, frame: this.frameCounts.frames, carried: null });
        }
        this.taps.push(tap);
        if (this.taps.length > 100) this.taps.shift();
        console.debug(`[live] tap: stamped ${ms(tap.stamped, tap.down)}, note ${ms(tap.note, tap.down)} after pointerdown${cold ? ' (cold)' : ''}`);
      }
    }
    return pushed;
  }

  /**
   * A keydown or keyup on the canvas (Key node), sent to every source that reads it. While audio isn't
   * running, auto-repeats are dropped (a held key would pile them up for the start), and the rest are
   * held like a pointerdown; a keydown also starts audio (`keyStartsAudio`). A keyup brings the keyups
   * the browser won't send (`HeldKeys`).
   */
  key(kind: 'down' | 'up', fields: KeyFields, timeStamp?: number): void {
    if (kind === 'up') {
      for (const event of this.keys.release(fields)) this.input(event, timeStamp);
      return;
    }
    if (fields.repeat && this.context.state !== 'running') return;
    this.keys.press(fields);
    this.input({ type: 'keydown', ...fields }, timeStamp);
  }

  /** The canvas lost focus: every key still down gets its keyup now, since the canvas won't see it (Key's Held). */
  releaseKeys(): void {
    for (const event of this.keys.releaseAll()) this.input(event);
  }

  // The canvas's lifecycle (Canvas node): `CanvasLifecycle` decides what's sent when.

  /** The canvas's size changed, in CSS pixels: Canvas's Width and Height. */
  canvasResize(width: number, height: number): void {
    this.lifecycle.resize(width, height);
  }

  /** The canvas gained or lost keyboard focus: Canvas's Focus or Blur. */
  canvasFocus(focused: boolean): void {
    this.lifecycle.focus(focused);
  }

  /** The page was hidden or shown: Canvas's Hidden or Visible. */
  canvasVisibility(visibility: DocumentVisibilityState): void {
    this.lifecycle.visibility(visibility);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.fluid.worker()?.terminate();
    this.scheduler.halt();
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('visibilitychange', this.onPageVisibility);
    this.runtime.dispose();
    for (const unwatch of this.unwatch) unwatch();
    this.unwatchPermissions();
    this.midi.dispose();
    void this.context.close();
    this.listeners.clear();
  }

  /** One animation frame: the visual nodes on the frame clock, then the Renderer's picture onto the canvas. */
  private frame(): void {
    this.frameCounts.frames++;
    this.frames.tick();
    // A Canvas new to the plan gets the size once its swap has landed.
    this.lifecycle.tick();
    this.followPorts();
    if (this.runtime.warningsVersion !== this.warningsSeen) {
      this.warningsSeen = this.runtime.warningsVersion;
      this.emit();
    }
    const image = this.renderer ? rendererImage(this.runtime.stateOf(this.renderer) ?? {}) : null;
    if (image) this.frameCounts.drawn++;
    this.draw(image);
    this.trackSplashes();
    this.watchWorker();
  }

  /** The running plan's host-facing parts: the source nodes canvas events reach, the Renderer, and status watchers. */
  private adopt(plan: Plan, swapTime: number): void {
    this.plan = plan;
    this.router = inputRouter(plan);
    // A source that reads the size and is new to the plan is sent it once the swap has landed.
    this.lifecycle.adopt(plan.order.filter((node) => node.definition.input?.reads.resize !== undefined).map((node) => node.id), swapTime);
    this.pointers = plan.order.filter((node) => node.definition.input?.reads.pointerdown !== undefined).length;
    this.renderer = plan.order.find((node) => node.definition.type === 'renderer')?.id ?? null;
    this.hasFluid = plan.order.some((node) => node.definition.type === 'fluid');
    this.needed = neededPermissions(plan.order);
    // A source added while the patch plays asks now; before the first tap, the tap asks.
    if (this.context.state === 'running') this.permissions.request(this.needed);
    if (!this.renderer || !this.hasFluid) this.splashes.length = 0;
    // An Event input's probe shows the cables into it in this plan.
    for (const track of this.probes.values()) this.followProbe(track);
    for (const unwatch of this.unwatch) unwatch();
    this.unwatch = plan.order.flatMap((node) => node.definition.watchStatus?.(this.statusContext(node), () => this.emit()) ?? []);
    this.emit();
  }

  /** The audio clock as you hear it: currentTime less the output latency. */
  private heard(): number {
    return this.context.currentTime - outputLatencyOf(this.context);
  }

  private follow(node: string, port: string): EventTrack {
    const key = `${node}.${port}`;
    let track = this.eventTracks.get(key);
    if (!track) this.eventTracks.set(key, (track = new EventTrack(node, port, this.heard())));
    track.users++;
    return track;
  }

  private release(track: EventTrack): void {
    if (--track.users > 0) return;
    const key = `${track.node}.${track.port}`;
    if (this.eventTracks.get(key) === track) this.eventTracks.delete(key);
  }

  /** Points an Event or Note probe at the outputs it shows: its own port, or the sources of the cables into it. */
  private followProbe(track: ProbeTrack): void {
    if (track.view.type !== 'event' && track.view.type !== 'note') return;
    const ends = track.direction === 'in'
      ? (this.plan.incoming.get(track.node)?.events ?? []).filter((l) => l.toPort === track.port).map((l) => l.from)
      : [{ node: track.node, port: track.port }];
    const before = track.sources;
    track.sources = ends.map((end) => this.follow(end.node, end.port));
    for (const source of before) this.release(source);
  }

  /** Reads every followed output ahead again, before the next wake can prune what a push or swap just added. */
  private refreshTracks(): void {
    for (const track of this.eventTracks.values()) track.refresh(this.runtime);
  }

  /** One frame of the probes and cable flashes: what sounded since the last frame, and each probed Signal and Value now. */
  private followPorts(): void {
    if (!this.eventTracks.size && !this.probes.size) return;
    const now = this.heard();
    for (const track of this.eventTracks.values()) track.update(this.runtime, now);
    for (const [key, listeners] of this.firing) {
      if (this.eventTracks.get(key)?.sounded.length) for (const listener of listeners) listener();
    }
    for (const track of this.probes.values()) {
      const view = track.view;
      const next: ProbeView = { ...view, now };
      if (view.type === 'event' || view.type === 'note') {
        // Nothing new: the same events, less what scrolled out. Several sources merge in time order, as the input does.
        if (!track.sources.some((s) => s.sounded.length)) next.events = view.events.filter((e) => e.time > now - PROBE_HISTORY);
        else if (track.sources.length === 1) next.events = [...track.sources[0]!.history];
        else next.events = track.sources.flatMap((s) => s.history).sort((a, b) => a.time - b.time || a.channel - b.channel);
        next.value = next.events.at(-1);
      } else if (view.type === 'signal') {
        const v = this.runtime.signalAt(track.node, track.port, now);
        next.samples = view.samples.filter((s) => s.t > now - PROBE_HISTORY);
        if (v !== undefined) next.samples.push({ t: now, v });
        next.value = v;
      } else if (view.type === 'value') {
        next.value = this.runtime.valueAt(track.node, track.port, now);
      }
      track.view = next;
      for (const listener of track.listeners) listener();
    }
  }

  private statusContext(node: PlanNode): StatusContext {
    return { nodeId: node.id, params: node.params, audio: this.audio, services: this.services, permission: this.permissions.of(node.definition) };
  }

  /** Warns once per stall when the fluid Worker hasn't answered a step for a couple of seconds (it may have hung). */
  private watchWorker(): void {
    const waiting = this.hasFluid ? this.fluid.host.stats.waitingFrames : 0;
    if (waiting > WORKER_STALL && !this.workerStalled) console.warn(`[live] fluid worker: no reply for ${waiting} frames`);
    this.workerStalled = waiting > WORKER_STALL;
  }

  /** Follows each tap's splash: the frame that handed the tap's event over, then the frame that drew it. */
  private trackSplashes(): void {
    const host = this.fluid.host;
    if (!this.splashes.length) return;
    const report = this.runtime.lastFrame;
    for (const pending of this.splashes) {
      if (!pending.carried && report?.taps.some((tap) => tap.time === pending.time)) {
        // The Fluid stepped after its writers this frame, so its newest step carries the splat.
        pending.carried = { handed: this.frameCounts.frames - pending.frame, step: host.stepCount };
      }
    }
    // Shown once the Fluid has latched (at a frame's start) the step that carried it.
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const { tap, downWall, frame, carried } = this.splashes[i]!;
      // Never handed over (the tap reaches no visual node), or never latched (a hung Worker): stop following it.
      if (this.frameCounts.frames - frame > SPLASH_GIVE_UP) {
        this.splashes.splice(i, 1);
        continue;
      }
      if (!carried) continue;
      // The step that carried it failed, or its work was cleared or capped: it will never be drawn.
      if (host.lostThrough >= carried.step) {
        this.splashes.splice(i, 1);
        tap.splashLost = true;
        console.debug(`[live] splash lost: the fluid step that carried it was dropped`);
        continue;
      }
      if (host.latchedThrough < carried.step) continue;
      this.splashes.splice(i, 1);
      tap.splash = { handed: carried.handed, frames: this.frameCounts.frames - frame, ms: performance.now() - downWall };
      console.debug(`[live] splash: handed over ${carried.handed} frame(s) after the tap, drawn after ${tap.splash.frames} (${tap.splash.ms.toFixed(1)} ms after pointerdown)`);
    }
  }

  private draw(image: ReturnType<typeof rendererImage>): void {
    const canvas = this.canvas;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    if (!image) {
      g.fillStyle = `rgb(${FLUID_BACKGROUND.join(' ')})`;
      g.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    // The pixels go back to the Worker at the next latch, so they're drawn now and not kept.
    if (this.ink.width !== image.width || this.ink.height !== image.height) {
      this.ink.width = image.width;
      this.ink.height = image.height;
    }
    this.ink.getContext('2d')!.putImageData(new ImageData(image.pixels as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(this.ink, 0, 0, canvas.width, canvas.height);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** The AudioContext as the runtime sees it, noting oscillator start times while a push runs. */
  private observeStarts(context: AudioContext): AudioContextLike {
    return {
      get currentTime() {
        return context.currentTime;
      },
      get sampleRate() {
        return context.sampleRate;
      },
      destination: context.destination,
      createGain: () => context.createGain(),
      createDynamicsCompressor: () => context.createDynamicsCompressor(),
      createWaveShaper: () => context.createWaveShaper(),
      createBiquadFilter: () => context.createBiquadFilter(),
      createStereoPanner: () => context.createStereoPanner(),
      decodeAudioData: (data) => context.decodeAudioData(data),
      createOscillator: () => {
        const osc = context.createOscillator();
        const start = osc.start.bind(osc);
        osc.start = (when = 0) => {
          const now = context.currentTime;
          this.noteStart(Math.max(when, now), now);
          start(when);
        };
        return osc;
      },
      createBufferSource: () => {
        const source = context.createBufferSource();
        const start = source.start.bind(source);
        source.start = (when = 0, offset?: number, duration?: number) => {
          const now = context.currentTime;
          this.noteStart(Math.max(when, now), now);
          start(when, offset, duration);
        };
        return source;
      },
    };
  }

  /** `clock`: currentTime when start() was called. */
  private noteStart(time: number, clock: number): void {
    if (this.starts) {
      this.starts.push(time);
      this.startClock ??= clock;
    } else if (this.coldTap) {
      this.coldTap.note = time;
      this.coldTap = null;
    }
  }
}

/** Frames to wait for a tap's event to reach a visual node before giving up on its splash. */
const SPLASH_GIVE_UP = 120;
/** Frames a fluid step may stay unanswered before the Worker counts as stalled. */
const WORKER_STALL = 120;

const ms = (time: number | null, from: number) => (time === null ? '—' : `${((time - from) * 1000).toFixed(2)} ms`);

/** The host that talks to the fluid's Worker (fluid/backend.ts), and the Worker once the first request started it. */
function createFluidWorker(): { host: FluidHost; worker: () => Worker | null } {
  let worker: Worker | null = null;
  const start = () => {
    const started = new Worker(new URL('./fluid-worker.ts', import.meta.url), { type: 'module' });
    started.onmessage = (event) => host.receive(event.data);
    started.onerror = (event) => {
      console.warn(`[live] fluid worker: ${event.message}`);
      host.fail(event.message);
    };
    started.onmessageerror = () => host.fail('reply could not be read');
    return started;
  };
  const host: FluidHost = new FluidHost((request, transfer) => (worker ??= start()).postMessage(request, transfer));
  return { host, worker: () => worker };
}
