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
import { canConnect, nodeType, portOf, registry, type CanvasInput } from './registry';
import { OUTPUT_CEILING } from './nodes/output';
import { IMMEDIATE_OFFSET } from './live-graph';
import { live, scheduler, startFrames } from './runtime';
import { setStage } from './stage';
import { PatchActions, SpikeNodeView, type SpikeNode } from './SpikeNode';
import { report, resetMeasurements, rewireEnd, rewireStart, stats } from './stats';

const nodeTypes = { spike: SpikeNodeView };
const edgeTypes = { cable: CableEdge };

/** Busy-waits the main thread, to check that the scheduler skips the windows it missed. */
function stall(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* spin */ }
}

/**
 * The full M0 patch, so every device measures the same graph. Positions are in flow coordinates.
 * The beat: Clock → Euclidean → Chord Tone (chords from Progression) → Sampled Voice → Output, with a coral Splat per hit.
 * The tap: Pointer → a second Chord Tone, an octave up, into the same voice, and Pointer → a lilac Splat that paints the drag.
 */
const DEMO = {
  nodes: [
    { id: 'pointer', type: 'pointer', at: [0, 0] },
    { id: 'clock', type: 'clock', at: [0, 300] },
    { id: 'progression', type: 'progression', at: [280, 300] },
    { id: 'euclidean', type: 'euclidean', at: [280, 600] },
    { id: 'tap-tone', type: 'chord-tone', at: [580, 0], values: { down: 0, up: 2 } },
    { id: 'beat-tone', type: 'chord-tone', at: [580, 330], values: { down: 1, up: 1 } },
    { id: 'voice', type: 'sampled-voice', at: [880, 160] },
    { id: 'output', type: 'output', at: [1160, 160] },
    { id: 'tap-splat', type: 'splat', at: [580, 660] },
    { id: 'beat-splat', type: 'splat', at: [880, 480], values: { color: 2 } },
    { id: 'fluid', type: 'fluid', at: [1160, 480] },
    { id: 'renderer', type: 'renderer', at: [1440, 480] },
  ],
  cables: [
    ['clock.tick', 'euclidean.tick'], ['clock.tick', 'progression.tick'],
    ['euclidean.hit', 'beat-tone.trigger'], ['progression.chord', 'beat-tone.chord'],
    ['pointer.down', 'tap-tone.trigger'], ['pointer.x', 'tap-tone.position'], ['progression.chord', 'tap-tone.chord'],
    ['beat-tone.note', 'voice.in'], ['tap-tone.note', 'voice.in'], ['voice.out', 'output.in'],
    ['pointer.down', 'tap-splat.at'], ['pointer.move', 'tap-splat.at'], ['euclidean.hit', 'beat-splat.at'],
    ['tap-splat.write', 'fluid.writers'], ['beat-splat.write', 'fluid.writers'], ['fluid.field', 'renderer.field'],
  ],
} as const;

/** Where the add menu opens; `place` is where its node lands (the click point for right-click). */
type Menu = { x: number; y: number; place?: { x: number; y: number } } | null;

