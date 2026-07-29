// ============================================================================
//  The recording: what goes in the trail, what stays out, and what an undo does
//  to it.
//
//  Three claims are load-bearing and each is asserted here rather than assumed:
//
//   * only ops the host CONFIRMED appear (a refusal is not a change);
//   * the redo tail is excluded from the export, and truncated by a new edit;
//   * the chain re-links correctly after a truncation, which is the one place a
//     hash-chained log can silently go wrong — the new op must chain to the op
//     that genuinely precedes it, not to the one that was undone.
// ============================================================================

import { describe, expect, it } from 'vitest';

import type { TreeSnapshot } from '../src/relay/protocol.js';
import { insertChild, removeNode, updateProp } from '../src/edit/ops.js';
import { canonicalJson } from '../src/trail/canonicalJson.js';
import { computeHashOf, DEVTOOLS_ACTOR, GENESIS_PREVIOUS_HASH } from '../src/trail/hashChain.js';
import { Trail } from '../src/trail/recorder.js';
import { TRAIL_MARKER } from '../src/trail/sessionLog.js';

const leaf = (id: string, kind = 'Heading', children: TreeSnapshot[] = []): TreeSnapshot => ({
  id,
  kind,
  bindings: [],
  childIds: children.map((child) => child.id),
  children,
});

const tree = (): TreeSnapshot => leaf('root', 'Box', [leaf('a'), leaf('b')]);

/** A fixed clock, so an exported document is byte-stable under test. */
const clock = () => '2020-01-01T00:00:00.000Z';

const started = (): Trail => {
  const trail = new Trail(clock);
  trail.noteIdentity({ host: 'h', hostVersion: '1', profile: 'relay@1.0' });
  trail.observeTree(tree(), 'r-0');
  return trail;
};

const parse = (trail: Trail): Record<string, unknown> =>
  JSON.parse(trail.exportDocument()) as Record<string, unknown>;

const opsOf = (trail: Trail): Record<string, unknown>[] =>
  parse(trail)['ops'] as Record<string, unknown>[];

describe('the session boundary', () => {
  it('takes the first observed tree as the base, not the tree at the first edit', () => {
    const trail = new Trail(clock);
    const first = tree();
    trail.observeTree(first, 'r-0');
    trail.observeTree(leaf('root', 'Box', []), 'r-1');
    const structure = parse(trail)['structure'] as Record<string, unknown>;
    expect((structure['base'] as TreeSnapshot).children).toHaveLength(2);
    expect((structure['final'] as TreeSnapshot).children).toHaveLength(0);
  });

  it('records nothing before a tree has been seen', async () => {
    const trail = new Trail(clock);
    await trail.record(updateProp('a', 'Text', 'x'), 'set Text');
    expect(trail.view().recorded).toBe(0);
  });

  it('ends the recording on reset, base and all', async () => {
    const trail = started();
    await trail.record(updateProp('a', 'Text', 'x'), 'set Text');
    trail.reset();
    const view = trail.view();
    expect(view.recorded).toBe(0);
    expect(view.interrupted).toBe(false);
    expect(parse(trail)['structure']).toEqual({
      shape: expect.any(String),
      base: null,
      final: null,
    });
  });
});

describe('the trail records applied ops', () => {
  it('chains the first op from genesis and attributes it to this extension', async () => {
    const trail = started();
    const op = updateProp('a', 'Text', 'one');
    await trail.record(op, 'set Text', 'r-1');

    const [first] = opsOf(trail);
    expect(first?.['seq']).toBe(1);
    expect(first?.['actor']).toEqual({ kind: 'human', id: 'devtools' });
    expect(first?.['prevHash']).toBe(GENESIS_PREVIOUS_HASH);
    expect(first?.['hash']).toBe(
      await computeHashOf(GENESIS_PREVIOUS_HASH, op as never, 1, DEVTOOLS_ACTOR),
    );
    expect(canonicalJson(first?.['op'] as never)).toBe(canonicalJson(op as never));
  });

  it('links each op to the one before it', async () => {
    const trail = started();
    await trail.record(updateProp('a', 'Text', 'one'), 'set Text');
    await trail.record(updateProp('b', 'Text', 'two'), 'set Text');
    const ops = opsOf(trail);
    expect(ops).toHaveLength(2);
    expect(ops[1]?.['prevHash']).toBe(ops[0]?.['hash']);
    expect(ops[1]?.['seq']).toBe(2);
  });
});

