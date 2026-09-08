// ============================================================================
//  trail/inverse — undoing an op EXACTLY, against the trees the session captured.
//
//  ── Why undo does not work the way undo usually works ──────────────────────
//
//  The playground undoes by REPLAY: it holds the base tree, drops the cursor,
//  and re-applies the first k ops through the apply engine. That is closed under
//  vocabulary growth — an op case added tomorrow replays because it applies —
//  and it is the right design when you own the tree.
//
//  This extension does not own the tree and must not pretend to. The page's tree
//  is live, the host is its arbiter, and the panel contributes no apply engine
//  (that absence is a stated security property, not an omission). Replay would
//  need a way to put a whole tree back, and `ReplaceRoot` carries a node the
//  panel has no engine to have produced.
//
//  So undo here is a COMPENSATING OP, sent through the same gated apply path as
//  every other edit. The host applies it, validates it, and can refuse it. An
//  undo is an edit like any other, which is the only honest framing when the
//  extension cannot mutate anything itself.
//
//  ── What changed: the derivation now has the trees to be exact ─────────────
//
//  This derivation used to be a function of the recorded OPS alone, and the
//  three places that could not reach were stated plainly and refused. That was
//  right while the recording held no tree in wire form. It no longer does:
//  `read.nodeJson` on the root returns the whole tree as canonical wire JSON,
//  the recorder captures it at the session's first edit, and it captures a
//  subtree about to be removed before the removal lands (see `trail/capture`).
//
//  So the three partial arms are GONE rather than kept as fallbacks:
//
//    UpdateProp        inverts against the value the field actually held. The
//                      search is newest-first through this session's own ops —
//                      an earlier edit to the same node and path, or the value
//                      the node was INSERTED with — and falls through to the
//                      CAPTURED BASE TREE, which is what the field held before
//                      this session touched anything. Indexed and nested paths
//                      resolve through the same walk the editor reads by
//                      (`panel/nodeJson`'s `valueAtPath`), so there is one path
//                      grammar in this build and not two.
//    UpdateStyle       inverts against the BLOCK the node actually carried, by
//                      the same three-source search and through the same
//                      accessor the style editor reads by (`styleBlock`). The
//                      op replaces the whole block, so the whole prior block is
//                      the complete answer — there is no per-token arm to get
//                      partially right. See `priorStyle` for the one place this
//                      is deliberately more total than `UpdateProp`.
//    RemoveNode        inverts by re-inserting the CAPTURED SUBTREE at the
//                      position the snapshot recorded, composed through
//                      `edit/ops`' own `insertOp` so the placement leg is
//                      elided when a plain append already lands it right.
//    InsertChild       always — the panel minted the child, so its id is known.
//    MoveNode          always, when the node had a parent: the snapshot names
//                      the old parent and the old sibling order.
//    ReorderChildren   always — the snapshot names the old order.
//    Batch             only the two composites this panel emits (an insert or a
//                      move followed by a reorder of the same parent). Any other
//                      batch is refused rather than inverted leg-by-leg, because
//                      a leg's inverse depends on the tree state BEFORE that leg
//                      and only the state before the whole batch is recorded.
//                      Guessing there would produce an op that applies
//                      successfully and lands the tree somewhere nobody chose —
//                      the same failure the id-addressed placement rule exists
//                      to prevent.
//
//  ── What is still refused, and why that is not a leftover ──────────────────
//
//  A capture is a capability of the PAGE. It can be absent (no `read.nodeJson`),
//  refused, over this recording's size ceiling, or overtaken by another writer.
//  When it is, this derivation says so BY NAME rather than approximating: every
//  refusal carries a machine-readable class beside its prose, in the shape the
//  relay's own refusals use, so the panel can render what happened and not
//  merely that nothing did. An undo that is offered and then restores an
//  invented value is worse than no undo at all — it succeeds, the page changes,
//  and nothing says the value was invented.
// ============================================================================

