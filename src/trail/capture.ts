// ============================================================================
//  trail/capture — reading a whole tree as canonical wire JSON, under a bound.
//
//  ── What this is for ───────────────────────────────────────────────────────
//
//  `read.nodeJson` (DEVTOOLS_RELAY §7.7) asked for the ROOT returns the whole
//  tree as the host's own canonical wire JSON, whole subtree and no elided
//  variant. That is what makes an exact undo possible — the recording can hold
//  what a field held before this session touched it — and it is what lets the
//  exported document carry the two trees the session-op-log format is built
//  around.
//
//  Everything about that read is a CAPABILITY OF THE PAGE, not of this
//  extension: the page may not serve `read.nodeJson` at all, may refuse the
//  read, or may hold a tree larger than a recording should carry. So a capture
//  is a tagged outcome rather than an optional value — every failure carries a
//  reason in words, because both places that consume one (the undo refusal and
//  the exported document's integrity note) have to SAY why rather than present
//  an absence.
//
//  ── The bound, and why refusing beats truncating ───────────────────────────
//
//  An exported document holds two of these plus every op, and the panel holds
//  both in memory for the life of the recording. Unbounded, a large application
//  turns Export into a browser tab that stops responding — and the panel would
//  have no way to say so, because it would already be inside the failure.
//
//  Over the ceiling the capture is REFUSED, never truncated. A truncated tree
//  is not a tree: it would hash to something no verifier can reproduce, it would
//  answer "what did this field hold" with silence for exactly the nodes that
//  fell off the end, and nothing in the document's shape would distinguish that
//  silence from a field that was genuinely absent. The refusal names the size it
//  measured and the ceiling it measured against, so the number is visible rather
//  than inferred.
//
//  ── The hash ───────────────────────────────────────────────────────────────
//
//  `hash` is SHA-256 over the tree's canonical bytes, which is the session-log
//  family's `baseHash` — the same definition the reference exporter uses
//  (`sha256Hex(canonicalBytes(baseTree))`, and the genesis hash when there is no
//  base tree). It is computed HERE, over the same bytes the document embeds, so
//  the two cannot drift: an export that hashed one encoding and published
//  another would fail verification for a reason nothing in it explains.
// ============================================================================

import { canonicalJson, type JsonValue } from './canonicalJson.js';
import { GENESIS_PREVIOUS_HASH, sha256Hex } from './hashChain.js';

/** A node in canonical wire JSON — `{ id, kind: { $type, … }, style? }`. */
export type WireNode = Readonly<Record<string, unknown>>;

/**
 * The largest tree this recording will hold, in bytes of canonical JSON.
 *
 * Two of these live in an exported document and both live in the panel for the
 * recording's life, so the ceiling is a bound on the export (~4 MiB of trees
 * plus the ops) rather than on one read. Chosen to sit above any application
 * tree seen in practice and below the size at which a blob download and a
 * devtools panel start to hurt.
 */
export const MAX_CAPTURED_TREE_BYTES = 2 * 1024 * 1024;

/** What a read of a node's wire JSON produced. The reason is the page's. */
export type WireRead =
  | { readonly ok: true; readonly node: WireNode }
  | { readonly ok: false; readonly why: 'not-offered' | 'refused' };

/** Read one node's canonical wire JSON. Supplied by whoever holds the relay. */
export type WireReader = (nodeId: string) => Promise<WireRead>;

/**
 * The reader for a recording with no page behind it.
 *
 * `not-offered` rather than `refused`: a `Trail` constructed without a reader
 * has nothing to ask, which is the same fact as a page that serves no
 * `read.nodeJson` — and it is not the same fact as a page that said no.
 */
export const NO_WIRE_READER: WireReader = async () => ({ ok: false, why: 'not-offered' });

export type CaptureFailure = 'not-attempted' | 'not-offered' | 'refused' | 'too-large' | 'stale';

/**
 * A tree this recording holds, or the reason it holds none.
 *
 * `json` is kept beside `node` because it is what was hashed. The document
 * re-encodes from `node` through the same pure function, so the two agree by
 * construction; keeping the bytes makes that checkable rather than assumed.
 */
