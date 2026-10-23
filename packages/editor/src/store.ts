// The patch store: the document is the source of truth (AGENTS.md), and
// React Flow state and the running plan are derived from it. Every change is
// a list of PatchEdits, and history keeps each batch with its inverse, so
// undo and redo are document diffs too.
import { createStore } from 'zustand/vanilla';
import { applyPatchEdits, invertPatchEdits, PATCH_FORMAT, PATCH_VERSION, type Patch, type PatchEdit } from '@flow-patcher/engine';
import { cableId } from './patch-graph';

export interface HistoryEntry {
  edits: PatchEdit[];
  inverse: PatchEdit[];
}

/** Undo steps kept. */
const HISTORY_LIMIT = 200;

export interface EditorState {
  doc: Patch;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Selected node and cable ids. */
  selection: ReadonlySet<string>;
  /** A drag is previewing edits it hasn't recorded yet. Undo and redo wait for it, since its step isn't in history. */
  dragging: boolean;
  /** Applies `edits` as one undo step. */
  apply(edits: PatchEdit[]): void;
  /** Applies `edits` without an undo step, such as a node following the pointer mid-drag. */
  preview(edits: PatchEdit[]): void;
  /** Records an undo step for edits already applied with `preview`. */
  record(entry: HistoryEntry): void;
  undo(): void;
  redo(): void;
  /** Replaces the document, such as an opened file, and clears history. */
  load(doc: Patch): void;
  select(selection: ReadonlySet<string>): void;
}

export const emptyPatch = (): Patch => ({
  format: PATCH_FORMAT,
  version: PATCH_VERSION,
  seed: Math.floor(Math.random() * 2 ** 31),
  nodes: [],
  cables: [],
});

const push = (stack: HistoryEntry[], entry: HistoryEntry) => [...stack, entry].slice(-HISTORY_LIMIT);

/** The selection less what the document no longer has, so a reused id doesn't come back selected. */
function prune(selection: ReadonlySet<string>, doc: Patch): ReadonlySet<string> {
  const ids = new Set([...doc.nodes.map((n) => n.id), ...doc.cables.map(cableId)]);
  return [...selection].every((id) => ids.has(id)) ? selection : new Set([...selection].filter((id) => ids.has(id)));
}

export function createEditorStore(doc: Patch) {
  return createStore<EditorState>()((set, get) => ({
    doc,
    past: [],
    future: [],
    selection: new Set(),
    dragging: false,
    apply(edits) {
      if (!edits.length) return;
      const { doc, past } = get();
      const inverse = invertPatchEdits(doc, edits);
      const next = applyPatchEdits(doc, edits);
      set({ doc: next, past: push(past, { edits, inverse }), future: [], selection: prune(get().selection, next) });
    },
    preview(edits) {
      if (edits.length) set({ doc: applyPatchEdits(get().doc, edits) });
    },
    record(entry) {
      set({ past: push(get().past, entry), future: [] });
    },
    undo() {
      const { doc, past, future, dragging } = get();
      if (dragging) return;
      const entry = past.at(-1);
      if (!entry) return;
      set({ doc: applyPatchEdits(doc, entry.inverse), past: past.slice(0, -1), future: [...future, entry], selection: new Set() });
    },
    redo() {
      const { doc, past, future, dragging } = get();
      if (dragging) return;
      const entry = future.at(-1);
      if (!entry) return;
      set({ doc: applyPatchEdits(doc, entry.edits), past: push(past, entry), future: future.slice(0, -1), selection: new Set() });
    },
    load(doc) {
      set({ doc, past: [], future: [], selection: new Set() });
    },
    select(selection) {
      set({ selection });
    },
  }));
}

export type EditorStore = ReturnType<typeof createEditorStore>;
