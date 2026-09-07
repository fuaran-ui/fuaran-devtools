// ============================================================================
//  Undoing an op EXACTLY — and, as much of the value, refusing to by name.
//
//  Two halves, and both carry weight.
//
//  The positive half is new: with the session's base tree captured, an
//  `UpdateProp` inverts against what the field genuinely held, an indexed or
//  nested path resolves through the same walk the editor reads by, and a
//  `RemoveNode` puts the captured subtree back where the snapshot says it was.
//  These are the cases that used to be refused, so each assertion here is a
//  partial arm that has actually gone rather than been renamed.
//
//  The negative half is unchanged in spirit and sharpened in form. An undo that
//  is offered and then does the wrong thing is worse than no undo at all: it
//  succeeds, the page changes, and nothing says the restored value was invented.
//  So every case this still cannot invert is asserted to be REFUSED — and now
//  asserted to be refused with the right CLASS, because "the page would not
//  serve a tree read" and "this build has no inverse for that op" are different
//  problems with different next actions, and a shared sentence hides that.
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
import {
  inverseOf,
  priorValue,
  type InverseRefusalClass,
  type InverseSources,
} from '../src/trail/inverse.js';
import {
  capture,
  MAX_CAPTURED_TREE_BYTES,
  NOT_ATTEMPTED,
  STALE,
  type Capture,
  type WireNode,
} from '../src/trail/capture.js';

const leaf = (id: string, kind = 'Heading', children: TreeSnapshot[] = []): TreeSnapshot => ({
  id,
  kind,
  bindings: [],
  childIds: children.map((child) => child.id),
  children,
});

const tree = (): TreeSnapshot =>
  leaf('root', 'Box', [leaf('a'), leaf('b'), leaf('card', 'Box', [leaf('inner'), leaf('grid')])]);

/**
 * The same tree in WIRE form — the shape `read.nodeJson` on the root returns.
 *
 * Deliberately a different document from the structural snapshot above, because
 * the two are different documents about the same tree: this one carries kind
 * OBJECTS with their property values and nests children under `kind.children`,
 * where the structural one carries a kind discriminator and no values at all.
 * A fixture that served one from the other would build in an equivalence the
 * derivation must not assume.
 */
const wireTree = (): WireNode => ({
  id: 'root',
  kind: {
    $type: 'Box',
    children: [
      { id: 'a', kind: { $type: 'Heading', level: 1, text: 'alpha' } },
      { id: 'b', kind: { $type: 'Heading', level: 2, text: 'beta' } },
      {
        id: 'card',
        kind: {
          $type: 'Box',
          children: [
            { id: 'inner', kind: { $type: 'Heading', level: 3, text: 'gamma' } },
            {
              id: 'grid',
              kind: {
                $type: 'Grid',
                columns: [
                  { label: 'First', width: 2 },
                  { label: 'Second', width: 3 },
                ],
              },
            },
          ],
        },
      },
    ],
  },
});

const withBase = async (node: WireNode = wireTree()): Promise<InverseSources> => ({
  base: await capture({ ok: true, node }),
  captured: new Map(),
});

const withCaptured = async (
  entries: readonly (readonly [string, WireNode])[],
): Promise<InverseSources> => ({
  base: await capture({ ok: true, node: wireTree() }),
  captured: new Map(
    await Promise.all(
      entries.map(
        async ([id, node]) => [id, await capture({ ok: true, node })] as readonly [string, Capture],
      ),
    ),
  ),
});

const expectOk = (result: ReturnType<typeof inverseOf>): Record<string, unknown> => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`${result.class}: ${result.message}`);
  return result.op as Record<string, unknown>;
};

const expectRefused = (
  result: ReturnType<typeof inverseOf>,
  refusalClass: InverseRefusalClass,
): string => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a refusal');
  expect(result.class).toBe(refusalClass);
  return result.message;
};

