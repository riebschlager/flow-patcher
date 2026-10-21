import { createContext, useContext } from 'react';
import { Handle, Position, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { Knob, Menu, TextParam } from './Knob';
import { nodeType } from './registry';

export type SpikeNodeData = { type: string; values: Record<string, number>; texts: Record<string, string> };
export type SpikeNode = Node<SpikeNodeData, 'spike'>;

/** Patch actions that node and cable components call; App provides them. */
export const PatchActions = createContext<{
  setKnob(nodeId: string, knob: string, value: number): void;
  setText(nodeId: string, name: string, text: string): void;
  removeCable(id: string): void;
}>({ setKnob() {}, setText() {}, removeCable() {} });

/** Center of port row i from the node's top edge: header 30 + divider 1 + padding 4 + half a 22px row. */
const portTop = (i: number) => 46 + i * 22;

export function SpikeNodeView({ id, data, selected, deletable }: NodeProps<SpikeNode>) {
  const def = nodeType(data.type);
  const { setKnob, setText } = useContext(PatchActions);
  const { deleteElements } = useReactFlow();
  const rows = Math.max(def.inputs.length, def.outputs.length);
  const menus = def.knobs.filter((k) => k.options), dials = def.knobs.filter((k) => !k.options);
  return (
    <div className={`spike-node${selected ? ' spike-node--selected' : ''}`} data-node-type={def.type}>
      <div className="spike-node__header">
        {def.label}
        {/* Touch has no Delete key; this routes through the same onDelete as the keyboard. */}
        {selected && deletable !== false && (
          <button className="spike-node__delete nodrag" onClick={() => void deleteElements({ nodes: [{ id }] })} aria-label="Delete node">×</button>
        )}
      </div>
      <div className="spike-node__ports">
        {Array.from({ length: rows }, (_, i) => (
          <div className="spike-node__row" key={i}>
            <span>{def.inputs[i]?.label}</span>
            <span>{def.outputs[i]?.label}</span>
          </div>
        ))}
      </div>
      {menus.length + (def.texts?.length ?? 0) > 0 && (
        <div className="spike-node__menus">
          {menus.map((k) => (
            <Menu key={k.name} knob={k} value={data.values[k.name] ?? k.default} onChange={(v) => setKnob(id, k.name, v)} />
          ))}
          {def.texts?.map((t) => (
            <TextParam key={t.name} def={t} value={data.texts[t.name] ?? t.default} onChange={(v) => setText(id, t.name, v)} />
          ))}
        </div>
      )}
      {dials.length > 0 && (
        <div className="spike-node__knobs">
          {dials.map((k) => (
            <Knob key={k.name} knob={k} value={data.values[k.name] ?? k.default} onChange={(v) => setKnob(id, k.name, v)} />
          ))}
        </div>
      )}
      {def.inputs.map((p, i) => (
        <Handle key={p.name} id={p.name} type="target" position={Position.Left} className="spike-handle" style={{ top: portTop(i) }}>
          <span className={`spike-port spike-port--${p.type}`} />
        </Handle>
      ))}
      {def.outputs.map((p, i) => (
        <Handle key={p.name} id={p.name} type="source" position={Position.Right} className="spike-handle" style={{ top: portTop(i) }}>
          <span className={`spike-port spike-port--${p.type}`} />
        </Handle>
      ))}
    </div>
  );
}
