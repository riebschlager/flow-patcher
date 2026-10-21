import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { portsOf } from '@flow-patcher/engine';
import type { PatchNodeData } from './patch-graph';
import { PORT_COLORS } from './ports';

export function PatchNode({ data }: NodeProps<Node<PatchNodeData>>) {
  const { definition } = data;
  if (!definition) {
    return <div className="patch-node patch-node--unknown" data-testid="patch-node">Unknown: {data.type}</div>;
  }
  const inputs = portsOf(definition, 'in'), outputs = portsOf(definition, 'out');
  const rows = Math.max(inputs.length, outputs.length);
  return (
    <div className="patch-node" data-testid="patch-node" data-node-type={definition.type}>
      <div className="patch-node__title">{definition.label}</div>
      <div className="patch-node__ports">
        {Array.from({ length: rows }, (_, i) => (
          <div className="patch-node__row" key={i}>
            <span>{inputs[i]?.label ?? inputs[i]?.name}</span>
            <span>{outputs[i]?.label ?? outputs[i]?.name}</span>
          </div>
        ))}
      </div>
      {inputs.map((port, i) => (
        <Handle key={port.name} id={port.name} type="target" position={Position.Left} style={{ top: 44 + i * 22, background: PORT_COLORS[port.type] }} data-port-type={port.type} />
      ))}
      {outputs.map((port, i) => (
        <Handle key={port.name} id={port.name} type="source" position={Position.Right} style={{ top: 44 + i * 22, background: PORT_COLORS[port.type] }} data-port-type={port.type} />
      ))}
    </div>
  );
}
