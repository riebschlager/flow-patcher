import { useContext } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { PatchActions } from './SpikeNode';

/** An audio cable. When selected it shows a × at its midpoint, so it can be deleted without a keyboard. */
export function CableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const { removeCable } = useContext(PatchActions);
  return (
    <>
      <BaseEdge path={path} interactionWidth={24} style={{ stroke: 'var(--fp-audio)', strokeOpacity: selected ? 1 : 0.7, strokeWidth: 3, strokeLinecap: 'round' }} />
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
