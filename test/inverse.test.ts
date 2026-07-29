// ============================================================================
//  Undoing an op, and — as much of the value — refusing to.
//
//  The negative cases carry the weight here. An undo that is offered and then
//  does the wrong thing is worse than no undo at all: it succeeds, the page
//  changes, and nothing says the restored value was invented. So every case
//  this cannot invert is asserted to be REFUSED, with a reason, rather than
//  approximated.
// ============================================================================

import { describe, expect, it } from 'vitest';

import type { TreeSnapshot } from '../src/relay/protocol.js';
import {
  batch,
  insertChild,
  moveNode,
  removeNode,
  reorderChildren,
  updateProp,
} from '../src/edit/ops.js';
import { inverseOf, priorValue } from '../src/trail/inverse.js';

const leaf = (id: string, kind = 'Heading', children: TreeSnapshot[] = []): TreeSnapshot => ({
  id,
  kind,
  bindings: [],
  childIds: children.map((child) => child.id),
  children,
});

const tree = (): TreeSnapshot =>
  leaf('root', 'Box', [leaf('a'), leaf('b'), leaf('card', 'Box', [leaf('inner')])]);

const expectOk = (result: ReturnType<typeof inverseOf>): Record<string, unknown> => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.op as Record<string, unknown>;
};

const expectRefused = (result: ReturnType<typeof inverseOf>): string => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a refusal');
  return result.reason;
};

describe('UpdateProp', () => {
  it('restores what an earlier edit in this session set', () => {
    const earlier = [updateProp('a', 'Text', 'first')];
    const op = updateProp('a', 'Text', 'second');
    expect(expectOk(inverseOf(op, tree(), earlier))).toEqual({
      $type: 'UpdateProp',
      path: 'Text',
      target: 'a',
      value: 'first',
    });
  });

  it('walks back to the most recent earlier edit, not the first', () => {
    const earlier = [
      updateProp('a', 'Text', 'one'),
      updateProp('a', 'Text', 'two'),
      updateProp('b', 'Text', 'other'),
    ];
    expect(expectOk(inverseOf(updateProp('a', 'Text', 'three'), tree(), earlier))['value']).toBe(
      'two',
    );
  });

  it('restores the value a node was INSERTED with', () => {
    // The node's origin is in this session, so what it was born holding is
    // known even though no read could ever have returned it.
    const earlier = [
      insertChild('root', { id: 'heading-1', kind: { $type: 'Heading', level: 1, text: 'Text' } }),
    ];
    expect(expectOk(inverseOf(updateProp('heading-1', 'Text', 'Edited'), tree(), earlier))).toEqual(
      {
        $type: 'UpdateProp',
        path: 'Text',
        target: 'heading-1',
        value: 'Text',
      },
    );
  });

  it('refuses when the value before this session was never readable', () => {
    // The single most common case, and the one where a plausible guess would
    // be a fabrication: nothing in relay@1.0 returns a property value.
    const reason = expectRefused(inverseOf(updateProp('a', 'Text', 'x'), tree(), []));
    expect(reason).toContain('never');
    expect(reason).toContain('relay@1.0');
  });

  it('refuses a nested path even when an insert is in the trail', () => {
    // `Columns[0].Label` addresses a position inside a node by a second
    // grammar. Resolving it approximately would restore the wrong field
    // silently, which is the failure this whole module is arranged against.
    const earlier = [
      insertChild('root', { id: 'grid-1', kind: { $type: 'Grid', columns: [{ label: 'A' }] } }),
    ];
    expect(
      expectRefused(inverseOf(updateProp('grid-1', 'Columns[0].Label', 'B'), tree(), earlier)),
    ).toContain('never');
  });

  it('refuses when the inserted node declared no such field', () => {
    const earlier = [insertChild('root', { id: 'h', kind: { $type: 'Heading', level: 1 } })];
    expectRefused(inverseOf(updateProp('h', 'Text', 'x'), tree(), earlier));
  });
});

