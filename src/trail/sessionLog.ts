// ============================================================================
//  trail/sessionLog — the exported document: the session-op-log envelope.
//
//  ── What this writes ───────────────────────────────────────────────────────
//
//  The session-op-log document is a self-describing record of an editing
//  session: a base tree, the ops applied to it — each carrying its actor and its
//  chain links — and the final tree the ops produce. Its central claim is that
//  THESE OPS BUILD THIS TREE, which a reader checks by replaying them.
//
//  This recording can now make that claim, and does. `read.nodeJson` (§7.7)
//  asked for the root returns the whole tree as canonical wire JSON; the
//  recorder captures one at the session's first edit and one at export, and
//  seeds the chain at the base tree's hash. When both trees are in hand the
//  document IS a session op log — same marker, same six fields, same base hash
//  rule, and no appendix, because there is nothing left for an appendix to
//  explain. That was the migration this module's previous form pre-stated, and
//  it is what `writeTrailDocument` now performs.
//
//  ── When the claim cannot be made, the document says which claim failed ────
//
//  A capture is a capability of the PAGE, and it can be absent, refused, or over
//  this recording's size ceiling. And a capture that succeeded can be OVERTAKEN:
//  when another writer edits the page mid-session, the ops recorded here no
//  longer build the final tree by themselves, however completely both trees were
//  read.
//
//  In any of those cases the document must not wear the session-log marker. It
//  would be easy to emit it anyway with `"base":null` and let an ingest discover
//  the problem — that is the wrong call twice over, because it puts a document
//  into circulation whose name promises replayability, and it reports the
//  absence as whatever gate happens to trip first rather than as the fact it is.
//  So the marker names the producer and the shape:
//
//      "$log": "fuaran-devtools-op-trail"
//
//  an ingest expecting the session log rejects it on the envelope check —
//  immediately, unambiguously, and before anything downstream has assumed the
//  trees are there — and the `integrity` note beside it says which of the four
//  things went wrong, in words, naming the cause the page gave.
//
//  ── The prefix is byte-compatible, on purpose ──────────────────────────────
//
//  Both documents write the six envelope fields EXACTLY: same names, same order,
//  same canonical encoding of every embedded document, same insertion-ordered
//  actor, same chain. Anything the degraded form adds is appended AFTER `tree`,
//  so the shared prefix diffs cleanly against a reference document. That was
//  verified rather than intended — this writer re-emits a reference session-log
//  document byte-for-byte from its parsed parts.
//
//  ── The appendix, and why the complete document drops it ───────────────────
//
//  Three additions, each earning its place by saying something the six fields
//  cannot while a tree is missing: `integrity` states what is absent and why, so
//  a reader never has to infer it from nulls; `session` records the boundary
//  (which page, which host, which revisions); and `structure` carries the
//  relay's own structural snapshots — the honest substitute for a missing tree,
//  in a shape no one can mistake for wire JSON, because its `kind` is a
//  discriminator name and its nodes carry no properties at all.
//
//  A complete document drops all three. `integrity` and `structure` exist to
//  stand in for what is absent, and nothing is; `session` goes with them because
//  the point of the complete form is to BE the session-op-log document rather
//  than a document shaped like one with extra members, and a reader of that
//  format knows nothing about a member this producer invented. What is lost is
//  the host identity and the revision pair, which the recording states in the
//  panel while it is live. That is the trade, taken deliberately.
// ============================================================================

import { RELAY_PROFILE } from '../relay/protocol.js';
import { canonicalJson, encodeString, type JsonValue } from './canonicalJson.js';
import { chainSeed, type Capture } from './capture.js';
import { encodeActor, type Actor } from './hashChain.js';

/**
 * The marker of the session op log — the format this document is shaped after,
 * and now wears when it can honour the format's central claim.
 */
export const SESSION_LOG_MARKER = 'fuaran-session-op-log';

/** The marker this extension emits when it cannot make that claim. */
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

/**
 * The reason this document is not a replayable session log, assembled from the
 * three facts that can make it one.
 *
 * Composed rather than selected from a table because the causes are
 * independent — a page can refuse the base read and serve the final one, and a
 * complete pair can still be overtaken by another writer. A table would need a
 * cell per combination and would go stale the first time one was added.
 */
export const integrityReason = (base: Capture, final: Capture, interrupted: boolean): string => {
  const parts = [
    base.ok
      ? 'The base tree was captured, and the op chain is seeded at its hash.'
      : `No base tree was captured — ${base.reason} — so the chain is seeded at the genesis hash.`,
    final.ok ? 'The final tree was captured.' : `No final tree was captured — ${final.reason}.`,
  ];
  if (interrupted)
    parts.push(
      'Another writer changed this page during the recording, so the ops recorded here do not by ' +
        'themselves build the final tree.',
    );
  parts.push(
    'The op chain itself is complete and independently verifiable; this document is not ' +
      'replayable, and an ingest that requires a replayable session should reject it on the ' +
      'envelope marker.',
  );
  return parts.join(' ');
};

export const integrityFor = (
  base: Capture,
  final: Capture,
  interrupted: boolean,
): IntegrityNote => ({
  base: base.ok ? 'present' : 'absent',
  tree: final.ok ? 'present' : 'absent',
  chainSeed: base.ok ? 'baseHash' : 'genesis',
  reason: integrityReason(base, final, interrupted),
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
 * The structural snapshots the relay can supply without a wire read, labelled so
 * they are never read as the wire trees they stand in for.
 */
export const STRUCTURE_SHAPE_NOTE =
  `${RELAY_PROFILE} read.tree.ok — 'kind' is a discriminator name, not a kind object, and ` +
  'property values are absent. This is a structural record, not wire-format JSON, and cannot be ' +
  'decoded or replayed as a tree.';

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

export interface TrailDocumentInput {
  readonly ops: readonly LoggedOp[];
  /** The session's base tree, or why there is none. */
  readonly base: Capture;
  /** The tree at export, or why there is none. */
  readonly final: Capture;
  /** True once a change this session did not cause has landed. */
  readonly interrupted: boolean;
  readonly session: SessionNote;
  readonly baseStructure: JsonValue | null;
  readonly finalStructure: JsonValue | null;
}

/**
 * Whether a recording can honour the session op log's central claim.
 *
 * All three, and interruption is not the odd one out: the claim is that the ops
 * build the tree, and an edit this session did not make sits between the two
 * trees whether or not both were read perfectly.
 */
export const isReplayable = (input: TrailDocumentInput): boolean =>
  input.base.ok && input.final.ok && !input.interrupted;

/** The whole document — the session op log when it can be one, the trail when not. */
export const writeTrailDocument = (input: TrailDocumentInput): string =>
  isReplayable(input)
    ? writeSessionLog({
        marker: SESSION_LOG_MARKER,
        version: TRAIL_VERSION,
        baseHash: chainSeed(input.base),
        base: (input.base.ok ? input.base.node : null) as JsonValue | null,
        ops: input.ops,
        tree: (input.final.ok ? input.final.node : null) as JsonValue | null,
      })
    : writeSessionLog({
        marker: TRAIL_MARKER,
        version: TRAIL_VERSION,
        baseHash: chainSeed(input.base),
        base: (input.base.ok ? input.base.node : null) as JsonValue | null,
        ops: input.ops,
        tree: (input.final.ok ? input.final.node : null) as JsonValue | null,
        appendix: trailAppendix({
          integrity: integrityFor(input.base, input.final, input.interrupted),
          session: input.session,
          baseStructure: input.baseStructure,
          finalStructure: input.finalStructure,
        }),
      });
