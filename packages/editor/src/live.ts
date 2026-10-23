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
  outputLatencyOf,
  Runtime,
  Scheduler,
  type AudioContextLike,
  type EngineEvent,
  type FluidHostStats,
  type HostServices,
  type NodeStatus,
  type NodeWarning,
  type Patch,
  type Plan,
  type PortType,
  type SchedulerStats,
  type StatusContext,
  type VoiceStats,
} from '@flow-patcher/engine';
import { nodeRegistry, rendererImage } from '@flow-patcher/nodes';

/** Pointer events the canvas forwards, as Pointer node output ports. */
export type PointerPort = 'down' | 'move' | 'up' | 'cancel';

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

/** How far back a probe's history reaches, seconds (design system Probe: "−2.0 s … now"). */
export const PROBE_HISTORY = 2;

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

/** An Event output's events as they sound: read ahead each frame, so what the runtime has stopped retaining
 *  since the last frame (`Runtime.retainedFrom`) still comes from the copy read then. */
class EventTrack {
  /** Events past the last frame's `now`, as read then. */
  private ahead: Readonly<EngineEvent>[] = [];
  /** What sounded in the last frame, and over the history. */
  sounded: Readonly<EngineEvent>[] = [];
  readonly history: Readonly<EngineEvent>[] = [];
  users = 0;

  constructor(readonly node: string, readonly port: string, private prev: number) {}

  update(runtime: Runtime, now: number): void {
    const prev = this.prev;
    this.prev = now;
    if (now <= prev) {
      this.sounded = [];
      return;
    }
    const from = runtime.retainedFrom ?? -Infinity;
    const fresh = runtime.eventsAt(this.node, this.port, prev, Infinity).filter((e) => e.time > prev);
    // What the runtime no longer retains comes from earlier reads. It prunes by currentTime, ahead of `now` by the output latency.
    const kept = this.ahead.filter((e) => e.time > prev && e.time < from);
    this.sounded = [...kept.filter((e) => e.time <= now), ...fresh.filter((e) => e.time <= now)];
    this.ahead = [...kept.filter((e) => e.time > now), ...fresh.filter((e) => e.time > now)];
    this.history.push(...this.sounded);
    let old = 0;
    while (old < this.history.length && this.history[old]!.time <= now - PROBE_HISTORY) old++;
    this.history.splice(0, old);
  }
}

