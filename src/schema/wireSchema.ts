// ============================================================================
//  schema/wireSchema — per-kind field derivation from the canonical JSON Schema.
//
//  WHY A SCHEMA AT ALL, AND WHICH ONE
//
//  The relay's read set (§7) answers "what is in this tree": a node's kind, its
//  BOUND binding slots, its child ids, one slot's resolved value, geometry, and
//  a kind lookup. It deliberately answers nothing about what a kind COULD hold
//  — there is no `read.kindSchema` in `relay@1.0` — so an editor that waited
//  for the host to describe its own vocabulary would wait forever.
//
//  The description exists, and it is not a host's: `schema.json` in the wire
//  format specification is the canonical Draft 2020-12 schema for the whole
//  format, generated from the type definitions and shipped beside the
//  conformance corpus this repo already resolves as a sibling checkout. Reading
//  it is reading the CONTRACT, which is the same posture `relay/protocol` takes
//  — written from the specification, pinned against its fixtures, importing no
//  host.
//
//  (The typed schema PACKAGE is a different artefact and would not do: it
//  carries compile-time types plus defaults, which erase at runtime and
//  describe one tier's idea of the vocabulary. What is wanted here is data
//  about the format, available at runtime, that no host tier owns.)
//
//  SCHEMA KNOWLEDGE IS AN ENHANCEMENT, NEVER A GATE
//
//  Every entry point below degrades rather than refuses. No schema loaded, a
//  kind absent from the one loaded, a property whose shape this module cannot
//  classify — each yields a READ-ONLY row carrying an honest reason, never an
//  empty panel and never a thrown error. That is the specification's own
//  tolerate-the-unknown posture applied to the editor: a page running a newer
//  vocabulary than this build knows is a page to inspect, not a page to refuse.
//
//  Everything here is pure and takes the schema document as data, so the
//  derivation is unit-testable against the real specification artefact with no
//  browser, no extension host, and no network.
// ============================================================================

/** A JSON Schema node, as far as this module needs to understand one. */
export type SchemaNode = Readonly<Record<string, unknown>>;

