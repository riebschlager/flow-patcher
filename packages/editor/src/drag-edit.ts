// A drag that edits the document: knob values and cable depths. While the
// pointer moves, the edit is previewed at most once per animation frame, so
// the running patch hot-swaps at frame rate, not at pointer rate; when it
// stops, the whole drag becomes one undo step.
import { invertPatchEdits, type PatchEdit } from '@flow-patcher/engine';
import type { EditorStore } from './store';

export interface DragEdit {
  /** The value at `dx` pixels from where the drag started; `fine` while Shift is held. */
  valueAt(dx: number, fine: boolean): number;
  /** The edits that set the value. They must give the same document however many times they're previewed. */
  edits(value: number): PatchEdit[];
  /** Called once the drag is over, recorded or not. */
  onEnd?(): void;
}

/** Starts a drag from a pointerdown. It listens on the window, so the moves keep coming when the pointer
 *  leaves the element, or when a preview re-renders the element away. */
export function startDrag(store: EditorStore, event: PointerEvent, drag: DragEdit): void {
  const x0 = event.clientX, before = store.getState().doc;
  let pending: PatchEdit[] | null = null, frame = 0, moved = false;
  const flush = () => {
    frame = 0;
    if (pending) store.getState().preview(pending);
    pending = null;
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    moved = true;
    pending = drag.edits(drag.valueAt(e.clientX - x0, e.shiftKey));
    frame ||= requestAnimationFrame(flush);
  };
  const end = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    if (frame) cancelAnimationFrame(frame);
    flush();
    drag.onEnd?.();
    if (!moved) return;
    const final = drag.edits(drag.valueAt(e.clientX - x0, e.shiftKey));
    store.getState().preview(final);
    const after = store.getState().doc;
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    store.getState().record({ edits: final, inverse: invertPatchEdits(before, final) });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

/** Rounds to `step`, or to a thousandth of the range without one, and clamps to [min, max]. */
export function snapTo(value: number, min: number, max: number, step?: number): number {
  const unit = step ?? (max - min) / 1000;
  const snapped = unit > 0 ? Math.round(value / unit) * unit : value;
  // Rounding by a fractional unit leaves float dust (0.30000000000000004); trim it to the unit's decimals.
  const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(unit || 1)) + 1));
  return Math.min(max, Math.max(min, Number(snapped.toFixed(decimals))));
}
