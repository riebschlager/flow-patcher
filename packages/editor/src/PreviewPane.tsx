import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { keepsDefault, keyFields } from './keys';
import type { ClickType, LivePatch, PenFields, PointerPort } from './live';

const MIN = { width: 200, height: 120 };
const DEFAULT = { width: 248, height: 156 };

/** The performance canvas in Patch view: a floating pane, resized from its lower-left corner. */
/** `full`: the canvas fills the window (`?canvas=full`), for playing a patch on a phone or tablet before Play view (M4). */
export function PreviewPane({ live, full = false }: { live: LivePatch | null; full?: boolean }) {
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

  // Wheel (canvas-sources.md): each wheel event pushed once, with the browser's deltas and deltaMode (Wheel
  // converts them to pixels). A trackpad pinch arrives as wheel + ctrlKey. While a source reads wheel the
  // canvas keeps it: no page scroll, and no browser zoom on a pinch or Ctrl + wheel. That needs a
  // non-passive listener, and React's onWheel is passive, so it's added here.
  useEffect(() => {
    const element = canvas.current;
    if (!element || !live) return;
    const wheel = (event: WheelEvent) => {
      if (!live.reads('wheel')) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      live.wheel({
        x: clamp01((event.clientX - box.left) / box.width),
        y: clamp01((event.clientY - box.top) / box.height),
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        shift: event.shiftKey,
        alt: event.altKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
      }, event.timeStamp);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [live]);

  // Touch extras (canvas-sources.md): Safari sends a pinch or twist (two fingers on iOS, the trackpad on
  // macOS) as gesturestart, gesturechange and gestureend. Each gesturechange is pushed once with its scale
  // and rotation (degrees) as Safari reports them, and its centre and modifiers where it has them. Only
  // gesturechange is a stream type (ADR 0029); start and end are listened to so that, while a source reads
  // gesturechange, the canvas keeps the whole gesture and Safari doesn't zoom the page. Other browsers never
  // send these, so nothing here runs there.
  useEffect(() => {
    const element = canvas.current;
    if (!element || !live) return;
    type Gesture = Event & { scale?: unknown; rotation?: unknown; clientX?: unknown; clientY?: unknown; shiftKey?: unknown; altKey?: unknown; ctrlKey?: unknown; metaKey?: unknown };
    const flag = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
    const keep = (event: Event) => {
      if (live.reads('gesturechange')) event.preventDefault();
    };
    const change = (event: Gesture) => {
      if (!live.reads('gesturechange')) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const { clientX, clientY } = event;
      const at = typeof clientX === 'number' && typeof clientY === 'number'
        ? { x: clamp01((clientX - box.left) / box.width), y: clamp01((clientY - box.top) / box.height) }
        : {};
      const modifiers = { shift: flag(event.shiftKey), alt: flag(event.altKey), ctrl: flag(event.ctrlKey), meta: flag(event.metaKey) };
      live.gesture({
        ...at,
        scale: typeof event.scale === 'number' ? event.scale : 1,
        rotation: typeof event.rotation === 'number' ? event.rotation : 0,
        ...Object.fromEntries(Object.entries(modifiers).filter(([, value]) => value !== undefined)),
      }, event.timeStamp);
    };
    element.addEventListener('gesturestart', keep, { passive: false });
    element.addEventListener('gesturechange', change, { passive: false });
    element.addEventListener('gestureend', keep, { passive: false });
    return () => {
      element.removeEventListener('gesturestart', keep);
      element.removeEventListener('gesturechange', change);
      element.removeEventListener('gestureend', keep);
    };
  }, [live]);

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
  // The pointerType of the last pointerdown on the canvas, for click events that carry none (Safari).
  const [lastDown] = useState(() => ({ pointerType: 'mouse' }));
  /** Seconds since this pointer's previous sample, or nothing for its first; and `timeStamp` becomes the latest. */
  const intervalOf = (pointerId: number, timeStamp: number): { interval?: number } => {
    const last = lastSample.get(pointerId);
    lastSample.set(pointerId, timeStamp);
    return last === undefined ? {} : { interval: Math.max(0, (timeStamp - last) / 1000) };
  };

  // Pen (canvas-sources.md): a pen's events carry its tilt, twist and tangential pressure as the browser
  // reports them, and altitudeAngle and azimuthAngle where it has them (Pen derives them from tilt where it
  // doesn't). Named as Pen's outputs (ADR 0029). Other pointers leave them out. The barrel button is in
  // `buttons` (bit 2), so it isn't sent separately.
  const penFields = (e: PointerEvent | ReactPointerEvent<HTMLCanvasElement>): PenFields | Record<string, never> => {
    if (e.pointerType !== 'pen') return {};
    // React's synthetic event doesn't copy the angles (only tilt, twist and tangential pressure), so they come from the native one.
    const { altitudeAngle, azimuthAngle } = ('nativeEvent' in e ? e.nativeEvent : e) as { altitudeAngle?: number; azimuthAngle?: number };
    return {
      tiltX: e.tiltX,
      tiltY: e.tiltY,
      twist: e.twist,
      tangentialPressure: e.tangentialPressure,
      ...(typeof altitudeAngle === 'number' ? { altitudeAngle } : {}),
      ...(typeof azimuthAngle === 'number' ? { azimuthAngle } : {}),
    };
  };

  const send = (port: PointerPort) => (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (port === 'down') lastDown.pointerType = event.pointerType;
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
      ...penFields(e),
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

  // Click (canvas-sources.md): click, dblclick, auxclick and contextmenu, each pushed once, at one stamp
  // shared by every source that reads it (ADR 0029). Clicks aren't contacts, so they carry no channel.
  // Chromium sends them as PointerEvents, with a pointerType; a keyboard contextmenu (menu key, Shift+F10)
  // has an empty one, sent as 'mouse'. Safari sends plain MouseEvents with no pointerType at all, so a
  // tap's click or a long press's contextmenu takes the last pointerdown's on the canvas, from any pointer
  // ('mouse' before the first).
  const sendClick = (type: ClickType) => (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!live?.reads(type)) return;
    const box = event.currentTarget.getBoundingClientRect();
    const native = event.nativeEvent as MouseEvent & { pointerType?: string };
    live.click(type, {
      x: clamp01((event.clientX - box.left) / box.width),
      y: clamp01((event.clientY - box.top) / box.height),
      pointerType: typeof native.pointerType === 'string' ? native.pointerType || 'mouse' : lastDown.pointerType,
      button: event.button,
      buttons: event.buttons,
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
    }, event.timeStamp);
  };
  // A middle press would start autoscroll (or paste, on Linux) and swallow its auxclick, so it's
  // suppressed while a source reads middle clicks, as the context menu is for right-clicks.
  const middleDown = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (event.button === 1 && live?.reads('auxclick')) event.preventDefault();
  };
  const clicked = sendClick('click'), doubled = sendClick('dblclick'), auxClicked = sendClick('auxclick'), rightClicked = sendClick('contextmenu');

  // The context menu stays unless a source in the patch reads right-clicks (Platform rules).
  const contextMenu = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (live?.reads('contextmenu')) event.preventDefault();
    rightClicked(event);
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
    <section className={`preview${full ? ' preview--full' : ''}`} data-testid="preview" style={full ? undefined : { width: size.width }}>
      <header className="preview__bar">
        <span className={`preview__led${running ? ' preview__led--live' : ''}`} />
        Preview
        <span className="preview__state" data-testid="audio-state">{running ? 'live' : 'tap to start'}</span>
      </header>
      <div className="preview__body" style={full ? undefined : { height: size.height }}>
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
          onClick={clicked}
          onDoubleClick={doubled}
          onAuxClick={auxClicked}
          onMouseDown={middleDown}
          onPointerDown={send('down')}
          onPointerMove={send('move')}
          onPointerUp={send('up')}
          onPointerCancel={send('cancel')}
          onPointerEnter={send('enter')}
          onPointerLeave={send('leave')}
        />
        {live && !pointers && <span className="preview__hint">No canvas input in this patch</span>}
      </div>
      {!full && <div className="preview__grip" onPointerDown={resize} aria-label="Resize preview" role="separator" />}
    </section>
  );
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
