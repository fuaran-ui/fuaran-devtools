// ============================================================================
//  edit/ops — the tree-op vocabulary the panel emits, in canonical wire JSON.
//
//  WRITTEN FROM THE WIRE FORMAT, NOT FROM A HOST TIER. The same posture
//  `relay/protocol` takes, for the same reason: this extension attaches to
//  whatever Fuaran host is on the page, and its op vocabulary must track the
//  FORMAT rather than one implementation's package version. A codec dependency
//  would pin the panel's idea of an op to one tier's release cadence, and the
//  panel would have no way to tell that the page in front of it disagreed.
//
//  It also is not needed. The relay carries the op as a STRUCTURED OBJECT and
//  puts canonical serialisation on the page peer (§8.2), so the one thing a
//  codec would buy — canonical byte ordering — is explicitly not this peer's
//  job. What remains is the op SHAPES, which are specified, and which the
//  conformance corpus pins.
//
//  ── Placement is id-addressed, never positional ────────────────────────────
//
//  There is no integer index anywhere in this module, and that is a property to
//  preserve rather than an accident of style. An op carrying a position is an
//  op whose meaning depends on what the tree looked like when it was composed;
//  between composing it and applying it, an AI driving the same page can insert
//  a sibling, and the op then lands somewhere nobody chose. Placement is
//  therefore expressed as `ReorderChildren` over the full sibling id list — the
//  order it names is the order it means, whatever happened in between.
// ============================================================================

/** A `TreeOp` in canonical wire JSON, carried as a structured object. */
export type TreeOpJson = Readonly<Record<string, unknown>>;

/** A node in canonical wire JSON — `{ id, kind, … }`. */
export type NodeJson = Readonly<Record<string, unknown>>;

// Keys are written in the canonical (ordinal) order the format serialises them
// in. The wire bytes are the page peer's to produce, so this buys nothing on
// the wire — it buys a diff that lines up against a fixture when one fails.

/** `{"$type":"UpdateProp","path":…,"target":…,"value":…}` */
export const updateProp = (target: string, path: string, value: unknown): TreeOpJson => ({
  $type: 'UpdateProp',
  path,
  target,
  value,
});

/** `{"$type":"InsertChild","child":{…},"parentId":…}` */
export const insertChild = (parentId: string, child: NodeJson): TreeOpJson => ({
  $type: 'InsertChild',
  child,
  parentId,
});

/** `{"$type":"ReorderChildren","newOrder":[…],"parentId":…}` — the FULL sibling list. */
export const reorderChildren = (parentId: string, newOrder: readonly string[]): TreeOpJson => ({
  $type: 'ReorderChildren',
  newOrder: [...newOrder],
  parentId,
});

/** `{"$type":"RemoveNode","target":…}` */
export const removeNode = (target: string): TreeOpJson => ({ $type: 'RemoveNode', target });

/** `{"$type":"MoveNode","newParentId":…,"target":…}` */
export const moveNode = (target: string, newParentId: string): TreeOpJson => ({
  $type: 'MoveNode',
  newParentId,
  target,
});

/** `{"$type":"Batch","ops":[…]}` — applied as one unit, refused as one unit. */
export const batch = (ops: readonly TreeOpJson[]): TreeOpJson => ({
  $type: 'Batch',
  ops: [...ops],
});

// ─── Placement ──────────────────────────────────────────────────────

/** Where a node should sit among its new siblings. */
export type Placement =
  | { readonly at: 'last' }
  | { readonly at: 'before'; readonly anchor: string }
  | { readonly at: 'after'; readonly anchor: string };

export interface Target {
  readonly parentId: string;
  readonly placement: Placement;
}

/**
 * The sibling order wanted, given the order that results from a plain append.
 *
 * An anchor that is not among the siblings APPENDS rather than failing: the
 * anchor may have been removed by another writer between the panel rendering
 * the affordance and the user using it, and landing the node at the end of the
 * list it was aimed at is a better answer than refusing an edit the user could
 * not have known was stale.
 */
export const reposition = (
  appended: readonly string[],
  moved: string,
  placement: Placement,
): readonly string[] => {
  const others = appended.filter((id) => id !== moved);
  if (placement.at === 'last') return [...others, moved];
  const index = others.indexOf(placement.anchor);
  if (index < 0) return [...others, moved];
  const cut = placement.at === 'before' ? index : index + 1;
  return [...others.slice(0, cut), moved, ...others.slice(cut)];
};

/**
 * Insert `child` under `target.parentId` at the wanted placement.
 *
 * The reorder leg is ELIDED when a plain append already lands the node where it
 * was wanted. That is not tidiness: a redundant `ReorderChildren` is a second
 * op in the host's log describing a change that did not happen, and the log is
 * the record of what a session did.
 */
export const insertOp = (
  siblingIds: readonly string[],
  target: Target,
  child: NodeJson,
): TreeOpJson => {
  const childId = typeof child['id'] === 'string' ? child['id'] : '';
  const appended = [...siblingIds, childId];
  const wanted = reposition(appended, childId, target.placement);
  const insert = insertChild(target.parentId, child);
  return sameOrder(wanted, appended)
    ? insert
    : batch([insert, reorderChildren(target.parentId, wanted)]);
};

/**
 * Move `moved` under `target.parentId` at the wanted placement.
 *
 * Post-move membership is "the siblings without it, plus it" — which is the
 * same expression whether the node is arriving from another parent or being
 * re-placed among the siblings it already has, so one route covers both.
 */
export const moveOp = (
  siblingIdsAfterMove: readonly string[],
  target: Target,
  moved: string,
): TreeOpJson => {
  const appended = [...siblingIdsAfterMove.filter((id) => id !== moved), moved];
  const wanted = reposition(appended, moved, target.placement);
  const move = moveNode(moved, target.parentId);
  return sameOrder(wanted, appended)
    ? move
    : batch([move, reorderChildren(target.parentId, wanted)]);
};

/**
 * Shift a node one place among its siblings. `undefined` at either end — the
 * caller renders that as "already first/last", never as a refused op.
 */
export const nudgeOp = (
  parentId: string,
  siblingIds: readonly string[],
  nodeId: string,
  delta: -1 | 1,
): TreeOpJson | undefined => {
  const index = siblingIds.indexOf(nodeId);
  if (index < 0) return undefined;
  const swapWith = index + delta;
  if (swapWith < 0 || swapWith >= siblingIds.length) return undefined;
  const next = [...siblingIds];
  next[index] = siblingIds[swapWith]!;
  next[swapWith] = nodeId;
  // The full sibling list, always: a partial order is not a legal reorder.
  return reorderChildren(parentId, next);
};

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);
