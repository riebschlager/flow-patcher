import { useContext } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import { CABLE_STYLES, PORT_COLORS } from './ports';
import type { PortType } from './registry';
import { PatchActions } from './SpikeNode';

export type CableData = { portType: PortType };

/** A cable styled by the type it carries. When selected it shows a × at its midpoint, so it can be deleted without a keyboard. */
export function CableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }: EdgeProps<Edge<CableData>>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const { removeCable } = useContext(PatchActions);
  const type = data?.portType ?? 'audio';
  const cable = CABLE_STYLES[type];
  return (
    <>
      <BaseEdge path={path} interactionWidth={24} style={{ stroke: PORT_COLORS[type], strokeOpacity: selected ? 1 : 0.7, strokeWidth: cable.width, strokeDasharray: cable.dash, strokeLinecap: cable.cap ?? 'butt' }} />
      {cable.inner && <path d={path} fill="none" style={{ stroke: 'var(--fp-surface-canvas)', strokeWidth: cable.inner, pointerEvents: 'none' }} />}
      {selected && (
        <EdgeLabelRenderer>
          <button
            className="cable-delete nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={() => removeCable(id)}
            aria-label="Delete cable"
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
