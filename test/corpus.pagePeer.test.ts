// ============================================================================
//  The relay conformance corpus, driven through the PAGE PEER.
//
//  For every fixture the read-only peer can serve: feed the fixture's request
//  envelope in, and assert the response satisfies §12.3 — the request's type
//  plus `.ok` (or `refusal` with the declared class), the request's id echoed
//  verbatim, and every field the fixture's payload declares present with the
//  stated JSON type.
//
//  The fixtures this peer CANNOT serve are enumerated with a reason, and the
//  partition is asserted to be total: a fixture added to the corpus that falls
//  into neither list fails the suite rather than being silently unexercised.
//  That check is the point of the table — a conformance run whose coverage can
//  drift without anyone noticing is not a conformance run.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { createPagePeer, type HostSurface } from '../src/relay/pagePeer.js';
import { readFixture, readManifest } from './support/corpus.js';
import { describeMismatches, shapeMismatches } from './support/shape.js';
import { bareHost, taggedHost } from './support/fakeHost.js';

const IDENTITY = { host: 'fuaran-devtools-page-relay', hostVersion: '0.1.0' };

/** Which surface each servable fixture is driven against. */
const SERVED: Record<string, HostSurface | undefined> = {
  'hello-read-only': bareHost,
  'read-node-state': bareHost,
  'read-tree': bareHost,
  'read-binding-value-resolved': bareHost,
  'read-rendered-dom': bareHost,
  'read-find-nodes': bareHost,
  'read-find-nodes-empty': bareHost,
  'refusal-node-not-found': bareHost,
  'refusal-slot-not-declared': bareHost,
  'refusal-capability-absent': bareHost,
  'refusal-unknown-message': bareHost,
  'refusal-foreign-profile': bareHost,
  // A host whose surface already emits the canonical tagged envelope is the
  // only one that can report `noOverride` (§7.3) — see `fakeHost`.
  'read-binding-value-no-override': taggedHost,
  // The absent-surface case: `undefined` is the "no in-page debug surface"
  // state, and §11.1 permits the minimal listener that answers NOT_OPTED_IN.
  'refusal-not-opted-in': undefined,
};

/**
 * Fixtures outside a READ-ONLY peer's reach. §6.4: "a read-only host is fully
 * conformant" — a peer offering only the five reads implements the contract
 * completely, so these are not gaps, they are the shape of this peer.
 */
const NOT_SERVED: Record<string, string> = {
  'hello-apply-capable': 'this peer never advertises apply or subscribe (§6.4)',
  'apply-accepted': 'no apply capability — refused CAPABILITY_ABSENT instead',
  subscribe: 'no subscribe capability — refused CAPABILITY_ABSENT instead',
  unsubscribe: 'no subscribe capability — refused CAPABILITY_ABSENT instead',
  'refusal-validator-reject': 'an apply-path refusal; unreachable without apply',
  'refusal-policy-denied': 'an apply-path refusal; unreachable without apply',
  'refusal-decode-failed': 'an apply-path refusal; unreachable without apply',
  'refusal-malformed-message':
    'the fixture malforms a subscribe, which this peer refuses CAPABILITY_ABSENT first (§6.4 ordering)',
  'changed-apply': 'an event; a read-only peer emits none',
  'changed-host': 'an event; a read-only peer emits none',
};

const manifest = readManifest();

describe('relay@1.0 corpus — page peer', () => {
  it('speaks the profile the corpus declares', () => {
    expect(manifest.profile).toBe('relay@1.0');
  });

  it('classifies every fixture as served or explicitly out of reach', () => {
    const unclassified = manifest.fixtures
      .map((fixture) => fixture.id)
      .filter((id) => !(id in SERVED) && !(id in NOT_SERVED));
    expect(unclassified).toEqual([]);
  });

  for (const fixture of manifest.fixtures) {
    if (!(fixture.id in SERVED)) continue;
    const requestFile = fixture.requestFile;
    const responseFile = fixture.responseFile;
    if (requestFile === undefined || responseFile === undefined) continue;

    it(`serves ${fixture.id}`, () => {
      const request = readFixture(requestFile);
      const expected = readFixture(responseFile);
      const peer = createPagePeer(SERVED[fixture.id], IDENTITY);

      const actual = peer.handle(request);
      expect(actual, 'the peer produced no response').toBeDefined();
      if (actual === undefined) return;

      // §4.1 — the id is echoed verbatim, refusals included.
      expect(actual.id).toBe(request['id']);
      // §4.2 — `<type>.ok` or `refusal`; there is no third outcome.
      expect(actual.type).toBe(expected['type']);
      if (fixture.kind === 'relay-refusal') {
        expect(actual.type).toBe('refusal');
        expect(actual.payload['class']).toBe(fixture.expectedClass);
      }

      const mismatches = shapeMismatches(expected, actual);
      expect(mismatches, `\n${describeMismatches(mismatches)}\n`).toEqual([]);
    });
  }

  for (const [id, reason] of Object.entries(NOT_SERVED)) {
    const fixture = manifest.fixtures.find((entry) => entry.id === id);
    if (fixture?.kind === 'relay-event') continue;
    const requestFile = fixture?.requestFile;
    if (requestFile === undefined) continue;

    it(`refuses ${id} — ${reason}`, () => {
      const request = readFixture(requestFile);
      const peer = createPagePeer(bareHost, IDENTITY);
      const actual = peer.handle(request);
      expect(actual).toBeDefined();
      // Whatever the reason, the contract's floor holds: exactly one response
      // per request, the id echoed, and never silence (§9.2, §10.1).
      expect(actual?.id).toBe(request['id']);
      expect(['refusal', 'hello.ok']).toContain(actual?.type);
    });
  }
});
