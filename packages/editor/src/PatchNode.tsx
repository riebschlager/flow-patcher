import { useCallback, useContext, useSyncExternalStore } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { PatchNodeData } from './patch-graph';
import { LIMIT_WINDOW, NODE_EVENT_LIMIT, PATCH_EVENT_LIMIT, portsOf, VOICE_LIMIT, type PortSpec } from '@flow-patcher/engine';
import type { NodeStatus, NodeWarning } from './live';
import { nodeIcon, PORT_SIZE } from './ports';
import { LivePatchContext, ParamRow } from './ParamField';
import { useProbeHandle } from './Probe';

/** A node's inline status from the running patch, kept current. Compared by content, so an unchanged status doesn't re-render. */
function useNodeStatus(id: string): NodeStatus | null {
  const live = useContext(LivePatchContext);
  const subscribe = useCallback((listener: () => void) => live?.subscribe(listener) ?? (() => {}), [live]);
  const json = useSyncExternalStore(subscribe, () => JSON.stringify(live?.nodeStatus(id) ?? null));
  return JSON.parse(json) as NodeStatus | null;
}

/** A node's warnings from the running patch, kept current. */
function useNodeWarnings(id: string): NodeWarning[] {
  const live = useContext(LivePatchContext);
  const subscribe = useCallback((listener: () => void) => live?.subscribe(listener) ?? (() => {}), [live]);
  const json = useSyncExternalStore(subscribe, () => JSON.stringify(live?.warnings(id) ?? []));
  return JSON.parse(json) as NodeWarning[];
}

const WINDOW_MS = Math.round(LIMIT_WINDOW * 1000);

/** A warning in the card's words: what happened, and how often since it was raised. Unknown kinds keep the runtime's message. */
function warningText({ kind, count, message }: NodeWarning): string {
  switch (kind) {
    case 'node-event-limit':
      return `Over ${NODE_EVENT_LIMIT} events in ${WINDOW_MS} ms: ${count} dropped`;
    case 'patch-event-limit':
      return `Patch over ${PATCH_EVENT_LIMIT} events in ${WINDOW_MS} ms: ${count} of this node's dropped`;
    case 'voice-steal':
      return `Over ${VOICE_LIMIT} voices: ${count} stolen, oldest first`;
    default:
      return message;
  }
}

/** Warnings (design system Node banner, in the warn color): the runtime's, which dismiss, and the unwired inputs' hints, which go once wired. */
function WarningBanner({ id, warnings, hints }: { id: string; warnings: NodeWarning[]; hints: string[] }) {
  const live = useContext(LivePatchContext);
  return (
    <div className="patch-node__warning" data-testid="node-warning" role="status">
      <i className="icon-triangle-alert patch-node__warning-icon" />
      <ul className="patch-node__warning-list">
        {warnings.map((w) => <li key={w.kind} data-kind={w.kind}>{warningText(w)}</li>)}
        {hints.map((hint) => <li key={hint} data-kind="unwired">{hint}</li>)}
      </ul>
      {warnings.length > 0 && (
        <button type="button" className="patch-node__dismiss nodrag" aria-label="Dismiss warnings" title="Dismiss" data-testid="dismiss-warnings" onClick={() => live?.clearWarnings(id)}>
          <i className="icon-x" />
        </button>
      )}
    </div>
  );
}

/** Why the patch isn't running: this node is in a loop with no delay edge. */
const CYCLE_STATUS: NodeStatus = { kind: 'error', message: 'In a loop with no delay. Put a Delay Edge in the loop, or remove a cable.' };

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
  // A denied permission is an inline error (design.md, Inline errors): the same banner, with its own kind for tests.
  return (
    <div className="patch-node__error" data-testid="node-status" data-status={status.kind} role="alert">
      {status.message}
      {status.action && <button type="button" className="patch-node__action nodrag" onClick={() => live?.retry(id)}>{status.action}</button>}
    </div>
  );
}

/** Center of port row i, from the node's top edge: header 30 + divider 1 + body padding 6 + half a 22px row. */
export const portTop = (i: number) => 48 + i * 22;

function PortHandle({ node, title, port, index }: { node: string; title: string; port: PortSpec; index: number }) {
  const [width, height] = PORT_SIZE[port.type];
  const input = port.direction === 'in';
  const probe = useProbeHandle({ node, port: port.name, type: port.type, direction: port.direction, title: `${title} · ${port.label ?? port.name}` });
  return (
    <Handle
      {...probe}
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
  const runtimeStatus = useNodeStatus(id);
  const status = data.inCycle ? CYCLE_STATUS : runtimeStatus;
  const warnings = useNodeWarnings(id);
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
    <div className={`patch-node${selected ? ' patch-node--selected' : ''}${status && status.kind !== 'loading' ? ' patch-node--error' : ''}`} data-testid="patch-node" data-node-type={definition.type}>
      <div className="patch-node__header">
        <i className={`icon-${status?.kind === 'error' ? 'circle-alert' : status?.kind === 'blocked' ? 'lock' : icon} patch-node__icon`} />
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
        {(warnings.length > 0 || data.hints.length > 0) && <WarningBanner id={id} warnings={warnings} hints={data.hints} />}
      </div>
      {definition.params.length > 0 && (
        <div className="patch-node__params">
          {definition.params.map((spec) => (
            <ParamRow key={spec.name} node={id} spec={spec} value={data.params[spec.name]} modulated={data.modulated.includes(spec.name)} />
          ))}
        </div>
      )}
      {inputs.map((port, i) => <PortHandle key={port.name} node={id} title={definition.label} port={port} index={i} />)}
      {outputs.map((port, i) => <PortHandle key={port.name} node={id} title={definition.label} port={port} index={i} />)}
    </div>
  );
}
