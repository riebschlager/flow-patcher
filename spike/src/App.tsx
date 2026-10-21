import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge,
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type IsValidConnection,
} from '@xyflow/react';
import { ensureRunning, playTestNote } from './audio';
import { CableEdge, type CableData } from './CableEdge';
import { canConnect, portOf, registry } from './registry';
import { live, scheduler } from './runtime';
import { PatchActions, SpikeNodeView, type SpikeNode } from './SpikeNode';
import { stats } from './stats';

const nodeTypes = { spike: SpikeNodeView };
const edgeTypes = { cable: CableEdge };

/** Busy-waits the main thread, to check that the scheduler skips the windows it missed. */
function stall(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* spin */ }
}

/** Where the add menu opens; `place` is where its node lands (the click point for right-click). */
type Menu = { x: number; y: number; place?: { x: number; y: number } } | null;

function Editor() {
  const [nodes, setNodes, onNodesChange] = useNodesState<SpikeNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<CableData>>([]);
  const [menu, setMenu] = useState<Menu>(null);
  const [log, setLog] = useState<string[]>([]);
  const [counters, setCounters] = useState({ ...stats });
  const nextId = useRef(1);
  const { screenToFlowPosition, getNode } = useReactFlow<SpikeNode, Edge<CableData>>();

  useEffect(() => {
    const id = setInterval(() => setCounters({ ...stats }), 250);
    return () => clearInterval(id);
  }, []);

  // Toolbar adds go to the canvas, stepped so they don't stack on each other.
  const stagger = () => ({ x: 160 + (nextId.current % 4) * 280, y: 120 + (nextId.current % 3) * 60 });

  // Audio is created here, in a click handler: a user gesture, and outside render, so StrictMode can't double it.
  const addNode = (type: string, at: { x: number; y: number }) => {
    const def = registry.find((t) => t.type === type)!;
    const id = `${type}-${nextId.current++}`;
    const values = Object.fromEntries(def.knobs.map((k) => [k.name, k.default]));
    void ensureRunning();
    live.addNode(id, type, values);
    scheduler.start();
    setNodes((ns) => [...ns, { id, type: 'spike', position: screenToFlowPosition(at), data: { type, values } }]);
    setMenu(null);
  };

  const portsOf = useCallback((c: Connection | Edge) => {
    const from = getNode(c.source), to = getNode(c.target);
    return {
      from: from && portOf(from.data.type, 'out', c.sourceHandle),
      to: to && portOf(to.data.type, 'in', c.targetHandle),
    };
  }, [getNode]);

  // Same-type cables only (Note may feed Event), and no event loops: the spike has no delay edge.
  const isValidConnection: IsValidConnection<Edge<CableData>> = useCallback((c) => {
    const { from, to } = portsOf(c);
    if (!from || !to || c.source === c.target || !canConnect(from.type, to.type)) return false;
    return (from.type !== 'event' && from.type !== 'note') || !live.wouldCycle(c.source, c.target);
  }, [portsOf]);

  const onConnect = useCallback((c: Connection) => {
    const portType = portsOf(c).from?.type;
    if (!portType) return;
    const id = `${c.source}.${c.sourceHandle}->${c.target}.${c.targetHandle}`;
    live.connect({ id, ...c }, portType); // no-op if this cable already exists
    setEdges((es) => (es.some((e) => e.id === id) ? es : addEdge({ ...c, id, type: 'cable', data: { portType } }, es)));
  }, [portsOf, setEdges]);

  // Keyboard deletes and node deletes both land here; LivePatch ignores ids it no longer has.
  const onDelete = useCallback(({ nodes: ns, edges: es }: { nodes: SpikeNode[]; edges: Edge[] }) => {
    for (const e of es) live.disconnect(e.id);
    for (const n of ns) live.removeNode(n.id);
  }, []);

  const actions = useMemo(() => ({
    setKnob(nodeId: string, knob: string, value: number) {
      live.set(nodeId, knob, value);
      setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, values: { ...n.data.values, [knob]: value } } } : n)));
    },
    removeCable(id: string) {
      live.disconnect(id);
      setEdges((es) => es.filter((e) => e.id !== id));
    },
  }), [setNodes, setEdges]);

  // Capture phase: any touch resumes audio, and a touch outside the menu closes it.
  const onPointerDownCapture = (e: React.PointerEvent) => {
    void ensureRunning();
    if (!(e.target as Element).closest('.spike__menu, .spike__add')) setMenu(null);
  };

  // The latency test lives on its own pad so pans and pinches on the canvas don't blip or pollute the log.
  const onTapPad = (e: React.PointerEvent) => {
    if (!e.isPrimary || e.button !== 0) return;
    void playTestNote(e).then((line) => setLog((l) => [line, ...l].slice(0, 8)));
  };

  return (
    <PatchActions.Provider value={actions}>
      <div className="spike" onPointerDownCapture={onPointerDownCapture} onContextMenu={(e) => e.preventDefault()}>
        <header className="spike__bar">
          <span className="spike__name">Flow Patcher spike</span>
          <button className="spike__add" onClick={(e) => setMenu(menu ? null : { x: e.clientX, y: e.clientY + 24, place: stagger() })}>+ Add node</button>
          <span className="spike__hint">
            {nodes.length === 0 ? 'Try Clock → Blip → Output, or Tone → Output.' : 'Tap the pad for the latency test note.'}
          </span>
          <span className="spike__stats" data-testid="stats">
            windows {counters.windows} · skipped {counters.skipped} · late {counters.late}
          </span>
          <button className="spike__add" onClick={() => stall(500)}>Stall 500 ms</button>
        </header>
        <main className="spike__graph">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onDelete={onDelete}
            onPaneContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            deleteKeyCode={['Backspace', 'Delete']}
            colorMode="dark"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          </ReactFlow>
          {menu && (
            <div className="spike__menu" style={{ left: menu.x, top: menu.y }}>
              {registry.map((t) => (
                <button key={t.type} onClick={() => addNode(t.type, menu.place ?? menu)}>{t.label}</button>
              ))}
            </div>
          )}
          <div className="spike__tap">
            <div className="spike__log">{log.map((line, i) => <div key={i}>{line}</div>)}</div>
            <div className="spike__pad" onPointerDown={onTapPad} data-testid="tap-pad">Tap</div>
          </div>
        </main>
      </div>
    </PatchActions.Provider>
  );
}

export function App() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}
