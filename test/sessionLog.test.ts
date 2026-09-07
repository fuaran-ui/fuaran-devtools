// ============================================================================
//  The exported document, asserted on BYTES.
//
//  The op-shape suite already makes the argument for byte assertions on ops: an
//  op is not environment-specific, and a renamed field or a silently-added leg
//  is exactly the regression worth catching. It goes double here. The whole
//  point of this envelope is that its shared prefix is byte-compatible with the
//  session-op-log document, so that the day a wire-JSON read lands the change
//  is two fields and a marker. A shape assertion would not notice the prefix
//  drifting; only the bytes will.
//
//  The reference bytes below were checked against a real session-op-log
//  document produced by the playground's own exporter: this writer re-emits
//  that document byte-for-byte from its parsed parts, which is what pins the
//  field order, the actor's insertion ordering, and the verbatim splicing of
//  each op's canonical bytes. That document is not reproduced here — what is
//  reproduced is the SHAPE it proved, in fixtures this repo owns.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  SESSION_LOG_MARKER,
  STRUCTURE_SHAPE_NOTE,
  TRAIL_MARKER,
  TRAIL_VERSION,
  writeSessionLog,
  writeTrailDocument,
  type LoggedOp,
  type SessionNote,
  type TrailDocumentInput,
} from '../src/trail/sessionLog.js';
import { GENESIS_PREVIOUS_HASH } from '../src/trail/hashChain.js';
import { capture, NOT_ATTEMPTED, type Capture, type WireNode } from '../src/trail/capture.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const ops: readonly LoggedOp[] = [
  {
    seq: 1,
    actor: { kind: 'human', id: 'devtools' },
    prevHash: GENESIS_PREVIOUS_HASH,
    hash: HASH_A,
    opJson: '{"$type":"UpdateProp","path":"Text","target":"title","value":"Q3"}',
  },
  {
    seq: 2,
    actor: { kind: 'agent', model: 'm', version: '', id: 'emission' },
    prevHash: HASH_A,
    hash: HASH_B,
    opJson: '{"$type":"RemoveNode","target":"note"}',
  },
];

describe('the session-op-log envelope', () => {
  it('writes the six fields in insertion order, with no whitespace', () => {
    expect(
      writeSessionLog({
        marker: SESSION_LOG_MARKER,
        version: 1,
        baseHash: HASH_A,
        base: { id: 'root', kind: { $type: 'Box', children: [] } },
        ops: [],
        tree: { id: 'root', kind: { $type: 'Box', children: [] } },
      }),
    ).toBe(
      `{"$log":"fuaran-session-op-log","version":1,"baseHash":"${HASH_A}",` +
        '"base":{"id":"root","kind":{"$type":"Box","children":[]}},' +
        '"ops":[],' +
        '"tree":{"id":"root","kind":{"$type":"Box","children":[]}}}',
    );
  });

  it('is NOT ordinal-sorted at the envelope level', () => {
    // Ordinal order would be `$log, base, baseHash, ops, tree, version`. Two
    // different rules live in one document: the envelope is insertion-ordered,
    // everything embedded in it is sorted.
    const written = writeSessionLog({
      marker: 'x',
      version: 1,
      baseHash: '',
      base: null,
      ops: [],
      tree: null,
    });
    expect(written.indexOf('"version"')).toBeLessThan(written.indexOf('"baseHash"'));
    expect(written.indexOf('"baseHash"')).toBeLessThan(written.indexOf('"base"'));
  });

  it('writes each op as seq, actor, prevHash, hash, op — with the actor kind first', () => {
    const written = writeSessionLog({
      marker: 'x',
      version: 1,
      baseHash: GENESIS_PREVIOUS_HASH,
      base: null,
      ops,
      tree: null,
    });
    expect(written).toContain(
      `{"seq":1,"actor":{"kind":"human","id":"devtools"},"prevHash":"${GENESIS_PREVIOUS_HASH}",` +
        `"hash":"${HASH_A}","op":{"$type":"UpdateProp","path":"Text","target":"title","value":"Q3"}}`,
    );
    expect(written).toContain(
      `{"seq":2,"actor":{"kind":"agent","model":"m","version":"","id":"emission"},` +
        `"prevHash":"${HASH_A}","hash":"${HASH_B}","op":{"$type":"RemoveNode","target":"note"}}`,
    );
  });

  it("splices each op's canonical bytes verbatim rather than re-serialising", () => {
    // A JSON writer that re-ordered or re-spaced the op would break every
    // verification downstream, for a reason that has nothing to do with
    // tampering. So the bytes go in exactly as they were hashed — even bytes
    // this writer would not itself have produced.
    const written = writeSessionLog({
      marker: 'x',
      version: 1,
      baseHash: '',
      base: null,
      ops: [
        {
          seq: 1,
          actor: { kind: 'human', id: 'd' },
          prevHash: '',
          hash: '',
          opJson: '{"zzz":1,"aaa":2}',
        },
      ],
      tree: null,
    });
    expect(written).toContain('"op":{"zzz":1,"aaa":2}}');
  });

  it('writes an absent tree as null, not as an empty object', () => {
    const written = writeSessionLog({
      marker: 'x',
      version: 1,
      baseHash: '',
      base: null,
      ops: [],
      tree: null,
    });
    expect(written).toContain('"base":null');
    expect(written).toContain('"tree":null');
  });
});

