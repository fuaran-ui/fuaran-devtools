// ============================================================================
//  The canonical encoder, against the specification's own canonical bytes.
//
//  The corpus fixtures are STORED canonically, which gives the encoder a
//  property that can be checked mechanically rather than argued: parse a
//  fixture and re-encode it, and the bytes must come back identical. Anything
//  the encoder gets wrong — a key ordered differently, a float laid out the
//  JavaScript way, an escape that should not be there — shows up as a byte
//  divergence in a real document rather than as a disagreement between this
//  suite and its own expectations.
//
//  The families are enumerated from the DIRECTORY, so a fixture added upstream
//  is covered with no change here. That matters more than it sounds: the whole
//  claim of this module is that it tracks the format, and a hand-written list
//  would quietly stop being that list the first time the format grew.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  encodeNumber,
  encodeString,
  formatDouble,
} from '../src/trail/canonicalJson.js';
import { listSpecFixtures, readSpecText } from './support/corpus.js';

const families = ['ops', 'nodes'] as const;

describe('canonical encoding is a fixed point on the specification corpus', () => {
  for (const family of families) {
    const fixtures = listSpecFixtures(family);

    it(`covers a non-empty '${family}' family`, () => {
      // A conformance run that quietly passes with no fixtures is a green tick
      // that means nothing — the same reason the relay corpus fails loudly.
      expect(fixtures.length).toBeGreaterThan(0);
    });

    for (const fixture of fixtures)
      it(`re-encodes ${fixture} byte-for-byte`, () => {
        const bytes = readSpecText(fixture);
        expect(canonicalJson(JSON.parse(bytes))).toBe(bytes);
      });
  }
});

describe('object keys sort by ordinal comparison, recursively', () => {
  it('orders by UTF-16 code unit, so `$type` leads and case is significant', () => {
    expect(canonicalJson({ b: 1, $type: 'X', A: 2, a: 3 })).toBe('{"$type":"X","A":2,"a":3,"b":1}');
  });

  it('sorts nested objects too', () => {
    expect(canonicalJson({ z: { b: 1, a: 2 }, a: [{ d: 1, c: 2 }] })).toBe(
      '{"a":[{"c":2,"d":1}],"z":{"a":2,"b":1}}',
    );
  });

  it('keeps array order', () => {
    expect(canonicalJson(['c', 'a', 'b'])).toBe('["c","a","b"]');
  });

  it('omits absent fields rather than writing null, and keeps an explicit null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('renders empty containers', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });
});

describe('strings escape only what the format escapes', () => {
  it('escapes the quote and the backslash', () => {
    expect(encodeString('a"b' + String.fromCharCode(92) + 'c')).toBe(
      '"a' + String.fromCharCode(92) + '"b' + String.fromCharCode(92).repeat(2) + 'c"',
    );
  });

  it('escapes control characters as lower-case four-digit unicode, with no shortcuts', () => {
    // NOT `\n` / `\t`: the format pins the long form, and the short one would
    // hash differently while looking identical to a reader.
    expect(encodeString('a\nb\tc')).toBe(
      '"a' + String.fromCharCode(92) + 'u000ab' + String.fromCharCode(92) + 'u0009c"',
    );
  });

  it('leaves the solidus and non-ASCII alone', () => {
    expect(encodeString('a/b — ü')).toBe('"a/b — ü"');
  });
});

describe('numbers follow the .NET layout, not the JavaScript one', () => {
  it('renders integers bare and collapses negative zero', () => {
    expect(encodeNumber(42)).toBe('42');
    expect(encodeNumber(-7)).toBe('-7');
    expect(encodeNumber(0)).toBe('0');
    expect(encodeNumber(-0)).toBe('0');
  });

  it('keeps fixed notation while the decimal exponent is within [-4, 16]', () => {
    expect(formatDouble(1.5)).toBe('1.5');
    expect(formatDouble(0.0001)).toBe('0.0001');
    expect(formatDouble(1e16)).toBe('10000000000000000');
  });

  it('switches to uppercase exponential with a signed two-digit exponent outside it', () => {
    // JavaScript writes `1e+21` and `1e-7`; the format writes these.
    expect(formatDouble(1e21)).toBe('1E+21');
    expect(formatDouble(1e-7)).toBe('1E-07');
    expect(formatDouble(-2.5e-9)).toBe('-2.5E-09');
  });

  it('quotes the values JSON has no literal for', () => {
    expect(encodeNumber(Number.NaN)).toBe('"NaN"');
    expect(encodeNumber(Number.POSITIVE_INFINITY)).toBe('"Infinity"');
    expect(encodeNumber(Number.NEGATIVE_INFINITY)).toBe('"-Infinity"');
  });
});
