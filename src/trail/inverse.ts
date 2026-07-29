// ============================================================================
//  trail/inverse — undoing an op WITHOUT a local copy of the tree.
//
//  ── Why undo cannot work the way undo usually works ────────────────────────
//
//  The playground undoes by REPLAY: it holds the base tree, drops the cursor,
//  and re-applies the first k ops through the apply engine. That is closed
//  under vocabulary growth — an op case added tomorrow replays because it
//  applies — and it is the right design when you own the tree.
//
//  This extension does not own the tree and must not pretend to. The page's
//  tree is live, the host is its arbiter, and the panel contributes no apply
//  engine (that absence is a stated security property, not an omission). Replay
//  would need two things the relay does not offer: a base tree in wire form to
//  replay FROM, and a way to put a whole tree back — `ReplaceRoot` carries a
//  node, and the panel has never been able to read one.
//
//  So undo here is a COMPENSATING OP, sent through the same gated apply path as
//  every other edit. The host applies it, validates it, and can refuse it. An
//  undo is an edit like any other, which is the only honest framing when the
//  extension cannot mutate anything itself.
//
//  ── Which ops have a recoverable inverse, and which do not ─────────────────
//
//  The inverse is derived from two things the panel genuinely holds: the op it
//  sent, and the STRUCTURAL tree snapshot from immediately before it landed.
//
//    UpdateProp        recoverable ONLY if this session already knows what was
//                      there — an earlier recorded edit to the same node and
//                      path, or the value the node was INSERTED with. Otherwise
//                      not: `relay@1.0` cannot read a property value, so the
//                      value before this session's first edit was never
//                      knowable and inventing one would be a fabrication.
//    InsertChild       always — the panel minted the child, so its id is known.
//    RemoveNode        never. The subtree is gone and was never readable as
//                      wire JSON, so nothing here can put it back. A "restore"
//                      that re-inserted a structurally-similar husk with no
//                      properties would be worse than refusing.
//    MoveNode          always, when the node had a parent: the snapshot names
//                      the old parent and the old sibling order.
//    ReorderChildren   always — the snapshot names the old order.
//    Batch             only the two composites this panel emits (an insert or
//                      a move followed by a reorder of the same parent). Any
//                      other batch is refused rather than inverted leg-by-leg,
//                      because a leg's inverse depends on the tree state BEFORE
//                      that leg, and only the state before the whole batch is
//                      recorded. Guessing there would produce an op that
//                      applies successfully and lands the tree somewhere nobody
//                      chose — the same failure mode the id-addressed placement
//                      rule exists to prevent.
//
//  A phase's worth of the value here is in the second column: the panel says
//  WHICH op it cannot undo and why, at the moment the user hovers Undo, rather
//  than offering an undo that turns out to be a lie.
// ============================================================================

import type { TreeSnapshot } from '../relay/protocol.js';
import {
  batch,
  moveNode,
  removeNode,
  reorderChildren,
  updateProp,
  type TreeOpJson,
} from '../edit/ops.js';
import { findNode, parentOf, siblingIds } from '../panel/treeModel.js';

export type Inverse =
  { readonly ok: true; readonly op: TreeOpJson } | { readonly ok: false; readonly reason: string };

const unavailable = (reason: string): Inverse => ({ ok: false, reason });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * The kind-object field an op path names, for a SIMPLE path only.
 *
 * Op paths are PascalCase (`Text`, `Label`); the kind object's fields are
 * camelCase. A path reaching into a collection or a nested record
 * (`Columns[0].Label`) is deliberately not resolved: the mapping from such a
 * path to a position inside a synthesised node is a second address grammar,
 * and getting it subtly wrong would restore the wrong field silently.
 */
const simpleField = (path: string): string | undefined => {
  if (path.length === 0 || path.includes('.') || path.includes('[')) return undefined;
  return path[0]!.toLowerCase() + path.slice(1);
};

/** Every op in `op`, flattened, outermost-last, so a Batch is searchable. */
const flatten = (op: TreeOpJson): readonly TreeOpJson[] => {
  if (op['$type'] !== 'Batch') return [op];
  const ops = op['ops'];
  if (!Array.isArray(ops)) return [];
  return ops.filter(isObject).flatMap((inner) => flatten(inner as TreeOpJson));
};

/**
 * What `target`'s `path` held before the op being undone, if this session
 * knows — searched newest-first through the ops recorded BEFORE it.
 *
 * Two ways to know, and the search stops at whichever comes first:
 *
 *   * an earlier `UpdateProp` on the same node and path set it, so its value is
 *     what restoring means;
 *   * the node was INSERTED by this session, so the synthesised child carries
 *     the value it was born with. The search stops at the insert either way —
 *     nothing before a node existed can have set a field on it.
 */