describe('structural ops', () => {
  it('undoes an insert by removing the child it minted', () => {
    const op = insertChild('root', { id: 'heading-1', kind: { $type: 'Heading' } });
    expect(expectOk(inverseOf(op, tree(), []))).toEqual({
      $type: 'RemoveNode',
      target: 'heading-1',
    });
  });

  it('refuses to undo a removal', () => {
    // The subtree was never readable as wire JSON, so putting back a
    // structural husk would restore something the page never had.
    const reason = expectRefused(inverseOf(removeNode('card'), tree(), []));
    expect(reason).toContain('cannot be restored');
  });

  it('undoes a move by restoring the old parent AND the old sibling order', () => {
    // The parent alone is not enough: a move appends, so without the reorder
    // the node comes back at the end and the undo silently half-worked.
    expect(expectOk(inverseOf(moveNode('b', 'card'), tree(), []))).toEqual({
      $type: 'Batch',
      ops: [
        { $type: 'MoveNode', newParentId: 'root', target: 'b' },
        { $type: 'ReorderChildren', newOrder: ['a', 'b', 'card'], parentId: 'root' },
      ],
    });
  });

  it('refuses to undo a move of the root, which had no parent', () => {
    expectRefused(inverseOf(moveNode('root', 'card'), tree(), []));
  });

  it('undoes a reorder with the order the snapshot recorded', () => {
    expect(expectOk(inverseOf(reorderChildren('root', ['card', 'b', 'a']), tree(), []))).toEqual({
      $type: 'ReorderChildren',
      newOrder: ['a', 'b', 'card'],
      parentId: 'root',
    });
  });

  it('refuses a reorder whose parent is not in the snapshot', () => {
    expectRefused(inverseOf(reorderChildren('ghost', ['x']), tree(), []));
  });
});

describe('the composites the panel emits', () => {
  it('undoes insert-and-place with the removal alone', () => {
    // The reorder preserved the existing siblings' relative order, so removing
    // the new child restores the parent's order by itself.
    const op = batch([
      insertChild('root', { id: 'heading-1', kind: { $type: 'Heading' } }),
      reorderChildren('root', ['a', 'heading-1', 'b', 'card']),
    ]);
    expect(expectOk(inverseOf(op, tree(), []))).toEqual({
      $type: 'RemoveNode',
      target: 'heading-1',
    });
  });

  it('undoes move-and-place with the move inverse alone', () => {
    const op = batch([moveNode('b', 'card'), reorderChildren('card', ['b', 'inner'])]);
    expect(expectOk(inverseOf(op, tree(), []))['$type']).toBe('Batch');
  });

  it('refuses any other batch rather than inverting it leg by leg', () => {
    // A leg's inverse depends on the tree BEFORE that leg, and only the state
    // before the whole batch is recorded. Guessing would produce an op that
    // applies successfully and lands somewhere nobody chose.
    const reason = expectRefused(inverseOf(batch([removeNode('a'), removeNode('b')]), tree(), []));
    expect(reason).toContain('composites');
    expectRefused(inverseOf(batch([moveNode('a', 'card')]), tree(), []));
  });
});

describe('unknown ops', () => {
  it('refuses an op case this build has never heard of, and names it', () => {
    const reason = expectRefused(inverseOf({ $type: 'ReplaceRoot', node: {} }, tree(), []));
    expect(reason).toContain('ReplaceRoot');
  });
});

describe('priorValue', () => {
  it('stops searching at the node origin', () => {
    // An edit to a DIFFERENT node before the insert must not be mistaken for
    // this node's prior value.
    const earlier = [
      updateProp('h', 'Text', 'ghost-of-a-previous-node'),
      insertChild('root', { id: 'h', kind: { $type: 'Heading', text: 'born' } }),
    ];
    expect(priorValue('h', 'Text', earlier)).toEqual({ known: true, value: 'born' });
  });

  it('finds an edit nested inside a batch', () => {
    const earlier = [batch([updateProp('a', 'Text', 'inside'), removeNode('z')])];
    expect(priorValue('a', 'Text', earlier)).toEqual({ known: true, value: 'inside' });
  });

  it('reports honestly when nothing in the session knows', () => {
    expect(priorValue('a', 'Text', [])).toEqual({ known: false });
  });
});
