// Edits to a patch document: scripted edits in headless runs and tests, and
// the editor's undo history (hot patching, design.md). The runtime itself never
// sees these: it takes the whole new plan (`Runtime.swap`) and works out what
// changed by node id. They are a convenience for building the next document,
// not a wire format.
//
// Every edit has an exact inverse (`invertPatchEdits`): undo gives back the
// document byte for byte under `serializePatch`, node and cable order included,
// since that order drives the plan's tie-breaks.
import type { ParamValue } from './definition';
import type { Patch, PatchCable, PatchNode, PortRef } from './patch';

export type PatchEdit =
  /** Sets a param's stored value, adding the key if it is absent. */
  | { op: 'set-param'; node: string; param: string; value: ParamValue }
  /** Removes a param's key, so the node falls back to the default. No-op when the key is absent. */
  | { op: 'unset-param'; node: string; param: string }
  /** Inserts the node at `index` in the node list (0 to its length), or appends it. */
  | { op: 'add-node'; node: PatchNode; index?: number }
  /** Removes the node and every cable into or out of it. */
  | { op: 'remove-node'; node: string }
  /** Moves a node on the canvas. */
  | { op: 'move-node'; node: string; position: { x: number; y: number } }
  /** Inserts the cable at `index` in the cable list (0 to its length), or appends it. */
  | { op: 'add-cable'; cable: PatchCable; index?: number }
  /** Removes the cable at `index`, which must have these ends; without `index`, the first cable with these ends. */
  | { op: 'remove-cable'; from: PortRef; to: PortRef; index?: number };

export const PATCH_EDIT_OPS = ['set-param', 'unset-param', 'add-node', 'remove-node', 'move-node', 'add-cable', 'remove-cable'] as const;

const sameRef = (a: PortRef, b: PortRef) => a.node === b.node && a.port === b.port;

const copyNode = (n: PatchNode): PatchNode => ({
  ...n,
  params: { ...n.params },
  position: { ...n.position },
  ...(n.pinned ? { pinned: [...n.pinned] } : {}),
});
const copyCable = (c: PatchCable): PatchCable => ({ ...c, from: { ...c.from }, to: { ...c.to } });

interface Doc {
  nodes: PatchNode[];
  cables: PatchCable[];
}

/** Where an insert at `index` goes in a list of `length`: the index itself, or the end. */
function insertAt(index: number | undefined, length: number, where: string): number {
  if (index === undefined) return length;
  if (!Number.isInteger(index) || index < 0 || index > length) throw new RangeError(`${where}: index ${index} is outside 0..${length}`);
  return index;
}

function nodeAt(doc: Doc, id: string, where: string): number {
  const at = doc.nodes.findIndex((n) => n.id === id);
  if (at < 0) throw new RangeError(`${where}: no node "${id}"`);
  return at;
}

function cableAt(doc: Doc, edit: Extract<PatchEdit, { op: 'remove-cable' }>, where: string): number {
  const name = `${edit.from.node}.${edit.from.port} → ${edit.to.node}.${edit.to.port}`;
  if (edit.index === undefined) {
    const at = doc.cables.findIndex((c) => sameRef(c.from, edit.from) && sameRef(c.to, edit.to));
    if (at < 0) throw new RangeError(`${where}: no cable ${name}`);
    return at;
  }
  const cable = Number.isInteger(edit.index) ? doc.cables[edit.index] : undefined;
  if (!cable || !sameRef(cable.from, edit.from) || !sameRef(cable.to, edit.to)) throw new RangeError(`${where}: no cable ${name} at index ${edit.index}`);
  return edit.index;
}

/** Indices of the cables into or out of a node, ascending. */
const cablesOf = (doc: Doc, id: string): number[] =>
  doc.cables.flatMap((c, i) => (c.from.node === id || c.to.node === id ? [i] : []));

