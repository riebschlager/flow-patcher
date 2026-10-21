import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { PortType } from '@flow-patcher/engine';
import { CABLE_STYLES, PORT_COLORS } from './ports';

export type CableEdgeData = { portType: PortType };

/** A cable styled by the type it carries: color, width and dash all come from the source port. */
export function CableEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<Edge<CableEdgeData>>) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const type = data?.portType ?? 'signal';
  const cable = CABLE_STYLES[type];
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