import type { TreeSnapshot } from '../relay/protocol.js';
import {
  batch,
  insertOp,
  moveNode,
  removeNode,
  reorderChildren,
  updateProp,
  updateStyle,
  type Placement,
  type TreeOpJson,
} from '../edit/ops.js';
import { findNode, parentOf, siblingIds } from '../panel/treeModel.js';
import { styleBlock, valueAtPath } from '../panel/nodeJson.js';
import { findWireNode, NOT_ATTEMPTED, type Capture } from './capture.js';

/**
 * Why an op has no inverse, as a closed set.
 *
 * A class rather than prose alone, for the reason DEVTOOLS_RELAY §8.4 gives for
 * its own refusal classes: each implies a different next action, and collapsing
 * them into one line sends the reader to fix something that was never the
 * problem. `NO_PRIOR_VALUE` after a page refused the read is a page to
 * configure; `COMPOSITE_UNSUPPORTED` is this build's own limit; `EXTERNAL_CHANGE`
 * is somebody else's edit and no local action changes it.
 */
export type InverseRefusalClass =
  /**
   * Nothing in the recording or the captured base knows what the field — or
   * the style block — held. One class rather than two: the next action is the
   * same either way (the page must serve `read.nodeJson`, or the base capture
   * must not have been overtaken), and §8.4's rule for separating classes is
   * that they imply DIFFERENT next actions.
   */
  | 'NO_PRIOR_VALUE'
  /** The removed subtree was not captured, so there is nothing to put back. */
  | 'NO_CAPTURED_SUBTREE'
  /** The node had no parent in the recorded snapshot. */
  | 'NO_PARENT'
  /** The snapshot does not contain the node the op names. */
  | 'NODE_NOT_IN_SNAPSHOT'
  /** A batch outside the two composites this panel emits. */
  | 'COMPOSITE_UNSUPPORTED'
  /** An op case this build knows no inverse for. */
  | 'UNKNOWN_OP'
  /** The recorded op is missing a field its own case requires. */
  | 'MALFORMED_OP'
  /** Another writer changed the page, so undoing across it is not offered. */
  | 'EXTERNAL_CHANGE';

/** A refusal, in the shape the relay's own refusals take: a class and a message. */
export interface InverseRefusal {
  readonly class: InverseRefusalClass;
  readonly message: string;
}

export type Inverse =
  { readonly ok: true; readonly op: TreeOpJson } | ({ readonly ok: false } & InverseRefusal);

/**
 * The trees the recording captured, as this derivation reads them.
 *
 * `base` is the session's base tree — what every field held before this session
 * touched anything. `captured` is keyed by node id and holds what was read
 * immediately before an op that destroys it; today that is exactly the
 * `RemoveNode` targets of the op being inverted.
 */
export interface InverseSources {
  readonly base: Capture;
  readonly captured: ReadonlyMap<string, Capture>;
}

/** A recording that captured nothing — the honest default for a caller with none. */
export const NO_SOURCES: InverseSources = { base: NOT_ATTEMPTED, captured: new Map() };