describe('UpdateProp inverts against what the field held', () => {
  it('restores what an earlier edit in this session set', async () => {
    const earlier = [updateProp('a', 'Text', 'first')];
    const op = updateProp('a', 'Text', 'second');
    expect(expectOk(inverseOf(op, tree(), earlier, await withBase()))).toEqual({
      $type: 'UpdateProp',
      path: 'Text',
      target: 'a',
      value: 'first',
    });
  });

  it('walks back to the most recent earlier edit, not the first', async () => {
    const earlier = [
      updateProp('a', 'Text', 'one'),
      updateProp('a', 'Text', 'two'),
      updateProp('b', 'Text', 'other'),
    ];
    expect(
      expectOk(inverseOf(updateProp('a', 'Text', 'three'), tree(), earlier, await withBase()))[
        'value'
      ],
    ).toBe('two');
  });

  it('restores from the CAPTURED BASE TREE when this session set nothing', async () => {
    // The case the whole phase is about. Nothing in the recording knows what
    // `a.Text` held, and the base tree does — so the undo is exact rather than
    // refused.
    expect(
      expectOk(inverseOf(updateProp('a', 'Text', 'edited'), tree(), [], await withBase())),
    ).toEqual({ $type: 'UpdateProp', path: 'Text', target: 'a', value: 'alpha' });
  });

  it('reaches a node nested well below the root', async () => {
    expect(
      expectOk(inverseOf(updateProp('inner', 'Level', 9), tree(), [], await withBase()))['value'],
    ).toBe(3);
  });

  it('resolves an INDEXED, NESTED path through the captured tree', async () => {
    // `Columns[0].Label` used to be refused outright: resolving it meant a
    // second address grammar, and getting it subtly wrong would restore the
    // wrong field silently. It now goes through the one walk the editor reads
    // by, so there is no second grammar to get wrong.
    expect(
      expectOk(
        inverseOf(updateProp('grid', 'Columns[1].Label', 'X'), tree(), [], await withBase()),
      ),
    ).toEqual({ $type: 'UpdateProp', path: 'Columns[1].Label', target: 'grid', value: 'Second' });
  });

  it('restores the value a node was INSERTED with, base tree or not', async () => {
    // The node's origin is in this session, so what it was born holding is
    // known — and it is the only right answer, because the node did not exist
    // when the base was captured.
    const earlier = [
      insertChild('root', { id: 'heading-1', kind: { $type: 'Heading', level: 1, text: 'Text' } }),
    ];
    expect(
      expectOk(
        inverseOf(updateProp('heading-1', 'Text', 'Edited'), tree(), earlier, await withBase()),
      ),
    ).toEqual({ $type: 'UpdateProp', path: 'Text', target: 'heading-1', value: 'Text' });
  });

  it('resolves an indexed path inside a node this session inserted', async () => {
    const earlier = [
      insertChild('root', {
        id: 'grid-1',
        kind: { $type: 'Grid', columns: [{ label: 'A' }, { label: 'B' }] },
      }),
    ];
    expect(
      expectOk(
        inverseOf(updateProp('grid-1', 'Columns[0].Label', 'Z'), tree(), earlier, await withBase()),
      )['value'],
    ).toBe('A');
  });
});

