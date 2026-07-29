// ============================================================================
//  trail/sessionLog — the exported document: the session-op-log envelope.
//
//  ── What this writes, and what it deliberately does not claim ──────────────
//
//  The session-op-log document is a self-describing record of an editing
//  session: a base tree, the ops applied to it — each carrying its actor and
//  its chain links — and the final tree the ops produce. Its central claim is
//  that THESE OPS BUILD THIS TREE, which a reader checks by replaying them.
//
//  This extension can honour every part of that except the two trees, and the
//  reason is a property of the relay contract rather than a gap here:
//
//      `relay@1.0` has NO read that returns a node's canonical wire JSON.
//
//  Its reads answer what the tree is STRUCTURALLY — kinds, bound slots, child
//  ids, geometry, one slot's resolved value. None returns the wire form of a
//  node, and `treeRevision` is specified as an opaque token a client must not
//  parse (§5.4). So a base tree cannot be captured, a final tree cannot be
//  captured, and the base hash — which is the SHA-256 of the base tree's
//  canonical bytes — cannot be computed. This is the same absence that makes
//  the property editor a set-only surface and rules out a style editor: one
//  missing read, three consequences.
//
//  ── So the document is NOT dressed as one it cannot be ─────────────────────
//
//  It would be easy to emit the playground's marker with `"base":null` and let
//  an ingest discover the problem. That is the wrong call twice over: it puts
//  a document into circulation whose name promises replayability, and it
//  reports the absence as whatever gate happens to trip first rather than as
//  the fact it is. So the marker names the producer and the shape:
//
//      "$log": "fuaran-devtools-op-trail"
//
//  and an ingest expecting the session log rejects it on the envelope check —
//  immediately, unambiguously, and before anything downstream has assumed the
//  trees are there.
//
//  ── Everything else is byte-compatible, on purpose ─────────────────────────
//
//  The first six fields are the session-log envelope EXACTLY: same names, same
//  order, same canonical encoding of every embedded document, same insertion-
//  ordered actor, same chain. Anything this extension adds is appended AFTER
//  `tree`, so the shared prefix diffs cleanly against a reference document and
//  the whole migration, on the day a wire-JSON read lands, is: capture the two
//  trees, seed the chain at their base hash, change the marker, drop the
//  appendix. That was verified rather than intended — this writer re-emits a
//  reference session-log document byte-for-byte from its parsed parts.
//
//  ── The appendix ───────────────────────────────────────────────────────────
//
//  Three additions, each earning its place by saying something the six fields
//  cannot: `integrity` states in the document what is absent and why, so a
//  reader never has to infer it from nulls; `session` records the boundary
//  (which page, which host, which revisions); and `structure` carries the
//  relay's own structural snapshots — the honest substitute for the two trees,
//  in a shape no one can mistake for wire JSON, because its `kind` is a
//  discriminator name and its nodes carry no properties at all.
// ============================================================================

import { canonicalJson, encodeString, type JsonValue } from './canonicalJson.js';
import { encodeActor, GENESIS_PREVIOUS_HASH, type Actor } from './hashChain.js';

/**
 * The marker of the playground's session op log — the document this one is
 * shaped after and deliberately does not impersonate. Named here so the
 * relationship is stated in the code rather than only in prose.
 */
export const SESSION_LOG_MARKER = 'fuaran-session-op-log';

/** The marker this extension emits. */
export const TRAIL_MARKER = 'fuaran-devtools-op-trail';

/** The document version. Bump on any change to the envelope's shape. */
export const TRAIL_VERSION = 1;

export const TRAIL_FILENAME = 'fuaran-devtools-op-trail.json';

/** One applied op, as the document records it. */
export interface LoggedOp {
  /** One-based, contiguous, and the position the chain hash was taken at. */
  readonly seq: number;
  readonly actor: Actor;
  readonly prevHash: string;
  readonly hash: string;
  /** The op's CANONICAL BYTES, verbatim — never a re-serialisation. */
  readonly opJson: string;
}

/** A key/value pair appended after `tree`, in the order given. */
export type Appendix = readonly (readonly [string, JsonValue])[];

export interface SessionLogDocument {
  readonly marker: string;
  readonly version: number;
  readonly baseHash: string;
  readonly base: JsonValue | null;
  readonly ops: readonly LoggedOp[];
  readonly tree: JsonValue | null;
  readonly appendix?: Appendix;
}

