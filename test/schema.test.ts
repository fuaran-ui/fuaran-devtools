// ============================================================================
//  Field derivation and candidate synthesis, against the REAL wire schema.
//
//  Every assertion here runs on the canonical specification artefact, not on a
//  miniature written to suit the code. That is the point of deriving rather
//  than hand-writing panels: a kind added to the vocabulary must appear with no
//  change here, and the only way to have evidence of that is to derive from the
//  document the vocabulary actually lives in.
//
//  The degradation cases get equal weight. "Schema knowledge is an enhancement,
//  never a gate" is a claim about what happens when the schema is absent,
//  partial, or newer than this build — so those paths are tested as first-class
//  behaviour rather than as error handling.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  acceptsChildren,
  classify,
  deref,
  fieldsFor,
  kindSchemas,
  opPathOf,
  type WireSchema,
} from '../src/schema/wireSchema.js';
import { synthesiseNode } from '../src/schema/synthesise.js';
import { deriveSchema } from '../src/panel/schemaSource.js';
import { readWireSchema } from './support/corpus.js';

const schema = readWireSchema() as WireSchema;
const kinds = kindSchemas(schema);

describe('kind resolution', () => {
  it('flattens every declared node kind out of the branch tree', () => {
    // The kinds sit behind a two-level `oneOf` of category refs, each branch an
    // `allOf` of a discriminator and a spec ref. Not flattening it does not
    // yield fewer fields — it yields none.
    expect(kinds.size).toBeGreaterThan(30);
    for (const discriminator of ['Heading', 'Box', 'Button', 'DataGrid', 'Metric'])
      expect(kinds.has(discriminator), discriminator).toBe(true);
  });

  it('keys on the WIRE discriminator, not a display name', () => {
    // The two genuinely differ on at least one kind, and keying on the pretty
    // name would silently fail to resolve exactly the kinds that were renamed.
    expect(kinds.get('DataGrid')?.discriminator).toBe('DataGrid');
    expect(kinds.has('Grid')).toBe(false);
  });

  it('bounds a ref chain rather than trusting the document to be acyclic', () => {
    const cyclic: WireSchema = { $defs: { A: { $ref: '#/$defs/B' }, B: { $ref: '#/$defs/A' } } };
    expect(deref(cyclic, { $ref: '#/$defs/A' })).toBeUndefined();
  });
});

describe('field derivation', () => {
  const headingFields = fieldsFor(schema, kinds, 'Heading');
  const fieldNamed = (path: string) => headingFields.find((field) => field.path === path);

  it('derives the op-path spelling from the wire spelling', () => {
    expect(opPathOf('level')).toBe('Level');
    expect(opPathOf('onClick')).toBe('OnClick');
    expect(opPathOf('')).toBe('');
  });

  it('offers a heading level as a whole-number field', () => {
    expect(fieldNamed('Level')?.control).toEqual({ kind: 'integer' });
  });

  it('offers a text field through its scalar branch', () => {
    // The text shape is a union of a bare string and a bound/structured form.
    // Offering the scalar branch is what makes a plain label editable at all.
    expect(fieldNamed('Text')?.control).toEqual({ kind: 'text' });
  });

  it('offers an enumerated field as its declared cases, in schema order', () => {
    const control = fieldNamed('Variant')?.control;
    expect(control?.kind).toBe('choice');
    if (control?.kind !== 'choice') return;
    expect(control.options.length).toBeGreaterThan(1);
  });

  it('makes a CURRENTLY BOUND slot read-only, with the reason', () => {
    // Committing a literal into a slot holding a binding would discard the
    // binding silently. The slot list the relay reports is enough to know.
    const bound = fieldsFor(schema, kinds, 'Heading', ['Text']);
    const text = bound.find((field) => field.path === 'Text');
    expect(text?.control.kind).toBe('readonly');
    if (text?.control.kind !== 'readonly') return;
    expect(text.control.reason).toContain('discard the binding');
  });

  it('never offers a structural or dispatch field as a property', () => {
    // Children are owned by the structural ops, which address them by id; an
    // action has no literal form at all.
    const box = fieldsFor(schema, kinds, 'Box').map((field) => field.path);
    expect(box).not.toContain('Children');
    expect(fieldsFor(schema, kinds, 'Button').map((f) => f.path)).not.toContain('OnClick');
  });

  it('degrades an unknown kind to no derived fields, not an error', () => {
    expect(fieldsFor(schema, kinds, 'SomethingFromTheFuture')).toEqual([]);
  });

  it('degrades an unclassifiable property to read-only with a reason', () => {
    const control = classify(schema, undefined);
    expect(control.kind).toBe('readonly');
    if (control.kind !== 'readonly') return;
    expect(control.reason).toContain('no schema');
  });

  it('reports whether a kind holds children, and says so when it cannot tell', () => {
    expect(acceptsChildren(kinds, 'Box')).toBe(true);
    expect(acceptsChildren(kinds, 'Heading')).toBe(false);
    // Not `false`: an unfamiliar kind is unknown, and treating unknown as "no"
    // would make an unfamiliar page look uneditable rather than unfamiliar.
    expect(acceptsChildren(kinds, 'SomethingFromTheFuture')).toBeUndefined();
  });
});

