// ============================================================================
//  A property edit and a style edit, ROUND-TRIPPED against the relay corpus.
//
//  Every other read-modify-write suite in this repo supplies its own tree: the
//  DOM suite drives the editor against a hand-written read, and the end-to-end
//  suite drives it against a host this repo also wrote. Both are worth having
//  and neither answers the question this file asks — does the panel, fed the
//  documents the CONTRACT declares, produce the documents the contract declares?
//
//  So every document here comes out of `wire-format-fixtures/devtools-relay/`:
//
//   * the handshake is `hello-node-json` — the relay@1.3 host that advertises
//     `read.nodeJson` and `apply`, which is exactly the pair this phase needs;
//   * the tree the panel navigates is `read-tree`;
//   * the values the editor seeds from are `read-node-json`;
//   * the op the property editor is expected to compose is the one carried by
//     `apply-accepted.request` — the corpus's own `UpdateProp` on the same node
//     and path, so the expectation is the contract's rather than this file's;
//   * the outcome is `apply-accepted.response`.
//
//  ── Comparing by SHAPE, and where it is tightened to equality ──────────────
//
//  §12.3 says a runner compares shapes and enumerated values, not bytes:
//  `treeRevision` tokens and message strings are environment-specific. The
//  request envelope the panel emits is therefore checked with the same
//  `shapeMismatches` walk the two corpus suites use.
//
//  The OP inside it is compared for equality, and that is not a violation of the
//  rule — it is the one part of the exchange that is not environment-specific.
//  The panel composed it from the corpus's own read; if it does not come out as
//  the corpus's own op, the read-modify-write derivation is wrong.
//
//  ── The two documents the corpus does not carry ────────────────────────────
//
//  Named rather than worked around, because the difference between "pinned by
//  the contract" and "pinned by this build" is the whole value of a corpus
//  suite, and a test that quietly blurred it would claim an authority it does
//  not have.
//
//   * NO FIXTURE NODE CARRIES A `style` BLOCK. The style leg substitutes one
//     into the `read-node-json` response and asserts FIRST that the substituted
//     envelope still satisfies the fixture's declared shape — so the extension
//     is answered by a document the contract declares with one member added,
//     never by a response shape invented here.
//   * THE ONLY APPLY VECTOR CARRIES AN `UpdateProp`. So the style leg's op has
//     nothing declared to be compared against: the CARRIER is pinned against
//     the corpus and the OP against this build's own composition, as two
//     separate assertions. See `expectApplyEnvelopeShape`.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { RelayClient, type RelayTransport } from '../src/relay/client.js';
import type { RelayEnvelope, TreeSnapshot } from '../src/relay/protocol.js';
import {
  renderPropertyEditor,
  renderStyleEditor,
  type EditContext,
} from '../src/panel/editSurface.js';
import { deriveSchema } from '../src/panel/schemaSource.js';
import { findNode } from '../src/panel/treeModel.js';
import type { TreeOpJson } from '../src/edit/ops.js';
import { Trail } from '../src/trail/recorder.js';
import type { WireRead } from '../src/trail/capture.js';
import { readFixture, readManifest, readWireSchema } from './support/corpus.js';
import { describeMismatches, shapeMismatches } from './support/shape.js';

const derived = deriveSchema(readWireSchema())!;
const manifest = readManifest();

const fixture = (id: string) => {
  const entry = manifest.fixtures.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`The corpus declares no fixture '${id}'.`);
  return entry;
};

const responseOf = (id: string): Record<string, unknown> => readFixture(fixture(id).responseFile!);
const requestOf = (id: string): Record<string, unknown> => readFixture(fixture(id).requestFile!);

const payloadOf = (envelope: Record<string, unknown>): Record<string, unknown> =>
  envelope['payload'] as Record<string, unknown>;

/**
 * A client answered from the corpus, keyed by REQUEST TYPE.
 *
 * Re-stamped with the id the client issued, exactly as the two corpus suites
 * do: the fixtures' ids are the fixture author's choice, and correlation has
 * its own assertions elsewhere.
 */
const corpusPage = (answers: Readonly<Record<string, Record<string, unknown>>>) => {
  const posted: RelayEnvelope[] = [];
  let handler: ((envelope: RelayEnvelope) => void) | undefined;
  const transport: RelayTransport = {
    post(envelope) {
      posted.push(envelope);
      const answer = answers[envelope.type];
      if (answer === undefined) return;
      queueMicrotask(() => handler?.({ ...answer, id: envelope.id } as RelayEnvelope));
    },
    listen(next) {
      handler = next;
      return () => {
        handler = undefined;
      };
    },
  };
  const client = new RelayClient(transport, {
    client: 'fuaran-devtools',
    clientVersion: '0.1.0',
  });
  const lastPost = (type: string): RelayEnvelope => {
    const found = [...posted].reverse().find((envelope) => envelope.type === type);
    if (found === undefined) throw new Error(`Nothing of type '${type}' was posted.`);
    return found;
  };
  return { client, posted, lastPost };
};