/** Applies one edit to `doc` in place. */
function applyOne(doc: Doc, edit: PatchEdit, where: string): void {
  switch (edit.op) {
    case 'set-param':
      doc.nodes[nodeAt(doc, edit.node, where)]!.params[edit.param] = edit.value;
      break;
    case 'unset-param':
      delete doc.nodes[nodeAt(doc, edit.node, where)]!.params[edit.param];
      break;
    case 'add-node':
      if (doc.nodes.some((n) => n.id === edit.node.id)) throw new RangeError(`${where}: node "${edit.node.id}" already exists`);
      doc.nodes.splice(insertAt(edit.index, doc.nodes.length, where), 0, copyNode(edit.node));
      break;
    case 'remove-node':
      doc.nodes.splice(nodeAt(doc, edit.node, where), 1);
      doc.cables = doc.cables.filter((c) => c.from.node !== edit.node && c.to.node !== edit.node);
      break;
    case 'move-node':
      doc.nodes[nodeAt(doc, edit.node, where)]!.position = { ...edit.position };
      break;
    case 'add-cable':
      doc.cables.splice(insertAt(edit.index, doc.cables.length, where), 0, copyCable(edit.cable));
      break;
    case 'remove-cable':
      doc.cables.splice(cableAt(doc, edit, where), 1);
      break;
    default:
      throw new RangeError(`${where}: unknown op`);
  }
}

/** The edits that undo `edit`, computed against `doc` just before it applies. */
function inverseOf(doc: Doc, edit: PatchEdit, where: string): PatchEdit[] {
  /** Re-adds the cables at these indices of `doc`, ascending, so each lands at its old index. */
  const readd = (indices: number[]): PatchEdit[] => indices.map((i) => ({ op: 'add-cable', cable: copyCable(doc.cables[i]!), index: i }));
  switch (edit.op) {
    case 'set-param':
    case 'unset-param': {
      const params = doc.nodes[nodeAt(doc, edit.node, where)]!.params;
      if (Object.hasOwn(params, edit.param)) return [{ op: 'set-param', node: edit.node, param: edit.param, value: params[edit.param]! }];
      return edit.op === 'set-param' ? [{ op: 'unset-param', node: edit.node, param: edit.param }] : [];
    }
    case 'add-node':
      // Cables already naming the new id (dangling until now) go with it on removal: put them back.
      return [{ op: 'remove-node', node: edit.node.id }, ...readd(cablesOf(doc, edit.node.id))];
    case 'remove-node': {
      const at = nodeAt(doc, edit.node, where);
      return [{ op: 'add-node', node: copyNode(doc.nodes[at]!), index: at }, ...readd(cablesOf(doc, edit.node))];
    }
    case 'move-node':
      return [{ op: 'move-node', node: edit.node, position: { ...doc.nodes[nodeAt(doc, edit.node, where)]!.position } }];
    case 'add-cable': {
      const at = insertAt(edit.index, doc.cables.length, where);
      return [{ op: 'remove-cable', from: { ...edit.cable.from }, to: { ...edit.cable.to }, index: at }];
    }
    case 'remove-cable': {
      const at = cableAt(doc, edit, where);
      return [{ op: 'add-cable', cable: copyCable(doc.cables[at]!), index: at }];
    }
    default:
      throw new RangeError(`${where}: unknown op`);
  }
}

const docOf = (patch: Patch): Doc => ({ nodes: patch.nodes.map(copyNode), cables: patch.cables.map(copyCable) });

/**
 * The patch after `edits`, applied in order. Returns a new document and leaves
 * `patch` alone. Throws a RangeError when an edit names a node or cable that
 * isn't there, adds a node id that is, or gives an index outside the list;
 * port and type checks are the compiler's job.
 */
export function applyPatchEdits(patch: Patch, edits: readonly PatchEdit[]): Patch {
  const doc = docOf(patch);
  for (const [i, edit] of edits.entries()) applyOne(doc, edit, `edit ${i} (${edit.op})`);
  return { ...patch, nodes: doc.nodes, cables: doc.cables };
}

/**
 * The edits that turn `applyPatchEdits(patch, edits)` back into `patch`
 * exactly (byte-identical under `serializePatch`), for undo. Each edit's
 * inverse is worked out against the document just before it, and the
 * inverses come in reverse order. Throws where `applyPatchEdits` would.
 * Inverses use explicit indices, so they restore node and cable order.
 */
export function invertPatchEdits(patch: Patch, edits: readonly PatchEdit[]): PatchEdit[] {
  const doc = docOf(patch);
  const inverses: PatchEdit[][] = [];
  for (const [i, edit] of edits.entries()) {
    const where = `edit ${i} (${edit.op})`;
    inverses.push(inverseOf(doc, edit, where));
    applyOne(doc, edit, where);
  }
  return inverses.reverse().flat();
}
