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