/** Assert `actual` satisfies the shape the corpus fixture declares. */
const expectShapeOf = (expected: unknown, actual: unknown): void => {
  const mismatches = shapeMismatches(expected, actual);
  expect(mismatches.length, `\n${describeMismatches(mismatches)}`).toBe(0);
};

const rowFor = (section: HTMLElement, name: string): HTMLElement =>
  [...section.querySelectorAll('.field')].find(
    (row) => row.querySelector('.field-name')?.textContent === name,
  ) as HTMLElement;

const controlIn = (row: HTMLElement): HTMLInputElement | HTMLSelectElement =>
  row.querySelector('input, select') as HTMLInputElement | HTMLSelectElement;

/** The actor the panel attributes an edit to (§8.2) — the corpus's own value. */
const ACTOR = 'fuaran-devtools';

/**
 * Assert the apply envelope the panel emitted is the shape the corpus declares.
 *
 * Two fields are re-stamped from the fixture before the walk, and both are the
 * SENDER'S OWN CHOICE rather than protocol content §12.3 lets a fixture pin:
 * the correlation `id` — the two corpus suites re-stamp it for exactly this
 * reason — and the attribution `reason`, which is free prose the panel writes
 * about the edit it just composed. Asserting either byte-for-byte would be
 * testing the fixture author's choices.
 *
 * `opOverride` exists for the style leg alone, and its need is a real limit of
 * the oracle worth naming rather than papering over: the corpus's only apply
 * vector carries an `UpdateProp`, so there is no declared `UpdateStyle` request
 * to compare one against. The style leg therefore pins the CARRIER here against
 * the corpus, and the OP separately against this build's own composition —
 * two assertions rather than one, so neither claims the corpus's authority for
 * something the corpus does not declare.
 */
const expectApplyEnvelopeShape = (
  posted: RelayEnvelope,
  opOverride?: Record<string, unknown>,
): void => {
  const expected = requestOf('apply-accepted');
  const expectedPayload = payloadOf(expected);
  const actualPayload = posted.payload as Record<string, unknown>;
  expectShapeOf(expected, {
    ...posted,
    id: expected['id'],
    payload: {
      ...actualPayload,
      op: opOverride ?? actualPayload['op'],
      attribution: {
        ...(actualPayload['attribution'] as Record<string, unknown>),
        reason: (expectedPayload['attribution'] as Record<string, unknown>)['reason'],
      },
    },
  });
};

interface Wired {
  readonly context: EditContext;
  readonly sent: TreeOpJson[];
  readonly lastPost: (type: string) => RelayEnvelope;
  readonly trail: Trail;
}

/**
 * The whole panel-side context, built from the corpus and nothing else.
 *
 * `nodeJsonResponse` is a parameter rather than a constant because the style leg
 * substitutes a styled node into it — see the header. Everything else is read
 * from the corpus verbatim.
 */
