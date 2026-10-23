import { useContext, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { NumberParamSpec, PatchCable, PatchEdit, PortType } from '@flow-patcher/engine';
import { CABLE_STYLES, PORT_COLORS } from './ports';
import { ABOVE_NODES, cableId, type CableEdgeData } from './patch-graph';
import { snapTo, startDrag } from './drag-edit';
import { EditorStoreContext, TypedNumber } from './ParamField';
import { formatParam, keyedValue } from './param-format';

/** How long a refused cable shows before it's gone, ms; its fade runs over the same time. */
export const REFUSED_MS = 900;
const fade = { animationDuration: `${REFUSED_MS}ms` };

/** The invisible stroke that takes a cable's clicks, px: wider for fingers. */
const INTERACTION_WIDTH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 28 : 16;
/** Pixels of drag on a depth chip that cross the param's whole range; Shift makes it this many times finer. */
const DEPTH_DRAG = 160, FINE = 5;
/** How long a cable's controls stay after the pointer leaves it, ms, so the pointer can cross onto them. */
const HOVER_GRACE = 200;

/** A cable styled by the type it carries: color, width and dash all come from the source port. */
export function CableEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<Edge<CableEdgeData>>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const [hovered, setHovered] = useState(false);
  /** A depth drag or typed depth in progress: the controls stay until it's done. */
  const [busy, setBusy] = useState(false);
  const leaving = useRef(0);
  const hover = (on: boolean) => {
    clearTimeout(leaving.current);
    if (on) setHovered(true);
    else leaving.current = window.setTimeout(() => setHovered(false), HOVER_GRACE);
  };
  useEffect(() => () => clearTimeout(leaving.current), []);
  const store = useContext(EditorStoreContext);
  const type = data?.portType ?? 'signal';
  const cable = CABLE_STYLES[type];
  if (data?.refused) {
    return (
      <g className="cable-refused" style={fade} data-testid="cable-refused">
        <BaseEdge path={path} style={{ stroke: 'var(--fp-error)', strokeWidth: cable.width, strokeDasharray: cable.dash, strokeLinecap: cable.cap ?? 'butt' }} />
        <EdgeLabelRenderer>
          <span className="cable-chip--error cable-refused" style={{ ...fade, position: 'absolute', zIndex: ABOVE_NODES, transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            <i className="icon-triangle-alert" />
            {data.refused}
          </span>
        </EdgeLabelRenderer>
      </g>
    );
  }
  const doc = data?.cable;
  const remove = () => {
    if (store && doc) store.getState().apply([{ op: 'remove-cable', from: doc.from, to: doc.to }]);
  };
  const showDepth = !!(data?.param && doc && (hovered || selected || busy));
  return (
    <>
      <g onPointerEnter={() => hover(true)} onPointerLeave={() => hover(false)}>
        <BaseEdge
          path={path}
          interactionWidth={INTERACTION_WIDTH}
          style={{
            stroke: PORT_COLORS[type],
            strokeOpacity: selected || hovered ? 1 : 0.7,
            strokeWidth: cable.width,
            strokeDasharray: cable.dash,
            strokeLinecap: cable.cap ?? 'butt',
          }}
        />
        {cable.inner && <path d={path} fill="none" stroke="var(--fp-bg-0)" strokeWidth={cable.inner} pointerEvents="none" />}
      </g>
      {(showDepth || (selected && doc)) && (
        <EdgeLabelRenderer>
          {/* Above the nodes, so a cable that runs behind one can still be changed or removed. */}
          <span
            className="cable-controls nodrag nopan"
            data-testid="cable-controls"
            data-cable={doc ? cableId(doc) : undefined}
            style={{ zIndex: ABOVE_NODES, transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onPointerEnter={() => hover(true)}
            onPointerLeave={() => hover(false)}
          >
            {showDepth && <DepthChip cable={doc!} spec={data!.param!} onBusy={setBusy} />}
            {selected && doc && (
              <button type="button" className="cable-remove" aria-label="Remove cable" title="Remove cable" data-testid="cable-remove" onClick={remove}>
                <i className="icon-x" />
              </button>
            )}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** A param cable's depth (design system CableChip "depth"), in the param's units: drag, Shift for fine, double-click to type, right-click to reset to 1. */
function DepthChip({ cable, spec, onBusy }: { cable: PatchCable; spec: NumberParamSpec; onBusy: (busy: boolean) => void }) {
  const store = useContext(EditorStoreContext);
  const [typing, setTypingState] = useState(false);
  const chip = useRef<HTMLSpanElement>(null);
  const setTyping = (on: boolean) => {
    setTypingState(on);
    onBusy(on);
  };
  const depth = cable.depth ?? 1;
  const range = spec.max - spec.min;
  // A depth edit is the cable taken out and put back at the same index, so cable order (and fan-in order) holds.
  const edits = (value: number): PatchEdit[] => {
    const index = store?.getState().doc.cables.findIndex((c) => cableId(c) === cableId(cable)) ?? -1;
    if (index < 0) return [];
    const { depth: _, ...rest } = cable;
    return [{ op: 'remove-cable', from: cable.from, to: cable.to }, { op: 'add-cable', cable: value === 1 ? rest : { ...rest, depth: value }, index }];
  };
  const set = (value: number) => {
    if (store && value !== depth) store.getState().apply(edits(value));
  };
  const clamp = (value: number) => snapTo(value, -range, range, spec.step);

  const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0 || typing || !store) return;
    event.preventDefault();
    event.stopPropagation();
    onBusy(true);
    startDrag(store, event.nativeEvent, {
      from: depth,
      valueAt: (dx, fine) => clamp(depth + (dx / (fine ? DEPTH_DRAG * FINE : DEPTH_DRAG)) * range),
      edits,
      onEnd: () => onBusy(false),
    });
  };
  const text = `${depth >= 0 ? '+' : ''}${formatParam(spec, depth)}`;
  const pct = range > 0 ? Math.min(1, Math.abs(depth) / range) * 100 : 0;
  return (
    <span
      ref={chip}
      className="cable-chip cable-chip--depth"
      data-testid="depth-chip"
      data-depth={depth}
      role="slider"
      aria-label={`Depth into ${spec.label ?? spec.name}`}
      aria-valuemin={-range}
      aria-valuemax={range}
      aria-valuenow={depth}
      aria-valuetext={text}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key === 'Enter') return setTyping(true);
        const next = keyedValue(event.key, event.shiftKey, depth, -range, range, spec.step);
        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        set(next);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        setTyping(true);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        set(1);
      }}
    >
      <span className="cable-chip__bar" style={{ background: `linear-gradient(90deg, var(--fp-signal) ${pct}%, var(--fp-line-2) ${pct}%)` }} />
      {typing ? (
        <TypedNumber
          className="cable-chip__input"
          label="Depth"
          initial={depth}
          onCommit={(typed) => set(clamp(typed))}
          onDone={(byKey) => {
            setTyping(false);
            // The chip stays drawn while typing, so it can take focus back from the input it held.
            if (byKey) chip.current?.focus();
          }}
        />
      ) : (
        text
      )}
    </span>
  );
}

/** The cable being dragged, styled by the port it started from. */
export function connectionLineStyle(type: PortType | undefined) {
  if (!type) return undefined;
  const cable = CABLE_STYLES[type];
  return { stroke: PORT_COLORS[type], strokeWidth: cable.width, strokeDasharray: cable.dash, strokeLinecap: cable.cap ?? 'butt' } as const;
}