/** The canonical wire-format schema document. */
export interface WireSchema {
  readonly $defs?: Readonly<Record<string, SchemaNode>>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const DEF_PREFIX = '#/$defs/';

/** The `$defs` name a `$ref` points at, or `undefined` for a foreign ref. */
export const refName = (node: SchemaNode): string | undefined => {
  const ref = node['$ref'];
  return typeof ref === 'string' && ref.startsWith(DEF_PREFIX)
    ? ref.slice(DEF_PREFIX.length)
    : undefined;
};

/**
 * Follow `$ref` chains to the node they name. Bounded rather than trusting the
 * document to be acyclic: a schema is data from a file, and a cycle here would
 * hang the panel rather than report a defect.
 */
export const deref = (schema: WireSchema, node: SchemaNode | undefined): SchemaNode | undefined => {
  let current = node;
  for (let hops = 0; hops < 16; hops += 1) {
    if (current === undefined) return undefined;
    const name = refName(current);
    if (name === undefined) return current;
    current = schema.$defs?.[name];
  }
  return undefined;
};

// ─── Kind resolution ────────────────────────────────────────────────

/** One node kind's shape, flattened out of the schema's branch tree. */
export interface KindSchema {
  readonly discriminator: string;
  readonly properties: Readonly<Record<string, SchemaNode>>;
  readonly required: readonly string[];
}

/**
 * The `$type` const a branch declares. Not dereferenced: the discriminator is
 * always written inline on the branch itself (a ref could only name a shared
 * shape, which by definition is not the thing that distinguishes this kind).
 */
const discriminatorOf = (branch: SchemaNode): string | undefined => {
  const properties = branch['properties'];
  if (isObject(properties)) {
    const marker = properties['$type'];
    if (isObject(marker) && typeof marker['const'] === 'string') return marker['const'];
  }
  const allOf = branch['allOf'];
  if (Array.isArray(allOf))
    for (const member of allOf) {
      if (!isObject(member)) continue;
      const found = discriminatorOf(member);
      if (found !== undefined) return found;
    }
  return undefined;
};

/**
 * Merge a branch's `allOf` members into one properties/required pair.
 *
 * A kind branch is written as `allOf: [ { $type: const }, { $ref: <Kind>Spec } ]`
 * — the discriminator and the shape are separate members, and the shape is
 * behind a ref. Flattening is therefore not an optimisation; without it a
 * kind's fields are simply not reachable from its branch.
 */
const flatten = (
  schema: WireSchema,
  branch: SchemaNode,
  properties: Record<string, SchemaNode>,
  required: string[],
  depth = 0,
): void => {
  if (depth > 8) return;
  const resolved = deref(schema, branch);
  if (resolved === undefined) return;

  const own = resolved['properties'];
  if (isObject(own))
    for (const [name, value] of Object.entries(own)) if (isObject(value)) properties[name] = value;

  const req = resolved['required'];
  if (Array.isArray(req))
    for (const name of req)
      if (typeof name === 'string' && !required.includes(name)) required.push(name);

  const allOf = resolved['allOf'];
  if (Array.isArray(allOf))
    for (const member of allOf)
      if (isObject(member)) flatten(schema, member, properties, required, depth + 1);
};

/**
 * Every node kind the schema declares, keyed by wire discriminator.
 *
 * The discriminator is the `$type` token, NOT any host's display name for the
 * kind — the two genuinely differ, and keying on a display name would silently
 * fail to resolve exactly the kinds whose names were prettified.
 */
export const kindSchemas = (schema: WireSchema): ReadonlyMap<string, KindSchema> => {
  const out = new Map<string, KindSchema>();
  const seen = new Set<SchemaNode>();

  const walk = (node: SchemaNode | undefined, depth: number): void => {
    if (node === undefined || depth > 8) return;
    const resolved = deref(schema, node);
    if (resolved === undefined || seen.has(resolved)) return;

    const oneOf = resolved['oneOf'];
    if (Array.isArray(oneOf)) {
      seen.add(resolved);
      for (const branch of oneOf) if (isObject(branch)) walk(branch, depth + 1);
      return;
    }

    const discriminator = discriminatorOf(resolved);
    if (discriminator === undefined) return;
    const properties: Record<string, SchemaNode> = {};
    const required: string[] = [];
    flatten(schema, resolved, properties, required);
    out.set(discriminator, { discriminator, properties, required });
  };

  walk(schema.$defs?.['NodeKind'], 0);
  return out;
};

// ─── Field derivation ───────────────────────────────────────────────

/** How one field is edited, or why it cannot be. */
export type Control =
  | { readonly kind: 'text' }
  | { readonly kind: 'integer' }
  | { readonly kind: 'number' }
  | { readonly kind: 'toggle' }
  | { readonly kind: 'choice'; readonly options: readonly string[] }
  | { readonly kind: 'readonly'; readonly reason: string };

/** One derived row of the property editor. */
export interface Field {
  /** The op path an `UpdateProp` addresses this field by. */
  readonly path: string;
  /** The schema's own property name — the wire spelling. */
  readonly wireName: string;
  readonly control: Control;
}

/**
 * The op-path spelling of a wire property name: the wire form lower-cases the
 * leading character, and the op path is that inverse. Stated as one function
 * because it is the single point where the two spellings meet.
 */
export const opPathOf = (wireName: string): string =>
  wireName.length === 0 ? wireName : wireName[0]!.toUpperCase() + wireName.slice(1);

const SCALAR_CONTROLS: Readonly<Record<string, Control>> = {
  string: { kind: 'text' },
  integer: { kind: 'integer' },
  number: { kind: 'number' },
  boolean: { kind: 'toggle' },
};

/**
 * Fields this module never offers, whatever their schema says.
 *
 * `$type` is the discriminator — changing it is a different op on a different
 * surface, not a property edit. Node-valued and Node-array-valued fields are
 * owned by the structural ops, which address them by id rather than by value.
 * `Action` is a dispatch target with no literal form at all.
 */
const STRUCTURAL_REFS = new Set(['Node', 'Action']);

const isStructural = (property: SchemaNode): boolean => {
  const name = refName(property);
  if (name !== undefined && STRUCTURAL_REFS.has(name)) return true;
  const items = property['items'];
  if (isObject(items)) {
    const itemName = refName(items);
    if (itemName !== undefined && STRUCTURAL_REFS.has(itemName)) return true;
  }
  return false;
};

/**
 * Classify one property's schema into an editing control.
 *
 * The union rule is the load-bearing one. A `oneOf` whose branches include a
 * bare scalar AND a bound/structured form (the text-source shape: a literal
 * string, or an object carrying a binding) is offered as its scalar branch —
 * that is what makes a plain label editable. But committing a literal into a
 * slot that currently holds a BINDING would discard the binding silently, so
 * the caller passes `bound` and the field goes read-only with that reason. The
 * binding is not damaged by an edit that was never offered.
 */
export const classify = (
  schema: WireSchema,
  property: SchemaNode | undefined,
  options: { readonly bound?: boolean } = {},
): Control => {
  if (options.bound === true)
    return {
      kind: 'readonly',
      reason: 'currently bound — committing a literal here would discard the binding',
    };

  const resolved = deref(schema, property);
  if (resolved === undefined)
    return { kind: 'readonly', reason: 'this kind publishes no schema for the field' };

  if ('const' in resolved) return { kind: 'readonly', reason: 'fixed by the schema' };

  const enumeration = resolved['enum'];
  if (Array.isArray(enumeration)) {
    const optionsList = enumeration.filter((value): value is string => typeof value === 'string');
    return optionsList.length === 0
      ? { kind: 'readonly', reason: 'the schema declares no selectable value' }
      : { kind: 'choice', options: optionsList };
  }

  const type = resolved['type'];
  if (typeof type === 'string') {
    const control = SCALAR_CONTROLS[type];
    if (control !== undefined) return control;
    return {
      kind: 'readonly',
      reason:
        type === 'array' || type === 'object'
          ? 'a structured value — not editable as a single field'
          : `unhandled schema type '${type}'`,
    };
  }

  const oneOf = resolved['oneOf'];
  if (Array.isArray(oneOf))
    for (const branch of oneOf) {
      if (!isObject(branch)) continue;
      const inner = classify(schema, branch);
      if (inner.kind !== 'readonly') return inner;
    }

  const allOf = resolved['allOf'];
  if (Array.isArray(allOf))
    for (const member of allOf) {
      if (!isObject(member)) continue;
      const inner = classify(schema, member);
      if (inner.kind !== 'readonly') return inner;
    }

  return { kind: 'readonly', reason: 'no literal form this editor can offer' };
};

/**
 * The editor's rows for one kind, given the slots the node currently binds.
 *
 * Only TOP-LEVEL properties are derived. The schema also describes indexed
 * paths inside collection-valued fields (a grid column's label, say), and the
 * op grammar addresses them — but expanding `[i]` needs the collection's
 * CURRENT LENGTH, and `relay@1.0` serves no read that reports it. Deriving
 * them anyway would offer rows addressing indices that may not exist, which is
 * worse than not offering them: the refusal would arrive after the edit rather
 * than instead of it.
 *
 * An unresolvable kind yields `[]` — the caller renders the honest "no schema
 * for this kind" state rather than an editor with nothing in it.
 */
export const fieldsFor = (
  schema: WireSchema,
  kinds: ReadonlyMap<string, KindSchema>,
  discriminator: string,
  boundSlots: readonly string[] = [],
): readonly Field[] => {
  const kind = kinds.get(discriminator);
  if (kind === undefined) return [];
  const bound = new Set(boundSlots);

  const fields: Field[] = [];
  for (const [wireName, property] of Object.entries(kind.properties)) {
    if (wireName === '$type') continue;
    if (isStructural(property)) continue;
    const path = opPathOf(wireName);
    // Binding slots are named in the op-path spelling on the wire, which is
    // the spelling the relay's `bindings` list uses — so the membership test
    // is against the path, never the schema's own name.
    fields.push({
      path,
      wireName,
      control: classify(schema, property, { bound: bound.has(path) }),
    });
  }
  return fields;
};

/**
 * Whether a kind can hold children at all, as far as the schema says.
 *
 * `undefined` means "the schema does not say" — an unknown kind, or no schema
 * loaded — and the caller must then proceed optimistically rather than hide
 * the affordance. Hiding on ignorance would make an unfamiliar page look
 * uneditable when it is merely unfamiliar.
 */
export const acceptsChildren = (
  kinds: ReadonlyMap<string, KindSchema>,
  discriminator: string,
): boolean | undefined => {
  const kind = kinds.get(discriminator);
  if (kind === undefined) return undefined;
  const children = kind.properties['children'];
  if (children === undefined) return false;
  const items = children['items'];
  return isObject(items) && refName(items) === 'Node';
};
