// M2 gate check: the mode patches "use only catalog node types". A test runs
// `expectCatalogTypes` on a patch, and it fails on any node whose type isn't
// in packages/nodes (nodeRegistry), so a patch can't lean on a node type that
// only a test defines.
import type { Patch } from '@flow-patcher/engine';
import { nodeRegistry } from '@flow-patcher/nodes';

/** Each node whose type isn't in packages/nodes, as `"id" (type)`, in patch order. Subpatches aren't in v1. */
export function nonCatalogNodes(patch: Pick<Patch, 'nodes'>): string[] {
  return patch.nodes.filter((node) => !nodeRegistry.has(node.type)).map((node) => `"${node.id}" (${node.type})`);
}

/** Throws, naming every node whose type isn't in packages/nodes. */
export function expectCatalogTypes(patch: Pick<Patch, 'nodes'>, name = 'patch'): void {
  const unknown = nonCatalogNodes(patch);
  if (unknown.length) throw new Error(`${name} uses node types that aren't in packages/nodes: ${unknown.join(', ')}`);
}
