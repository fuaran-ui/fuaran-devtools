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
import type { RelayEnvelope } from '../src/relay/protocol.js';
import { readFixture, readManifest } from './support/corpus.js';
import { describeMismatches, shapeMismatches } from './support/shape.js';
import { applyHost, applyHostWith, bareHost, taggedHost } from './support/fakeHost.js';

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

  // ── the write side ──
  //
  // Every one of these is driven against a host that wired an apply path and a
  // change hub. What the peer contributes is the §8.3 MAPPING — the host's own
  // envelope status onto the contract's refusal classes — so a fixture passing
  // here is evidence about the mapping, not about the fake.
  'hello-apply-capable': applyHost,
  'apply-accepted': applyHost,
  subscribe: applyHost,
  unsubscribe: applyHost,
  'refusal-validator-reject': applyHost,
  'refusal-policy-denied': applyHost,
  'refusal-decode-failed': applyHost,
  'refusal-malformed-message': applyHost,
  // (`refusal-capability-absent` stays on the READ-ONLY host above: the
  // fixture's whole content is a host that does not offer apply, so serving it
  // from an apply-capable one would assert nothing.)
};

/**
 * Fixtures no REQUEST can reach, because they are not responses.
 *
 * The change events are covered separately below — they are emitted, not
 * answered, so the request-driven loop cannot exercise them. Enumerating them
 * here keeps the partition total: a fixture added to the corpus that falls
 * into neither list still fails the suite.
 */
const NOT_SERVED: Record<string, string> = {
  'changed-apply': 'an event: emitted by a subscription, never a response to a request',
  'changed-host': 'an event: emitted by a subscription, never a response to a request',
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

  // ── the emitted half (§8.5) ──
  //
  // Events are the one part of the contract a request-driven runner cannot
  // reach: nothing asks for them. So they are driven from the other end — take
  // a subscription, make the host change, and compare what the peer PUT ON THE
  // WIRE against the fixture. Without this the peer could advertise
  // `subscribe`, answer `subscribe.ok`, and emit nothing at all, and every
  // fixture above would still pass.
  for (const fixture of manifest.fixtures.filter((entry) => entry.kind === 'relay-event')) {
    const eventFile = fixture.eventFile;
    if (eventFile === undefined) continue;

    it(`emits ${fixture.id}`, () => {
      const expected = readFixture(eventFile);
      const cause = (expected['payload'] as Record<string, unknown>)['cause'];
      const emitted: RelayEnvelope[] = [];
      const { host, driver } = applyHostWith();
      const peer = createPagePeer(host, IDENTITY, { emit: (event) => emitted.push(event) });

      const request = readFixture('subscribe.request.json');
      const established = peer.handle(request);
      expect(established?.type).toBe('subscribe.ok');

      driver.emit('r-42', String(cause));
      expect(emitted).toHaveLength(1);
      const actual = emitted[0]!;

      // §4.1: the event carries the id of the `subscribe` request that
      // established it, so a client routes it without extra state.
      expect(actual.id).toBe(request['id']);
      const mismatches = shapeMismatches(expected, actual);
      expect(mismatches, `\n${describeMismatches(mismatches)}\n`).toEqual([]);
    });
  }

  it('classifies the event fixtures as unreachable by request, with a reason', () => {
    // The partition's other half: these ids are declared out of the
    // request-driven loop's reach, and the reason is recorded beside them.
    for (const id of Object.keys(NOT_SERVED))
      expect(manifest.fixtures.find((entry) => entry.id === id)?.kind).toBe('relay-event');
  });

  it('stops emitting for a released subscription (§8.5)', () => {
    const emitted: RelayEnvelope[] = [];
    const { host, driver } = applyHostWith();
    const peer = createPagePeer(host, IDENTITY, { emit: (event) => emitted.push(event) });

    peer.handle(readFixture('subscribe.request.json'));
    driver.emit('r-42', 'apply');
    expect(emitted).toHaveLength(1);

    const released = peer.handle(readFixture('unsubscribe.request.json'));
    expect(released?.type).toBe('unsubscribe.ok');
    expect(driver.listenerCount()).toBe(0);

    driver.emit('r-43', 'host');
    // A released subscription emits NOTHING further. A peer that kept pushing
    // would leave a client re-reading a tree it had explicitly stopped watching.
    expect(emitted).toHaveLength(1);
  });

  it('releases every subscription on dispose (§8.5)', () => {
    const { host, driver } = applyHostWith();
    const peer = createPagePeer(host, IDENTITY, { emit: () => undefined });
    peer.handle(readFixture('subscribe.request.json'));
    expect(driver.listenerCount()).toBe(1);
    peer.dispose();
    expect(driver.listenerCount()).toBe(0);
  });

  it('answers `unsubscribe` for an id it never issued (§8.5)', () => {
    const peer = createPagePeer(applyHost, IDENTITY);
    const response = peer.handle({
      $relay: 'relay@1.0',
      dir: 'request',
      id: 'c-99',
      type: 'unsubscribe',
      payload: { subscriptionId: 's-does-not-exist' },
    });
    // The caller's desired end state is reached either way, so this is `ok`.
    expect(response?.type).toBe('unsubscribe.ok');
  });
});