export const priorValue = (
  target: string,
  path: string,
  earlier: readonly TreeOpJson[],
): { readonly known: true; readonly value: unknown } | { readonly known: false } => {
  const field = simpleField(path);
  for (let index = earlier.length - 1; index >= 0; index -= 1) {
    const candidates = flatten(earlier[index]!);
    for (let inner = candidates.length - 1; inner >= 0; inner -= 1) {
      const op = candidates[inner]!;
      if (op['$type'] === 'UpdateProp' && op['target'] === target && op['path'] === path)
        return { known: true, value: op['value'] };
      if (op['$type'] === 'InsertChild') {
        const child = op['child'];
        if (!isObject(child) || child['id'] !== target) continue;
        // The node's origin. Whatever it was born holding is the answer, and
        // there is nothing earlier to consult.
        const kind = child['kind'];
        if (field === undefined || !isObject(kind) || !(field in kind)) return { known: false };
        return { known: true, value: kind[field] };
      }
    }
  }
  return { known: false };
};

/** Put `target` back under the parent it had in `treeBefore`, in its old place. */
const restoreParent = (target: string, treeBefore: TreeSnapshot): Inverse => {
  const parent = parentOf(treeBefore, target);
  if (parent === undefined)
    return unavailable(
      `'${target}' had no parent in the recorded snapshot, so there is nowhere to move it back to.`,
    );
  const order = siblingIds(treeBefore, target);
  const move = moveNode(target, parent.id);
  // A move APPENDS, so restoring the parent is not enough — the old sibling
  // order has to be named too, in full, or the node comes back in the wrong
  // place and the undo silently half-worked.
  return { ok: true, op: batch([move, reorderChildren(parent.id, order)]) };
};

/** Undo one recorded op, given the structural tree from just before it. */
export const inverseOf = (
  op: TreeOpJson,
  treeBefore: TreeSnapshot,
  earlier: readonly TreeOpJson[],
): Inverse => {
  switch (op['$type']) {
    case 'UpdateProp': {
      const target = str(op['target']);
      const path = str(op['path']);
      if (target === undefined || path === undefined)
        return unavailable('The recorded edit names no node and path.');
      const prior = priorValue(target, path, earlier);
      if (!prior.known)
        return unavailable(
          `What '${target}.${path}' held before this session's first edit to it was never ` +
            'readable — relay@1.0 has no read of a property value — so it cannot be restored.',
        );
      return { ok: true, op: updateProp(target, path, prior.value) };
    }

    case 'InsertChild': {
      const child = op['child'];
      const id = isObject(child) ? str(child['id']) : undefined;
      if (id === undefined) return unavailable('The recorded insert names no child id.');
      return { ok: true, op: removeNode(id) };
    }

    case 'RemoveNode':
      return unavailable(
        'A removed subtree cannot be restored: relay@1.0 never let this panel read it as wire ' +
          'JSON, and re-inserting a structural husk would put back something the page never had.',
      );

    case 'MoveNode': {
      const target = str(op['target']);
      if (target === undefined) return unavailable('The recorded move names no node.');
      return restoreParent(target, treeBefore);
    }

    case 'ReorderChildren': {
      const parentId = str(op['parentId']);
      if (parentId === undefined) return unavailable('The recorded reorder names no parent.');
      const parent = findNode(treeBefore, parentId);
      if (parent === undefined)
        return unavailable(
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
      if (!Array.isArray(legs) || legs.length !== 2)
        return unavailable('Only the insert-and-place and move-and-place composites are undoable.');
      const [head, tail] = legs as [unknown, unknown];
      if (!isObject(head) || !isObject(tail) || tail['$type'] !== 'ReorderChildren')
        return unavailable('Only the insert-and-place and move-and-place composites are undoable.');

      // Insert-then-place: removing the child restores the parent's old order
      // by itself. The reorder only ever moved the NEW child among siblings
      // whose relative order it preserved, so there is nothing else to put back.
      if (head['$type'] === 'InsertChild')
        return inverseOf(head as TreeOpJson, treeBefore, earlier);
      // Move-then-place: the destination's remaining order is likewise restored
      // by the node leaving, so the whole inverse is the move's own.
      if (head['$type'] === 'MoveNode') return inverseOf(head as TreeOpJson, treeBefore, earlier);

      return unavailable('Only the insert-and-place and move-and-place composites are undoable.');
    }

    default:
      return unavailable(
        `This build cannot undo a '${String(op['$type'])}' — it knows no inverse for that op.`,
      );
  }
};