describe('undo, redo, and the redo tail', () => {
  it('excludes the redo tail from the export', async () => {
    const trail = started();
    await trail.record(insertChild('root', { id: 'h', kind: { $type: 'Heading' } }), 'insert');
    await trail.record(insertChild('root', { id: 'i', kind: { $type: 'Heading' } }), 'insert');
    trail.confirmUndo('r-3');

    // The document claims its ops built its tree; an undone op in the list
    // would falsify that.
    expect(opsOf(trail)).toHaveLength(1);
    expect(trail.view().undone).toBe(1);
  });

  it('moves the cursor only after the host confirms', async () => {
    const trail = started();
    await trail.record(insertChild('root', { id: 'h', kind: { $type: 'Heading' } }), 'insert');
    // Asking for the inverse changes nothing on its own — an undo the page
    // refuses is not an undo.
    expect(trail.undoOp()?.ok).toBe(true);
    expect(trail.view().applied).toBe(1);
    trail.confirmUndo();
    expect(trail.view().applied).toBe(0);
  });

  it('restores the entry on redo, keeping its original hash', async () => {
    const trail = started();
    await trail.record(insertChild('root', { id: 'h', kind: { $type: 'Heading' } }), 'insert');
    const before = opsOf(trail);
    trail.confirmUndo();
    expect(trail.redoOp()).toBeDefined();
    trail.confirmRedo();
    // Same position, same predecessor, so the same hash — a redo is not a new
    // op and must not be recorded as one.
    expect(opsOf(trail)).toEqual(before);
  });

  it('truncates the redo tail on a new edit, and re-chains against the survivor', async () => {
    const trail = started();
    await trail.record(updateProp('a', 'Text', 'one'), 'set Text');
    await trail.record(updateProp('a', 'Text', 'two'), 'set Text');
    trail.confirmUndo();

    const replacement = updateProp('b', 'Text', 'branch');
    await trail.record(replacement, 'set Text');

    const ops = opsOf(trail);
    expect(ops).toHaveLength(2);
    expect(trail.view().undone).toBe(0);
    // The re-chained op links to op 1, NOT to the op that was undone. Getting
    // this wrong produces a document that reads perfectly and verifies nowhere.
    expect(ops[1]?.['prevHash']).toBe(ops[0]?.['hash']);
    expect(ops[1]?.['hash']).toBe(
      await computeHashOf(String(ops[0]?.['hash']), replacement as never, 2, DEVTOOLS_ACTOR),
    );
  });

  it('offers no undo for an op with no recoverable inverse, and says why', async () => {
    const trail = started();
    await trail.record(removeNode('a'), 'remove a');
    const view = trail.view();
    expect(view.undoable).toBeUndefined();
    expect(view.undoBlocked).toContain('cannot be restored');
  });
});

describe('when another writer changes the same page', () => {
  it('stops undo at the interruption rather than reverting their work', async () => {
    const trail = started();
    await trail.record(insertChild('root', { id: 'h', kind: { $type: 'Heading' } }), 'insert');
    trail.externalChange('r-9');

    const view = trail.view();
    expect(view.interrupted).toBe(true);
    expect(view.undoable).toBeUndefined();
    expect(view.undoBlocked).toContain('did not do');
    // And it stays put even if asked.
    trail.confirmUndo();
    expect(trail.view().applied).toBe(1);
  });

  it('discards the redo tail, because replaying across it lands nowhere chosen', async () => {
    const trail = started();
    await trail.record(insertChild('root', { id: 'h', kind: { $type: 'Heading' } }), 'insert');
    trail.confirmUndo();
    expect(trail.redoOp()).toBeDefined();

    trail.externalChange('r-9');
    expect(trail.redoOp()).toBeUndefined();
  });

  it('keeps recording, and everything after the interruption is undoable again', async () => {
    const trail = started();
    await trail.record(insertChild('root', { id: 'h', kind: { $type: 'Heading' } }), 'insert');
    trail.externalChange('r-9');
    trail.observeTree(tree(), 'r-9');
    await trail.record(insertChild('root', { id: 'i', kind: { $type: 'Heading' } }), 'insert');

    // Composed against the tree as it is NOW, so its inverse is sound.
    expect(trail.view().undoable?.seq).toBe(2);
    expect(opsOf(trail)).toHaveLength(2);
    trail.confirmUndo();
    // ...but the barrier still holds for what came before it.
    expect(trail.view().undoable).toBeUndefined();
  });
});

describe('the exported document', () => {
  it('names itself, seeds at genesis, and carries no trees', async () => {
    const trail = started();
    await trail.record(updateProp('a', 'Text', 'x'), 'set Text', 'r-1');
    const document = parse(trail);
    expect(document['$log']).toBe(TRAIL_MARKER);
    expect(document['baseHash']).toBe(GENESIS_PREVIOUS_HASH);
    expect(document['base']).toBeNull();
    expect(document['tree']).toBeNull();
    expect((document['integrity'] as Record<string, unknown>)['chainSeed']).toBe('genesis');
  });

  it('records the session boundary it observed', async () => {
    const trail = started();
    await trail.record(updateProp('a', 'Text', 'x'), 'set Text', 'r-4');
    expect(parse(trail)['session']).toEqual({
      host: 'h',
      hostVersion: '1',
      profile: 'relay@1.0',
      startedAt: '2020-01-01T00:00:00.000Z',
      endedAt: '2020-01-01T00:00:00.000Z',
      startRevision: 'r-0',
      endRevision: 'r-4',
    });
  });

  it('is byte-stable for the same recording', async () => {
    const one = started();
    const two = started();
    for (const trail of [one, two])
      await trail.record(updateProp('a', 'Text', 'x'), 'set Text', 'r-1');
    expect(one.exportDocument()).toBe(two.exportDocument());
  });
});
