// ============================================================================
//  panel/treeModel — pure projections of a relay tree snapshot.
//
//  The panel renders the TYPED tree the relay reports, never the DOM tree. The
//  two are not the same shape — one typed node can project to several elements,
//  and a DOM walk cannot recover a node's kind, its binding slots, or its
//  identity. Reading the DOM would give a plausible-looking tree that is not
//  the one the app is actually running.
//
//  Everything here is pure, so the flatten / breadcrumb / lookup logic is
//  unit-testable with no DOM and no extension host.
// ============================================================================

import type { TreeSnapshot } from '../relay/protocol.js';

/** One renderable row of the tree view. */
export interface TreeRow {
  readonly id: string;
  readonly kind: string;
  readonly depth: number;
  readonly bindingCount: number;
  readonly hasChildren: boolean;
  readonly collapsed: boolean;
}

/**
 * Depth-first flatten honouring `collapsed`: a collapsed node emits its own row
 * and none of its descendants.
 */
export const flattenTree = (
  tree: TreeSnapshot,
  collapsed: ReadonlySet<string>,
): readonly TreeRow[] => {
  const rows: TreeRow[] = [];
  const walk = (node: TreeSnapshot, depth: number): void => {
    const isCollapsed = collapsed.has(node.id);
    rows.push({
      id: node.id,
      kind: node.kind,
      depth,
      bindingCount: node.bindings.length,
      hasChildren: node.children.length > 0,
      collapsed: isCollapsed,
    });
    if (!isCollapsed) for (const child of node.children) walk(child, depth + 1);
  };
  walk(tree, 0);
  return rows;
};

/** Find one node's snapshot by id (depth-first). */
export const findNode = (tree: TreeSnapshot, id: string): TreeSnapshot | undefined => {
  if (tree.id === id) return tree;
  for (const child of tree.children) {
    const found = findNode(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * The root→node path, as the breadcrumb renders it. Empty when the id is not in
 * the tree — an absent node has no path, and returning a partial one would let
 * the breadcrumb claim an ancestry that does not exist.
 */
export const breadcrumb = (tree: TreeSnapshot, id: string): readonly TreeSnapshot[] => {
  const path: TreeSnapshot[] = [];
  const walk = (node: TreeSnapshot): boolean => {
    path.push(node);
    if (node.id === id) return true;
    for (const child of node.children) if (walk(child)) return true;
    path.pop();
    return false;
  };
  return walk(tree) ? path : [];
};

/**
 * Every ancestor id of `id`, so revealing a node selected in the page can
 * expand exactly the collapsed rows on its path and nothing else.
 */
export const ancestorIds = (tree: TreeSnapshot, id: string): readonly string[] =>
  breadcrumb(tree, id)
    .slice(0, -1)
    .map((node) => node.id);

/** Total node count — the panel's one summary statistic. */
export const countNodes = (tree: TreeSnapshot): number =>
  1 + tree.children.reduce((total, child) => total + countNodes(child), 0);

/** The root→node id path, or `undefined` when the id is not in the tree. */
export const pathTo = (tree: TreeSnapshot, id: string): readonly string[] | undefined => {
  const path = breadcrumb(tree, id);
  return path.length === 0 ? undefined : path.map((node) => node.id);
};

/** Every id in the tree — what a minted id must not collide with. */
export const allNodeIds = (tree: TreeSnapshot): ReadonlySet<string> => {
  const ids = new Set<string>();
  const walk = (node: TreeSnapshot): void => {
    ids.add(node.id);
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return ids;
};

/** The node holding `id` as a child, or `undefined` for the root / a missing id. */
export const parentOf = (tree: TreeSnapshot, id: string): TreeSnapshot | undefined => {
  const path = breadcrumb(tree, id);
  return path.length < 2 ? undefined : path[path.length - 2];
};

/** A node's sibling ids in order — the list a `ReorderChildren` must name. */
export const siblingIds = (tree: TreeSnapshot, id: string): readonly string[] => {
  const parent = parentOf(tree, id);
  return parent === undefined ? [] : parent.children.map((child) => child.id);
};

/**
 * Re-resolve a stored selection against a tree that may have changed underneath
 * it — the panel's whole answer to "an AI is driving this page while I work".
 *
 * The rule: the DEEPEST id on the stored path that still exists anywhere in the
 * new tree wins; if nothing on the path survives, the root does. Total by
 * construction, so the selection always addresses a live node.
 *
 * Note what is NOT stored: no index, no ordinal, no captured snapshot. A
 * selection remembered as "the third child of the second box" is wrong the
 * moment anything is inserted above it, and wrong SILENTLY — it still resolves,
 * just to the wrong node, and the next edit lands there. A path of ids either
 * resolves to what was selected or is honestly gone.
 */
export const reresolve = (tree: TreeSnapshot, storedPath: readonly string[]): readonly string[] => {
  for (let index = storedPath.length - 1; index >= 0; index -= 1) {
    const id = storedPath[index];
    if (id === undefined) continue;
    const found = pathTo(tree, id);
    if (found !== undefined) return found;
  }
  return [tree.id];
};