function Editor() {
  const [nodes, setNodes, onNodesChange] = useNodesState<SpikeNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<CableData>>([]);
  const [menu, setMenu] = useState<Menu>(null);
  const [counters, setCounters] = useState({ ...stats });
  const [measured, setMeasured] = useState<string | null>(null);
  const nextId = useRef(1);
  const { screenToFlowPosition, getNode, getNodes, getEdges, fitView } = useReactFlow<SpikeNode, Edge<CableData>>();

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
  const createNode = (id: string, type: string, position: { x: number; y: number }, overrides: Record<string, number> = {}): SpikeNode => {
    const def = nodeType(type);
    const values = { ...Object.fromEntries(def.knobs.map((k) => [k.name, k.default])), ...overrides };
    const texts = Object.fromEntries((def.texts ?? []).map((t) => [t.name, t.default]));
    void ensureRunning();
    live.addNode(id, type, values, texts);
    scheduler.start();
    startFrames();
    return { id, type: 'spike', position, data: { type, values, texts }, deletable: !def.unique };
  };

  const addNode = (type: string, at: { x: number; y: number }) => {
    const node = createNode(`${type}-${nextId.current++}`, type, screenToFlowPosition(at));
    setNodes((ns) => [...ns, node]);
    setMenu(null);
  };

  // Replaces whatever is on the canvas, so every device starts from the same graph.
  const loadDemo = () => {
    for (const e of getEdges()) live.disconnect(e.id);
    for (const n of getNodes()) live.removeNode(n.id);
    const ns = DEMO.nodes.map((n) => createNode(n.id, n.type, { x: n.at[0], y: n.at[1] }, 'values' in n ? n.values : {}));
    const es = DEMO.cables.map(([from, to]): Edge<CableData> => {
      const [source, sourceHandle] = from.split('.'), [target, targetHandle] = to.split('.');
      const portType = portOf(ns.find((n) => n.id === source)!.data.type, 'out', sourceHandle)!.type;
      const id = `${source}.${sourceHandle}->${target}.${targetHandle}`;
      live.connect({ id, source, sourceHandle, target, targetHandle }, portType);
      return { id, source, sourceHandle, target, targetHandle, type: 'cable', data: { portType } };
    });
    setNodes(ns);
    setEdges(es);
    setMenu(null);
    requestAnimationFrame(() => void fitView({ padding: 0.05 }));
  };

  const showReport = () => {
    const text = report(getCtx(), IMMEDIATE_OFFSET * 1000);
    console.log(`[spike] report\n${text}`);
    setMeasured(text);
  };

  const portsOf = useCallback((c: Connection | Edge) => {
    const from = getNode(c.source), to = getNode(c.target);
    return {
      from: from && portOf(from.data.type, 'out', c.sourceHandle),
      to: to && portOf(to.data.type, 'in', c.targetHandle),
    };
  }, [getNode]);

  // Same-type cables only (Note may feed Event), and no event or value loops: the spike has no delay edge.
  // Field loops can't form with today's nodes (Fluid is unique, Renderer has no outputs, Splat no Field input); a later Field node needs the check.
  const isValidConnection: IsValidConnection<Edge<CableData>> = useCallback((c) => {
    const { from, to } = portsOf(c);
    if (!from || !to || c.source === c.target || !canConnect(from.type, to.type)) return false;
    return from.type === 'signal' || from.type === 'audio' || from.type === 'field' || !live.wouldCycle(c.source, c.target);
  }, [portsOf]);

  const onConnect = useCallback((c: Connection) => {
    const portType = portsOf(c).from?.type;
    if (!portType) return;
    const id = `${c.source}.${c.sourceHandle}->${c.target}.${c.targetHandle}`;
    const exists = getEdges().some((e) => e.id === id);
    live.connect({ id, ...c }, portType); // no-op if this cable already exists
    rewireEnd(!exists);
    setEdges((es) => (es.some((e) => e.id === id) ? es : addEdge({ ...c, id, type: 'cable', data: { portType } }, es)));
  }, [portsOf, setEdges, getEdges]);

  // Keyboard deletes and node deletes both land here; LivePatch ignores ids it no longer has.
  const onDelete = useCallback(({ nodes: ns, edges: es }: { nodes: SpikeNode[]; edges: Edge[] }) => {
    for (const e of es) live.disconnect(e.id);
    for (const n of ns) live.removeNode(n.id);
    if (es.length) rewireEnd(true);
  }, []);

  // Live side effects happen here, once; the setNodes updaters only merge, so calls between renders don't undo each other.
  const actions = useMemo(() => {
    const merge = (nodeId: string, values: Record<string, number>, texts: Record<string, string>) =>
      setNodes((ns) => ns.map((n) => (n.id === nodeId
        ? { ...n, data: { ...n.data, values: { ...n.data.values, ...values }, texts: { ...n.data.texts, ...texts } } }
        : n)));
    return {
      setKnob(nodeId: string, knob: string, value: number) {
        const node = getNode(nodeId);
        if (!node) return;
        live.set(nodeId, knob, value);
        // A preset menu writes its text param; option 0 (Custom) leaves the text as it is.
        const fills = nodeType(node.data.type).knobs.find((k) => k.name === knob)?.fills;
        if (!fills || value === 0) return merge(nodeId, { [knob]: value }, {});
        live.setText(nodeId, fills.text, fills.values[value]);
        merge(nodeId, { [knob]: value }, { [fills.text]: fills.values[value] });
      },
      setText(nodeId: string, name: string, text: string) {
        const node = getNode(nodeId);
        if (!node) return;
        const def = nodeType(node.data.type);
        if (!def.texts?.find((t) => t.name === name)?.check?.(text)) live.setText(nodeId, name, text);
        // Hand-edited text no longer matches a preset, so menus that fill it go back to Custom.
        const resets = def.knobs.filter((k) => k.fills?.text === name).map((k) => k.name);
        for (const k of resets) live.set(nodeId, k, 0);
        merge(nodeId, Object.fromEntries(resets.map((k) => [k, 0])), { [name]: text });
      },
      removeCable(id: string) {
        live.disconnect(id);
        rewireEnd(true);
        setEdges((es) => es.filter((e) => e.id !== id));
      },
    };
  }, [getNode, setNodes, setEdges]);

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
          <button className="spike__add" onClick={loadDemo} title="Replace the canvas with the full M0 patch">Demo</button>
          <span className="spike__hint">
            {nodes.length === 0 ? 'Try Clock → Euclidean → Chord Tone → Sampled Voice → Output, with Clock → Progression → Chord Tone’s Chord. Or Pointer → Chord Tone and play the canvas. For dye: Pointer → Splat → Fluid → Renderer.' : 'Play the canvas on the right.'}
          </span>
          <span className="spike__stats" data-testid="stats">
            windows {counters.windows} · skipped {counters.skipped} · late {counters.late} ·{' '}
            <span title={`Sample peak at the speakers, and the highest since load; the ceiling is ${OUTPUT_CEILING}`}>
              peak {counters.peak.toFixed(2)} / {counters.peakMax.toFixed(2)}
            </span>{' '}·{' '}
            <span title="Meter polls where the limiter's output went above the ceiling, so the peak guard clipped">
              guard {counters.guardHits}
            </span>
            {counters.fluidGrid && (
              <>
                {' '}·{' '}
                <span title={`Fluid step time per frame: running average and highest since load, on a ${counters.fluidGrid} grid`}>
                  fluid {counters.fluidMs.toFixed(1)} / {counters.fluidMaxMs.toFixed(1)} ms
                </span>
              </>
            )}
          </span>
          <button className="spike__add" onClick={() => stall(500)} title="Block the main thread for 500 ms">Stall</button>
          <button className="spike__add" onClick={showReport} title="The gate measurements so far, to paste into the spike notes">Report</button>
        </header>
        <div className="spike__body">
        <main className="spike__graph">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={rewireStart}
            onConnectEnd={() => rewireEnd(false)}
            isValidConnection={isValidConnection}
            onDelete={onDelete}
            onPaneContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            deleteKeyCode={['Backspace', 'Delete']}
            colorMode="dark"
            minZoom={0.2} // so the demo patch fits a phone's graph pane
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          </ReactFlow>
          {menu && (
            <div className="spike__menu" style={{ left: menu.x, top: menu.y }}>
              {registry.map((t) => {
                const taken = t.unique && nodes.some((n) => n.data.type === t.type);
                return (
                  <button key={t.type} disabled={taken} title={taken ? `A patch has one ${t.label}` : undefined} onClick={() => addNode(t.type, menu.place ?? menu)}>
                    {t.label}
                  </button>
                );
              })}
            </div>
          )}
        </main>
        <PerformanceCanvas taps={counters.taps} rendering={nodes.some((n) => n.data.type === 'renderer')} />
        </div>
        {measured !== null && (
          <div className="spike__report" role="dialog" aria-label="Gate measurements">
            {/* A textarea, because the LAN page isn't a secure context and has no clipboard API: select and copy by hand. */}
            <textarea readOnly value={measured} rows={10} onFocus={(e) => e.currentTarget.select()} data-testid="report" />
            <div className="spike__report-actions">
              <button className="spike__add" onClick={() => { resetMeasurements(); showReport(); }} title="Zero the counters, e.g. after warming up">Reset</button>
              <button className="spike__add" onClick={showReport}>Refresh</button>
              <button className="spike__add" onClick={() => setMeasured(null)}>Close</button>
            </div>
          </div>
        )}
      </div>
    </PatchActions.Provider>
  );
}

/**
 * The performance canvas: what you play. Pointer events go to every Pointer node through the
 * immediate path. The Renderer draws the fluid here.
 */
function PerformanceCanvas({ taps, rendering }: { taps: string[]; rendering: boolean }) {
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
        ref={setStage}
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
      {!rendering && <div className="spike__placeholder">Play here</div>}
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
