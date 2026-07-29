// ============================================================================
//  The op vocabulary the panel emits.
//
//  These assertions are on BYTES, not shapes — deliberately, and in contrast to
//  the relay corpus suite, which compares shapes because a `treeRevision` or a
//  geometry number is environment-specific. An op is not: `{"$type":"InsertChild",
//  "child":…,"parentId":…}` is the same in every host, and a field renamed or a
//  leg silently added is exactly the regression worth catching.
//
//  The last test in this file is a NEGATIVE SWEEP over every op the whole suite
//  emits. Placement is id-addressed, and the way that stops being true is not a
//  deliberate decision to use indices — it is one convenience field added to one
//  op by someone who did not know. A sweep catches that; a per-op assertion
//  only catches it in the op someone thought to check.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  batch,
  insertOp,
  moveOp,
  nudgeOp,
  removeNode,
  reorderChildren,
  reposition,
  updateProp,
  type TreeOpJson,
} from '../src/edit/ops.js';

/** Every op this file emits, swept at the end. */
const emitted: TreeOpJson[] = [];
const record = <T extends TreeOpJson>(op: T): T => {
  emitted.push(op);
  return op;
};

const SIBLINGS = ['a', 'card', 'c'];
const HEADING = { id: 'heading-1', kind: { $type: 'Heading', level: 1, text: 'Text' } };

describe('property ops', () => {
  it('emits UpdateProp addressing the node by id and the field by op path', () => {
    expect(JSON.stringify(record(updateProp('h', 'Level', 3)))).toBe(
      '{"$type":"UpdateProp","path":"Level","target":"h","value":3}',
    );
  });

  it('carries a string value verbatim', () => {
    expect(JSON.stringify(record(updateProp('h', 'Text', 'Channel name')))).toBe(
      '{"$type":"UpdateProp","path":"Text","target":"h","value":"Channel name"}',
    );
  });
});

