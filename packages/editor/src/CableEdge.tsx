import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { PortType } from '@flow-patcher/engine';
import { CABLE_STYLES, PORT_COLORS } from './ports';

/** React Flow z-index above every node, selected ones included. */
export const ABOVE_NODES = 2000;

export type CableEdgeData = {
  portType: PortType;
  /** A cable the editor refused, drawn in red with this reason until it fades. */
  refused?: string;
};

/** A cable styled by the type it carries: color, width and dash all come from the source port. */
export function CableEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<Edge<CableEdgeData>>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const type = data?.portType ?? 'signal';
  const cable = CABLE_STYLES[type];
  if (data?.refused) {
    return (
      <g className="cable-refused" data-testid="cable-refused">
        <BaseEdge path={path} style={{ stroke: 'var(--fp-error)', strokeWidth: cable.width, strokeDasharray: cable.dash, strokeLinecap: cable.cap ?? 'butt' }} />
        <EdgeLabelRenderer>
          <span className="cable-chip--error cable-refused" style={{ position: 'absolute', zIndex: ABOVE_NODES, transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            <i className="icon-triangle-alert" />
            {data.refused}
          </span>
        </EdgeLabelRenderer>
      </g>
    );
  }
  return (
    <>
      <BaseEdge
        path={path}
        style={{
          stroke: PORT_COLORS[type],
          strokeOpacity: selected ? 1 : 0.7,
          strokeWidth: cable.width,
          strokeDasharray: cable.dash,
          strokeLinecap: cable.cap ?? 'butt',
        }}
      />
      {cable.inner && <path d={path} fill="none" stroke="var(--fp-bg-0)" strokeWidth={cable.inner} pointerEvents="none" />}
    </>
  );
}

/** The cable being dragged, styled by the port it started from. */
export function connectionLineStyle(type: PortType | undefined) {
  if (!type) return undefined;
  const cable = CABLE_STYLES[type];
  return { stroke: PORT_COLORS[type], strokeWidth: cable.width, strokeDasharray: cable.dash, strokeLinecap: cable.cap ?? 'butt' } as const;
}
