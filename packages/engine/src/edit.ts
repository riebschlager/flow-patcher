// Edits to a patch document, for scripted edits in headless runs and tests
// (hot patching, design.md). The runtime itself never sees these: it takes the
// whole new plan (`Runtime.swap`) and works out what changed by node id. They
// are a convenience for building the next document, not a wire format.
import type { ParamValue } from './definition';
import type { Patch, PatchCable, PatchNode, PortRef } from './patch';

export type PatchEdit =
  | { op: 'set-param'; node: string; param: string; value: ParamValue }
  | { op: 'add-node'; node: PatchNode }
  /** Removes the node and every cable into or out of it. */
  | { op: 'remove-node'; node: string }
  | { op: 'add-cable'; cable: PatchCable }
  /** Removes the first cable with these ends. */
  | { op: 'remove-cable'; from: PortRef; to: PortRef };

export const PATCH_EDIT_OPS = ['set-param', 'add-node', 'remove-node', 'add-cable', 'remove-cable'] as const;

const sameRef = (a: PortRef, b: PortRef) => a.node === b.node && a.port === b.port;

/**
 * The patch after `edits`, applied in order. Returns a new document and leaves
 * `patch` alone. Throws a RangeError when an edit names a node or cable that
 * isn't there, or adds a node id that is; port and type checks are the
 * compiler's job.
 */
export function applyPatchEdits(patch: Patch, edits: readonly PatchEdit[]): Patch {
  let nodes: PatchNode[] = patch.nodes.map((n) => ({ ...n, params: { ...n.params }, position: { ...n.position } }));
  let cables: PatchCable[] = patch.cables.map((c) => ({ ...c, from: { ...c.from }, to: { ...c.to } }));
  for (const [i, edit] of edits.entries()) {
    const where = `edit ${i} (${edit.op})`;
    switch (edit.op) {
      case 'set-param': {
        const node = nodes.find((n) => n.id === edit.node);
        if (!node) throw new RangeError(`${where}: no node "${edit.node}"`);
        node.params[edit.param] = edit.value;
        break;
      }
      case 'add-node':
        if (nodes.some((n) => n.id === edit.node.id)) throw new RangeError(`${where}: node "${edit.node.id}" already exists`);
        nodes.push({ ...edit.node, params: { ...edit.node.params }, position: { ...edit.node.position } });
        break;
      case 'remove-node':
        if (!nodes.some((n) => n.id === edit.node)) throw new RangeError(`${where}: no node "${edit.node}"`);
        nodes = nodes.filter((n) => n.id !== edit.node);
        cables = cables.filter((c) => c.from.node !== edit.node && c.to.node !== edit.node);
        break;
      case 'add-cable':
        cables.push({ ...edit.cable, from: { ...edit.cable.from }, to: { ...edit.cable.to } });
        break;
      case 'remove-cable': {
        const at = cables.findIndex((c) => sameRef(c.from, edit.from) && sameRef(c.to, edit.to));
        if (at < 0) throw new RangeError(`${where}: no cable ${edit.from.node}.${edit.from.port} → ${edit.to.node}.${edit.to.port}`);
        cables.splice(at, 1);
        break;
      }
      default:
        throw new RangeError(`${where}: unknown op`);
    }
  }
  return { ...patch, nodes, cables };
}
