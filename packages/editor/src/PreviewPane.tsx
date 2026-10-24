import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { keepsDefault, keyFields } from './keys';
import type { LivePatch, PointerPort } from './live';

const MIN = { width: 200, height: 120 };
const DEFAULT = { width: 248, height: 156 };

/** The performance canvas in Patch view: a floating pane, resized from its lower-left corner. */
export function PreviewPane({ live }: { live: LivePatch | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(DEFAULT);
  const subscribe = useCallback((listener: () => void) => live?.subscribe(listener) ?? (() => {}), [live]);
  const status = useSyncExternalStore(
    subscribe,
    () => live?.status.audio ?? 'closed',
  );
  const running = status === 'running';
  // Pointer nodes come and go as the patch is edited.
  const pointers = useSyncExternalStore(subscribe, () => live?.status.pointers ?? 0);

  // The Renderer draws into the canvas each frame.
  useEffect(() => {
    live?.attachCanvas(canvas.current);
    return () => live?.attachCanvas(null);
  }, [live]);

  // Keep the backing store at device pixels.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry!.contentBoxSize[0]!;
      element.width = Math.round(box.inlineSize * devicePixelRatio);
      element.height = Math.round(box.blockSize * devicePixelRatio);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The canvas's size in CSS pixels, for the Canvas node's Width, Height and Aspect.
  useEffect(() => {
    const element = canvas.current;
    if (!element || !live) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry!.contentBoxSize[0]!;
      live.canvasResize(box.inlineSize, box.blockSize);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [live]);

  // Each pointer's latest sample time (event.timeStamp, ms), for `interval`: motion is measured on the
  // browser's clock, since the stamps carry render quanta and handler delays (canvas-sources.md).
  const [lastSample] = useState(() => new Map<number, number>());
  /** Seconds since this pointer's previous sample, or nothing for its first; and `timeStamp` becomes the latest. */
  const intervalOf = (pointerId: number, timeStamp: number): { interval?: number } => {
    const last = lastSample.get(pointerId);
    lastSample.set(pointerId, timeStamp);
    return last === undefined ? {} : { interval: Math.max(0, (timeStamp - last) / 1000) };
  };

  const send = (port: PointerPort) => (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!live) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (port === 'down') {
      event.currentTarget.setPointerCapture(event.pointerId);
      // Playing the canvas gives it the keyboard (focus rules), without scrolling the page to it. The ring
      // is for keyboard focus, so a tap after tabbing elsewhere doesn't light it.
      event.currentTarget.focus({ preventScroll: true, focusVisible: false });
    }
    const fields = (e: PointerEvent | ReactPointerEvent<HTMLCanvasElement>) => ({
      channel: e.pointerId,
      x: clamp01((e.clientX - box.left) / box.width),
      y: clamp01((e.clientY - box.top) / box.height),
      // Mice report 0.5 while a button is down and 0 otherwise.
      pressure: e.pressure,
      pointerType: e.pointerType,
      width: e.width,
      height: e.height,
      button: e.button,
      buttons: e.buttons,
      shift: e.shiftKey,
      alt: e.altKey,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
    });
    if (port === 'enter' || port === 'leave') {
      // Hover state only: no sample. A pointer that leaves starts afresh when it comes back.
      if (port === 'leave') lastSample.delete(event.pointerId);
      live.pointer(port, fields(event), event.timeStamp);
      return;
    }
    if (port === 'move' && live.readsCoalesced) {
      // Pointer (high rate): every sample the browser coalesced into this move, then the move itself
      // for Pointer, in one push. The list includes the dispatched move, so high rate reads only the
      // samples (`coalesced: true`) and Pointer only the plain move. One source in every browser:
      // pointerrawupdate isn't used, since its samples come again in the next move's list, and a push
      // per sample would cost a rewind each and collide on render-quantum stamps.
      const native = event.nativeEvent;
      const listed = native.getCoalescedEvents?.() ?? [];
      const samples = listed.length ? listed : [native];
      // The plain move spans from the previous move (or down) to this one; each sample from the one before it.
      const before = lastSample.get(event.pointerId);
      const plain = { type: 'pointermove' as const, ...fields(event), ...(before === undefined ? {} : { interval: Math.max(0, (event.timeStamp - before) / 1000) }) };
      const coalesced = samples.map((sample) => ({ type: 'pointermove' as const, ...fields(sample), coalesced: true, ...intervalOf(event.pointerId, sample.timeStamp) }));
      lastSample.set(event.pointerId, event.timeStamp);
      live.inputAll([...coalesced, plain]);
      return;
    }
    live.pointer(port, { ...fields(event), ...intervalOf(event.pointerId, event.timeStamp) }, event.timeStamp);
    if (port === 'up' || port === 'cancel') lastSample.delete(event.pointerId);
  };

  // Focus rules (Platform rules): while the canvas has focus its keys stay with it, so the editor's
  // shortcuts (undo, Delete, Tab for the palette) don't fire. Escape always returns to the editor.
  // Only keydown: the shortcuts all fire on it, and React Flow tracks held keys (Space, Shift) from
  // keyup on the document, so swallowing keyup would leave them stuck down.
  // Every other key goes to the Key node: keydown here, keyup below (Escape is never sent). With a Key in the
  // patch the canvas is an instrument, so keys lose their page defaults (Space scrolling, quick find), apart
  // from Tab, the function keys and Ctrl or Meta shortcuts (`keepsDefault`).
  const keyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === 'Escape') {
      event.currentTarget.blur();
      return;
    }
    event.stopPropagation();
    if (!live) return;
    const fields = keyFields(event.nativeEvent);
    if (live.reads('keydown') && !keepsDefault(fields)) event.preventDefault();
    live.key('down', fields, event.timeStamp);
  };
  // Not stopped: React Flow has to see it (above).
  const keyUp = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (event.key !== 'Escape') live?.key('up', keyFields(event.nativeEvent), event.timeStamp);
  };

  // The context menu stays unless a source in the patch reads right-clicks (Platform rules).
  const contextMenu = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (live?.reads('contextmenu')) event.preventDefault();
  };

  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY, ...size };
    const move = (e: PointerEvent) =>
      setSize({
        width: Math.max(MIN.width, start.width - (e.clientX - start.x)),
        height: Math.max(MIN.height, start.height + (e.clientY - start.y)),
      });
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  };

  return (
    <section className="preview" data-testid="preview" style={{ width: size.width }}>
      <header className="preview__bar">
        <span className={`preview__led${running ? ' preview__led--live' : ''}`} />
        Preview
        <span className="preview__state" data-testid="audio-state">{running ? 'live' : 'tap to start'}</span>
      </header>
      <div className="preview__body" style={{ height: size.height }}>
        <canvas
          ref={canvas}
          className="preview__canvas"
          data-testid="performance-canvas"
          tabIndex={0}
          aria-label="Performance canvas"
          onKeyDown={keyDown}
          onKeyUp={keyUp}
          onFocus={() => live?.canvasFocus(true)}
          onBlur={() => {
            // Keys still down get their keyups before the Blur, so Key's Held lets go.
            live?.releaseKeys();
            live?.canvasFocus(false);
          }}
          onContextMenu={contextMenu}
          onPointerDown={send('down')}
          onPointerMove={send('move')}
          onPointerUp={send('up')}
          onPointerCancel={send('cancel')}
          onPointerEnter={send('enter')}
          onPointerLeave={send('leave')}
        />
        {live && !pointers && <span className="preview__hint">No Pointer in this patch</span>}
      </div>
      <div className="preview__grip" onPointerDown={resize} aria-label="Resize preview" role="separator" />
    </section>
  );
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
