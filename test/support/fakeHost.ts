// ============================================================================
//  test/support/fakeHost — two in-page surfaces, one per host shape.
//
//  The point of these fakes is that they emit the HOST-LOCAL shapes, not the
//  canonical relay ones, so driving corpus requests through the page peer
//  exercises the §1.4 adaptation rather than a pass-through. Specifically:
//
//    bareHost   — the shape a host that shipped its in-page surface BEFORE the
//                 relay existed returns: a bare `{ kind: 'Resolved', … }`
//                 resolution with no binding identity, and a bare array from
//                 `findNodes`. Both are §1.4 divergences the peer must convert.
//    taggedHost — a host whose surface already speaks the canonical tagged
//                 resolution envelope. It is the only shape that can report the
//                 `noOverride` status, which is exactly why the peer refuses to
//                 synthesise it from the bare form.
//
//  The tree mirrors the corpus's `read-tree` fixture, so the recursive snapshot
//  assertion is against real declared structure rather than a shape invented
//  here.
// ============================================================================

import type { HostSurface } from '../../src/relay/pagePeer.js';

interface FakeNode {
  readonly id: string;
  readonly kind: string;
  readonly bindings: readonly { slot: string; expression: string; source: string }[];
  readonly childIds: readonly string[];
  readonly children: readonly FakeNode[];
}

export const FAKE_TREE: FakeNode = {
  id: 'root',
  kind: 'Box',
  bindings: [],
  childIds: ['metric-1', 'grid-1'],
  children: [
    {
      id: 'metric-1',
      kind: 'Metric',
      bindings: [{ slot: 'Value', expression: '$state.revenue', source: 'State' }],
      childIds: [],
      children: [],
    },
    {
      id: 'grid-1',
      kind: 'DataGrid',
      bindings: [{ slot: 'Source', expression: '$queries.channels', source: 'Query' }],
      childIds: [],
      children: [],
    },
  ],
};

const find = (node: FakeNode, id: string): FakeNode | undefined => {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = find(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
};

const nodeState = (id: string): unknown => {
  const node = find(FAKE_TREE, id);
  if (node === undefined) return { error: `Node '${id}' not found in tree.` };
  return { id: node.id, kind: node.kind, bindings: node.bindings, childIds: node.childIds };
};

/** Only `metric-1` is "rendered"; everything else reports the geometry miss. */
const geometry = (id: string): unknown =>
  id === 'metric-1'
    ? { x: 24, y: 180.5, width: 320, height: 96, overflowing: false, hidden: false }
    : { error: `No rendered element for node '${id}'.` };

/**
 * A stub lookup, deliberately not derived from the tree: `findNodes` is fully
 * delegated to the host, so what the peer is responsible for — and what this
 * exercises — is the bare-array → `{ nodeIds }` conversion (§1.4), not the
 * search itself.
 */
const FOUND: Record<string, readonly string[]> = { Metric: ['metric-1', 'metric-2'] };

export const bareHost: HostSurface = {
  version: '0.1.0',
  getNodeState: nodeState,
  inspectTree: () => FAKE_TREE,
  getRenderedDom: geometry,
  findNodes: (kind) => FOUND[kind] ?? [],
  getBindingValue: (nodeId, slot) => {
    const node = find(FAKE_TREE, nodeId);
    if (node === undefined) return { error: `Node '${nodeId}' not found in tree.` };
    const binding = node.bindings.find((entry) => entry.slot === slot);
    if (binding === undefined)
      return {
        error: `Slot '${slot}' is not a binding slot on node '${nodeId}' (kind=${node.kind}).`,
      };
    return { kind: 'Resolved', value: 42 };
  },
};

export const taggedHost: HostSurface = {
  ...bareHost,
  getBindingValue: (nodeId, slot) => {
    const node = find(FAKE_TREE, nodeId);
    if (node === undefined) return { error: `Node '${nodeId}' not found in tree.` };
    const binding = node.bindings.find((entry) => entry.slot === slot);
    if (binding !== undefined)
      return {
        status: 'resolved',
        value: 42,
        expression: binding.expression,
        source: binding.source,
      };
    // A slot declared on the kind but holding nothing — the one state only a
    // relay-shaped surface can distinguish from "not a slot at all".
    if (slot === 'Trend') return { status: 'noOverride', expression: '$none', source: 'Static' };
    return { error: `Slot '${slot}' is not a binding slot on node '${nodeId}'.` };
  },
};