const SESSION: SessionNote = {
  host: 'a-host',
  hostVersion: '1.0.0',
  profile: 'relay@1.0',
  startedAt: '2020-01-01T00:00:00.000Z',
  endedAt: '2020-01-01T00:01:00.000Z',
  startRevision: 'r-1',
  endRevision: 'r-3',
};

const BASE_NODE: WireNode = { id: 'root', kind: { $type: 'Box', children: [] } };
const FINAL_NODE: WireNode = {
  id: 'root',
  kind: { $type: 'Box', children: [{ id: 'title', kind: { $type: 'Heading', text: 'Q3' } }] },
};

const document_ = (
  overrides: Partial<TrailDocumentInput> & { base: Capture; final: Capture },
): string =>
  writeTrailDocument({
    ops,
    interrupted: false,
    session: SESSION,
    baseStructure: { id: 'root', kind: 'Box', bindings: [], childIds: [], children: [] },
    finalStructure: null,
    ...overrides,
  });

describe('the complete document IS a session op log', () => {
  it('wears the session-log marker, carries both trees, and drops the appendix', async () => {
    const base = await capture({ ok: true, node: BASE_NODE });
    const final = await capture({ ok: true, node: FINAL_NODE });
    const written = document_({ base, final });

    expect(written.startsWith(`{"$log":"${SESSION_LOG_MARKER}",`)).toBe(true);
    // The appendix explained what was absent and stood in for it. Nothing is
    // absent, so all three of its members go — the document is the format, not
    // a document shaped like it with extra members a reader of that format
    // knows nothing about.
    expect(written).not.toContain('"integrity"');
    expect(written).not.toContain('"session"');
    expect(written).not.toContain('"structure"');
    expect(JSON.parse(written)).toMatchObject({ base: BASE_NODE, tree: FINAL_NODE });
  });

  it('seeds the chain at the BASE TREE HASH, not at genesis', async () => {
    // The session-log family's own rule: `sha256Hex` over the base tree's
    // canonical bytes. A chain seeded at the base hash binds the ops to the tree
    // they were composed against.
    const base = await capture({ ok: true, node: BASE_NODE });
    const final = await capture({ ok: true, node: FINAL_NODE });
    if (!base.ok) throw new Error('the fixture must capture');
    expect(document_({ base, final })).toContain(`"baseHash":"${base.hash}"`);
    expect(base.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-encodes the embedded tree to the exact bytes it hashed', async () => {
    // The document must not publish one encoding while the chain seed names
    // another — that fails verification for a reason nothing in the file
    // explains.
    const base = await capture({ ok: true, node: BASE_NODE });
    const final = await capture({ ok: true, node: FINAL_NODE });
    if (!base.ok) throw new Error('the fixture must capture');
    expect(document_({ base, final })).toContain(`,"base":${base.json},`);
  });
});

describe("the extension's own document, when it cannot be a session log", () => {
  const written = document_({ base: NOT_ATTEMPTED, final: NOT_ATTEMPTED });

  it('does NOT wear the session-op-log marker', () => {
    // The document cannot carry a base or final tree, so wearing the marker of
    // the format whose central claim is "these ops build this tree" would put a
    // document into circulation whose name promises what it cannot do. An
    // ingest expecting the session log rejects this one on the envelope check,
    // which is the earliest and clearest place to be told.
    expect(written.startsWith(`{"$log":"${TRAIL_MARKER}","version":${TRAIL_VERSION},`)).toBe(true);
    expect(written).not.toContain(SESSION_LOG_MARKER);
  });

  it('keeps the six-field prefix byte-compatible with the session log', () => {
    const prefix = written.slice(0, written.indexOf(',"integrity":'));
    const asSessionLog = writeSessionLog({
      marker: TRAIL_MARKER,
      version: TRAIL_VERSION,
      baseHash: GENESIS_PREVIOUS_HASH,
      base: null,
      ops,
      tree: null,
    });
    // Identical but for the closing brace the appendix displaces.
    expect(`${prefix}}`).toBe(asSessionLog);
  });

  it('seeds the chain at genesis and says so in the document', () => {
    expect(written).toContain(`"baseHash":"${GENESIS_PREVIOUS_HASH}"`);
    expect(written).toContain('"chainSeed":"genesis"');
    expect(written).toContain('"base":"absent"');
    expect(written).toContain('"tree":"absent"');
    expect(written).toContain('nothing was edited in this session');
  });

  it('names the page as the cause when the page refused the read', async () => {
    const refused = await capture({ ok: false, why: 'refused' });
    expect(document_({ base: refused, final: refused })).toContain('refused to encode its root');
  });

  it('carries the trees it DID capture, and seeds at the base hash regardless', async () => {
    // A half-capture is not nothing: the base tree still binds the chain, and
    // the note says which half is missing rather than presenting both as absent.
    const base = await capture({ ok: true, node: BASE_NODE });
    const final = await capture({ ok: false, why: 'not-offered' });
    if (!base.ok) throw new Error('the fixture must capture');
    const half = document_({ base, final });
    expect(half.startsWith(`{"$log":"${TRAIL_MARKER}",`)).toBe(true);
    expect(half).toContain(`"baseHash":"${base.hash}"`);
    expect(half).toContain('"base":"present"');
    expect(half).toContain('"tree":"absent"');
    expect(half).toContain('"chainSeed":"baseHash"');
  });

  it('refuses the session-log marker when another writer interrupted the session', async () => {
    // Both trees are in hand and the claim is still false: an edit this session
    // did not make sits between them, so the recorded ops do not build the
    // final tree.
    const base = await capture({ ok: true, node: BASE_NODE });
    const final = await capture({ ok: true, node: FINAL_NODE });
    const interrupted = document_({ base, final, interrupted: true });
    expect(interrupted.startsWith(`{"$log":"${TRAIL_MARKER}",`)).toBe(true);
    expect(interrupted).toContain('Another writer changed this page');
    // Both trees are still published — the document is less than a session log,
    // not less than it was.
    expect(JSON.parse(interrupted)).toMatchObject({ base: BASE_NODE, tree: FINAL_NODE });
  });

  it('labels the structural snapshots so they cannot be read as wire JSON', () => {
    expect(written).toContain(STRUCTURE_SHAPE_NOTE.slice(0, 40));
    // The structural shape's `kind` is a discriminator string, which is exactly
    // what makes it unmistakable for a kind object.
    expect(written).toContain('"kind":"Box"');
  });

  it('is valid JSON that round-trips', () => {
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed['$log']).toBe(TRAIL_MARKER);
    expect(Array.isArray(parsed['ops'])).toBe(true);
    expect((parsed['ops'] as unknown[]).length).toBe(2);
    expect(parsed['base']).toBeNull();
    expect(parsed['tree']).toBeNull();
  });
});
