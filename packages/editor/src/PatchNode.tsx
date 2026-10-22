import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { portsOf, type PortSpec } from '@flow-patcher/engine';
import type { PatchNodeData } from './patch-graph';
import type { LivePatch, NodeStatus } from './live';
import { nodeIcon, PORT_SIZE } from './ports';

/** The running patch, for the inline statuses node cards show. */
export const LivePatchContext = createContext<LivePatch | null>(null);

/** A node's inline status from the running patch, kept current. Compared by content, so an unchanged status doesn't re-render. */
function useNodeStatus(id: string): NodeStatus | null {
  const live = useContext(LivePatchContext);
  const subscribe = useCallback((listener: () => void) => live?.subscribe(listener) ?? (() => {}), [live]);
  const json = useSyncExternalStore(subscribe, () => JSON.stringify(live?.nodeStatus(id) ?? null));
  return JSON.parse(json) as NodeStatus | null;
}

function StatusBanner({ id, status }: { id: string; status: NodeStatus }) {
  const live = useContext(LivePatchContext);
  if (status.kind === 'loading') {
    return (
      <div className="patch-node__loading" data-testid="node-status" data-status="loading" role="status">
        <i className="icon-loader-circle patch-node__spinner" />
        {status.message}
      </div>
    );
  }
  return (
    <div className="patch-node__error" data-testid="node-status" data-status="error" role="alert">
      {status.message}
      {status.action && <button type="button" className="patch-node__action nodrag" onClick={() => live?.retry(id)}>{status.action}</button>}
    </div>
  );
}

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

export function PatchNode({ id, data, selected }: NodeProps<Node<PatchNodeData>>) {
  const { definition } = data;
  const status = useNodeStatus(id);
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
  const icon = nodeIcon(definition);
  return (
    <div className={`patch-node${selected ? ' patch-node--selected' : ''}${status?.kind === 'error' ? ' patch-node--error' : ''}`} data-testid="patch-node" data-node-type={definition.type}>
      <div className="patch-node__header">
        <i className={`icon-${status?.kind === 'error' ? 'circle-alert' : icon} patch-node__icon`} />
        <span className="patch-node__title">{definition.label}</span>
      </div>
      <div className="patch-node__ports">
        {Array.from({ length: rows }, (_, i) => (
          <div className="patch-node__row" key={i}>
            <span>{inputs[i]?.label ?? inputs[i]?.name}</span>
            <span>{outputs[i]?.label ?? outputs[i]?.name}</span>
          </div>
        ))}
        {/* Below the port rows, so the handles' fixed offsets (portTop) still line up. */}
        {status && <StatusBanner id={id} status={status} />}
      </div>
      {inputs.map((port, i) => <PortHandle key={port.name} port={port} index={i} />)}
      {outputs.map((port, i) => <PortHandle key={port.name} port={port} index={i} />)}
    </div>
  );
}
