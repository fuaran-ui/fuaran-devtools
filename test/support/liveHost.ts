// ============================================================================
//  test/support/liveHost — an in-page surface over a REAL mutable tree.
//
//  The other fake answers with fixed envelopes, which is right for pinning the
//  §8.3 mapping but cannot answer the questions the acceptance criteria ask:
//  did the edit round-trip, did the insert land where it was placed, and — the
//  one that matters most — is the tree genuinely UNCHANGED after a refusal.
//
//  So this host holds a tree and applies to it, through a miniature of the
//  pipeline a real host runs: gate, decode-ish, apply to a CANDIDATE, validate,
//  and fold only if the candidate survived. A `Batch` is all-or-nothing for the
//  same reason the contract requires it — a partly-applied batch would leave a
//  tree no op describes.
//
//  It is deliberately NOT a general apply engine. It implements the ops this
//  panel emits, and refuses everything else as an unrecognised case, which is
//  what a decode failure looks like from the peer's side.
// ============================================================================

import type { HostSurface } from '../../src/relay/pagePeer.js';

export interface LiveNode {
  id: string;
  kind: Record<string, unknown>;
  children: LiveNode[];
  /** The node-level style block, when the node carries one. */
  style?: Record<string, unknown>;
}

export const node = (
  id: string,
  discriminator: string,
  props: Record<string, unknown> = {},
  children: LiveNode[] = [],
  style?: Record<string, unknown>,
): LiveNode => ({
  id,
  kind: { $type: discriminator, ...props },
  children,
  ...(style === undefined ? {} : { style }),
});

const clone = (tree: LiveNode): LiveNode => JSON.parse(JSON.stringify(tree)) as LiveNode;

