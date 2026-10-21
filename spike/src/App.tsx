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
import { ensureRunning, getCtx } from './audio';
import { CableEdge, type CableData } from './CableEdge';
import { canConnect, portOf, registry, type CanvasInput } from './registry';
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
  const [counters, setCounters] = useState({ ...stats });
  const nextId = useRef(1);
  const { screenToFlowPosition, getNode } = useReactFlow<SpikeNode, Edge<CableData>>();

  useEffect(() => {
    const id = setInterval(() => setCounters({ ...stats }), 250);
    return () => clearInterval(id);
  }, []);

  // Toolbar adds go into the visible graph pane, stepped across and down so they don't stack.
  const stagger = () => {
    const pane = document.querySelector('.spike__graph')!.getBoundingClientRect();
    const cols = Math.max(1, Math.floor((pane.width - 40) / 240));
    const k = nextId.current - 1;
    return { x: pane.left + 30 + (k % cols) * 240, y: pane.top + 30 + (Math.floor(k / cols) % 3) * 200 + (k % 2) * 40 };
  };

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

  return (
    <PatchActions.Provider value={actions}>
      <div className="spike" onPointerDownCapture={onPointerDownCapture} onContextMenu={(e) => e.preventDefault()}>
        <header className="spike__bar">
          <span className="spike__name">Flow Patcher spike</span>
          <button className="spike__add" onClick={(e) => setMenu(menu ? null : { x: e.clientX, y: e.clientY + 24, place: stagger() })}>+ Add node</button>
          <span className="spike__hint">
            {nodes.length === 0 ? 'Try Pointer → Chord Tone → Sampled Voice → Output, then play the canvas.' : 'Play the canvas on the right.'}
          </span>
          <span className="spike__stats" data-testid="stats">
            windows {counters.windows} · skipped {counters.skipped} · late {counters.late}
          </span>
          <button className="spike__add" onClick={() => stall(500)} title="Block the main thread for 500 ms">Stall</button>
        </header>
        <div className="spike__body">
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
        </main>
        <PerformanceCanvas taps={counters.taps} />
        </div>
      </div>
    </PatchActions.Provider>
  );
}

/**
 * The performance canvas: what you play. Pointer events go to every Pointer node through the
 * immediate path. The Renderer will draw here later (issue #8).
 */
function PerformanceCanvas({ taps }: { taps: string[] }) {
  const send = (kind: CanvasInput['kind'], e: React.PointerEvent<HTMLCanvasElement>) => {
    if (kind === 'move' && e.buttons === 0) return; // hovering isn't playing
    const ctx = getCtx();
    const cold = ctx.state !== 'running';
    if (cold) void ensureRunning();
    const rect = e.currentTarget.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    live.canvas({
      kind,
      pointerId: e.pointerId,
      x: clamp((e.clientX - rect.left) / rect.width),
      y: clamp((e.clientY - rect.top) / rect.height),
      pressure: e.pressure,
      pointerType: e.pointerType,
      // currentTime, minus how long the event took to reach this handler.
      inputAt: ctx.currentTime - (performance.now() - e.timeStamp) / 1000,
      cold,
    });
  };
  return (
    <section className="spike__perform">
      <canvas
        className="spike__canvas"
        data-testid="performance-canvas"
        onPointerDown={(e) => {
          if (e.button !== 0) return; // right-click and pen barrel buttons don't play
          e.currentTarget.setPointerCapture(e.pointerId);
          send('down', e);
        }}
        onPointerMove={(e) => send('move', e)}
        onPointerUp={(e) => send('up', e)}
        onPointerCancel={(e) => send('cancel', e)}
        // A lost capture without an up would otherwise hold the Pointer's one channel forever.
        onLostPointerCapture={(e) => send('cancel', e)}
      />
      <div className="spike__placeholder">Play here</div>
      <div className="spike__log">{taps.map((line, i) => <div key={i}>{line}</div>)}</div>
    </section>
  );
}

export function App() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}
