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

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The specification checkout itself — the relay corpus is one family in it. */
export const SPEC_DIR = resolve(here, '../../../wire-format-fixtures');

export const CORPUS_DIR = join(SPEC_DIR, 'devtools-relay');

const CLONE_HINT =
  'Clone the specification repository as a sibling of this repo:\n' +
  '  git clone https://github.com/fuaran-ui/fuaran-ui-specification ../wire-format-fixtures';

/**
 * A specification file's BYTES, unparsed.
 *
 * The canonical fixtures are stored in canonical byte form, so the encoder here
 * has a fixed-point property that can only be checked against the bytes — parse
 * them and the property being tested is gone.
 */
export const readSpecText = (relative: string): string => {
  const path = join(SPEC_DIR, relative);
  if (!existsSync(path)) throw new Error(`Missing specification file ${path}.\n${CLONE_HINT}`);
  // The trailing newline is a file convention, not part of the canonical bytes.
  return readFileSync(path, 'utf8').replace(/\s+$/, '');
};

export const readSpecJson = <T>(relative: string): T => JSON.parse(readSpecText(relative)) as T;

/**
 * Every canonical fixture in a specification family, by path.
 *
 * Enumerated from the DIRECTORY rather than from a list written here, so a
 * fixture added upstream is covered without anyone remembering to add it — the
 * conformance claim is about the format, not about the fixtures this repo
 * happened to know about when it was written.
 */
export const listSpecFixtures = (family: string): readonly string[] => {
  const path = join(SPEC_DIR, family);
  if (!existsSync(path)) throw new Error(`Missing specification family ${path}.\n${CLONE_HINT}`);
  return readdirSync(path)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => `${family}/${name}`);
};

/** One golden record of the cross-host op-stream chain corpus. */
export interface ChainRecord {
  readonly opFixture: string;
  readonly sequence: number;
  readonly actor:
    | { readonly kind: 'human'; readonly id: string }
    | {
        readonly kind: 'agent';
        readonly model: string;
        readonly version: string;
        readonly id: string;
      };
  readonly promptId: string | null;
  readonly result: { readonly kind: string; readonly code?: string; readonly message?: string };
  readonly timestampUnixSeconds: number;
  readonly previousHash: string;
  readonly hash: string;
}

export interface ChainCorpus {
  readonly version: number;
  readonly genesisPreviousHash: string;
  readonly records: readonly ChainRecord[];
}

export const readChainCorpus = (): ChainCorpus =>
  readSpecJson<ChainCorpus>('chain/chain-corpus.json');

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