const find = (tree: LiveNode, id: string): LiveNode | undefined => {
  if (tree.id === id) return tree;
  for (const child of tree.children) {
    const found = find(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
};

const parentOf = (tree: LiveNode, id: string): LiveNode | undefined => {
  for (const child of tree.children) {
    if (child.id === id) return tree;
    const found = parentOf(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
};

const ids = (tree: LiveNode): string[] => [tree.id, ...tree.children.flatMap(ids)];

/** The wire spelling of an op-path segment: the leading character lower-cased. */
const wireName = (path: string): string =>
  path.length === 0 ? path : path[0]!.toLowerCase() + path.slice(1);

const SEGMENT = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\[(\d+)\])?$/;

/**
 * Assign `value` at an op path inside a kind object, walking `Columns[0].Label`
 * the way a real apply engine does.
 *
 * Indexed segments are here because the panel derives them and the corpus's own
 * op family covers them — including the out-of-range case, which this refuses
 * rather than extending the array. A host that grew the collection to fit the
 * index would be inventing elements nobody authored, and would make the panel's
 * bounds check untestable by making it unnecessary for the wrong reason.
 */
const assignAtPath = (
  kind: Record<string, unknown>,
  path: string,
  value: unknown,
  discriminator: string,
): Failure | undefined => {
  const segments = path.split('.');
  let holder: Record<string, unknown> = kind;

  for (let i = 0; i < segments.length; i += 1) {
    const match = SEGMENT.exec(segments[i]!);
    if (match === null)
      return { code: 'FUARAN-APPLY-MALFORMED-PATH', message: `'${path}' is not a legal op path.` };
    const key = wireName(match[1]!);
    const index = match[2] === undefined ? undefined : Number(match[2]);
    const last = i === segments.length - 1;

    if (index === undefined) {
      if (last) {
        if (!(key in holder))
          return {
            code: 'FUARAN-APPLY-UNKNOWN-PATH',
            message: `'${path}' is not a field of ${discriminator}.`,
          };
        holder[key] = value;
        return undefined;
      }
      const next = holder[key];
      if (typeof next !== 'object' || next === null || Array.isArray(next))
        return {
          code: 'FUARAN-APPLY-UNKNOWN-PATH',
          message: `'${path}' is not a field of ${discriminator}.`,
        };
      holder = next as Record<string, unknown>;
      continue;
    }

    const collection = holder[key];
    if (!Array.isArray(collection))
      return {
        code: 'FUARAN-APPLY-UNKNOWN-PATH',
        message: `'${key}' is not a collection on ${discriminator}.`,
      };
    if (index >= collection.length)
      return {
        code: 'FUARAN-APPLY-INDEX-OUT-OF-RANGE',
        message: `'${path}' addresses element ${index} of ${collection.length}.`,
      };
    const element = collection[index];
    if (typeof element !== 'object' || element === null)
      return { code: 'FUARAN-APPLY-UNKNOWN-PATH', message: `'${path}' does not resolve.` };
    if (last) {
      collection[index] = value;
      return undefined;
    }
    holder = element as Record<string, unknown>;
  }
  return { code: 'FUARAN-APPLY-MALFORMED-PATH', message: `'${path}' is empty.` };
};

type Failure = { readonly code: string; readonly message: string };

/** Apply one op to `tree` IN PLACE, or report why it is not a legal edit. */
const applyTo = (tree: LiveNode, op: Record<string, unknown>): Failure | undefined => {
  switch (op['$type']) {
    case 'Batch': {
      const ops = op['ops'];
      if (!Array.isArray(ops)) return { code: 'BATCH-SHAPE', message: 'Batch needs an ops array.' };
      for (const inner of ops) {
        const failure = applyTo(tree, inner as Record<string, unknown>);
        if (failure !== undefined) return failure;
      }
      return undefined;
    }
    case 'UpdateProp': {
      const target = find(tree, String(op['target']));
      if (target === undefined)
        return { code: 'NODE-MISSING', message: `No node '${String(op['target'])}'.` };
      return assignAtPath(
        target.kind,
        String(op['path']),
        op['value'],
        String(target.kind['$type']),
      );
    }
    case 'UpdateStyle': {
      const target = find(tree, String(op['target']));
      if (target === undefined)
        return { code: 'NODE-MISSING', message: `No node '${String(op['target'])}'.` };
      const style = op['style'];
      if (typeof style !== 'object' || style === null || Array.isArray(style))
        return { code: 'STYLE-SHAPE', message: 'UpdateStyle needs a style object.' };
      // REPLACES the block, exactly as the op grammar says. The host does not
      // merge, and must not: if it did, the whole reason a panel has to read the
      // block before editing it would disappear, and the falsifier that proves
      // the merge happens would pass against a panel that had never read
      // anything.
      target.style = { ...(style as Record<string, unknown>) };
      return undefined;
    }
    case 'InsertChild': {
      const parent = find(tree, String(op['parentId']));
      if (parent === undefined)
        return { code: 'NODE-MISSING', message: `No node '${String(op['parentId'])}'.` };
      const child = op['child'] as LiveNode | undefined;
      if (child === undefined || typeof child.id !== 'string')
        return { code: 'CHILD-SHAPE', message: 'InsertChild needs a child node.' };
      if (ids(tree).includes(child.id))
        return { code: 'FUARAN-APPLY-DUPLICATE-ID', message: `Duplicate node id '${child.id}'.` };
      parent.children.push({ id: child.id, kind: child.kind, children: child.children ?? [] });
      return undefined;
    }
    case 'RemoveNode': {
      const target = String(op['target']);
      if (target === tree.id)
        return { code: 'FUARAN-APPLY-ROOT-REMOVAL', message: 'The root cannot be removed.' };
      const parent = parentOf(tree, target);
      if (parent === undefined) return { code: 'NODE-MISSING', message: `No node '${target}'.` };
      parent.children = parent.children.filter((child) => child.id !== target);
      return undefined;
    }
    case 'MoveNode': {
      const target = String(op['target']);
      const moved = find(tree, target);
      const parent = parentOf(tree, target);
      const destination = find(tree, String(op['newParentId']));
      if (moved === undefined || parent === undefined || destination === undefined)
        return { code: 'NODE-MISSING', message: 'Move endpoints must both exist.' };
      if (find(moved, destination.id) !== undefined)
        return { code: 'FUARAN-APPLY-CYCLE', message: 'A node cannot move inside itself.' };
      parent.children = parent.children.filter((child) => child.id !== target);
      destination.children.push(moved);
      return undefined;
    }
    case 'ReorderChildren': {
      const parent = find(tree, String(op['parentId']));
      if (parent === undefined)
        return { code: 'NODE-MISSING', message: `No node '${String(op['parentId'])}'.` };
      const wanted = (op['newOrder'] as string[] | undefined) ?? [];
      const present = parent.children.map((child) => child.id);
      // The order must name EVERY sibling: a partial order states something
      // untrue about the siblings it leaves out.
      if (wanted.length !== present.length || !wanted.every((id) => present.includes(id)))
        return {
          code: 'FUARAN-APPLY-PARTIAL-ORDER',
          message: 'A reorder must name every sibling exactly once.',
        };
      parent.children = wanted.map((id) => parent.children.find((child) => child.id === id)!);
      return undefined;
    }
    default:
      return { code: 'UNKNOWN_DU_CASE', message: `Unknown TreeOp case '${String(op['$type'])}'.` };
  }
};

const KNOWN_OPS = new Set([
  'Batch',
  'UpdateProp',
  'UpdateStyle',
  'InsertChild',
  'RemoveNode',
  'MoveNode',
  'ReorderChildren',
]);

export interface LiveHost {
  readonly surface: HostSurface;
  /** The tree as it is now — what a test asserts against. */
  current(): LiveNode;
  /** A change made by SOMETHING ELSE driving the page, as an AI would. */
  mutate(op: Record<string, unknown>): void;
  /** Refuse the next apply at the policy gate, whatever it is. */
  denyNext(): void;
  /** How many ops the policy gate has been asked about. */
  policyCalls(): number;
}

/**
 * A STANDING policy predicate, in addition to the one-shot `denyNext`.
 *
 * A real host's gate is a rule about the op, not a switch: it refuses a write
 * to a field the application never declared controllable, and refuses anything
 * addressing a reserved module outright. `denyNext` cannot express either,
 * because it refuses whatever arrives next regardless of what it is — which is
 * exactly the wrong shape for asserting that an agent's op and a person's op
 * are judged by the same rule.
 *
 * Returning a string denies with it as the reason; `undefined` permits.
 */
export type LivePolicy = (op: Record<string, unknown>) => string | undefined;

export const liveHost = (
  initial: LiveNode,
  options: { canApply?: boolean; policy?: LivePolicy } = {},
): LiveHost => {
  let tree = initial;
  let revision = 0;
  let deny = false;
  let policyCalls = 0;
  const listeners = new Set<(change: unknown) => void>();

  const commit = (next: LiveNode, cause: 'apply' | 'host'): void => {
    tree = next;
    revision += 1;
    const change = { treeRevision: `r-${revision}`, cause };
    for (const listener of listeners) listener(change);
  };

  /**
   * The node's WIRE form: the kind OBJECT with its values, children nested
   * inside it, and the style block at the node level.
   *
   * Deliberately a different projection from `project` below, because the two
   * are different documents about the same node — the structural snapshot
   * reports a kind DISCRIMINATOR and no values at all. A fake that served one
   * from the other would build in the equivalence the peer must not assume.
   */
  const wireJson = (live: LiveNode): Record<string, unknown> => ({
    id: live.id,
    kind: {
      ...live.kind,
      ...(live.children.length === 0 ? {} : { children: live.children.map(wireJson) }),
    },
    ...(live.style === undefined ? {} : { style: live.style }),
  });

  const project = (live: LiveNode): Record<string, unknown> => ({
    id: live.id,
    // The relay reports the kind DISCRIMINATOR, not the kind object.
    kind: String(live.kind['$type']),
    bindings: [],
    childIds: live.children.map((child) => child.id),
    children: live.children.map(project),
  });

  const surface: HostSurface = {
    version: '0.1.0',
    canApply: options.canApply ?? true,
    treeRevision: () => `r-${revision}`,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    inspectTree: () => project(tree),
    // §7.7 — the node's own canonical wire JSON, whole subtree. Deep-cloned so
    // a caller holding the payload cannot reach into the live tree through it;
    // a real host encodes into a fresh document for the same reason.
    getNodeJson: (id) => {
      const found = find(tree, id);
      return found === undefined
        ? { error: `Node '${id}' not found in tree.` }
        : (JSON.parse(JSON.stringify(wireJson(found))) as unknown);
    },
    getNodeState: (id) => {
      const found = find(tree, id);
      return found === undefined
        ? { error: `Node '${id}' not found in tree.` }
        : {
            id: found.id,
            kind: String(found.kind['$type']),
            bindings: [],
            childIds: found.children.map((child) => child.id),
          };
    },
    getRenderedDom: (id) => ({ error: `No rendered element for node '${id}'.` }),
    findNodes: (kind) => ids(tree).filter((id) => find(tree, id)?.kind['$type'] === kind),
    apply: (op) => {
      const json = op as Record<string, unknown>;
      // The gate runs BEFORE anything is parsed: a default-deny posture should
      // not spend effort on what it will refuse anyway.
      if (deny) {
        deny = false;
        return { ok: false, status: 'denied', denied: true, error: 'Denied by the policy gate.' };
      }
      policyCalls += 1;
      // The standing rule sees the OP and nothing else. It is handed no
      // attribution, no actor and no class — which is not a simplification of a
      // real gate but a statement of the contract: §8.2.1 rule 2 forbids the
      // decision from varying on who proposed the op, so a gate that COULD see
      // the class would be modelling a host that is entitled to be wrong.
      const denial = options.policy?.(json);
      if (denial !== undefined) return { ok: false, status: 'denied', denied: true, error: denial };
      if (!KNOWN_OPS.has(String(json['$type'])))
        return {
          ok: false,
          status: 'decodeFailed',
          error: `Unknown TreeOp case '${String(json['$type'])}'.`,
          decodeError: { Code: 'UNKNOWN_DU_CASE', Path: '$.$type', Message: 'Unknown case.' },
        };

      // Applied to a CANDIDATE. A refused op — including a Batch whose second
      // leg fails — must leave the live tree exactly as it was (§8.3).
      const candidate = clone(tree);
      const failure = applyTo(candidate, json);
      if (failure !== undefined)
        return { ok: false, status: 'rejected', error: failure.message, code: failure.code };

      commit(candidate, 'apply');
      return { ok: true, status: 'applied', treeRevision: `r-${revision}` };
    },
  };

  return {
    surface,
    current: () => tree,
    mutate: (op) => {
      const candidate = clone(tree);
      const failure = applyTo(candidate, op);
      if (failure !== undefined)
        throw new Error(`the test's own mutation failed: ${failure.message}`);
      commit(candidate, 'host');
    },
    policyCalls: () => policyCalls,
    denyNext: () => {
      deny = true;
    },
  };
};
