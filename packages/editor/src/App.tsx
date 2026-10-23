import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type OnConnectStartParams,
} from '@xyflow/react';
import { useStore } from 'zustand';
import { applyPatchEdits, compilePatch, defaultParams, parsePatch, serializePatch, type NodeDefinition, type Patch, type PatchEdit } from '@flow-patcher/engine';
import { nodeDefinitions, nodeRegistry } from '@flow-patcher/nodes';
import { ABOVE_NODES, cableFor, cableId, handlePort, loadErrors, matchingPort, nextNodeId, patchToGraph, type CableEnd } from './patch-graph';
import { PatchNode } from './PatchNode';
import { EditorStoreContext, LivePatchContext } from './ParamField';
import { CableEdge, REFUSED_MS, connectionLineStyle, type CableEdgeData } from './CableEdge';
import { LivePatch } from './live';
import { PreviewPane } from './PreviewPane';
import { NodePalette, type PaletteItem } from './NodePalette';
import { createEditorStore, emptyPatch, type HistoryEntry } from './store';

const nodeTypes = { patch: PatchNode };
const edgeTypes = { cable: CableEdge };

const examples = import.meta.glob<string>('../../../examples/*.flowpatch', { query: '?raw', import: 'default', eager: true });

declare global {
  interface Window {
    /** The running patch, for e2e and the console. */
    flowPatcher?: LivePatch;
  }
}

/** Snap grid, as the canvas draws it (design system: 20px). */
const GRID = 20;


/** `?patch=<name>` opens examples/<name>.flowpatch, `?patch=new` an empty patch; clock-blips by default. Read once per page load. */
function initialPatch(): { doc: Patch; error: string | null } {
  const name = new URLSearchParams(location.search).get('patch') ?? 'clock-blips';
  if (name === 'new') return { doc: emptyPatch(), error: null };
  const source = examples[`../../../examples/${name}.flowpatch`];
  if (source === undefined) return { doc: emptyPatch(), error: `No example named "${name}"` };
  const parsed = parsePatch(JSON.parse(source));
  return parsed.ok ? { doc: parsed.patch, error: null } : { doc: emptyPatch(), error: parsed.errors.join('; ') };
}

interface Status {
  text: string;
  error: boolean;
}

// One store and one running patch per page: edits and opened files swap into it, so sound never stops.
const initial = initialPatch();
const store = createEditorStore(initial.doc);
const live = new LivePatch();
window.flowPatcher = live;
import.meta.hot?.dispose(() => live.dispose());

let status: Status = initial.error ? { text: initial.error, error: true } : sync(initial.doc);
const statusListeners = new Set<() => void>();
function setStatus(next: Status) {
  status = next;
  for (const listener of statusListeners) listener();
}
/** Sends the document to the running patch. An edit that doesn't compile leaves the last plan playing. */
function sync(doc: Patch): Status {
  const result = live.update(doc);
  return result.ok ? { text: `${doc.nodes.length} nodes compiled`, error: false } : { text: result.errors.join('; '), error: true };
}
store.subscribe((state, prev) => {
  if (state.doc !== prev.doc) setStatus(sync(state.doc));
});

/** The palette, open: where it shows, where a picked node goes, and the cable it would take. */
interface PaletteState {
  at: { x: number; y: number };
  position: { x: number; y: number };
  end: CableEnd | null;
}

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
const snap = (v: number) => Math.round(v / GRID) * GRID;