/**
 * Write the document.
 *
 * Assembled by concatenation rather than by `JSON.stringify` on an object,
 * because the envelope's own key order is INSERTION order while every embedded
 * document is ordinal-sorted — two different rules in one file, which no single
 * serialiser call expresses. `opJson` is spliced in verbatim: the chain hashes
 * the canonical bytes, so a round-trip through any JSON writer that re-spaced
 * or re-ordered anything would break verification for a reason that has
 * nothing to do with tampering.
 */
export const writeSessionLog = (document: SessionLogDocument): string => {
  const ops = document.ops
    .map(
      (op) =>
        `{"seq":${op.seq},"actor":${encodeActor(op.actor)},"prevHash":${encodeString(
          op.prevHash,
        )},"hash":${encodeString(op.hash)},"op":${op.opJson}}`,
    )
    .join(',');

  const appendix = (document.appendix ?? [])
    .map(([key, value]) => `,${encodeString(key)}:${canonicalJson(value)}`)
    .join('');

  return (
    `{"$log":${encodeString(document.marker)}` +
    `,"version":${document.version}` +
    `,"baseHash":${encodeString(document.baseHash)}` +
    `,"base":${document.base === null ? 'null' : canonicalJson(document.base)}` +
    `,"ops":[${ops}]` +
    `,"tree":${document.tree === null ? 'null' : canonicalJson(document.tree)}` +
    `${appendix}}`
  );
};

/** What the recording could not carry, and why — stated in the document. */
export interface IntegrityNote {
  readonly base: 'absent' | 'present';
  readonly tree: 'absent' | 'present';
  readonly chainSeed: 'genesis' | 'baseHash';
  readonly reason: string;
}

/** The standing reason under `relay@1.0`. One sentence per consequence. */
export const RELAY_INTEGRITY_REASON =
  'relay@1.0 exposes no read returning a node or tree as canonical wire JSON, so this ' +
  'recording carries no base tree and no final tree, and its chain is seeded at the genesis ' +
  'hash rather than at a base-tree hash. The op chain itself is complete and independently ' +
  'verifiable; the document is not replayable, and an ingest that requires a base tree should ' +
  'reject it on the envelope marker.';

export const relayIntegrity = (): IntegrityNote => ({
  base: 'absent',
  tree: 'absent',
  chainSeed: 'genesis',
  reason: RELAY_INTEGRITY_REASON,
});

/**
 * Which host, and when. None of this is hashed.
 *
 * There is deliberately no page URL. Reading one means
 * `chrome.devtools.inspectedWindow.eval`, and this extension's whole security
 * story is that it adds no capability the page did not already have — spending
 * an in-page evaluation on a provenance field would trade that for a
 * convenience. The host identity and the revision pair say which surface was
 * recorded; whoever exported the file knows which page they were on.
 */
export interface SessionNote {
  readonly host: string;
  readonly hostVersion: string;
  readonly profile: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly startRevision: string;
  readonly endRevision: string;
}

/**
 * The structural snapshots the relay CAN supply, labelled so they are never
 * read as the wire trees they stand in for.
 */
export const STRUCTURE_SHAPE_NOTE =
  "relay@1.0 read.tree.ok — 'kind' is a discriminator name, not a kind object, and property " +
  'values are absent. This is a structural record, not wire-format JSON, and cannot be decoded ' +
  'or replayed as a tree.';

export interface TrailAppendixInput {
  readonly integrity: IntegrityNote;
  readonly session: SessionNote;
  readonly baseStructure: JsonValue | null;
  readonly finalStructure: JsonValue | null;
}

export const trailAppendix = (input: TrailAppendixInput): Appendix => [
  ['integrity', input.integrity as unknown as JsonValue],
  ['session', input.session as unknown as JsonValue],
  [
    'structure',
    {
      shape: STRUCTURE_SHAPE_NOTE,
      base: input.baseStructure,
      final: input.finalStructure,
    } as unknown as JsonValue,
  ],
];

/** The whole document, for a recording made over a relay with no tree read. */
export const writeTrail = (ops: readonly LoggedOp[], appendix: Appendix): string =>
  writeSessionLog({
    marker: TRAIL_MARKER,
    version: TRAIL_VERSION,
    baseHash: GENESIS_PREVIOUS_HASH,
    base: null,
    ops,
    tree: null,
    appendix,
  });
