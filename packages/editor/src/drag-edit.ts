// A drag that edits the document: knob values and cable depths. While the
// pointer moves, the edit is previewed at most once per animation frame, so
// the running patch hot-swaps at frame rate, not at pointer rate; when it
// stops, the whole drag becomes one undo step.
import { invertPatchEdits, type Patch, type PatchEdit } from '@flow-patcher/engine';
import type { EditorStore } from './store';

/** Pixels the pointer must travel before a press becomes a drag, so a click or a double-click's jitter edits nothing. */
export const DRAG_THRESHOLD = 3;

export interface DragEdit {
  /** The value when the drag starts. A drag that ends on it records nothing. */
  from: number;
  /** The value at `dx` pixels from where the drag started (never 0); `fine` while Shift is held. */
  valueAt(dx: number, fine: boolean): number;
  /** The edits that set the value. They must give the same document however many times they're previewed. */
  edits(value: number): PatchEdit[];
  /** Called once the drag is over: recorded, cancelled or aborted. */
  onEnd?(): void;
}

/**
 * Starts a drag from a pointerdown. It listens on the window, so the moves keep
 * coming when the pointer leaves the element, or when a preview re-renders the
 * element away. A pointercancel puts the document back. Anything else that
 * changes the document mid-drag (an undo, a delete) ends the drag where it is,
 * unrecorded, because its undo step would no longer apply.
 */
export function startDrag(store: EditorStore, event: Pick<PointerEvent, 'pointerId' | 'clientX'>, drag: DragEdit): void {
  const x0 = event.clientX, before = store.getState().doc;
  let value = drag.from, moved = false, frame = 0, done = false, previewing = false;
  /** The document as this drag last left it, to tell its own changes from anyone else's. */
  let ours: Patch = before;
  const preview = (edits: PatchEdit[]) => {
    if (!edits.length) return false;
    previewing = true;
    try {
      store.getState().preview(edits);
    } catch {
      // The node or cable went away under the drag.
      return false;
    } finally {
      previewing = false;
    }
    ours = store.getState().doc;
    return true;
  };
  const flush = () => {
    frame = 0;
    if (!preview(drag.edits(value))) stop();
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    const dx = e.clientX - x0;
    if (!moved && Math.abs(dx) < DRAG_THRESHOLD) return;
    moved = true;
    value = dx === 0 ? drag.from : drag.valueAt(dx, e.shiftKey);
    frame ||= requestAnimationFrame(flush);
  };
  const stop = () => {
    if (done) return;
    done = true;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    unsubscribe();
    if (frame) cancelAnimationFrame(frame);
    drag.onEnd?.();
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    move(e);
    stop();
    if (!moved) return;
    // Dragged away and back: undo the previews, record nothing.
    if (value === drag.from) {
      preview(drag.edits(drag.from));
      return;
    }
    const final = drag.edits(value);
    if (preview(final)) store.getState().record({ edits: final, inverse: invertPatchEdits(before, final) });
  };
  // A cancel's coordinates can't be trusted (Chromium sends 0, 0 for touch): go back to where the drag began.
  const cancel = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    stop();
    if (moved) preview(drag.edits(drag.from));
  };
  const unsubscribe = store.subscribe((state) => {
    // The store tells subscribers inside preview(), before `ours` catches up.
    if (!previewing && state.doc !== ours) stop();
  });
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

/** Rounds to `step`, or to a thousandth of the range without one, and clamps to [min, max]. */
export function snapTo(value: number, min: number, max: number, step?: number): number {
  const unit = step ?? (max - min) / 1000;
  const snapped = unit > 0 ? Math.round(value / unit) * unit : value;
  // Rounding by a fractional unit leaves float dust (0.30000000000000004); trim it to the unit's decimals.
  const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(unit || 1)) + 1));
  return Math.min(max, Math.max(min, Number(snapped.toFixed(decimals))));
}