export type Capture =
  | {
      readonly ok: true;
      readonly node: WireNode;
      readonly json: string;
      readonly hash: string;
    }
  | { readonly ok: false; readonly why: CaptureFailure; readonly reason: string };

/**
 * Why there is no capture, as a clause that reads inside a sentence.
 *
 * Written as fragments rather than sentences because both consumers compose
 * them into a larger statement — "…could not be restored because X" and "No
 * base tree was captured — X — so the chain is seeded at genesis". A capitalised
 * standalone sentence would read wrongly in both.
 */
export const NOT_ATTEMPTED_REASON =
  'nothing was edited in this session, so no tree was ever captured';

export const NOT_OFFERED_REASON =
  'this page serves no `read.nodeJson`, so no canonical encoding of its tree can be obtained';

export const REFUSED_REASON = 'the page refused to encode its root as canonical wire JSON';

export const STALE_REASON =
  'another writer changed this page after the tree was captured, and a `changed` event says only ' +
  'that the tree moved, never how, so the captured tree can no longer answer for a value it did ' +
  'not itself set';

export const tooLargeReason = (bytes: number): string =>
  `the tree encodes to ${bytes} bytes, over the ${MAX_CAPTURED_TREE_BYTES}-byte ceiling this ` +
  'recording holds a tree to, and a truncated tree is not a tree';

/** A capture that was never attempted — the state a recording starts in. */
export const NOT_ATTEMPTED: Capture = {
  ok: false,
  why: 'not-attempted',
  reason: NOT_ATTEMPTED_REASON,
};

/** A capture that WAS taken and has since been overtaken by another writer. */
export const STALE: Capture = { ok: false, why: 'stale', reason: STALE_REASON };

/** Canonicalise, measure, and hash — or refuse, saying which of the three failed. */
export const capture = async (read: WireRead): Promise<Capture> => {
  if (!read.ok)
    return {
      ok: false,
      why: read.why,
      reason: read.why === 'not-offered' ? NOT_OFFERED_REASON : REFUSED_REASON,
    };
  const json = canonicalJson(read.node as JsonValue);
  // Measured in BYTES, not in UTF-16 units: a tree of non-ASCII text is up to
  // three times longer on the wire than `json.length` reports, and the ceiling
  // is about what the document weighs.
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > MAX_CAPTURED_TREE_BYTES)
    return { ok: false, why: 'too-large', reason: tooLargeReason(bytes) };
  return { ok: true, node: read.node, json, hash: await sha256Hex(json) };
};

/**
 * The hash the op chain is seeded at: the base tree's, or genesis when there is
 * no base tree.
 *
 * This is the session-log family's rule and not a choice made here. A chain
 * seeded at the base hash binds the ops to the tree they were composed against;
 * a chain seeded at genesis states that the ops stand alone, which is the honest
 * claim when no base tree was captured.
 */
export const chainSeed = (base: Capture): string => (base.ok ? base.hash : GENESIS_PREVIOUS_HASH);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether `value` is a wire node: an id, and a kind object carrying a `$type`. */
const isWireNode = (value: unknown): value is WireNode => {
  if (!isObject(value) || typeof value['id'] !== 'string') return false;
  const kind = value['kind'];
  return isObject(kind) && typeof kind['$type'] === 'string';
};

/**
 * Find a node by id anywhere inside a captured tree.
 *
 * The walk descends through EVERY nested value rather than only `kind.children`,
 * because a node is not always a child: a form's fields and a table's cells are
 * whole nodes with their own ids, addressed by the same ops, sitting in
 * collection slots the container declares. A walk that only followed `children`
 * would refuse to undo an edit to one of those while claiming the tree was
 * captured — the worst of both answers.
 */
export const findWireNode = (root: WireNode, id: string): WireNode | undefined => {
  if (root['id'] === id) return root;
  const search = (value: unknown): WireNode | undefined => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = search(entry);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (!isObject(value)) return undefined;
    if (isWireNode(value) && value['id'] === id) return value;
    for (const entry of Object.values(value)) {
      const found = search(entry);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return search(root['kind']);
};