const refuse = (refusalClass: InverseRefusalClass, message: string): Inverse => ({
  ok: false,
  class: refusalClass,
  message,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Every op in `op`, flattened, outermost-last, so a Batch is searchable. */
export const flattenOps = (op: TreeOpJson): readonly TreeOpJson[] => {
  if (op['$type'] !== 'Batch') return [op];
  const ops = op['ops'];
  if (!Array.isArray(ops)) return [];
  return ops.filter(isObject).flatMap((inner) => flattenOps(inner as TreeOpJson));
};

/** What was at `path`, and — when it is not known — why not, in words. */
export type PriorValue =
  | { readonly known: true; readonly value: unknown }
  | { readonly known: false; readonly why: string };

/**
 * What `target`'s `path` held before the op being undone.
 *
 * Three sources, consulted in the order that makes each one's answer the
 * closest-in-time truth:
 *
 *   * an earlier `UpdateProp` on the same node and path set it, so its value is
 *     what restoring means;
 *   * the node was INSERTED by this session, so the child it was born with
 *     carries the value. The search stops at the insert either way — nothing
 *     before a node existed can have set a field on it;
 *   * otherwise the CAPTURED BASE TREE, which is the page as the session found
 *     it. Nothing in the recording touched this field, so the base value is
 *     still what it held.
 *
 * A `path` is resolved by the same walk the editor reads by, so `Columns[0].Label`
 * resolves here exactly where it resolves there. `undefined` from that walk is
 * NOT KNOWN rather than "absent": an op cannot express "make this optional
 * absent again" — setting it null would be a different document — so claiming
 * to restore it would be a fabrication.
 */
export const priorValue = (
  target: string,
  path: string,
  earlier: readonly TreeOpJson[],
  sources: InverseSources = NO_SOURCES,
): PriorValue => {
  for (let index = earlier.length - 1; index >= 0; index -= 1) {
    const candidates = flattenOps(earlier[index]!);
    for (let inner = candidates.length - 1; inner >= 0; inner -= 1) {
      const op = candidates[inner]!;
      if (op['$type'] === 'UpdateProp' && op['target'] === target && op['path'] === path)
        return { known: true, value: op['value'] };
      if (op['$type'] === 'InsertChild') {
        const child = op['child'];
        if (!isObject(child) || child['id'] !== target) continue;
        // The node's origin. Whatever it was born holding is the answer, and
        // there is nothing earlier — in the recording OR in the base tree — to
        // consult: the node did not exist when the base was captured.
        const born = valueAtPath(child, path);
        return born === undefined
          ? {
              known: false,
              why:
                `'${target}' was inserted by this session declaring no '${path}', so there is no ` +
                'earlier value to restore',
            }
          : { known: true, value: born };
      }
    }
  }

  if (!sources.base.ok)
    return {
      known: false,
      why:
        `no earlier edit in this recording set '${target}.${path}' and ` +
        `${sources.base.reason}, so what it held cannot be recovered`,
    };

  const node = findWireNode(sources.base.node, target);
  if (node === undefined)
    return {
      known: false,
      why:
        `no earlier edit in this recording set '${target}.${path}' and '${target}' is not in the ` +
        'captured base tree, so what it held cannot be recovered',
    };
  const held = valueAtPath(node, path);
  return held === undefined
    ? {
        known: false,
        why:
          `no earlier edit in this recording set '${target}.${path}' and the captured base tree ` +
          `carries no '${path}' on '${target}', so what it held cannot be recovered`,
      }
    : { known: true, value: held };
};

/** The style block that was there, or — when it is not known — why not. */
export type PriorStyle =
  | { readonly known: true; readonly block: Readonly<Record<string, unknown>> }
  | { readonly known: false; readonly why: string };

/**
 * The WHOLE style block `target` carried before the style edit being undone.
 *
 * The same three sources as `priorValue`, in the same order and for the same
 * reasons: an earlier `UpdateStyle` in this recording carries the block it
 * replaced the previous one with, a node this session INSERTED carries the
 * block it was born with, and otherwise the captured base tree holds the block
 * the page started with. The search stops at the insert either way — nothing
 * before a node existed can have styled it.
 *
 * ── Why this is TOTAL where `priorValue` refuses ───────────────────────────
 *
 * `UpdateProp` cannot express "make this optional absent again", so a field the
 * captured tree does not carry is NOT KNOWN there: setting it null would be a
 * different document, and claiming to restore it would be a fabrication.
 *
 * The style block has no such gap, because `UpdateStyle` replaces the block
 * whole and the empty block is a value it can carry. A node with no `style`
 * member and a node with an empty one hold the same TOKEN SET — which is what
 * this op addresses — and `panel/nodeJson`'s `styleBlock` already reads them
 * identically, on both the reading and the writing side: the style editor
 * itself emits `{}` when a user clears the last token. So restoring `{}` is
 * the spelling this build already uses for "no tokens", not an invention made
 * up at undo time.
 *
 * What is NOT claimed, stated because the difference is real and small: whether
 * a host re-encodes an emptied block as an absent `style` member or as `{}` is
 * the host's own canonical encoding (§7.7 rule 1), and nothing here decides it.
 * The claim is that the node ends up carrying the tokens it carried before.
 */
export const priorStyle = (
  target: string,
  earlier: readonly TreeOpJson[],
  sources: InverseSources = NO_SOURCES,
): PriorStyle => {
  for (let index = earlier.length - 1; index >= 0; index -= 1) {
    const candidates = flattenOps(earlier[index]!);
    for (let inner = candidates.length - 1; inner >= 0; inner -= 1) {
      const op = candidates[inner]!;
      if (op['$type'] === 'UpdateStyle' && op['target'] === target) {
        const block = op['style'];
        // Unreachable through this panel — `edit/ops`' `updateStyle` takes a
        // record — so this is totality rather than a case anyone has seen. It
        // does NOT fall through to an older source: this op is the closest
        // answer in time, and skipping past a malformed one would restore a
        // block that was superseded.
        return isObject(block)
          ? { known: true, block }
          : {
              known: false,
              why:
                `the most recent style edit to '${target}' in this recording carries no style ` +
                'block, so what it replaced cannot be recovered',
            };
      }
      if (op['$type'] === 'InsertChild') {
        const child = op['child'];
        if (!isObject(child) || child['id'] !== target) continue;
        return { known: true, block: styleBlock(child) };
      }
    }
  }

  if (!sources.base.ok)
    return {
      known: false,
      why:
        `no earlier edit in this recording styled '${target}' and ` +
        `${sources.base.reason}, so the block it carried cannot be recovered`,
    };

  const node = findWireNode(sources.base.node, target);
  return node === undefined
    ? {
        known: false,
        why:
          `no earlier edit in this recording styled '${target}' and '${target}' is not in the ` +
          'captured base tree, so the block it carried cannot be recovered',
      }
    : { known: true, block: styleBlock(node) };
};

/** Put `target` back under the parent it had in `treeBefore`, in its old place. */
const restoreParent = (target: string, treeBefore: TreeSnapshot): Inverse => {
  const parent = parentOf(treeBefore, target);
  if (parent === undefined)
    return refuse(
      'NO_PARENT',
      `'${target}' had no parent in the recorded snapshot, so there is nowhere to move it back to.`,
    );
  const order = siblingIds(treeBefore, target);
  const move = moveNode(target, parent.id);
  // A move APPENDS, so restoring the parent is not enough — the old sibling
  // order has to be named too, in full, or the node comes back in the wrong
  // place and the undo silently half-worked.
  return { ok: true, op: batch([move, reorderChildren(parent.id, order)]) };
};

/**
 * Where a node sat among its siblings, as a placement.
 *
 * Expressed relative to the sibling that FOLLOWED it rather than as an index,
 * because that is the only spelling `edit/ops` accepts and the only one that
 * survives the tree moving underneath: an index means whatever the list happens
 * to be at apply time, an anchor means the node it names.
 */
const placementWithin = (order: readonly string[], target: string): Placement => {
  const successor = order[order.indexOf(target) + 1];
  return successor === undefined ? { at: 'last' } : { at: 'before', anchor: successor };
};

/** Undo one recorded op, given the snapshot and the trees the session captured. */
export const inverseOf = (
  op: TreeOpJson,
  treeBefore: TreeSnapshot,
  earlier: readonly TreeOpJson[],
  sources: InverseSources = NO_SOURCES,
): Inverse => {
  switch (op['$type']) {
    case 'UpdateProp': {
      const target = str(op['target']);
      const path = str(op['path']);
      if (target === undefined || path === undefined)
        return refuse('MALFORMED_OP', 'The recorded edit names no node and path.');
      const prior = priorValue(target, path, earlier, sources);
      if (!prior.known)
        return refuse('NO_PRIOR_VALUE', `This edit cannot be undone: ${prior.why}.`);
      return { ok: true, op: updateProp(target, path, prior.value) };
    }

    case 'UpdateStyle': {
      const target = str(op['target']);
      if (target === undefined)
        return refuse('MALFORMED_OP', 'The recorded style edit names no node.');
      // Checked on the RECORDED op rather than only on what is restored: an
      // entry whose own block is missing describes no change, so there is
      // nothing coherent to reverse even when a prior block is known.
      if (!isObject(op['style']))
        return refuse('MALFORMED_OP', 'The recorded style edit carries no style block.');
      const prior = priorStyle(target, earlier, sources);
      if (!prior.known)
        return refuse('NO_PRIOR_VALUE', `This style edit cannot be undone: ${prior.why}.`);
      return { ok: true, op: updateStyle(target, prior.block) };
    }

    case 'InsertChild': {
      const child = op['child'];
      const id = isObject(child) ? str(child['id']) : undefined;
      if (id === undefined) return refuse('MALFORMED_OP', 'The recorded insert names no child id.');
      return { ok: true, op: removeNode(id) };
    }

    case 'RemoveNode': {
      const target = str(op['target']);
      if (target === undefined)
        return refuse('MALFORMED_OP', 'The recorded removal names no node.');
      const subtree = sources.captured.get(target);
      if (subtree === undefined || !subtree.ok)
        return refuse(
          'NO_CAPTURED_SUBTREE',
          `'${target}' cannot be put back: ${subtree?.reason ?? 'this recording holds no copy of the removed subtree'}.`,
        );
      const parent = parentOf(treeBefore, target);
      if (parent === undefined)
        return refuse(
          'NO_PARENT',
          `'${target}' had no parent in the recorded snapshot, so there is nowhere to put it back.`,
        );
      const order = siblingIds(treeBefore, target);
      // Composed through the panel's own insert composition, so the placement
      // leg is elided when a plain append already lands the node where it was —
      // a redundant reorder is a second op in the host's log describing a change
      // that did not happen.
      return {
        ok: true,
        op: insertOp(
          order.filter((id) => id !== target),
          { parentId: parent.id, placement: placementWithin(order, target) },
          subtree.node,
        ),
      };
    }

    case 'MoveNode': {
      const target = str(op['target']);
      if (target === undefined) return refuse('MALFORMED_OP', 'The recorded move names no node.');
      return restoreParent(target, treeBefore);
    }

    case 'ReorderChildren': {
      const parentId = str(op['parentId']);
      if (parentId === undefined)
        return refuse('MALFORMED_OP', 'The recorded reorder names no parent.');
      const parent = findNode(treeBefore, parentId);
      if (parent === undefined)
        return refuse(
          'NODE_NOT_IN_SNAPSHOT',
          `'${parentId}' is not in the recorded snapshot, so its old order is not known.`,
        );
      return {
        ok: true,
        op: reorderChildren(
          parentId,
          parent.children.map((entry) => entry.id),
        ),
      };
    }

    case 'Batch': {
      const legs = op['ops'];
      const composites = 'Only the insert-and-place and move-and-place composites are undoable.';
      if (!Array.isArray(legs) || legs.length !== 2)
        return refuse('COMPOSITE_UNSUPPORTED', composites);
      const [head, tail] = legs as [unknown, unknown];
      if (!isObject(head) || !isObject(tail) || tail['$type'] !== 'ReorderChildren')
        return refuse('COMPOSITE_UNSUPPORTED', composites);

      // Insert-then-place: removing the child restores the parent's old order
      // by itself. The reorder only ever moved the NEW child among siblings
      // whose relative order it preserved, so there is nothing else to put back.
      if (head['$type'] === 'InsertChild')
        return inverseOf(head as TreeOpJson, treeBefore, earlier, sources);
      // Move-then-place: the destination's remaining order is likewise restored
      // by the node leaving, so the whole inverse is the move's own.
      if (head['$type'] === 'MoveNode')
        return inverseOf(head as TreeOpJson, treeBefore, earlier, sources);

      return refuse('COMPOSITE_UNSUPPORTED', composites);
    }

    default:
      return refuse(
        'UNKNOWN_OP',
        `This build cannot undo a '${String(op['$type'])}' — it knows no inverse for that op.`,
      );
  }
};
