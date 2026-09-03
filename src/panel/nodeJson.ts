// ============================================================================
//  panel/nodeJson — reading a node's own canonical wire JSON, by op path.
//
//  `read.nodeJson` (§7.7) hands back the host's canonical encoding of one node,
//  whole subtree, as a structured object. This module is the only place that
//  looks inside it, and everything here is pure so the read half of the editor
//  is testable against real fixture payloads with no browser and no relay.
//
//  ── The two spellings, and where they meet ─────────────────────────────────
//
//  An op addresses a field by its OP PATH — `Level`, `Columns[0].Label` — and
//  the wire encoding spells the same field with a lower-cased leading character
//  (`level`, `columns[0].label`). `schema/wireSchema` owns that inverse
//  (`opPathOf`); this module walks it in the reading direction.
//
//  Node kind properties live under `kind`, because that is where the wire
//  format puts them: a node is `{ id, kind: { $type, …properties }, style?, … }`.
//  The style block is the one thing addressed at the NODE level rather than
//  inside the kind, which is why it has its own accessor here rather than being
//  a path like any other.
//
//  ── What this module refuses to do ────────────────────────────────────────
//
//  It never rewrites, normalises, or re-orders the payload. §7.7 rule 1 puts
//  the encoding in the host's hands and says member order is not observable, so
//  anything here that reshaped it would be inventing a second projection of a
//  document this build does not own.
// ============================================================================

import { isSentinel } from '../relay/protocol.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The wire spelling of an op-path segment: the leading character lower-cased. */
export const wireNameOf = (segment: string): string =>
  segment.length === 0 ? segment : segment[0]!.toLowerCase() + segment.slice(1);

/** One step of an op path: a named member, optionally indexed. */
interface Step {
  readonly name: string;
  readonly index?: number;
}

const STEP = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\[(\d+)\])?$/;

/**
 * Split an op path into its steps, or `undefined` when it is not one.
 *
 * Refusing an unparseable path rather than best-guessing it is deliberate: the
 * only caller is deriving a READ from a path it is about to also WRITE, and a
 * path this module silently mis-parsed would show one field's value beside
 * another field's editor.
 */
export const parsePath = (path: string): readonly Step[] | undefined => {
  if (path === '') return undefined;
  const steps: Step[] = [];
  for (const segment of path.split('.')) {
    const match = STEP.exec(segment);
    if (match === null) return undefined;
    const [, name, index] = match;
    if (name === undefined) return undefined;
    steps.push(index === undefined ? { name } : { name, index: Number(index) });
  }
  return steps;
};

/**
 * The value at an op path inside a node's wire JSON, or `undefined` when the
 * path does not resolve.
 *
 * `undefined` deliberately conflates "absent" with "not resolvable" — a wire
 * document has no `undefined`, so the two are the same fact from the editor's
 * side: there is nothing here to show. What must NOT be conflated with either
 * is a present `null`, which is why that comes back as `null`.
 */
export const valueAtPath = (node: Readonly<Record<string, unknown>>, path: string): unknown => {
  const steps = parsePath(path);
  if (steps === undefined) return undefined;
  // Kind properties hang off `kind`; the walk starts there because that is
  // where an `UpdateProp` path is rooted.
  let current: unknown = node['kind'];
  for (const step of steps) {
    if (!isObject(current)) return undefined;
    let next: unknown = current[wireNameOf(step.name)];
    if (step.index !== undefined) {
      if (!Array.isArray(next)) return undefined;
      next = next[step.index];
    }
    current = next;
  }
  return current;
};

/**
 * The length of the collection at an op path, or `undefined` when there is no
 * array there.
 *
 * This is the number no other read in the contract reports, and it is the whole
 * reason an indexed path could not be derived before §7.7 — see the editor's
 * indexed-row derivation, which never offers an index this did not authorise.
 */
export const collectionLength = (
  node: Readonly<Record<string, unknown>>,
  path: string,
): number | undefined => {
  const value = valueAtPath(node, path);
  return Array.isArray(value) ? value.length : undefined;
};

/**
 * The node's style block as the encoding carries it — `{}` when it carries none.
 *
 * An absent block and an empty one are the same starting point for editing (the
 * phase's "an absent block edits from empty"), and they stay distinguishable
 * where it matters: `mergeStyle` below returns an empty object for a block that
 * ends up with no tokens, and the caller decides whether emitting that is an
 * edit worth making.
 */
export const styleBlock = (
  node: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const style = node['style'];
  return isObject(style) ? style : {};
};

/**
 * The whole style block, with `changes` applied over it.
 *
 * SPREAD OVER THE READ, never rebuilt from the editor's own fields. That is
 * what makes "a single-token edit preserves every other token" true by
 * construction rather than by the editor happening to render a control for
 * every token — including tokens this build's schema has never heard of, which
 * a rebuild-from-controls would silently drop on the first page running a newer
 * vocabulary.
 *
 * A change whose value is `undefined` CLEARS the token, because that is the
 * only way an editor can express "remove this" through an op that replaces the
 * whole block. A cleared token is deleted rather than set to null: the wire
 * format's absent-optional is absence, and `null` is a different document.
 */
export const mergeStyle = (
  block: Readonly<Record<string, unknown>>,
  changes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const merged: Record<string, unknown> = { ...block };
  for (const [token, value] of Object.entries(changes)) {
    if (value === undefined) delete merged[token];
    else merged[token] = value;
  }
  return merged;
};

/**
 * Whether any value inside `value` is a sentinel (§7.7 rule 2).
 *
 * Used as the LAST guard before an op is emitted, over the whole value rather
 * than over the scalar an editor happens to hold: a style block or a collection
 * element carrying `"<closure>"` several members deep is exactly the payload
 * rule 2 forbids sending back, and a shallow check would pass it.
 */
export const carriesSentinel = (value: unknown): boolean => {
  if (isSentinel(value)) return true;
  if (Array.isArray(value)) return value.some(carriesSentinel);
  if (isObject(value)) return Object.values(value).some(carriesSentinel);
  return false;
};

/**
 * How a read value is rendered in a field that shows it.
 *
 * Only scalars round-trip through a text control, so anything structured is
 * shown as its JSON rather than as `[object Object]` — which reads as a value
 * the user could retype, and is not one. The editor gives those rows a
 * read-only control anyway; this is what goes in the row.
 */
export const displayValue = (value: unknown): string => {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
};
