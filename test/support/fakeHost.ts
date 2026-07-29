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

/**
 * A host that additionally wired an apply path and a change hub.
 *
 * Its `apply` returns the ENVELOPE SHAPE the real host tiers return — a status
 * token plus tier-specific extras — rather than anything relay-shaped, so
 * driving the corpus's apply fixtures through the peer exercises the §8.3
 * mapping (envelope status → refusal class) rather than a pass-through. The
 * per-op outcomes are chosen to match what the corpus's own apply fixtures
 * declare, so one fake covers the accepted case and all three refusal classes.
 */
const applyEnvelope = (op: unknown): unknown => {
  const json = op as Record<string, unknown>;
  const type = json['$type'];
  const target = json['target'];

  if (type === 'RemoveNode' && target === 'root')
    return {
      ok: false,
      status: 'rejected',
      error: 'The op decoded but the apply engine rejected it.',
      code: 'FUARAN-APPLY-ROOT-REMOVAL',
    };
  if (type === 'RemoveNode')
    return { ok: false, status: 'denied', denied: true, error: 'Denied by the policy gate.' };
  if (
    type !== 'UpdateProp' &&
    type !== 'InsertChild' &&
    type !== 'ReorderChildren' &&
    type !== 'MoveNode' &&
    type !== 'Batch'
  )
    return {
      ok: false,
      status: 'decodeFailed',
      error: `Unknown TreeOp case '${String(type)}'.`,
      decodeError: {
        Code: 'UNKNOWN_DU_CASE',
        Path: '$.$type',
        Message: `Unknown TreeOp case '${String(type)}'.`,
        ExpectedShape: 'UpdateProp | InsertChild | RemoveNode | MoveNode | ReorderChildren | Batch',
      },
    };
  return { ok: true, status: 'applied', treeRevision: 'r-42' };
};

/** Drives the change listeners a `subscribe` established, as a host would. */
export interface ChangeDriver {
  emit(treeRevision: string, cause: string): void;
  readonly listenerCount: () => number;
}

export const applyHostWith = (): { host: HostSurface; driver: ChangeDriver } => {
  const listeners = new Set<(change: unknown) => void>();
  const host: HostSurface = {
    ...bareHost,
    canApply: true,
    treeRevision: () => 'r-41',
    apply: applyEnvelope,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    host,
    driver: {
      emit: (treeRevision, cause) => {
        for (const listener of listeners) listener({ treeRevision, cause });
      },
      listenerCount: () => listeners.size,
    },
  };
};

export const applyHost: HostSurface = applyHostWith().host;

/**
 * A host that exposes `apply` but never wired one — the shape a read-only
 * build of an otherwise apply-capable tier presents. The capability must NOT
 * be advertised for it, which is the whole reason `canApply` is read as a
 * claim rather than inferred from the method's presence.
 */
export const unwiredApplyHost: HostSurface = {
  ...bareHost,
  canApply: false,
  apply: () => ({ ok: false, status: 'unwired', error: 'apply is not wired on this host.' }),
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
