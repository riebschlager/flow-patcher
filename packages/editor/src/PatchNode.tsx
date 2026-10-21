import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { portsOf, type PortSpec } from '@flow-patcher/engine';
import type { PatchNodeData } from './patch-graph';
import { FAMILY_ICONS, PORT_SIZE } from './ports';

/** Center of port row i, from the node's top edge: header 30 + divider 1 + body padding 6 + half a 22px row. */
const portTop = (i: number) => 48 + i * 22;

function PortHandle({ port, index }: { port: PortSpec; index: number }) {
  const [width, height] = PORT_SIZE[port.type];
  const input = port.direction === 'in';
  return (
    <Handle
      id={port.name}
      type={input ? 'target' : 'source'}
      position={input ? Position.Left : Position.Right}
      className="fp-handle"
      style={{ top: portTop(index), width, height }}
      data-port-type={port.type}
    >
      <span className={`fp-port fp-port--${port.type}`} />
    </Handle>
  );
}

export function PatchNode({ data, selected }: NodeProps<Node<PatchNodeData>>) {
  const { definition } = data;
  if (!definition) {
    return (
      <div className="patch-node patch-node--unknown" data-testid="patch-node">
        <div className="patch-node__header">
          <i className="icon-circle-alert patch-node__icon" />
          <span className="patch-node__title">Unknown: {data.type}</span>
        </div>
      </div>
    );
  }
  const inputs = portsOf(definition, 'in'), outputs = portsOf(definition, 'out');
  const rows = Math.max(inputs.length, outputs.length);
  const icon = definition.type === 'output' ? 'speaker' : FAMILY_ICONS[definition.category];
  return (
    <div className={`patch-node${selected ? ' patch-node--selected' : ''}`} data-testid="patch-node" data-node-type={definition.type}>
      <div className="patch-node__header">
        <i className={`icon-${icon} patch-node__icon`} />
        <span className="patch-node__title">{definition.label}</span>
      </div>
      <div className="patch-node__ports">
        {Array.from({ length: rows }, (_, i) => (
          <div className="patch-node__row" key={i}>
            <span>{inputs[i]?.label ?? inputs[i]?.name}</span>
            <span>{outputs[i]?.label ?? outputs[i]?.name}</span>
          </div>
        ))}
      </div>
      {inputs.map((port, i) => <PortHandle key={port.name} port={port} index={i} />)}
      {outputs.map((port, i) => <PortHandle key={port.name} port={port} index={i} />)}
    </div>
  );
}