describe('UpdateProp refuses when nothing can answer, and says which nothing', () => {
  it('names the page as the reason when no tree was captured', async () => {
    const message = expectRefused(
      inverseOf(updateProp('a', 'Text', 'x'), tree(), [], {
        base: await capture({ ok: false, why: 'not-offered' }),
        captured: new Map(),
      }),
      'NO_PRIOR_VALUE',
    );
    expect(message).toContain('read.nodeJson');
  });

  it('names the SIZE when the tree was over the ceiling', async () => {
    // Refused rather than truncated, and the number is in the sentence: a
    // ceiling nobody can see is a ceiling nobody can act on.
    const huge: WireNode = {
      id: 'root',
      kind: { $type: 'Markdown', text: 'x'.repeat(MAX_CAPTURED_TREE_BYTES + 1) },
    };
    const message = expectRefused(
      inverseOf(updateProp('a', 'Text', 'x'), tree(), [], {
        base: await capture({ ok: true, node: huge }),
        captured: new Map(),
      }),
      'NO_PRIOR_VALUE',
    );
    expect(message).toContain(String(MAX_CAPTURED_TREE_BYTES));
  });

  it('refuses once another writer has overtaken the captured base', async () => {
    // The base was true when it was read. A `changed` event does not say what
    // it stopped being true about, so it can no longer answer for a field this
    // session did not itself set.
    const message = expectRefused(
      inverseOf(updateProp('a', 'Text', 'x'), tree(), [], { base: STALE, captured: new Map() }),
      'NO_PRIOR_VALUE',
    );
    expect(message).toContain('another writer');
  });

  it('refuses a path the captured tree does not carry', async () => {
    expectRefused(
      inverseOf(updateProp('a', 'NotAField', 'x'), tree(), [], await withBase()),
      'NO_PRIOR_VALUE',
    );
  });

  it('refuses a node the captured tree does not hold', async () => {
    const message = expectRefused(
      inverseOf(updateProp('ghost', 'Text', 'x'), tree(), [], await withBase()),
      'NO_PRIOR_VALUE',
    );
    expect(message).toContain('not in the captured base tree');
  });

  it('refuses when the inserted node declared no such field', async () => {
    // The search stops at the node's origin, so the base tree is NOT consulted:
    // the node did not exist when it was captured, and a value found there
    // would belong to some earlier node that happened to share an id.
    const earlier = [insertChild('root', { id: 'a', kind: { $type: 'Heading', level: 1 } })];
    const message = expectRefused(
      inverseOf(updateProp('a', 'Text', 'x'), tree(), earlier, await withBase()),
      'NO_PRIOR_VALUE',
    );
    expect(message).toContain('inserted by this session');
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

  it('undoes a removal by re-inserting the captured subtree, in its old place', async () => {
    const subtree: WireNode = { id: 'b', kind: { $type: 'Heading', level: 2, text: 'beta' } };
    expect(
      expectOk(inverseOf(removeNode('b'), tree(), [], await withCaptured([['b', subtree]]))),
    ).toEqual({
      $type: 'Batch',
      ops: [
        { $type: 'InsertChild', child: subtree, parentId: 'root' },
        { $type: 'ReorderChildren', newOrder: ['a', 'b', 'card'], parentId: 'root' },
      ],
    });
  });

  it('puts a whole subtree back, children and property values included', async () => {
    // A structural husk with no properties was the reason a removal was never
    // invertible. What goes back is the wire document that was read, so the
    // children ride along inside it.
    const subtree: WireNode = {
      id: 'card',
      kind: {
        $type: 'Box',
        children: [{ id: 'inner', kind: { $type: 'Heading', level: 3, text: 'gamma' } }],
      },
    };
    const inverse = expectOk(
      inverseOf(removeNode('card'), tree(), [], await withCaptured([['card', subtree]])),
    );
    // `card` was the LAST sibling, so a plain append already lands it where it
    // was and the placement leg is elided — a redundant reorder would describe
    // a change that did not happen.
    expect(inverse).toEqual({ $type: 'InsertChild', child: subtree, parentId: 'root' });
  });

  it('refuses a removal whose subtree was not captured, naming the page reason', async () => {
    const refused = await capture({ ok: false, why: 'refused' });
    const message = expectRefused(
      inverseOf(removeNode('card'), tree(), [], {
        base: NOT_ATTEMPTED,
        captured: new Map([['card', refused]]),
      }),
      'NO_CAPTURED_SUBTREE',
    );
    expect(message).toContain('refused to encode');
  });

  it('refuses a removal with no capture at all', () => {
    expectRefused(inverseOf(removeNode('card'), tree(), []), 'NO_CAPTURED_SUBTREE');
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
    expectRefused(inverseOf(moveNode('root', 'card'), tree(), []), 'NO_PARENT');
  });

  it('undoes a reorder with the order the snapshot recorded', () => {
    expect(expectOk(inverseOf(reorderChildren('root', ['card', 'b', 'a']), tree(), []))).toEqual({
      $type: 'ReorderChildren',
      newOrder: ['a', 'b', 'card'],
      parentId: 'root',
    });
  });

  it('refuses a reorder whose parent is not in the snapshot', () => {
    expectRefused(inverseOf(reorderChildren('ghost', ['x']), tree(), []), 'NODE_NOT_IN_SNAPSHOT');
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
    const op = batch([moveNode('b', 'card'), reorderChildren('card', ['b', 'inner', 'grid'])]);
    expect(expectOk(inverseOf(op, tree(), []))['$type']).toBe('Batch');
  });

  it('refuses any other batch rather than inverting it leg by leg', () => {
    // A leg's inverse depends on the tree BEFORE that leg, and only the state
    // before the whole batch is recorded. Guessing would produce an op that
    // applies successfully and lands somewhere nobody chose.
    const message = expectRefused(
      inverseOf(batch([removeNode('a'), removeNode('b')]), tree(), []),
      'COMPOSITE_UNSUPPORTED',
    );
    expect(message).toContain('composites');
    expectRefused(inverseOf(batch([moveNode('a', 'card')]), tree(), []), 'COMPOSITE_UNSUPPORTED');
  });
});

describe('unknown ops', () => {
  it('refuses an op case this build has never heard of, and names it', () => {
    const message = expectRefused(
      inverseOf({ $type: 'ReplaceRoot', node: {} }, tree(), []),
      'UNKNOWN_OP',
    );
    expect(message).toContain('ReplaceRoot');
  });
});

describe('priorValue', () => {
  it('stops searching at the node origin', async () => {
    // An edit to a DIFFERENT node before the insert must not be mistaken for
    // this node's prior value.
    const earlier = [
      updateProp('h', 'Text', 'ghost-of-a-previous-node'),
      insertChild('root', { id: 'h', kind: { $type: 'Heading', text: 'born' } }),
    ];
    expect(priorValue('h', 'Text', earlier, await withBase())).toEqual({
      known: true,
      value: 'born',
    });
  });

  it('finds an edit nested inside a batch', () => {
    const earlier = [batch([updateProp('a', 'Text', 'inside'), removeNode('z')])];
    expect(priorValue('a', 'Text', earlier)).toEqual({ known: true, value: 'inside' });
  });

  it('reports honestly, with a reason, when nothing can answer', () => {
    const answer = priorValue('a', 'Text', []);
    expect(answer.known).toBe(false);
    if (answer.known) throw new Error('expected no answer');
    expect(answer.why).toContain('nothing was edited in this session');
  });
});