interface ProbeTrack {
  node: string;
  port: string;
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
  /** Pointer nodes the canvas feeds. Canvas sources are host-fed, so the runner finds them by type. */
  private pointers: string[] = [];
  /** Oscillator starts scheduled while a push runs, collected for its Tap. */
  private starts: number[] | null = null;
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
    this.runtime.attachAudio(this.audio);
    const context = this.context;
    this.scheduler = new Scheduler(this.runtime, {
      clock: {
        audioTime: () => context.currentTime,
        wallTime: () => performance.now(),
        running: () => context.state === 'running',
        hidden: () => document.hidden,
      },
      timer: {
        every(ms, tick) {
          const id = setInterval(tick, ms);
          return () => clearInterval(id);
        },
      },
      onStall: (stall) => console.warn(`[live] stall: ${stall.skipped} window(s) skipped, ${(stall.late * 1000).toFixed(1)} ms late`),
    });
    context.addEventListener('statechange', () => {
      // Held pushes run on the first wake after the context starts.
      this.scheduler.wake();
      this.emit();
    });
    document.addEventListener('visibilitychange', this.onVisibility);
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
    return { audio: this.context.state, pointers: this.pointers.length };
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
    this.scheduler.swap(compiled.plan);
    this.planKey = key;
    this.adopt(compiled.plan);
    return { ok: true };
  }

  /** What a node's card shows inline, from its definition's status hook (an instrument loading, say). Null when there's nothing to say. */
  nodeStatus(nodeId: string): NodeStatus | null {
    const node = this.plan.order.find((n) => n.id === nodeId);
    return node?.definition.status?.(this.statusContext(node.id, node.params)) ?? null;
  }

  /** The action on an error status, such as loading an instrument again. */
  retry(nodeId: string): void {
    const node = this.plan.order.find((n) => n.id === nodeId);
    node?.definition.retry?.(this.statusContext(node.id, node.params));
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
   * Follows a port for a probe until the returned function is called: `listener` runs each frame it changes,
   * and `probe` reads it. Event and Note ports keep what sounded, Signal ports a sample a frame, over the
   * last PROBE_HISTORY seconds; Value ports their latest value. An Event input shows every cable into it.
   */
  watchProbe(node: string, port: string, type: PortType, listener: () => void): () => void {
    const key = `${node}.${port}`;
    let track = this.probes.get(key);
    if (!track) {
      track = { node, port, view: { type, now: this.heard(), events: [], samples: [], value: undefined }, listeners: new Set(), sources: [] };
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
  probe(node: string, port: string): ProbeView | null {
    return this.probes.get(`${node}.${port}`)?.view ?? null;
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

  /** Sends one pointer event to every Pointer node. x and y are 0–1, y = 0 at the top. */
  pointer(
    port: PointerPort,
    fields: { channel: number; x: number; y: number; pressure: number; pointerType: string },
    /** The event's timeStamp (performance.now() time), when it came from a real input event. */
    timeStamp?: number,
  ): void {
    const cold = this.context.state !== 'running';
    // The first pointerdown starts audio. Its push is held until then, so the first touch still sounds (Platform rules).
    if (cold && port === 'down') void this.context.resume();
    // Pushes are held while audio is stopped, so hover moves before the first tap would pile up and
    // replay as a burst that the event cap can cut the Down out of. Down carries the position anyway.
    if (!this.pointers.length || (cold && port === 'move')) return;
    const at = this.context.currentTime;
    const wall = performance.now();
    const waited = timeStamp !== undefined && timeStamp <= wall ? (wall - timeStamp) / 1000 : 0;
    this.starts = [];
    let stamped: number | null = null;
    try {
      for (const id of this.pointers) stamped ??= this.scheduler.push(id, port, fields)?.time ?? null;
    } finally {
      const starts = this.starts;
      this.starts = null;
      if (port === 'down') {
        const tap: Tap = { at, down: at - waited, stamped, note: starts.length ? Math.min(...starts) : null, cold, splash: null, splashLost: false };
        if (cold && tap.note === null) this.coldTap = tap;
        if (this.renderer && this.hasFluid && stamped !== null) {
          this.splashes.push({ tap, time: stamped, downWall: wall - waited * 1000, frame: this.frameCounts.frames, carried: null });
        }
        this.taps.push(tap);
        if (this.taps.length > 100) this.taps.shift();
        console.debug(`[live] tap: stamped ${ms(tap.stamped, tap.down)}, note ${ms(tap.note, tap.down)} after pointerdown${cold ? ' (cold)' : ''}`);
      }
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.fluid.worker()?.terminate();
    this.scheduler.halt();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.runtime.dispose();
    for (const unwatch of this.unwatch) unwatch();
    void this.context.close();
    this.listeners.clear();
  }

  /** One animation frame: the visual nodes on the frame clock, then the Renderer's picture onto the canvas. */
  private frame(): void {
    this.frameCounts.frames++;
    this.frames.tick();
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

  /** The running plan's host-facing parts: Pointer nodes, the Renderer, and status watchers. */
  private adopt(plan: Plan): void {
    this.plan = plan;
    this.pointers = plan.order.filter((node) => node.definition.type === 'pointer').map((node) => node.id);
    this.renderer = plan.order.find((node) => node.definition.type === 'renderer')?.id ?? null;
    this.hasFluid = plan.order.some((node) => node.definition.type === 'fluid');
    if (!this.renderer || !this.hasFluid) this.splashes.length = 0;
    // An Event input's probe shows the cables into it in this plan.
    for (const track of this.probes.values()) this.followProbe(track);
    for (const unwatch of this.unwatch) unwatch();
    this.unwatch = plan.order.flatMap((node) => node.definition.watchStatus?.(this.statusContext(node.id, node.params), () => this.emit()) ?? []);
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
    const node = this.plan.order.find((n) => n.id === track.node);
    const input = node?.definition.ports.some((p) => p.name === track.port && p.direction === 'in');
    const ends = input
      ? (this.plan.incoming.get(track.node)?.events ?? []).filter((l) => l.toPort === track.port).map((l) => l.from)
      : [{ node: track.node, port: track.port }];
    const before = track.sources;
    track.sources = ends.map((end) => this.follow(end.node, end.port));
    for (const source of before) this.release(source);
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
        if (track.sources.length === 1) next.events = [...track.sources[0]!.history];
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

  private statusContext(nodeId: string, params: StatusContext['params']): StatusContext {
    return { nodeId, params, audio: this.audio, services: this.services };
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
      decodeAudioData: (data) => context.decodeAudioData(data),
      createOscillator: () => {
        const osc = context.createOscillator();
        const start = osc.start.bind(osc);
        osc.start = (when = 0) => {
          this.noteStart(Math.max(when, context.currentTime));
          start(when);
        };
        return osc;
      },
      createBufferSource: () => {
        const source = context.createBufferSource();
        const start = source.start.bind(source);
        source.start = (when = 0, offset?: number, duration?: number) => {
          this.noteStart(Math.max(when, context.currentTime));
          start(when, offset, duration);
        };
        return source;
      },
    };
  }

  private noteStart(time: number): void {
    if (this.starts) this.starts.push(time);
    else if (this.coldTap) {
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
