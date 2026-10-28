// ============================================================================
//  repro/boardSnapshot — the "copy repro" action: a board snapshot record,
//  verified, ready to paste into a bug report.
//
//  ── What a board snapshot is ───────────────────────────────────────────────
//
//  A record naming everything a board's rendered data is a function of: the
//  tree (by the SHA-256 of its canonical wire bytes), each live source's
//  op-stream head (stream, length, head hash), the bound parameters (embedded
//  as canonical values), the pinned `Now` and the ambient locale. Given the
//  record and access to the op streams, any conformant host renders the same
//  data again. Its identifier is `sha256:` over the record's canonical bytes.
//
//  ── Why this extension does not BUILD the record ───────────────────────────
//
//  Only the host knows its op-stream heads, which of its channels are live, and
//  the instant it furnished as `Now` — none of that is in the tree, and nothing
//  this panel can read reconstructs it. A record assembled here from what the
//  panel CAN see would name a tree and guess the rest, which is exactly the
//  approximation a reproduction must never be. So the host captures the record
//  and publishes it beside the board as an inert element:
//
//      <script type="application/vnd.fuaran.board-snapshot+json"
//              data-fuaran-board-snapshot="sha256:…">{ canonical record }</script>
//
//  and this action READS that element, VERIFIES it, and copies it. Reading the
//  DOM needs no relay request and no new capability: it is a fact about the
//  page, held locally.
//
//  ── What "verified" means ──────────────────────────────────────────────────
//
//   1. Exactly one record is published (two would be two boards' worth of
//      claims, and picking one is a guess).
//   2. It is a well-formed record of the one format this build reads, with no
//      member it does not know — an unknown member would be carried into the
//      hash and dropped by every reader that re-encodes it.
//   3. Its hash, recomputed over its canonical bytes here, equals the hash the
//      host published beside it — so a hand-edited or half-updated element is
//      refused rather than copied.
//   4. When the page serves its root's canonical wire JSON, the tree it names
//      IS the tree on the page. A record published for a tree the page has
//      since replaced is refused as stale. When the page serves no such read,
//      the copy says the tree went unchecked rather than implying it was.
// ============================================================================

import { canonicalJson, type JsonValue } from '../trail/canonicalJson.js';
import { sha256Hex } from '../trail/hashChain.js';
import type { Capture } from '../trail/capture.js';

/** The record's format marker. */
export const BOARD_SNAPSHOT_FORMAT = 'fuaran-board-snapshot@1';

/** The media type a host publishes the record under. */
export const BOARD_SNAPSHOT_MEDIA_TYPE = 'application/vnd.fuaran.board-snapshot+json';

/** The attribute carrying the published hash. */
export const BOARD_SNAPSHOT_HASH_ATTRIBUTE = 'data-fuaran-board-snapshot';

/** One published element, as read off the page. */
export interface PublishedRecord {
  readonly attribute: string | null;
  readonly text: string | null;
}

/** What the action produced. */
export type Repro =
  | {
      readonly ok: true;
      /** The record's canonical text — what is copied. */
      readonly text: string;
      /** `sha256:` over `text`. */
      readonly hash: string;
      /** Whether the record's tree was checked against the page's own tree. */
      readonly treeChecked: boolean;
    }
  | { readonly ok: false; readonly reason: string };

const CHANNELS = new Set(['state', 'filter', 'selection', 'query']);
const FORMS = new Set(['wire', 'scalar']);

const TOP_MEMBERS = ['board', 'locale', 'now', 'parameters', 'sources', 'tree'];
const PARAMETER_MEMBERS = ['channel', 'form', 'key', 'value'];
const SOURCE_MEMBERS = ['channel', 'form', 'head', 'key', 'length', 'stream'];

type JsonObject = { readonly [key: string]: JsonValue };

const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The members must be exactly `expected` — no fewer, no more. */
const membersAre = (o: JsonObject, expected: readonly string[]): string | undefined => {
  const keys = Object.keys(o).sort();
  for (const k of expected) if (!keys.includes(k)) return `member '${k}' is missing`;
  for (const k of keys) if (!expected.includes(k)) return `member '${k}' is not a record member`;
  return undefined;
};

