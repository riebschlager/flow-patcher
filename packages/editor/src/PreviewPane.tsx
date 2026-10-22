import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
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

  const send = (port: PointerPort) => (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!live) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (port === 'down') event.currentTarget.setPointerCapture(event.pointerId);
    live.pointer(port, {
      channel: event.pointerId,
      x: clamp01((event.clientX - box.left) / box.width),
      y: clamp01((event.clientY - box.top) / box.height),
      // Mice report 0.5 while a button is down and 0 otherwise.
      pressure: event.pressure,
      pointerType: event.pointerType,
    }, event.timeStamp);
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
          onPointerDown={send('down')}
          onPointerMove={send('move')}
          onPointerUp={send('up')}
          onPointerCancel={send('cancel')}
        />
        {live && !pointers && <span className="preview__hint">No Pointer in this patch</span>}
      </div>
      <div className="preview__grip" onPointerDown={resize} aria-label="Resize preview" role="separator" />
    </section>
  );
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
