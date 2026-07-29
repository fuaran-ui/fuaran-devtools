// ============================================================================
//  test/support/corpus — locate and read the relay conformance corpus.
//
//  The corpus is the `devtools-relay/` family of the shared Fuaran UI
//  specification repository, resolved as a SIBLING checkout at
//  `../wire-format-fixtures`. That path is the interface every conformant host
//  in the family uses, and CI checks the spec repo out to it.
//
//  A missing corpus FAILS LOUDLY rather than skipping. A conformance suite that
//  quietly passes when its fixtures are absent is worse than no suite: it turns
//  the one gate that can catch a protocol regression into a green tick that
//  means nothing.
// ============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const CORPUS_DIR = resolve(here, '../../../wire-format-fixtures/devtools-relay');

export interface CorpusFixture {
  readonly id: string;
  readonly kind: 'relay-exchange' | 'relay-refusal' | 'relay-event';
  readonly requestFile?: string;
  readonly responseFile?: string;
  readonly eventFile?: string;
  readonly expectedClass?: string;
  readonly description?: string;
}

export interface CorpusManifest {
  readonly version: number;
  readonly profile: string;
  readonly fixtures: readonly CorpusFixture[];
}

export const readManifest = (): CorpusManifest => {
  const manifestPath = join(CORPUS_DIR, 'manifest.json');
  if (!existsSync(manifestPath))
    throw new Error(
      `The relay conformance corpus is missing at ${CORPUS_DIR}.\n` +
        'Clone the specification repository as a sibling of this repo:\n' +
        '  git clone https://github.com/fuaran-ui/fuaran-ui-specification ../wire-format-fixtures',
    );
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as CorpusManifest;
};

export const readFixture = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(CORPUS_DIR, file), 'utf8')) as Record<string, unknown>;

/** The canonical wire-format JSON Schema — the artefact the editor derives from. */
export const WIRE_SCHEMA_PATH = resolve(CORPUS_DIR, '../schema.json');

/**
 * Read the real schema, never a fixture of one.
 *
 * A hand-written stand-in would test this repo's idea of the format rather than
 * the format, and the derivation's whole claim is that it tracks the contract:
 * a kind added to the vocabulary must appear here with no change to the code.
 * That claim is only tested against the actual artefact.
 */
export const readWireSchema = (): Record<string, unknown> => {
  if (!existsSync(WIRE_SCHEMA_PATH))
    throw new Error(
      `The canonical wire schema is missing at ${WIRE_SCHEMA_PATH}.\n` +
        'Clone the specification repository as a sibling of this repo:\n' +
        '  git clone https://github.com/fuaran-ui/fuaran-ui-specification ../wire-format-fixtures',
    );
  return JSON.parse(readFileSync(WIRE_SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
};
