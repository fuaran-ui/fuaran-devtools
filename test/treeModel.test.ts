import { describe, expect, it } from 'vitest';

import type { TreeSnapshot } from '../src/relay/protocol.js';
import {
  ancestorIds,
  breadcrumb,
  countNodes,
  findNode,
  flattenTree,
} from '../src/panel/treeModel.js';

const leaf = (id: string, kind: string, bindings = 0): TreeSnapshot => ({
  id,
  kind,
  bindings: Array.from({ length: bindings }, (_unused, index) => ({
    slot: `s${index}`,
    expression: '$static',
    source: 'Static',
  })),
  childIds: [],
  children: [],
});

const branch = (id: string, kind: string, children: TreeSnapshot[]): TreeSnapshot => ({
  id,
  kind,
  bindings: [],
  childIds: children.map((child) => child.id),
  children,
});

const TREE = branch('root', 'Box', [
  branch('panel', 'Card', [leaf('metric-1', 'Metric', 1), leaf('metric-2', 'Metric')]),
  leaf('grid-1', 'DataGrid', 2),
]);

describe('flatten', () => {
  it('walks depth-first with depth and binding counts', () => {
    const rows = flattenTree(TREE, new Set());
    expect(rows.map((row) => row.id)).toEqual(['root', 'panel', 'metric-1', 'metric-2', 'grid-1']);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 2, 1]);
    expect(rows.find((row) => row.id === 'grid-1')?.bindingCount).toBe(2);
    expect(rows.find((row) => row.id === 'panel')?.hasChildren).toBe(true);
  });

  it('emits a collapsed node but none of its descendants', () => {
    const rows = flattenTree(TREE, new Set(['panel']));
    expect(rows.map((row) => row.id)).toEqual(['root', 'panel', 'grid-1']);
    expect(rows.find((row) => row.id === 'panel')?.collapsed).toBe(true);
  });

  it('emits only the root when the root is collapsed', () => {
    expect(flattenTree(TREE, new Set(['root']))).toHaveLength(1);
  });
});

describe('lookup, breadcrumb, ancestry', () => {
  it('finds a node at any depth', () => {
    expect(findNode(TREE, 'metric-2')?.kind).toBe('Metric');
    expect(findNode(TREE, 'root')?.kind).toBe('Box');
    expect(findNode(TREE, 'nope')).toBeUndefined();
  });

  it('gives the root→node path', () => {
    expect(breadcrumb(TREE, 'metric-1').map((node) => node.id)).toEqual([
      'root',
      'panel',
      'metric-1',
    ]);
    expect(breadcrumb(TREE, 'root').map((node) => node.id)).toEqual(['root']);
  });

  it('gives an EMPTY path for an absent node, not a partial one', () => {
    // A partial path would let the breadcrumb claim an ancestry that does not
    // exist — worse than showing nothing.
    expect(breadcrumb(TREE, 'nope')).toEqual([]);
    expect(ancestorIds(TREE, 'nope')).toEqual([]);
  });

  it('lists exactly the ancestors to expand when revealing a node', () => {
    expect(ancestorIds(TREE, 'metric-1')).toEqual(['root', 'panel']);
    expect(ancestorIds(TREE, 'root')).toEqual([]);
  });

  it('counts every node once', () => {
    expect(countNodes(TREE)).toBe(5);
    expect(countNodes(leaf('solo', 'Text'))).toBe(1);
  });
});