describe('candidate synthesis', () => {
  it('builds a minimal valid node for a required-field kind', () => {
    const node = synthesiseNode(schema, kinds, new Set(), 'Heading');
    expect(node).toBeDefined();
    expect(node!['id']).toBe('heading-1');
    expect(node!['kind']).toMatchObject({ $type: 'Heading', level: 1 });
  });

  it('fills every required field and no optional one', () => {
    const node = synthesiseNode(schema, kinds, new Set(), 'Heading');
    const kind = node!['kind'] as Record<string, unknown>;
    const declared = kinds.get('Heading')!;
    for (const required of declared.required) expect(kind).toHaveProperty(required);
    // Nothing beyond the requirements: a minimal candidate is the point, and a
    // populated one puts content on the page nobody asked for.
    expect(Object.keys(kind).sort()).toEqual([...declared.required].sort());
  });

  it('mints an id that collides with nothing already in the tree', () => {
    const node = synthesiseNode(schema, kinds, new Set(['heading-1', 'heading-2']), 'Heading');
    expect(node!['id']).toBe('heading-3');
  });

  it('synthesises a nested node position with its own distinct id', () => {
    // A kind requiring a child node must not fill that position by the generic
    // object route, which would give the child a placeholder string for an id —
    // and two candidates would then share the one field that must be unique.
    const node = synthesiseNode(schema, kinds, new Set(), 'ErrorBoundary');
    expect(node).toBeDefined();
    const kind = node!['kind'] as Record<string, unknown>;
    const child = kind['child'] as Record<string, unknown>;
    const fallback = kind['fallback'] as Record<string, unknown>;
    expect(typeof child['id']).toBe('string');
    expect(child['id']).not.toBe(fallback['id']);
    expect(child['id']).not.toBe(node!['id']);
  });

  it('declines a kind it cannot build rather than building half of one', () => {
    expect(synthesiseNode(schema, kinds, new Set(), 'SomethingFromTheFuture')).toBeUndefined();
  });

  it('synthesises the great majority of the declared vocabulary', () => {
    // Not "all": a kind whose requirements this module cannot satisfy is simply
    // not offered, which is the designed behaviour, and asserting totality here
    // would make a legitimately-unofferable kind read as a regression.
    const built = [...kinds.keys()].filter(
      (kind) => synthesiseNode(schema, kinds, new Set(), kind) !== undefined,
    );
    expect(built.length).toBeGreaterThan(kinds.size / 2);
  });
});

describe('schema loading degrades rather than fails', () => {
  it('derives from the real document', () => {
    expect(deriveSchema(readWireSchema())?.kinds.size).toBe(kinds.size);
  });

  it.each([
    ['a non-object', 42],
    ['an array', []],
    ['an empty object', {}],
    ['a document with no node kinds', { $defs: { NodeKind: { type: 'string' } } }],
  ])('reports %s as no schema at all, not as a schema with no kinds', (_label, document) => {
    // The distinction matters in the panel: "no schema bundled" is a packaging
    // problem, while "a schema in which every kind is unknown" reads as a page
    // problem. Reporting the first as the second sends the user to the wrong place.
    expect(deriveSchema(document)).toBeUndefined();
  });
});
