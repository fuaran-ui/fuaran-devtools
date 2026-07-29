// ============================================================================
//  schema/synthesise — minimal-valid node candidates from the wire schema.
//
//  The insert palette does not hold a hand-written template per kind. It asks
//  the schema what each kind REQUIRES and fills each required position with the
//  least value that position admits: the fixed value if the schema fixes one,
//  the first case of an enumeration, a placeholder string named for the field,
//  the smallest sensible number, an empty collection, and — recursively — a
//  minimal node wherever a node is required.
//
//  Two consequences are the point of doing it this way. A kind added to the
//  vocabulary appears in the palette with no code change here. And a kind whose
//  requirements this module cannot satisfy is NOT OFFERED at all, rather than
//  offered and refused on click: the candidate that cannot be built is the
//  candidate the user should never have seen.
//
//  Pure and schema-driven; no host, no DOM, no network.
// ============================================================================

import { deref, refName, type KindSchema, type SchemaNode, type WireSchema } from './wireSchema.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A synthesis either produced a value or could not — never a partial one. */
type Synth = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

const missing: Synth = { ok: false };
const made = (value: unknown): Synth => ({ ok: true, value });

/** A placeholder string named for the position it fills, so the result reads. */
const placeholder = (hint: string): string =>
  hint.length === 0 ? 'Text' : hint[0]!.toUpperCase() + hint.slice(1);

/**
 * Mint ids that collide with nothing already in the tree.
 *
 * Tree-wide, not sibling-local: node ids address the whole tree, so a candidate
 * whose id merely happens not to clash with its new siblings is a candidate
 * that will be refused — or, worse, applied against the wrong node.
 */
export const mintId = (taken: ReadonlySet<string>, discriminator: string): string => {
  const stem = discriminator.toLowerCase();
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = `${stem}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}`;
};

export interface SynthesisContext {
  readonly schema: WireSchema;
  readonly kinds: ReadonlyMap<string, KindSchema>;
  /** Every id already in the tree, plus every id minted during this synthesis. */
  readonly taken: Set<string>;
}

const synthKind = (context: SynthesisContext, discriminator: string, depth: number): Synth => {
  const kind = context.kinds.get(discriminator);
  if (kind === undefined || depth > 8) return missing;

  const out: Record<string, unknown> = { $type: discriminator };
  for (const name of kind.required) {
    if (name === '$type') continue;
    const property = kind.properties[name];
    if (property === undefined) return missing;
    const value = synth(context, property, depth + 1, name);
    if (!value.ok) return missing;
    out[name] = value.value;
  }
  return made(out);
};

/** Build one minimal node — the `{ id, kind }` pair a node position requires. */
const synthNode = (context: SynthesisContext, depth: number): Synth => {
  if (depth > 8) return missing;
  // A node position needs a kind before it needs an id, and any kind will do:
  // the FIRST kind the schema declares that can itself be synthesised. Minting
  // the id first would leak an id into `taken` for a node that never gets built.
  for (const discriminator of context.kinds.keys()) {
    const kind = synthKind(context, discriminator, depth + 1);
    if (!kind.ok) continue;
    const id = mintId(context.taken, discriminator);
    context.taken.add(id);
    return made({ id, kind: kind.value });
  }
  return missing;
};

const synth = (context: SynthesisContext, node: SchemaNode, depth: number, hint: string): Synth => {
  if (depth > 8) return missing;

  // Checked BEFORE dereferencing: a node position resolved generically would
  // fill its `id` with a placeholder string, and two candidates would then
  // carry the same id — the one field in the whole format that must be unique.
  if (refName(node) === 'Node') return synthNode(context, depth);

  const resolved = deref(context.schema, node);
  if (resolved === undefined) return missing;

  if ('const' in resolved) return made(resolved['const']);

  const enumeration = resolved['enum'];
  if (Array.isArray(enumeration)) return enumeration.length === 0 ? missing : made(enumeration[0]);

  const type = resolved['type'];
  switch (type) {
    case 'string':
      return made(placeholder(hint));
    case 'integer':
      return made(1);
    case 'number':
      return made(0);
    case 'boolean':
      return made(false);
    case 'array':
      // The empty collection, never a synthesised element: a required array
      // says a field exists, not that it must be populated, and inventing a
      // first row would put content on the page nobody asked for.
      return made([]);
    case 'object': {
      const properties = resolved['properties'];
      const required = resolved['required'];
      const out: Record<string, unknown> = {};
      if (Array.isArray(required) && isObject(properties))
        for (const name of required) {
          if (typeof name !== 'string') return missing;
          const property = properties[name];
          if (!isObject(property)) return missing;
          const value = synth(context, property, depth + 1, name);
          if (!value.ok) return missing;
          out[name] = value.value;
        }
      return made(out);
    }
    default:
      break;
  }

  const allOf = resolved['allOf'];
  if (Array.isArray(allOf)) {
    const merged: Record<string, unknown> = {};
    for (const member of allOf) {
      if (!isObject(member)) return missing;
      const value = synth(context, member, depth + 1, hint);
      if (!value.ok || !isObject(value.value)) return missing;
      Object.assign(merged, value.value);
    }
    return made(merged);
  }

  const oneOf = resolved['oneOf'];
  if (Array.isArray(oneOf))
    for (const branch of oneOf) {
      if (!isObject(branch)) continue;
      const value = synth(context, branch, depth + 1, hint);
      if (value.ok) return value;
    }

  return missing;
};

/** A minimal-valid node of `discriminator`, or `undefined` if none can be built. */
export const synthesiseNode = (
  schema: WireSchema,
  kinds: ReadonlyMap<string, KindSchema>,
  taken: ReadonlySet<string>,
  discriminator: string,
): Readonly<Record<string, unknown>> | undefined => {
  const context: SynthesisContext = { schema, kinds, taken: new Set(taken) };
  const kind = synthKind(context, discriminator, 0);
  if (!kind.ok) return undefined;
  const id = mintId(context.taken, discriminator);
  return { id, kind: kind.value };
};