const wire = async (
  focusId: string,
  nodeJsonResponse: Record<string, unknown>,
  baseWireTree: Record<string, unknown>,
): Promise<Wired> => {
  const page = corpusPage({
    hello: responseOf('hello-node-json'),
    'read.tree': responseOf('read-tree'),
    'read.nodeJson': nodeJsonResponse,
    apply: responseOf('apply-accepted'),
  });

  const handshake = await page.client.hello();
  expect(handshake.ok).toBe(true);
  if (!handshake.ok) throw new Error('the corpus handshake did not complete');

  const treeResult = await page.client.readTree();
  expect(treeResult.ok).toBe(true);
  if (!treeResult.ok) throw new Error('the corpus tree did not arrive');
  const tree: TreeSnapshot = treeResult.value;

  const readResult = await page.client.readNodeJson(focusId);
  expect(readResult.ok).toBe(true);
  if (!readResult.ok) throw new Error('the corpus wire-JSON read did not arrive');

  const node = findNode(tree, focusId);
  if (node === undefined) throw new Error(`'${focusId}' is not in the corpus tree.`);

  // The base capture reads the ROOT. The corpus's `read.nodeJson` fixture is a
  // read of `grid-1`, so the root wrapper is supplied here and the corpus's own
  // node is the subtree inside it — the values the undo restores are still the
  // corpus's, which is the part that matters.
  const reader = async (nodeId: string): Promise<WireRead> =>
    nodeId === tree.id ? { ok: true, node: baseWireTree } : { ok: false, why: 'refused' };

  const trail = new Trail(undefined, reader);
  trail.observeTree(tree, handshake.value.treeRevision);

  const sent: TreeOpJson[] = [];
  const context: EditContext = {
    capabilities: handshake.value.capabilities,
    derived,
    tree,
    node: { id: node.id, kind: node.kind, bindings: node.bindings, childIds: node.childIds },
    nodeJson: readResult.value,
    held: undefined,
    async commit(op, reason) {
      // The panel's own write route, in miniature: prepare the captures, cross
      // the wire, record only what the host confirmed.
      await trail.prepare(op);
      const result = await page.client.apply(op, { actor: ACTOR, reason });
      if (!result.ok)
        return { ok: false, class: 'NO_ANSWER', message: 'the corpus did not answer' };
      await trail.record(op, reason, result.value.treeRevision);
      // Pushed LAST, so a test that waits on this has waited on the whole
      // route rather than on the first line of it.
      sent.push(op);
      return { ok: true, treeRevision: result.value.treeRevision };
    },
    revision: () => readResult.value.treeRevision,
    reread: async () => readResult.value,
    reload: () => undefined,
    setHeld: () => undefined,
  };

  return { context, sent, lastPost: page.lastPost, trail };
};

/** The corpus's `grid-1` node, as `read-node-json` serves it. */
const corpusGridNode = (): Record<string, unknown> =>
  payloadOf(responseOf('read-node-json'))['node'] as Record<string, unknown>;

/** The corpus's node wrapped in the root the tree fixture declares. */
const baseTreeAround = (node: Record<string, unknown>): Record<string, unknown> => ({
  id: 'root',
  kind: { $type: 'Box', children: [node] },
});

describe('a property round-trip, corpus in and corpus out', () => {
  it('seeds the indexed row from the value the corpus read carries', async () => {
    const { context } = await wire(
      'grid-1',
      responseOf('read-node-json'),
      baseTreeAround(corpusGridNode()),
    );
    const section = renderPropertyEditor(context);
    // 'Channel', from the fixture. Before `read.nodeJson` this row could not
    // exist at all: the index needs the collection's length, and no other read
    // in the contract reports it.
    expect(controlIn(rowFor(section, 'Columns[0].Label')).value).toBe('Channel');
  });

  it('composes exactly the op the corpus’s own apply request carries', async () => {
    const { context, sent, lastPost } = await wire(
      'grid-1',
      responseOf('read-node-json'),
      baseTreeAround(corpusGridNode()),
    );
    const section = renderPropertyEditor(context);
    const expectedRequest = requestOf('apply-accepted');
    const expectedOp = payloadOf(expectedRequest)['op'] as Record<string, unknown>;

    const row = rowFor(section, 'Columns[0].Label');
    controlIn(row).value = expectedOp['value'] as string;
    (row.querySelector('button') as HTMLButtonElement).click();

    await expect.poll(() => sent.length).toBe(1);
    // Equality, not shape: the panel derived this from the corpus's read, so
    // anything other than the corpus's op is a derivation defect.
    expect(sent[0]).toEqual(expectedOp);

    // And the envelope it crossed in satisfies the shape the corpus declares
    // for an apply request, op included.
    expectApplyEnvelopeShape(lastPost('apply'));
  });

  it('reads back the outcome the corpus’s apply response declares', async () => {
    const { context, sent } = await wire(
      'grid-1',
      responseOf('read-node-json'),
      baseTreeAround(corpusGridNode()),
    );
    const section = renderPropertyEditor(context);
    const row = rowFor(section, 'Columns[0].Label');
    controlIn(row).value = 'Channel name';
    (row.querySelector('button') as HTMLButtonElement).click();

    await expect.poll(() => sent.length).toBe(1);
    expect(section.querySelector('.refusal')).toBeNull();
  });

  it('inverts back to the value the corpus read carried', async () => {
    const { context, sent, trail } = await wire(
      'grid-1',
      responseOf('read-node-json'),
      baseTreeAround(corpusGridNode()),
    );
    const section = renderPropertyEditor(context);
    const row = rowFor(section, 'Columns[0].Label');
    controlIn(row).value = 'Channel name';
    (row.querySelector('button') as HTMLButtonElement).click();
    await expect.poll(() => sent.length).toBe(1);

    // The round trip closes here: the corpus's read seeded the editor, the
    // corpus's op left the panel, and the undo puts the corpus's own value back.
    const undo = trail.undoOp();
    expect(undo?.ok).toBe(true);
    if (undo === undefined || !undo.ok) return;
    expect(undo.op).toEqual({
      $type: 'UpdateProp',
      path: 'Columns[0].Label',
      target: 'grid-1',
      value: 'Channel',
    });
  });
});