describe('structural placement', () => {
  it('emits the exact Batch for an insert before a sibling', () => {
    const op = record(
      insertOp(
        SIBLINGS,
        { parentId: 'root', placement: { at: 'before', anchor: 'card' } },
        HEADING,
      ),
    );
    expect(JSON.stringify(op)).toBe(
      '{"$type":"Batch","ops":[' +
        '{"$type":"InsertChild","child":{"id":"heading-1","kind":{"$type":"Heading","level":1,"text":"Text"}},"parentId":"root"},' +
        '{"$type":"ReorderChildren","newOrder":["a","heading-1","card","c"],"parentId":"root"}' +
        ']}',
    );
  });

  it('emits the exact Batch for an insert after a sibling', () => {
    const op = record(
      insertOp(SIBLINGS, { parentId: 'root', placement: { at: 'after', anchor: 'a' } }, HEADING),
    );
    const ops = op['ops'] as TreeOpJson[];
    expect((ops[1] as TreeOpJson)['newOrder']).toEqual(['a', 'heading-1', 'card', 'c']);
  });

  it('ELIDES the reorder leg when a plain append already lands it there', () => {
    // A redundant ReorderChildren is a second op in the host's log describing a
    // change that did not happen, and the log is the record of what happened.
    for (const placement of [{ at: 'last' } as const, { at: 'after', anchor: 'c' } as const]) {
      const op = record(insertOp(SIBLINGS, { parentId: 'root', placement }, HEADING));
      expect(op['$type']).toBe('InsertChild');
    }
  });

  it('names the FULL sibling list in a reorder', () => {
    // A partial order is not a legal reorder: the op states the order, so an
    // order missing a sibling states something untrue about that sibling.
    const op = record(nudgeOp('root', SIBLINGS, 'card', -1)!);
    expect(op['newOrder']).toEqual(['card', 'a', 'c']);
    expect((op['newOrder'] as string[]).length).toBe(SIBLINGS.length);
  });

  it('reports the ends of the sibling list rather than emitting a no-op', () => {
    expect(nudgeOp('root', SIBLINGS, 'a', -1)).toBeUndefined();
    expect(nudgeOp('root', SIBLINGS, 'c', 1)).toBeUndefined();
    expect(nudgeOp('root', SIBLINGS, 'not-here', 1)).toBeUndefined();
  });

  it('emits MoveNode, batched with the order when placement asks for one', () => {
    const op = record(
      moveOp(['x', 'y'], { parentId: 'card', placement: { at: 'before', anchor: 'y' } }, 'a'),
    );
    expect(JSON.stringify(op)).toBe(
      '{"$type":"Batch","ops":[' +
        '{"$type":"MoveNode","newParentId":"card","target":"a"},' +
        '{"$type":"ReorderChildren","newOrder":["x","a","y"],"parentId":"card"}' +
        ']}',
    );
  });

  it('emits a bare MoveNode when the append already lands it there', () => {
    const op = record(moveOp(['x', 'y'], { parentId: 'card', placement: { at: 'last' } }, 'a'));
    expect(JSON.stringify(op)).toBe('{"$type":"MoveNode","newParentId":"card","target":"a"}');
  });

  it('re-places a node among the siblings it already has', () => {
    // "Siblings without it, plus it" is the same expression whether the node is
    // arriving or merely moving, so one route covers both.
    const op = record(
      moveOp(SIBLINGS, { parentId: 'root', placement: { at: 'before', anchor: 'a' } }, 'c'),
    );
    const ops = op['ops'] as TreeOpJson[];
    expect((ops[1] as TreeOpJson)['newOrder']).toEqual(['c', 'a', 'card']);
  });

  it('emits RemoveNode addressed by id', () => {
    expect(JSON.stringify(record(removeNode('card')))).toBe(
      '{"$type":"RemoveNode","target":"card"}',
    );
  });

  it('appends when the anchor has vanished from under the affordance', () => {
    // Between the panel rendering "insert before card" and the user clicking,
    // another writer may have removed `card`. Landing at the end of the list
    // aimed at is a better answer than refusing an edit whose staleness the
    // user had no way to see.
    expect(reposition(['a', 'c', 'new'], 'new', { at: 'before', anchor: 'card' })).toEqual([
      'a',
      'c',
      'new',
    ]);
  });
});

describe('the placement algebra never becomes positional', () => {
  const POSITIONAL_KEYS = ['position', 'newPosition', 'index', 'newIndex', 'at', 'offset'];

  const walk = (value: unknown, visit: (key: string, value: unknown) => void): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, visit);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      visit(key, child);
      walk(child, visit);
    }
  };

  it('emits no integer-position key in any op the suite produced', () => {
    expect(emitted.length).toBeGreaterThan(8);
    const found: string[] = [];
    for (const op of emitted)
      walk(op, (key) => {
        if (POSITIONAL_KEYS.includes(key)) found.push(key);
      });
    // An op carrying a position means something different depending on what the
    // tree looked like when it was composed. Between composing and applying it,
    // an AI driving the same page can insert a sibling — and the op then lands
    // somewhere nobody chose.
    expect(found).toEqual([]);
  });

  it('names every reorder entry as a string id', () => {
    for (const op of emitted)
      walk(op, (key, value) => {
        if (key !== 'newOrder') return;
        expect(Array.isArray(value)).toBe(true);
        for (const entry of value as unknown[]) expect(typeof entry).toBe('string');
      });
  });

  it('sweeps a positional key when one IS present, so the sweep can fail', () => {
    // The sweep's own probe. A negative assertion that has never been seen to
    // fail is indistinguishable from one that cannot.
    const contaminated = batch([reorderChildren('root', ['a']), { $type: 'X', position: 2 }]);
    const found: string[] = [];
    walk(contaminated, (key) => {
      if (POSITIONAL_KEYS.includes(key)) found.push(key);
    });
    expect(found).toEqual(['position']);
  });
});
