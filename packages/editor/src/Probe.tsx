import { useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { ViewportPortal } from '@xyflow/react';
import { createStore, useStore } from 'zustand';
import type { EngineEvent, PortType } from '@flow-patcher/engine';
import { PROBE_HISTORY, type LivePatch, type ProbeView } from './live';
import { LivePatchContext } from './ParamField';
import { PORT_COLORS } from './ports';

/** A port a probe shows. */
export interface ProbeTarget {
  node: string;
  port: string;
  type: PortType;
  direction: 'in' | 'out';
  /** Node and port labels, for the card's title. */
  title: string;
}

const keyOf = (t: Pick<ProbeTarget, 'node' | 'port'>) => `${t.node}.${t.port}`;

/** Which probes show: the port under the pointer, and those pinned. UI state: not in the document, not undone. */
export const probeStore = createStore<{
  hover: ProbeTarget | null;
  pinned: ProbeTarget[];
  setHover: (target: ProbeTarget | null) => void;
  toggle: (target: ProbeTarget) => void;
  /** Unpins probes on nodes no longer in the patch. */
  keep: (ids: ReadonlySet<string>) => void;
}>((set, get) => ({
  hover: null,
  pinned: [],
  setHover: (hover) => set({ hover }),
  toggle: (target) => {
    const { pinned } = get();
    const key = keyOf(target);
    set({ pinned: pinned.some((p) => keyOf(p) === key) ? pinned.filter((p) => keyOf(p) !== key) : [...pinned, target], hover: null });
  },
  keep: (ids) => {
    const { pinned, hover } = get();
    if (pinned.every((p) => ids.has(p.node)) && (!hover || ids.has(hover.node))) return;
    set({ pinned: pinned.filter((p) => ids.has(p.node)), hover: hover && ids.has(hover.node) ? hover : null });
  },
}));

/** How long the pointer rests on a port before its probe shows, ms. */
export const HOVER_DELAY = 250;
/** Card widths, px: a pinned probe (design system Probe) and the lighter hover one. */
const PINNED_W = 300, HOVER_W = 220;
/** Space between a node and a probe beside it, and between stacked probes, px. */
const GAP = 12, STACK = 168;

/** A port's live view while the card shows: re-renders each frame it changes. */
function useProbe(live: LivePatch | null, target: ProbeTarget): ProbeView | null {
  const subscribe = useCallback((listener: () => void) => live?.watchProbe(target.node, target.port, target.type, listener) ?? (() => {}), [live, target.node, target.port, target.type]);
  return useSyncExternalStore(subscribe, () => live?.probe(target.node, target.port) ?? null);
}

/** Probes in the graph's own coordinates, beside their ports, so they pan and zoom with their nodes. */
export function ProbeLayer({ anchor }: { anchor: (target: ProbeTarget) => { x: number; y: number; width: number } | null }) {
  const hover = useStore(probeStore, (s) => s.hover);
  const pinned = useStore(probeStore, (s) => s.pinned);
  const placed = useMemo(() => {
    const stacks = new Map<string, number>();
    const at = (target: ProbeTarget, width: number) => {
      const box = anchor(target);
      if (!box) return null;
      const side = `${target.node}:${target.direction}`;
      const n = stacks.get(side) ?? 0;
      stacks.set(side, n + 1);
      return { x: target.direction === 'out' ? box.x + box.width + GAP : box.x - width - GAP, y: box.y + n * STACK };
    };
    const cards = pinned.map((target) => ({ target, pinned: true, at: at(target, PINNED_W) }));
    if (hover && !pinned.some((p) => keyOf(p) === keyOf(hover))) cards.push({ target: hover, pinned: false, at: at(hover, HOVER_W) });
    return cards;
  }, [anchor, hover, pinned]);
  return (
    <ViewportPortal>
      {placed.map(({ target, pinned, at }) => at && (
        <div key={`${pinned ? 'pin' : 'hover'}:${keyOf(target)}`} className="probe-anchor nodrag nopan nowheel" style={{ transform: `translate(${at.x}px, ${at.y}px)` }}>
          <ProbeCard target={target} pinned={pinned} />
        </div>
      ))}
    </ViewportPortal>
  );
}

/** One probe (design system Probe): a scope for Signal, a timeline for Event and Note, the value for Value. */
function ProbeCard({ target, pinned }: { target: ProbeTarget; pinned: boolean }) {
  const live = useContext(LivePatchContext);
  const view = useProbe(live, target);
  const { type } = target;
  return (
    <div className={`probe${pinned ? ' probe--pinned' : ''}`} data-testid={pinned ? 'probe-pinned' : 'probe-hover'} data-probe={keyOf(target)} style={{ width: pinned ? PINNED_W : HOVER_W }}>
      <div className="probe__header">
        <span className={`probe__port fp-port fp-port--${type}`} />
        <span className="probe__title">{target.title}</span>
        <span className="probe__value" data-testid="probe-value" style={type === 'signal' ? { color: PORT_COLORS.signal } : undefined}>{headline(view)}</span>
        {pinned && (
          <button type="button" className="probe__pin" aria-label="Unpin probe" title="Unpin probe" onClick={() => probeStore.getState().toggle(target)}>
            <i className="icon-pin" />
          </button>
        )}
      </div>
      {pinned ? <ProbeBody view={view} type={type} /> : <HoverBody view={view} type={type} />}
    </div>
  );
}

function ProbeBody({ view, type }: { view: ProbeView | null; type: PortType }) {
  if (type === 'audio' || type === 'field') return <p className="probe__empty">No probe for {type} ports yet</p>;
  const fields = view ? fieldsOf(type === 'value' ? view.value : view.events.at(-1)) : null;
  return (
    <>
      {type === 'signal' && <Scope view={view} />}
      {(type === 'event' || type === 'note') && <Timeline view={view} type={type} />}
      {fields && fields.length > 0 && (
        <div className="probe__fields">
          {fields.map(([k, v]) => <span key={k} className="probe__field"><span className="probe__field-key">{k}</span><span>{v}</span></span>)}
        </div>
      )}
      {type !== 'value' && (
        <div className="probe__footer">
          <span>−{PROBE_HISTORY.toFixed(1)} s</span>
          <span>now</span>
        </div>
      )}
    </>
  );
}

/** The hover probe: the last value, or the last few events. */
function HoverBody({ view, type }: { view: ProbeView | null; type: PortType }) {
  if (type === 'audio' || type === 'field') return <p className="probe__empty">No probe for {type} ports yet</p>;
  if (type === 'event' || type === 'note') {
    const last = view?.events.slice(-5).reverse() ?? [];
    if (!last.length) return <p className="probe__empty">Nothing in the last {PROBE_HISTORY} s</p>;
    return (
      <ol className="probe__list">
        {last.map((e, i) => <li key={i}><span className="probe__field-key">{(e.time - view!.now).toFixed(2)} s</span><span>{summary(e)}</span></li>)}
      </ol>
    );
  }
  if (type === 'value') {
    const fields = view ? fieldsOf(view.value) : null;
    return fields && fields.length ? <div className="probe__fields">{fields.map(([k, v]) => <span key={k} className="probe__field"><span className="probe__field-key">{k}</span><span>{v}</span></span>)}</div> : null;
  }
  return null;
}

/** Signal scope: channel 0 over the history, scaled to what it spans. */
function Scope({ view }: { view: ProbeView | null }) {
  const samples = view?.samples ?? [];
  let lo = Infinity, hi = -Infinity;
  for (const s of samples) {
    lo = Math.min(lo, s.v);
    hi = Math.max(hi, s.v);
  }
  const span = hi - lo || 1;
  const now = view?.now ?? 0;
  const points = samples.map((s) => `${((1 - (now - s.t) / PROBE_HISTORY) * 280).toFixed(1)},${(60 - ((s.v - (hi === lo ? lo - 0.5 : lo)) / span) * 56).toFixed(1)}`).join(' ');
  return (
    <svg className="probe__scope" data-testid="probe-scope" data-samples={samples.length} viewBox="0 0 280 64" preserveAspectRatio="none">
      <line x1="0" y1="32" x2="280" y2="32" stroke="var(--fp-line-1)" strokeWidth="1" />
      <polyline points={points} fill="none" stroke={PORT_COLORS.signal} strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Event timeline: a tick per event over the history, channel 0 on the top lane and the rest below. */
function Timeline({ view, type }: { view: ProbeView | null; type: PortType }) {
  const events = view?.events ?? [];
  const now = view?.now ?? 0;
  return (
    <div className="probe__timeline" data-testid="probe-timeline" data-events={events.length}>
      {events.map((e, i) => (
        <span
          key={i}
          className={`probe__tick${e.channel ? ' probe__tick--lane' : ''}`}
          style={{ left: `${(1 - (now - e.time) / PROBE_HISTORY) * 100}%`, background: PORT_COLORS[type] }}
        />
      ))}
    </div>
  );
}

/** The value beside the title: a signal's level, the number of events in the history, a value's summary. */
function headline(view: ProbeView | null): string {
  if (!view) return '';
  if (view.type === 'signal') return typeof view.value === 'number' ? view.value.toFixed(3) : '—';
  if (view.type === 'event' || view.type === 'note') return `${view.events.length} in ${PROBE_HISTORY} s`;
  if (view.type === 'value') return summary(view.value);
  return '';
}

/** One line for a value or an event: a chord's symbol, a note's pitch, a number. */
function summary(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'number') return format(value);
  if (typeof value !== 'object') return String(value);
  const o = value as Record<string, unknown>;
  if (typeof o.symbol === 'string') return o.symbol;
  if (typeof o.pitch === 'number') return `pitch ${format(o.pitch)}`;
  if (typeof o.beat === 'number') return `beat ${format(o.beat)}`;
  const e = o as Partial<EngineEvent>;
  return typeof e.channel === 'number' ? `ch ${e.channel}` : '';
}

/** A value's or an event's fields, for the mono grid under the body. Time is left to the timeline. */
function fieldsOf(value: unknown): [string, string][] | null {
  if (!value || typeof value !== 'object') return null;
  return Object.entries(value as Record<string, unknown>)
    .filter(([k, v]) => k !== 'time' && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || Array.isArray(v)))
    .slice(0, 8)
    .map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => (typeof x === 'number' ? format(x) : String(x))).join(' ') : typeof v === 'number' ? format(v) : String(v)]);
}

const format = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3));

/** Hover and click on a port handle: the hover probe after a rest, and a click (not a drag) pins it. */
export function useProbeHandle(target: ProbeTarget) {
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    onPointerEnter: (event: ReactPointerEvent) => {
      // A finger has no hover: a tap pins instead.
      if (event.pointerType !== 'mouse' || event.buttons) return;
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => probeStore.getState().setHover(target), HOVER_DELAY);
    },
    onPointerLeave: () => {
      clearTimeout(timer.current);
      const { hover, setHover } = probeStore.getState();
      if (hover && keyOf(hover) === keyOf(target)) setHover(null);
    },
    onPointerDown: () => {
      clearTimeout(timer.current);
      probeStore.getState().setHover(null);
    },
    onClick: () => probeStore.getState().toggle(target),
  };
}
