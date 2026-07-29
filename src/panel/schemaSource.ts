// ============================================================================
//  panel/schemaSource — load the canonical wire schema the editor derives from.
//
//  The schema travels with the extension as a web-accessible resource, copied
//  from the specification checkout at build time rather than vendored into this
//  repository. One home for the artefact, so it cannot drift from the corpus
//  the conformance suite runs against — the two are shipped together and
//  updated together.
//
//  ABSENCE IS A DEGRADED MODE, NOT A FAILURE. A build made without the
//  specification present, or a fetch that fails, leaves the editor deriving
//  nothing and rendering read-only rows with an honest reason. The panel still
//  inspects, still subscribes, still shows refusals. Schema knowledge is an
//  enhancement over the whole surface, and that has to be true of the load
//  itself or it is not true at all.
// ============================================================================

import { kindSchemas, type KindSchema, type WireSchema } from '../schema/wireSchema.js';

export interface DerivedSchema {
  readonly schema: WireSchema;
  readonly kinds: ReadonlyMap<string, KindSchema>;
}

/** The bundled artefact's name inside the extension package. */
export const WIRE_SCHEMA_FILE = 'wire-schema.json';

/**
 * Parse a schema document into the derived form the editor uses. Separate from
 * the fetch so the derivation is testable against the real specification file
 * with no browser.
 */
export const deriveSchema = (document: unknown): DerivedSchema | undefined => {
  if (typeof document !== 'object' || document === null || Array.isArray(document))
    return undefined;
  const schema = document as WireSchema;
  const kinds = kindSchemas(schema);
  // A document that yields no kinds is not a wire schema, whatever else it is.
  // Reporting it as "loaded" would make every kind look unknown, which reads
  // as a page problem rather than a packaging one.
  return kinds.size === 0 ? undefined : { schema, kinds };
};

export const loadWireSchema = async (url: string): Promise<DerivedSchema | undefined> => {
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    return deriveSchema(await response.json());
  } catch {
    return undefined;
  }
};
