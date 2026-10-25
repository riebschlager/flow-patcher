// The canvas's lifecycle for the Canvas node (docs/nodes/canvas-sources.md): its size, focus and the
// page's visibility, as the live host sends them. Apart from LivePatch so it can be tested on a
// ManualClock.
import { IMMEDIATE_OFFSET, type InputEventType, type InputFields, type SchedulerTimer } from '@flow-patcher/engine';

/** The canvas's lifecycle events, which the host sends again as state when audio starts. */
export const CANVAS_TYPES: ReadonlySet<InputEventType> = new Set(['resize', 'focus', 'blur', 'visibilitychange']);

/** The canvas as the host sees it, or as it last reached the source nodes: CSS-pixel size (null before
 *  the first measurement), focus, and the page's visibility. */
export interface CanvasState {
  size: { width: number; height: number } | null;
  focused: boolean;
  visibility: DocumentVisibilityState;
}

export interface CanvasLifecycleHost {
  /** Sends one input event to the sources that read it (`LivePatch.input`). */
  send(event: InputFields): unknown;
  /** Whether audio runs: while it doesn't, nothing is sent and the state is kept. */
  running(): boolean;
  /** The audio clock, which pushes are stamped from (plus IMMEDIATE_OFFSET). */
  now(): number;
}

/**
 * The browser reports changes only, so each one is sent while audio runs. While it doesn't, the state is
 * kept, and `start` sends what changed once it does: so the first tap (which focuses the canvas while audio
 * is still starting) brings the size and a Focus with it, and an interruption that blurred the canvas
 * brings a Blur when audio comes back.
 *
 * A source that reads the size and is new to the plan is sent it once its swap has taken effect: a swap
 * lands at a window boundary at least SWAP_MARGIN past now (ADR 0023), and a push stamped before that reaches a window
 * the new node isn't in yet, so it would be lost. `tick` sends it when a push would be stamped at or
 * after the swap. The host calls it each frame, at each AudioContext state change, and after each of the
 * scheduler's wakes (`pace`), since frames stop while the page is hidden and the wakes don't.
 */
export class CanvasLifecycle {
  readonly surface: CanvasState;
  private readonly sent: CanvasState;
  /** Nodes in the running plan that read resize. */
  private sized = new Set<string>();
  /** When the size is due to a new reader: the latest swap that brought one, until it's sent. */
  private sizeDue: number | null = null;

  constructor(private readonly host: CanvasLifecycleHost, visibility: DocumentVisibilityState) {
    this.surface = { size: null, focused: false, visibility };
    // The sources start out knowing nothing but the page they were loaded on.
    this.sent = { size: null, focused: false, visibility };
  }

  /** The canvas's size changed, in CSS pixels: Canvas's Width and Height. */
  resize(width: number, height: number): void {
    this.surface.size = { width, height };
    if (!this.host.running()) return;
    this.sent.size = { width, height };
    this.host.send({ type: 'resize', canvasWidth: width, canvasHeight: height });
  }

  /** The canvas gained or lost keyboard focus: Canvas's Focus or Blur. */
  focus(focused: boolean): void {
    this.surface.focused = focused;
    if (!this.host.running()) return;
    this.sent.focused = focused;
    this.host.send({ type: focused ? 'focus' : 'blur' });
  }

  /** The page was hidden or shown: Canvas's Hidden or Visible. */
  visibility(visibility: DocumentVisibilityState): void {
    this.surface.visibility = visibility;
    if (!this.host.running()) return;
    this.sent.visibility = visibility;
    this.host.send({ type: 'visibilitychange', visibility });
  }

  /** Audio started: sends what changed while it wasn't running. */
  start(): void {
    const { size, focused, visibility } = this.surface;
    const sent = this.sent;
    if (this.sizeDue !== null) this.tick();
    else if (size && (size.width !== sent.size?.width || size.height !== sent.size.height)) this.resize(size.width, size.height);
    if (focused !== sent.focused) this.focus(focused);
    if (visibility !== sent.visibility) this.visibility(visibility);
  }

  /** A new plan: the ids of its nodes that read resize, and when its swap took effect (`SwapReport.time`). */
  adopt(readers: Iterable<string>, swapTime: number): void {
    const sized = new Set(readers);
    const fresh = [...sized].some((id) => !this.sized.has(id));
    this.sized = sized;
    if (!sized.size) this.sizeDue = null;
    if (!fresh) return;
    this.sizeDue = Math.max(this.sizeDue ?? -Infinity, swapTime);
    this.tick();
  }

  /** The scheduler's wake timer, with a `tick` after every wake, so a due size is sent while frames are paused. */
  pace(timer: SchedulerTimer): SchedulerTimer {
    return {
      every: (ms, tick) => timer.every(ms, () => {
        tick();
        this.tick();
      }),
    };
  }

  /** Sends the size to a new reader once a push would land at or after its swap. Cheap, and does nothing
   *  when no size is due, so it can be called as often as the host likes. */
  tick(): void {
    const due = this.sizeDue;
    if (due === null || !this.host.running() || this.host.now() + IMMEDIATE_OFFSET < due) return;
    this.sizeDue = null;
    const size = this.surface.size;
    if (size) this.resize(size.width, size.height);
  }
}