function Editor() {
  const doc = useStore(store, (s) => s.doc);
  const selection = useStore(store, (s) => s.selection);
  const canUndo = useStore(store, (s) => s.past.length > 0);
  const canRedo = useStore(store, (s) => s.future.length > 0);
  const [statusNow, setStatusNow] = useState(status);
  useEffect(() => {
    const listener = () => setStatusNow(status);
    statusListeners.add(listener);
    return () => void statusListeners.delete(listener);
  }, []);

  const flow = useReactFlow();
  const area = useRef<HTMLElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [sizes, setSizes] = useState<ReadonlyMap<string, { width: number; height: number }>>(new Map());
  const [palette, setPalette] = useState<PaletteState | null>(null);
  const [dragging, setDragging] = useState<CableEnd | null>(null);
  const [refused, setRefused] = useState<Edge<CableEdgeData> | null>(null);
  /** Where each dragged node started, for the drag's single undo step. */
  const dragStart = useRef(new Map<string, { x: number; y: number }>());

  const graph = useMemo(() => patchToGraph(doc, nodeRegistry, selection), [doc, selection]);
  // React Flow keeps measured sizes on the nodes it's given; the document doesn't hold them.
  const nodes = useMemo(() => graph.nodes.map((node) => ({ ...node, measured: sizes.get(node.id) })), [graph, sizes]);
  // A removed node's size goes with it, so a node that reuses its id is measured afresh.
  useEffect(() => store.subscribe(({ doc }) => {
    const ids = new Set(doc.nodes.map((n) => n.id));
    setSizes((prev) => ([...prev.keys()].every((id) => ids.has(id)) ? prev : new Map([...prev].filter(([id]) => ids.has(id)))));
  }), []);
  const edges = useMemo(() => (refused ? [...graph.edges, refused] : graph.edges), [graph, refused]);

  const onNodesChange = useCallback((changes: NodeChange<Node>[]) => {
    const { doc, selection } = store.getState();
    const moves: PatchEdit[] = [], nudges: PatchEdit[] = [];
    let selected: Set<string> | null = null;
    const measured: [string, { width: number; height: number }][] = [];
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        const move: PatchEdit = { op: 'move-node', node: change.id, position: change.position };
        // A mouse drag follows the pointer and becomes one undo step when it stops; an arrow-key nudge is one on its own.
        if (change.dragging || dragStart.current.size) {
          const node = doc.nodes.find((n) => n.id === change.id);
          if (node && !dragStart.current.has(change.id)) dragStart.current.set(change.id, node.position);
          moves.push(move);
        } else nudges.push(move);
      } else if (change.type === 'select') {
        selected ??= new Set(selection);
        if (change.selected) selected.add(change.id);
        else selected.delete(change.id);
      } else if (change.type === 'dimensions' && change.dimensions) {
        measured.push([change.id, change.dimensions]);
      }
      // Removals arrive through onDelete, nodes and cables together, as one undo step.
    }
    if (moves.length) store.getState().preview(moves);
    if (nudges.length) store.getState().apply(nudges);
    if (selected) store.getState().select(selected);
    if (measured.length) setSizes((prev) => new Map([...prev, ...measured]));
  }, []);

  const onNodeDragStop = useCallback(() => {
    const { doc, record } = store.getState();
    const edits: PatchEdit[] = [], inverse: PatchEdit[] = [];
    for (const [id, from] of dragStart.current) {
      const node = doc.nodes.find((n) => n.id === id);
      if (!node || (node.position.x === from.x && node.position.y === from.y)) continue;
      edits.push({ op: 'move-node', node: id, position: node.position });
      inverse.push({ op: 'move-node', node: id, position: from });
    }
    dragStart.current.clear();
    if (edits.length) record({ edits, inverse } satisfies HistoryEntry);
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    const { selection, select } = store.getState();
    const selected = new Set(selection);
    for (const change of changes) {
      if (change.type !== 'select') continue;
      if (change.selected) selected.add(change.id);
      else selected.delete(change.id);
    }
    select(selected);
  }, []);

  const onDelete = useCallback(({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
    const { doc, apply } = store.getState();
    const removed = new Set(nodes.map((n) => n.id));
    const ids = new Set(edges.map((e) => e.id));
    // Cables into or out of a removed node go with it.
    const cables: PatchEdit[] = doc.cables
      .filter((c) => ids.has(cableId(c)) && !removed.has(c.from.node) && !removed.has(c.to.node))
      .map((c) => ({ op: 'remove-cable', from: c.from, to: c.to }));
    apply([...cables, ...[...removed].map((node): PatchEdit => ({ op: 'remove-node', node }))]);
  }, []);

  const isValidConnection = useCallback((connection: Connection | Edge) => cableFor(store.getState().doc, nodeRegistry, connection) !== null, []);

  const onConnect = useCallback((connection: Connection) => {
    const { doc, apply } = store.getState();
    const cable = cableFor(doc, nodeRegistry, connection);
    if (!cable) return;
    const edit: PatchEdit = { op: 'add-cable', cable };
    const compiled = compilePatch(applyPatchEdits(doc, [edit]), nodeRegistry);
    if (!compiled.ok && compiled.cycles?.length) {
      const port = handlePort(doc, nodeRegistry, cable.from.node, cable.from.port, 'out');
      setRefused({
        id: `refused:${cableId(cable)}`,
        type: 'cable',
        source: cable.from.node,
        sourceHandle: cable.from.port,
        target: cable.to.node,
        targetHandle: cable.to.port,
        selectable: false,
        // A cable closing a loop runs back across the nodes: draw it, and its reason, above them.
        zIndex: ABOVE_NODES,
        data: { portType: port?.type ?? 'signal', refused: 'Needs a Delay Edge' },
      });
      return;
    }
    apply([edit]);
  }, []);

  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(() => setRefused(null), REFUSED_MS);
    return () => clearTimeout(timer);
  }, [refused]);

  const openPalette = useCallback((client: { x: number; y: number }, end: CableEnd | null) => {
    const box = area.current?.getBoundingClientRect();
    if (!box) return;
    setPalette({ at: { x: client.x - box.left, y: client.y - box.top }, position: flow.screenToFlowPosition(client), end });
  }, [flow]);

  const onConnectStart = useCallback((_: unknown, { nodeId, handleId, handleType }: OnConnectStartParams) => {
    const port = nodeId ? handlePort(store.getState().doc, nodeRegistry, nodeId, handleId, handleType === 'source' ? 'out' : 'in') : undefined;
    setDragging(nodeId && port ? { node: nodeId, port } : null);
  }, []);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const end = dragging;
    setDragging(null);
    if (!end || state.toHandle) return;
    const touch = 'changedTouches' in event ? event.changedTouches[0] : undefined;
    const at = touch ? { x: touch.clientX, y: touch.clientY } : { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY };
    // Dropped on empty canvas: offer the nodes that could take the cable. A touch's target is where it started, so look up where it ended.
    if (document.elementFromPoint(at.x, at.y)?.classList.contains('react-flow__pane')) openPalette(at, end);
  }, [dragging, openPalette]);

  const items = useMemo((): PaletteItem[] => {
    const types = new Set(doc.nodes.map((n) => n.type));
    const end = palette?.end;
    return nodeDefinitions
      .filter((definition) => !end || matchingPort(definition, end))
      .map((definition) => (definition.unique && types.has(definition.type) ? { definition, disabled: `One per patch: there's a ${definition.label} already` } : { definition }));
  }, [doc, palette?.end]);

  const insert = useCallback((definition: NodeDefinition) => {
    if (!palette) return;
    const { doc, apply } = store.getState();
    const id = nextNodeId(doc, definition.type);
    const edits: PatchEdit[] = [{
      op: 'add-node',
      node: { id, type: definition.type, typeVersion: definition.version, params: defaultParams(definition), position: { x: snap(palette.position.x), y: snap(palette.position.y) } },
    }];
    const port = palette.end && matchingPort(definition, palette.end);
    if (palette.end && port) {
      const out = palette.end.port.direction === 'out';
      const ends = out ? { source: palette.end.node, sourceHandle: palette.end.port.name, target: id, targetHandle: port.name } : { source: id, sourceHandle: port.name, target: palette.end.node, targetHandle: palette.end.port.name };
      const cable = cableFor(applyPatchEdits(doc, edits), nodeRegistry, ends);
      if (cable) edits.push({ op: 'add-cable', cable });
    }
    apply(edits);
    setPalette(null);
  }, [palette]);

  const onDoubleClick = useCallback((event: ReactMouseEvent) => {
    if (event.target instanceof Element && event.target.classList.contains('react-flow__pane')) openPalette({ x: event.clientX, y: event.clientY }, null);
  }, [openPalette]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'z') store.getState()[event.shiftKey ? 'redo' : 'undo']();
      else if (mod && event.key.toLowerCase() === 'y') store.getState().redo();
      else if (event.key === 'Tab' && !mod && !event.altKey) {
        // Tab still moves focus through the toolbar and the preview; it opens the palette from the graph.
        if (document.activeElement !== document.body && !area.current?.contains(document.activeElement)) return;
        const box = area.current?.getBoundingClientRect();
        if (!box) return;
        openPalette(pointer.current ?? { x: box.left + box.width / 3, y: box.top + box.height / 3 }, null);
      } else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette]);

  const file = useRef<HTMLInputElement>(null);
  const save = () => {
    let text: string;
    try {
      text = serializePatch(store.getState().doc);
    } catch (error) {
      setStatus({ text: `Couldn't save: ${(error as Error).message}`, error: true });
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: 'patch.flowpatch' });
    link.click();
    // Some browsers read the URL after click() returns.
    setTimeout(() => URL.revokeObjectURL(url));
  };
  const open = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    let parsed: ReturnType<typeof parsePatch>;
    try {
      parsed = parsePatch(JSON.parse(await picked.text()));
    } catch {
      parsed = { ok: false, errors: ['not a JSON file'] };
    }
    // A file that wouldn't run is refused whole, so the canvas never shows one patch while another plays.
    if (parsed.ok) {
      const errors = loadErrors(parsed.patch, nodeRegistry);
      if (errors.length) parsed = { ok: false, errors };
    }
    if (parsed.ok) {
      store.getState().load(parsed.patch);
      // Once React Flow has the new nodes.
      requestAnimationFrame(() => void flow.fitView());
    }
    else setStatus({ text: `Couldn't open ${picked.name}: ${parsed.errors.join('; ')}`, error: true });
  };

  return (
    <div className="app">
      <header className="app__bar">
        <span className="app__name">Flow Patcher</span>
        <span className={`app__status${statusNow.error ? ' app__status--error' : ''}`} data-testid="compile-status">{statusNow.text}</span>
        <span className="app__actions">
          <button type="button" className="icon-button" title="Undo" aria-label="Undo" disabled={!canUndo} onClick={() => store.getState().undo()}><i className="icon-undo-2" /></button>
          <button type="button" className="icon-button" title="Redo" aria-label="Redo" disabled={!canRedo} onClick={() => store.getState().redo()}><i className="icon-redo-2" /></button>
          <span className="app__divider" />
          <button type="button" className="button" onClick={() => file.current?.click()}><i className="icon-folder-open" />Open</button>
          <button type="button" className="button" onClick={save}><i className="icon-download" />Save</button>
          <input ref={file} type="file" accept=".flowpatch,application/json" hidden data-testid="open-file" onChange={open} />
        </span>
      </header>
      <main className="app__graph" ref={area} onDoubleClick={onDoubleClick} onPointerMove={(event) => (pointer.current = { x: event.clientX, y: event.clientY })}>
        <EditorStoreContext.Provider value={store}>
        <LivePatchContext.Provider value={live}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            onDelete={onDelete}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            connectionLineStyle={connectionLineStyle(dragging?.port.type)}
            deleteKeyCode={['Backspace', 'Delete']}
            zoomOnDoubleClick={false}
            snapToGrid
            snapGrid={[GRID, GRID]}
            // An empty patch would wait for its first node and zoom right onto it.
            fitView={initial.doc.nodes.length > 0}
            colorMode="dark"
          >
            <Background variant={BackgroundVariant.Dots} gap={GRID} size={1} />
            <MiniMap pannable zoomable nodeBorderRadius={8} />
            <Controls />
          </ReactFlow>
        </LivePatchContext.Provider>
        </EditorStoreContext.Provider>
        {palette && <NodePalette items={items} accepts={palette.end?.port.type} at={palette.at} onPick={insert} onClose={() => setPalette(null)} />}
        <PreviewPane live={live} />
      </main>
    </div>
  );
}

export function App() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}