const channelProblem = (entry: JsonObject): string | undefined => {
  if (typeof entry['channel'] !== 'string' || !CHANNELS.has(entry['channel']))
    return `channel '${String(entry['channel'])}' is not state, filter, selection or query`;
  if (typeof entry['key'] !== 'string') return "an entry's key is not a string";
  if (typeof entry['form'] !== 'string' || !FORMS.has(entry['form']))
    return `form '${String(entry['form'])}' is not wire or scalar`;
  return undefined;
};

/**
 * Why `value` is not a board snapshot record, or `undefined` when it is one.
 * The same refusals the reference reader makes, plus the unknown-member rule.
 */
export const recordProblem = (value: unknown): string | undefined => {
  if (!isObject(value)) return 'the record is not an object';
  const top = membersAre(value, TOP_MEMBERS);
  if (top !== undefined) return top;
  if (value['board'] !== BOARD_SNAPSHOT_FORMAT)
    return `format '${String(value['board'])}' is not ${BOARD_SNAPSHOT_FORMAT}`;
  for (const name of ['tree', 'now', 'locale'])
    if (typeof value[name] !== 'string') return `member '${name}' is not a string`;
  const parameters = value['parameters'];
  const sources = value['sources'];
  if (!Array.isArray(parameters)) return "member 'parameters' is not an array";
  if (!Array.isArray(sources)) return "member 'sources' is not an array";
  for (const p of parameters) {
    if (!isObject(p)) return "an entry of 'parameters' is not an object";
    const problem = membersAre(p, PARAMETER_MEMBERS) ?? channelProblem(p);
    if (problem !== undefined) return problem;
  }
  for (const s of sources) {
    if (!isObject(s)) return "an entry of 'sources' is not an object";
    const problem = membersAre(s, SOURCE_MEMBERS) ?? channelProblem(s);
    if (problem !== undefined) return problem;
    if (typeof s['stream'] !== 'string' || typeof s['head'] !== 'string')
      return "a source's stream or head is not a string";
    const length = s['length'];
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0)
      return "a source's length is not a non-negative integer";
  }
  return undefined;
};

/**
 * Read, verify and canonicalise the record a page published. `tree` is the
 * page's root as canonical wire JSON, when the page serves it.
 */
export const reproFrom = async (
  published: readonly PublishedRecord[],
  tree: Capture,
): Promise<Repro> => {
  if (published.length === 0)
    return {
      ok: false,
      reason:
        'this page publishes no board snapshot — its host captures one and places it beside the board',
    };
  if (published.length > 1)
    return {
      ok: false,
      reason: `this page publishes ${published.length} board snapshots, and copying one of them would be a guess`,
    };
  const [only] = published;
  if (only === undefined || only.text === null)
    return { ok: false, reason: 'the published board snapshot is empty' };

  let value: unknown;
  try {
    value = JSON.parse(only.text);
  } catch {
    return { ok: false, reason: 'the published board snapshot is not JSON' };
  }
  const problem = recordProblem(value);
  if (problem !== undefined)
    return { ok: false, reason: `the published board snapshot is not a record: ${problem}` };

  const text = canonicalJson(value as JsonValue);
  const hash = `sha256:${await sha256Hex(text)}`;
  if (only.attribute !== hash)
    return {
      ok: false,
      reason: `the published board snapshot hashes to ${hash}, but the page published it as ${String(
        only.attribute,
      )} — it was edited or half-updated`,
    };

  const record = value as JsonObject;
  if (tree.ok) {
    const onPage = `sha256:${tree.hash}`;
    if (record['tree'] !== onPage)
      return {
        ok: false,
        reason: `the board snapshot names tree ${String(record['tree'])}, but the page now shows ${onPage} — it is stale`,
      };
  }
  return { ok: true, text, hash, treeChecked: tree.ok };
};

/**
 * The expression the panel evaluates in the inspected page to read every
 * published record. Pure DOM, no page code is called.
 */
export const PUBLISHED_RECORDS_EXPRESSION =
  `Array.from(document.querySelectorAll('script[type="${BOARD_SNAPSHOT_MEDIA_TYPE}"]'))` +
  `.map(function (s) { return { attribute: s.getAttribute('${BOARD_SNAPSHOT_HASH_ATTRIBUTE}'), text: s.textContent }; })`;

/** Narrow whatever the page evaluation returned to published records. */
export const asPublishedRecords = (value: unknown): readonly PublishedRecord[] => {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const o = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    return {
      attribute: typeof o['attribute'] === 'string' ? (o['attribute'] as string) : null,
      text: typeof o['text'] === 'string' ? (o['text'] as string) : null,
    };
  });
};