// ─── The style leg ──────────────────────────────────────────────────

/** The corpus's `grid-1` node with a style block, and the response carrying it. */
const STYLED_BLOCK = { emphasis: 'Loud', tone: 'Success', weight: 'Spacious' };

const styledGridNode = (): Record<string, unknown> => ({
  ...corpusGridNode(),
  style: { ...STYLED_BLOCK },
});

const styledNodeJsonResponse = (): Record<string, unknown> => {
  const response = responseOf('read-node-json');
  return {
    ...response,
    payload: { ...payloadOf(response), node: styledGridNode() },
  };
};

describe('a style round-trip, against the corpus’s own read and apply shapes', () => {
  it('is still the response shape the corpus declares, one member added', () => {
    // Asserted before anything is driven through it. A substituted document the
    // contract would not recognise would make every assertion below a statement
    // about this file rather than about the format.
    expectShapeOf(responseOf('read-node-json'), styledNodeJsonResponse());
  });

  it('seeds each token from the block the read carries', async () => {
    const { context } = await wire(
      'grid-1',
      styledNodeJsonResponse(),
      baseTreeAround(styledGridNode()),
    );
    const section = renderStyleEditor(context);
    expect(controlIn(rowFor(section, 'tone')).value).toBe('Success');
    expect(controlIn(rowFor(section, 'emphasis')).value).toBe('Loud');
  });

  it('commits one merged block, and crosses in the corpus’s apply shape', async () => {
    const { context, sent, lastPost } = await wire(
      'grid-1',
      styledNodeJsonResponse(),
      baseTreeAround(styledGridNode()),
    );
    const section = renderStyleEditor(context);
    controlIn(rowFor(section, 'tone')).value = 'Critical';
    (section.querySelector('button') as HTMLButtonElement).click();

    await expect.poll(() => sent.length).toBe(1);
    // ONE op, the WHOLE block: `UpdateStyle` replaces it, so an op naming only
    // `tone` would have deleted the other two.
    expect(sent[0]).toEqual({
      $type: 'UpdateStyle',
      style: { emphasis: 'Loud', tone: 'Critical', weight: 'Spacious' },
      target: 'grid-1',
    });

    // The carrier, against the corpus. The op it carries is asserted above,
    // because the corpus declares no `UpdateStyle` request to pin it against.
    expectApplyEnvelopeShape(
      lastPost('apply'),
      payloadOf(requestOf('apply-accepted'))['op'] as Record<string, unknown>,
    );
  });

  it('inverts back to the block that was read, token for token', async () => {
    const { context, sent, trail } = await wire(
      'grid-1',
      styledNodeJsonResponse(),
      baseTreeAround(styledGridNode()),
    );
    const section = renderStyleEditor(context);
    controlIn(rowFor(section, 'tone')).value = 'Critical';
    (section.querySelector('button') as HTMLButtonElement).click();
    await expect.poll(() => sent.length).toBe(1);

    const undo = trail.undoOp();
    expect(undo?.ok).toBe(true);
    if (undo === undefined || !undo.ok) return;
    // The pre-edit block, whole. The two tokens the user never touched are the
    // falsifier: an inverse derived from the op alone could only put `tone`
    // back, and would leave the node carrying a block of one.
    expect(undo.op).toEqual({ $type: 'UpdateStyle', style: STYLED_BLOCK, target: 'grid-1' });
  });

  it('carries the style edit into the exported trail, inverse and all', async () => {
    const { context, sent, trail } = await wire(
      'grid-1',
      styledNodeJsonResponse(),
      baseTreeAround(styledGridNode()),
    );
    const section = renderStyleEditor(context);
    controlIn(rowFor(section, 'tone')).value = 'Critical';
    (section.querySelector('button') as HTMLButtonElement).click();
    await expect.poll(() => sent.length).toBe(1);

    const view = trail.view();
    expect(view.recorded).toBe(1);
    expect(view.entries[0]?.op['$type']).toBe('UpdateStyle');
    // The surface OFFERS the undo. Before this phase the same recording would
    // have rendered `undoBlocked: UNKNOWN_OP` — the style edit was in the trail
    // and was not undoable from it, which is the half the phase closes.
    expect(view.undoBlocked).toBeUndefined();
    expect(view.undoable).toBe(view.entries[0]);
  });
});
