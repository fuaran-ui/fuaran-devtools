// ============================================================================
//  Reading a node's own canonical wire JSON, by op path.
//
//  Driven against the corpus's own `read-node-json` payload rather than a shape
//  invented here: what these functions must understand is the format, and a
//  hand-written stand-in would only prove they understand this file.
//
//  The claims that matter are the ones an editor would get silently wrong:
//  that an op path and a wire member name are two spellings of one field, that
//  a collection's length is a fact about the page rather than about the schema,
//  and that a merged style block preserves what the merging build has never
//  heard of.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  carriesSentinel,
  collectionLength,
  displayValue,
  mergeStyle,
  parsePath,
  styleBlock,
  valueAtPath,
  wireNameOf,
} from '../src/panel/nodeJson.js';
import { readFixture } from './support/corpus.js';

const payload = readFixture('read-node-json.response.json')['payload'] as Record<string, unknown>;
const grid = payload['node'] as Record<string, unknown>;

describe('op paths against the wire spelling', () => {
  it('reads a top-level field through the leading-character inverse', () => {
    // `Source` on the wire is `source`; the op path is the field's name with
    // its leading character upper-cased, and this is where the two meet.
    expect(valueAtPath(grid, 'Source')).toEqual({ $type: 'Query', name: 'channels' });
    expect(wireNameOf('Columns')).toBe('columns');
  });

  it('reads an indexed path into a collection', () => {
    expect(valueAtPath(grid, 'Columns[0].Label')).toBe('Channel');
  });

  it('is undefined for a path the node does not carry, at any depth', () => {
    expect(valueAtPath(grid, 'Nonesuch')).toBeUndefined();
    expect(valueAtPath(grid, 'Columns[9].Label')).toBeUndefined();
    expect(valueAtPath(grid, 'Columns[0].Nonesuch')).toBeUndefined();
  });

  it('refuses a path it cannot parse rather than guessing at one', () => {
    // The one caller derives a READ from a path it is about to WRITE, so a
    // mis-parse would show one field's value beside another field's editor.
    expect(parsePath('Columns[')).toBeUndefined();
    expect(parsePath('')).toBeUndefined();
    expect(valueAtPath(grid, 'Columns[0]].Label')).toBeUndefined();
  });

  it('keeps a present null distinct from an absent member', () => {
    const node = { id: 'x', kind: { $type: 'K', a: null } };
    expect(valueAtPath(node, 'A')).toBeNull();
    expect(valueAtPath(node, 'B')).toBeUndefined();
  });
});

describe('collection length — the fact no other read reports', () => {
  it('reports the current length of a collection-valued field', () => {
    expect(collectionLength(grid, 'Columns')).toBe(1);
  });

  it('is undefined where there is no array, never zero', () => {
    // Zero would read as "an empty collection", which is a claim about the
    // page; `undefined` is the honest "there is no collection here at all",
    // and the editor renders no rows for either — but only one of them would
    // be a lie if it were shown as a count.
    expect(collectionLength(grid, 'Source')).toBeUndefined();
    expect(collectionLength(grid, 'Nonesuch')).toBeUndefined();
  });
});

describe('the style block', () => {
  it('reads an absent block as empty, so editing starts from empty', () => {
    expect(styleBlock(grid)).toEqual({});
  });

  it('preserves every other token when one is changed', () => {
    const block = { emphasis: 'Loud', tone: 'Success', weight: 'Spacious' };
    expect(mergeStyle(block, { tone: 'Danger' })).toEqual({
      emphasis: 'Loud',
      tone: 'Danger',
      weight: 'Spacious',
    });
  });

  it('preserves a token this build has never heard of', () => {
    // The merge spreads over the READ, so a page running a newer vocabulary
    // keeps what it had. A block rebuilt from the editor's own controls would
    // drop this silently — which is the whole-block discard the style surface
    // was withheld to avoid, arriving by a different door.
    const block = { tone: 'Success', somethingNewer: 'Whatever' };
    expect(mergeStyle(block, { tone: 'Danger' })).toEqual({
      tone: 'Danger',
      somethingNewer: 'Whatever',
    });
  });

  it('clears a token by removing it, never by setting it null', () => {
    // The wire format's absent-optional is absence; `null` is a different
    // document, and one the host may well refuse.
    const merged = mergeStyle({ tone: 'Success', emphasis: 'Loud' }, { tone: undefined });
    expect(merged).toEqual({ emphasis: 'Loud' });
    expect('tone' in merged).toBe(false);
  });
});

describe('sentinels (§7.7 rule 2)', () => {
  it('finds a sentinel wherever it sits, not only at the top', () => {
    expect(carriesSentinel('<closure>')).toBe(true);
    expect(carriesSentinel('<opaque>')).toBe(true);
    expect(carriesSentinel(grid)).toBe(true); // the column's `value`
    expect(carriesSentinel({ a: [{ b: '<opaque>' }] })).toBe(true);
  });

  it('does not mistake ordinary text for one', () => {
    expect(carriesSentinel('closure')).toBe(false);
    expect(carriesSentinel('<closure> and more')).toBe(false);
    expect(carriesSentinel({ label: 'Channel' })).toBe(false);
  });
});

describe('what a row shows', () => {
  it('shows a scalar as itself and a structure as its JSON', () => {
    expect(displayValue('Channel')).toBe('Channel');
    expect(displayValue(3)).toBe('3');
    expect(displayValue(false)).toBe('false');
    // Not `[object Object]`, which reads as a value the user could retype.
    expect(displayValue({ $type: 'Query' })).toBe('{"$type":"Query"}');
  });

  it('shows an absent value as empty, so the box is empty rather than "undefined"', () => {
    expect(displayValue(undefined)).toBe('');
  });
});
